import { Router } from 'express';
import { db } from '../db/client.js';
import {
  seniors,
  conversations,
  memories,
  reminders,
  callAnalyses,
  dailyCallContext,
  caregivers,
  seniorCallSchedules,
  callQueue,
  callAttempts,
  outboundCallGuards,
  schedulerShadowComparisons,
} from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { seniorService } from '../services/seniors.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { writeLimiter, authLimiter } from '../middleware/rate-limit.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  createSeniorSchema,
  updateSeniorSchema,
  updateScheduleSchema,
  seniorIdParamSchema,
} from '../validators/schemas.js';
import { getAccessibleSeniorIds, canAccessSenior, routeError } from './helpers.js';
import { logAudit, writeAudit, authToRole } from '../services/audit.js';
import { decrypt, decryptJson } from '../lib/encryption.js';
import { sendError } from '../lib/http-response.js';
import { normalizeCallAnalysis } from '../services/call-analyses.js';
import { decryptDailyContextPhi, decryptReminderPhi } from '../lib/phi.js';
import { createLogger } from '../lib/logger.js';

const router = Router();
const log = createLogger('Seniors');

function decryptExportConversation(row) {
  const summary = row.summaryEncrypted ? decrypt(row.summaryEncrypted) : row.summary;
  const transcript = row.transcriptEncrypted ? decryptJson(row.transcriptEncrypted) : row.transcript;
  const transcriptText = row.transcriptTextEncrypted ? decrypt(row.transcriptTextEncrypted) : undefined;
  const {
    summaryEncrypted,
    transcriptEncrypted,
    transcriptTextEncrypted,
    ...rest
  } = row;
  return {
    ...rest,
    summary,
    transcript,
    ...(transcriptText ? { transcriptText } : {}),
  };
}

function decryptExportMemory(row) {
  const {
    contentEncrypted,
    ...rest
  } = row;
  return {
    ...rest,
    content: contentEncrypted ? decrypt(contentEncrypted) : row.content,
  };
}

function decryptExportSeniorCallSchedule(row) {
  const {
    contextNotesEncrypted,
    ...rest
  } = row;
  return {
    ...rest,
    ...(contextNotesEncrypted ? { contextNotes: decrypt(contextNotesEncrypted) } : {}),
  };
}

function decryptExportPostCallJob(row) {
  const {
    payload_encrypted: payloadEncryptedSnake,
    payloadEncrypted = payloadEncryptedSnake,
    ...rest
  } = row;
  return {
    ...rest,
    ...(payloadEncrypted ? { payload: decryptJson(payloadEncrypted) } : {}),
  };
}

// Create a senior profile (admin only)
router.post('/api/seniors', requireAdmin, validateBody(createSeniorSchema), idempotencyMiddleware, writeLimiter, async (req, res) => {
  try {
    const senior = await seniorService.create(req.body);
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'create',
      resourceType: 'senior',
      resourceId: senior.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json(senior);
  } catch (error) {
    routeError(res, error, 'POST /api/seniors');
  }
});

// List seniors (admins see all, caregivers see assigned)
router.get('/api/seniors', requireAuth, async (req, res) => {
  try {
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'senior',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    const accessibleIds = await getAccessibleSeniorIds(req.auth);
    if (accessibleIds === null) {
      // Admin: return all
      const allSeniors = await seniorService.list();
      return res.json(allSeniors);
    }
    if (accessibleIds.length === 0) {
      return res.json([]);
    }
    // Caregiver: filter by assigned seniors
    const allSeniors = await seniorService.list();
    const filtered = allSeniors.filter(s => accessibleIds.includes(s.id));
    res.json(filtered);
  } catch (error) {
    routeError(res, error, 'GET /api/seniors');
  }
});

// Get senior by ID
router.get('/api/seniors/:id', requireAuth, validateParams(seniorIdParamSchema), async (req, res) => {
  try {
    if (!await canAccessSenior(req.auth, req.params.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'senior',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    const senior = await seniorService.getById(req.params.id);
    if (!senior) {
      return sendError(res, 404, { error: 'Senior not found' });
    }
    res.json(senior);
  } catch (error) {
    routeError(res, error, 'GET /api/seniors/:id');
  }
});

// Update senior
router.patch('/api/seniors/:id', requireAuth, validateParams(seniorIdParamSchema), validateBody(updateSeniorSchema), idempotencyMiddleware, writeLimiter, async (req, res) => {
  try {
    if (!await canAccessSenior(req.auth, req.params.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'update',
      resourceType: 'senior',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { fields: Object.keys(req.body) },
    });
    const senior = await seniorService.update(req.params.id, req.body);
    res.json(senior);
  } catch (error) {
    routeError(res, error, 'PATCH /api/seniors/:id');
  }
});

// Get senior's call schedule
router.get('/api/seniors/:id/schedule', requireAuth, validateParams(seniorIdParamSchema), async (req, res) => {
  try {
    if (!await canAccessSenior(req.auth, req.params.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    const senior = await seniorService.getById(req.params.id);
    if (!senior) {
      return sendError(res, 404, { error: 'Senior not found' });
    }

    const schedule = senior.preferredCallTimes?.schedule || null;

    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'senior_schedule',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: {
        scheduleItems: Array.isArray(schedule) ? schedule.length : 0,
        topicsToAvoidCount: senior.preferredCallTimes?.topicsToAvoid?.length || 0,
      },
    });

    res.json({
      schedule,
      topicsToAvoid: senior.preferredCallTimes?.topicsToAvoid || [],
    });
  } catch (error) {
    routeError(res, error, 'GET /api/seniors/:id/schedule');
  }
});

// Update senior's call schedule
router.patch('/api/seniors/:id/schedule', requireAuth, validateParams(seniorIdParamSchema), validateBody(updateScheduleSchema), idempotencyMiddleware, writeLimiter, async (req, res) => {
  try {
    if (!await canAccessSenior(req.auth, req.params.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    const { schedule, topicsToAvoid } = req.body;
    const senior = await seniorService.getById(req.params.id);

    if (!senior) {
      return sendError(res, 404, { error: 'Senior not found' });
    }

    const updatedPreferredCallTimes = {
      ...senior.preferredCallTimes,
      schedule: schedule || senior.preferredCallTimes?.schedule,
      topicsToAvoid: topicsToAvoid || senior.preferredCallTimes?.topicsToAvoid || [],
    };

    const updated = await seniorService.update(req.params.id, {
      preferredCallTimes: updatedPreferredCallTimes,
    });

    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'update',
      resourceType: 'senior_schedule',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: {
        fields: Object.keys(req.body),
        scheduleItems: Array.isArray(schedule) ? schedule.length : undefined,
        topicsToAvoidCount: Array.isArray(topicsToAvoid) ? topicsToAvoid.length : undefined,
      },
    });

    res.json({
      schedule: updated.preferredCallTimes?.schedule,
      topicsToAvoid: updated.preferredCallTimes?.topicsToAvoid || [],
    });
  } catch (error) {
    // Use structured logger so error gets PII-sanitized and shipped to
    // the standard log sink (was console.error which bypasses both).
    log.error('Schedule update failed', {
      seniorId: req.params.id,
      error: error.message,
      code: error.code,
    });
    routeError(res, error, 'PATCH /api/seniors/:id/schedule');
  }
});

// Hard-delete a senior and all associated data
router.delete('/api/seniors/:id/data', requireAuth, validateParams(seniorIdParamSchema), idempotencyMiddleware, writeLimiter, async (req, res) => {
  try {
    if (!await canAccessSenior(req.auth, req.params.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    const senior = await seniorService.getById(req.params.id);
    if (!senior) {
      return sendError(res, 404, { error: 'Senior not found' });
    }

    const deletedBy = req.auth.userId || 'unknown';
    const reason = !req.auth.isAdmin && !req.auth.isCofounder ? 'caregiver_request' : 'admin_request';

    const counts = await seniorService.hardDelete(req.params.id, deletedBy, reason);
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'hard_delete',
      resourceType: 'senior',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { reason, deleted_counts: counts },
    });
    res.json({ success: true, deleted_counts: counts });
  } catch (error) {
    routeError(res, error, 'DELETE /api/seniors/:id/data');
  }
});

// Data export — HIPAA right-to-access (all data for a senior in one JSON bundle)
router.get('/api/seniors/:id/export', requireAuth, validateParams(seniorIdParamSchema), authLimiter, async (req, res) => {
  try {
    if (!await canAccessSenior(req.auth, req.params.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }

    const seniorId = req.params.id;

    const [
      senior,
      seniorConversations,
      seniorMemories,
      seniorReminders,
      seniorAnalyses,
      seniorDailyContext,
      seniorCaregiverLinks,
      seniorCallScheduleRows,
      seniorCallQueueRows,
      seniorCallAttemptRows,
      seniorPostCallJobRows,
      seniorOutboundCallGuardRows,
      seniorSchedulerShadowRows,
    ] = await Promise.all([
      seniorService.getById(seniorId),
      db.select({
        id: conversations.id,
        seniorId: conversations.seniorId,
        callSid: conversations.callSid,
        startedAt: conversations.startedAt,
        endedAt: conversations.endedAt,
        durationSeconds: conversations.durationSeconds,
        status: conversations.status,
        summary: conversations.summary,
        summaryEncrypted: conversations.summaryEncrypted,
        sentiment: conversations.sentiment,
        concerns: conversations.concerns,
        transcript: conversations.transcript,
        transcriptEncrypted: conversations.transcriptEncrypted,
        transcriptTextEncrypted: conversations.transcriptTextEncrypted,
        callMetrics: conversations.callMetrics,
      }).from(conversations)
        .where(eq(conversations.seniorId, seniorId))
        .orderBy(desc(conversations.startedAt)),
      db.select({
        id: memories.id,
        seniorId: memories.seniorId,
        type: memories.type,
        content: memories.content,
        contentEncrypted: memories.contentEncrypted,
        source: memories.source,
        importance: memories.importance,
        metadata: memories.metadata,
        createdAt: memories.createdAt,
        lastAccessedAt: memories.lastAccessedAt,
      }).from(memories)
        .where(eq(memories.seniorId, seniorId))
        .orderBy(desc(memories.createdAt)),
      db.select().from(reminders)
        .where(eq(reminders.seniorId, seniorId))
        .orderBy(desc(reminders.createdAt)),
      db.select().from(callAnalyses)
        .where(eq(callAnalyses.seniorId, seniorId))
        .orderBy(desc(callAnalyses.createdAt)),
      db.select().from(dailyCallContext)
        .where(eq(dailyCallContext.seniorId, seniorId))
        .orderBy(desc(dailyCallContext.callDate)),
      db.select({
        id: caregivers.id,
        clerkUserId: caregivers.clerkUserId,
        seniorId: caregivers.seniorId,
        role: caregivers.role,
        createdAt: caregivers.createdAt,
      }).from(caregivers)
        .where(eq(caregivers.seniorId, seniorId)),
      db.select().from(seniorCallSchedules)
        .where(eq(seniorCallSchedules.seniorId, seniorId))
        .orderBy(desc(seniorCallSchedules.createdAt)),
      db.select().from(callQueue)
        .where(eq(callQueue.seniorId, seniorId))
        .orderBy(desc(callQueue.createdAt)),
      db.select().from(callAttempts)
        .where(eq(callAttempts.seniorId, seniorId))
        .orderBy(desc(callAttempts.createdAt)),
      db.execute(sql`
        SELECT *
        FROM post_call_jobs
        WHERE senior_id = ${seniorId}
           OR conversation_id IN (SELECT id FROM conversations WHERE senior_id = ${seniorId})
        ORDER BY created_at DESC
      `).then(result => result.rows || []),
      db.select().from(outboundCallGuards)
        .where(eq(outboundCallGuards.seniorId, seniorId))
        .orderBy(desc(outboundCallGuards.createdAt)),
      db.select().from(schedulerShadowComparisons)
        .where(eq(schedulerShadowComparisons.seniorId, seniorId))
        .orderBy(desc(schedulerShadowComparisons.createdAt)),
    ]);

    if (!senior) {
      return sendError(res, 404, { error: 'Senior not found' });
    }

    await writeAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'export',
      resourceType: 'senior',
      resourceId: seniorId,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({
      exportedAt: new Date().toISOString(),
      senior,
      conversations: seniorConversations.map(decryptExportConversation),
      memories: seniorMemories.map(decryptExportMemory),
      reminders: seniorReminders.map(decryptReminderPhi),
      callAnalyses: seniorAnalyses.map(normalizeCallAnalysis).filter(Boolean),
      dailyContext: seniorDailyContext.map(decryptDailyContextPhi),
      caregiverLinks: seniorCaregiverLinks,
      callSchedules: seniorCallScheduleRows.map(decryptExportSeniorCallSchedule),
      callQueue: seniorCallQueueRows,
      callAttempts: seniorCallAttemptRows,
      postCallJobs: seniorPostCallJobRows.map(decryptExportPostCallJob),
      outboundCallGuards: seniorOutboundCallGuardRows,
      schedulerShadowComparisons: seniorSchedulerShadowRows,
    });
  } catch (error) {
    routeError(res, error, 'GET /api/seniors/:id/export');
  }
});

export default router;
