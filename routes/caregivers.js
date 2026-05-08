import { Router } from 'express';
import { clerkClient } from '@clerk/express';
import { caregiverService } from '../services/caregivers.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { db } from '../db/client.js';
import { caregivers, seniors, notificationPreferences, notifications } from '../db/schema.js';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { seniorService } from '../services/seniors.js';
import { routeError } from './helpers.js';
import { logAudit, authToRole } from '../services/audit.js';
import { sendError } from '../lib/http-response.js';
import { pushTokenSchema } from '../validators/schemas.js';

const router = Router();

// List all caregiver-senior links (admin only)
router.get('/api/caregivers', requireAdmin, async (req, res) => {
  try {
    const links = await db.select({
      id: caregivers.id,
      clerkUserId: caregivers.clerkUserId,
      seniorId: caregivers.seniorId,
      seniorName: seniors.name,
      role: caregivers.role,
      createdAt: caregivers.createdAt,
    })
    .from(caregivers)
    .leftJoin(seniors, eq(caregivers.seniorId, seniors.id))
    .orderBy(desc(caregivers.createdAt));

    res.json(links);
  } catch (error) {
    routeError(res, error, 'GET /api/caregivers');
  }
});

// Get current user's seniors (uses Clerk user ID directly)
router.get('/api/caregivers/me', requireAuth, async (req, res) => {
  try {
    const clerkUserId = req.auth.userId;

    // Get all seniors this user can access
    const seniors = await caregiverService.getSeniorsForUser(clerkUserId);

    if (seniors.length === 0) {
      // No seniors linked - they need to complete onboarding
      return sendError(res, 404, { error: 'No seniors found', needsOnboarding: true });
    }

    res.json({
      clerkUserId,
      seniors,
    });
  } catch (error) {
    routeError(res, error, 'GET /api/caregivers/me');
  }
});

// Register the Expo push token for the current caregiver across every
// senior link they have. Allows the backend to push to the mobile app on
// events like a voice-created reminder so the UI cache invalidates.
router.post('/api/caregivers/me/push-token', requireAuth, writeLimiter, async (req, res) => {
  try {
    const parsed = pushTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, {
        error: 'Validation error',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const clerkUserId = req.auth.userId;
    const result = await db.update(caregivers)
      .set({
        expoPushToken: parsed.data.token,
        expoPushTokenUpdatedAt: new Date(),
      })
      .where(eq(caregivers.clerkUserId, clerkUserId))
      .returning({ id: caregivers.id });

    if (result.length === 0) {
      return sendError(res, 404, { error: 'Caregiver not found' });
    }

    res.json({ success: true, updated: result.length });
  } catch (error) {
    routeError(res, error, 'POST /api/caregivers/me/push-token');
  }
});

// Cancel an auth account that has not completed Donna onboarding.
// This intentionally refuses to delete any account already linked to caregiver data.
router.delete('/api/caregivers/me/incomplete-account', requireAuth, writeLimiter, async (req, res) => {
  try {
    if (req.auth.provider !== 'clerk') {
      return sendError(res, 400, { error: 'Clerk authentication required for incomplete account cleanup' });
    }

    const clerkUserId = req.auth.userId;
    const [assignment] = await db.select({ id: caregivers.id })
      .from(caregivers)
      .where(eq(caregivers.clerkUserId, clerkUserId))
      .limit(1);

    if (assignment) {
      return sendError(res, 409, {
        error: 'Donna profile already exists. Use account deletion from settings.',
        code: 'caregiver_profile_exists',
      });
    }

    logAudit({
      userId: clerkUserId,
      userRole: authToRole(req.auth),
      action: 'delete',
      resourceType: 'pending_caregiver_account',
      resourceId: clerkUserId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { reason: 'onboarding_cancelled_before_completion' },
    });

    let clerkUserDeleted = false;
    try {
      await clerkClient.users.deleteUser(clerkUserId);
      clerkUserDeleted = true;
    } catch (error) {
      logAudit({
        userId: clerkUserId,
        userRole: authToRole(req.auth),
        action: 'delete_clerk_user_failed',
        resourceType: 'pending_caregiver_account',
        resourceId: clerkUserId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: {
          error_name: error?.name,
          error_code: error?.code,
        },
      });

      return res.status(202).json({
        success: true,
        clerkUserDeleted,
        deletedSeniors: [],
        unlinkedSeniors: [],
        deletionCounts: {},
        message: 'Donna setup data was cleared. Contact support to finish deleting the sign-in account.',
      });
    }

    res.json({
      success: true,
      clerkUserDeleted,
      deletedSeniors: [],
      unlinkedSeniors: [],
      deletionCounts: {},
    });
  } catch (error) {
    routeError(res, error, 'DELETE /api/caregivers/me/incomplete-account');
  }
});

// Delete current caregiver account and associated Donna data.
router.delete('/api/caregivers/me/account', requireAuth, idempotencyMiddleware, writeLimiter, async (req, res) => {
  try {
    if (req.auth.provider !== 'clerk') {
      return sendError(res, 400, { error: 'Clerk authentication required for account deletion' });
    }

    const clerkUserId = req.auth.userId;
    const assignments = await db.select()
      .from(caregivers)
      .where(eq(caregivers.clerkUserId, clerkUserId));

    const assignmentsBySenior = new Map();
    for (const assignment of assignments) {
      const current = assignmentsBySenior.get(assignment.seniorId) ?? [];
      current.push(assignment);
      assignmentsBySenior.set(assignment.seniorId, current);
    }

    const deletedSeniors = [];
    const unlinkedSeniors = [];
    const deletionCounts = {};

    for (const [seniorId, seniorAssignments] of assignmentsBySenior.entries()) {
      const otherCaregiverResult = await db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM caregivers
        WHERE senior_id = ${seniorId}
          AND clerk_user_id <> ${clerkUserId}
      `);
      const otherCaregiverCount = Number(otherCaregiverResult.rows?.[0]?.count ?? 0);

      if (otherCaregiverCount === 0) {
        deletionCounts[seniorId] = await seniorService.hardDelete(
          seniorId,
          clerkUserId,
          'caregiver_account_deletion',
        );
        deletedSeniors.push(seniorId);
        continue;
      }

      const assignmentIds = seniorAssignments.map((assignment) => assignment.id);
      const unlinkCounts = await db.transaction(async (tx) => {
        const deletedPreferences = await tx.delete(notificationPreferences)
          .where(inArray(notificationPreferences.caregiverId, assignmentIds))
          .returning({ id: notificationPreferences.id });
        const deletedNotifications = await tx.delete(notifications)
          .where(inArray(notifications.caregiverId, assignmentIds))
          .returning({ id: notifications.id });
        const deletedCaregivers = await tx.delete(caregivers)
          .where(inArray(caregivers.id, assignmentIds))
          .returning({ id: caregivers.id });

        return {
          notification_preferences: deletedPreferences.length,
          notifications: deletedNotifications.length,
          caregivers: deletedCaregivers.length,
        };
      });

      deletionCounts[seniorId] = unlinkCounts;
      unlinkedSeniors.push(seniorId);
    }

    logAudit({
      userId: clerkUserId,
      userRole: authToRole(req.auth),
      action: 'delete',
      resourceType: 'caregiver_account',
      resourceId: clerkUserId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: {
        deleted_senior_count: deletedSeniors.length,
        unlinked_senior_count: unlinkedSeniors.length,
      },
    });

    let clerkUserDeleted = false;
    try {
      await clerkClient.users.deleteUser(clerkUserId);
      clerkUserDeleted = true;
    } catch (error) {
      logAudit({
        userId: clerkUserId,
        userRole: authToRole(req.auth),
        action: 'delete_clerk_user_failed',
        resourceType: 'caregiver_account',
        resourceId: clerkUserId,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: {
          error_name: error?.name,
          error_code: error?.code,
        },
      });

      return res.status(202).json({
        success: true,
        clerkUserDeleted,
        deletedSeniors,
        unlinkedSeniors,
        deletionCounts,
        message: 'Donna data was deleted. Contact support to finish deleting the sign-in account.',
      });
    }

    res.json({
      success: true,
      clerkUserDeleted,
      deletedSeniors,
      unlinkedSeniors,
      deletionCounts,
    });
  } catch (error) {
    routeError(res, error, 'DELETE /api/caregivers/me/account');
  }
});

export default router;
