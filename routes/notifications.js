import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { notificationPreferencesSchema, notificationTriggerSchema } from '../validators/schemas.js';
import { decryptNotificationRow, notificationService } from '../services/notifications.js';
import { db } from '../db/client.js';
import { caregivers, notifications } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { routeError } from './helpers.js';
import { isProductionEnv, matchServiceApiKey, parseServiceApiKeys } from '../lib/security-config.js';
import { sendError } from '../lib/http-response.js';
import { logAudit, authToRole } from '../services/audit.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helper: get caregiver ID for the authenticated Clerk user
// ---------------------------------------------------------------------------
async function getCaregiverIdForUser(clerkUserId) {
  const [caregiver] = await db.select({ id: caregivers.id })
    .from(caregivers)
    .where(eq(caregivers.clerkUserId, clerkUserId))
    .limit(1);
  return caregiver?.id || null;
}

// ---------------------------------------------------------------------------
// Helper: validate X-API-Key for service-to-service calls (Pipecat → Node.js)
// ---------------------------------------------------------------------------
function requireServiceApiKey(req, res, next) {
  const configuredKeys = parseServiceApiKeys();
  if (configuredKeys.size === 0) {
    if (isProductionEnv()) {
      return sendError(res, 503, { error: 'Service API key auth is not configured' });
    }
    return next();
  }

  const provided = req.headers['x-api-key'];
  if (!provided) {
    return sendError(res, 401, { error: 'X-API-Key header required' });
  }

  const keyLabel = matchServiceApiKey(provided);
  if (!keyLabel) {
    return sendError(res, 403, { error: 'Invalid API key' });
  }

  req.serviceApiKeyLabel = keyLabel;
  next();
}

// ---------------------------------------------------------------------------
// GET /api/notifications/preferences — get current user's notification prefs
// ---------------------------------------------------------------------------
router.get('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const caregiverId = await getCaregiverIdForUser(req.auth.userId);
    if (!caregiverId) {
      return sendError(res, 404, { error: 'Caregiver not found' });
    }

    const prefs = await notificationService.getPreferences(caregiverId);
    res.json(prefs);
  } catch (error) {
    routeError(res, error, 'GET /api/notifications/preferences');
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/notifications/preferences — update current user's notification prefs
// ---------------------------------------------------------------------------
router.patch('/api/notifications/preferences', requireAuth, idempotencyMiddleware, async (req, res) => {
  try {
    const parsed = notificationPreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, {
        error: 'Validation error',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const caregiverId = await getCaregiverIdForUser(req.auth.userId);
    if (!caregiverId) {
      return sendError(res, 404, { error: 'Caregiver not found' });
    }

    const updated = await notificationService.upsertPreferences(caregiverId, parsed.data);
    res.json(updated);
  } catch (error) {
    routeError(res, error, 'PATCH /api/notifications/preferences');
  }
});

// ---------------------------------------------------------------------------
// GET /api/notifications — list notifications for current user (paginated)
// ---------------------------------------------------------------------------
router.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const caregiverId = await getCaregiverIdForUser(req.auth.userId);
    if (!caregiverId) {
      return sendError(res, 404, { error: 'Caregiver not found' });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const results = await db.select()
      .from(notifications)
      .where(eq(notifications.caregiverId, caregiverId))
      .orderBy(desc(notifications.sentAt))
      .limit(limit)
      .offset(offset);

    const decrypted = results.map(decryptNotificationRow);
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'notification',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { page, limit, count: decrypted.length },
    });

    res.json(decrypted);
  } catch (error) {
    routeError(res, error, 'GET /api/notifications');
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/notifications/:id/read — mark notification as read
// ---------------------------------------------------------------------------
router.patch('/api/notifications/:id/read', requireAuth, idempotencyMiddleware, async (req, res) => {
  try {
    const caregiverId = await getCaregiverIdForUser(req.auth.userId);
    if (!caregiverId) {
      return sendError(res, 404, { error: 'Caregiver not found' });
    }

    const [updated] = await db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(
        eq(notifications.id, req.params.id),
        eq(notifications.caregiverId, caregiverId),
      ))
      .returning();

    if (!updated) {
      return sendError(res, 404, { error: 'Notification not found' });
    }

    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'update',
      resourceType: 'notification',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { field: 'readAt' },
    });

    res.json(decryptNotificationRow(updated));
  } catch (error) {
    routeError(res, error, 'PATCH /api/notifications/:id/read');
  }
});

// ---------------------------------------------------------------------------
// POST /api/notifications/trigger — trigger a notification event
// (service-to-service: Pipecat → Node.js, uses X-API-Key auth)
// ---------------------------------------------------------------------------
router.post('/api/notifications/trigger', requireServiceApiKey, async (req, res) => {
  try {
    const parsed = notificationTriggerSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, {
        error: 'Validation error',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { event_type, senior_id, data } = parsed.data;

    // Dispatch based on event type
    switch (event_type) {
      case 'call_completed':
        await notificationService.onCallCompleted(senior_id, data);
        break;
      case 'reminder_missed':
        await notificationService.onReminderMissed(senior_id, data);
        break;
      case 'consent_declined':
        await notificationService.onConsentDeclined(senior_id, data);
        break;
    }

    res.json({ success: true, event_type });
  } catch (error) {
    routeError(res, error, 'POST /api/notifications/trigger');
  }
});

export default router;
