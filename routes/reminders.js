import { Router } from 'express';
import { db } from '../db/client.js';
import { reminders, reminderDeliveries, seniors } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  createReminderSchema,
  createReminderBatchSchema,
  updateReminderSchema,
  reminderIdParamSchema,
} from '../validators/schemas.js';
import { getAccessibleSeniorIds, canAccessSenior, routeError } from './helpers.js';
import { logAudit, authToRole } from '../services/audit.js';
import { seniorService } from '../services/seniors.js';
import { sendError } from '../lib/http-response.js';
import { getDatePartsInTimezone, resolveTimezoneFromProfile } from '../lib/timezone.js';
import { decryptReminderPhi, encryptReminderPhi } from '../lib/phi.js';

const router = Router();

function dailyCronFromScheduledTime(scheduledTime, senior) {
  if (!scheduledTime) return undefined;
  const date = new Date(scheduledTime);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = getDatePartsInTimezone(date, resolveTimezoneFromProfile(senior));
  return `${parts.minutes} ${parts.hours} * * *`;
}

function dateFromScheduledTime(scheduledTime) {
  if (!scheduledTime) return null;
  const date = new Date(scheduledTime);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getSeniorTimezoneProfile(seniorId) {
  const [senior] = await db.select({
    id: seniors.id,
    timezone: seniors.timezone,
    city: seniors.city,
    state: seniors.state,
    zipCode: seniors.zipCode,
  }).from(seniors).where(eq(seniors.id, seniorId)).limit(1);
  return senior || {};
}

// List all reminders with senior info (admins see all, caregivers see their seniors')
router.get('/api/reminders', requireAuth, async (req, res) => {
  try {
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'reminder',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    const accessibleIds = await getAccessibleSeniorIds(req.auth);
    let query = db.select({
      id: reminders.id,
      seniorId: reminders.seniorId,
      seniorName: seniors.name,
      type: reminders.type,
      title: reminders.title,
      titleEncrypted: reminders.titleEncrypted,
      description: reminders.description,
      descriptionEncrypted: reminders.descriptionEncrypted,
      scheduledTime: reminders.scheduledTime,
      isRecurring: reminders.isRecurring,
      cronExpression: reminders.cronExpression,
      isActive: reminders.isActive,
      lastDeliveredAt: reminders.lastDeliveredAt,
      createdAt: reminders.createdAt,
      createdVia: reminders.createdVia,
    })
    .from(reminders)
    .leftJoin(seniors, eq(reminders.seniorId, seniors.id))
    .where(eq(reminders.isActive, true))
    .orderBy(desc(reminders.createdAt));

    const result = (await query).map(decryptReminderPhi);
    if (accessibleIds === null) {
      return res.json(result); // Admin sees all
    }
    // Filter for caregiver
    const filtered = result.filter(r => accessibleIds.includes(r.seniorId));
    res.json(filtered);
  } catch (error) {
    routeError(res, error, 'GET /api/reminders');
  }
});

// Create a reminder
router.post('/api/reminders', requireAuth, validateBody(createReminderSchema), idempotencyMiddleware, writeLimiter, async (req, res) => {
  try {
    const { seniorId, type, title, description, scheduledTime, isRecurring, isActive, cronExpression, recurringDays } = req.body;
    // Check access to the senior
    if (!await canAccessSenior(req.auth, seniorId)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    const seniorProfile = await getSeniorTimezoneProfile(seniorId);
    const reminderCronExpression = cronExpression ||
      (isRecurring ? dailyCronFromScheduledTime(scheduledTime, seniorProfile) : undefined);
    const reminderScheduledTime = dateFromScheduledTime(scheduledTime);
    const [reminder] = await db.insert(reminders).values({
      ...encryptReminderPhi({ seniorId, type, title, description }),
      scheduledTime: reminderScheduledTime,
      isRecurring,
      isActive,
      deactivatedAt: isActive === false ? new Date() : null,
      cronExpression: reminderCronExpression,
      ...(recurringDays && { recurringDays }),
    }).returning();
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'create',
      resourceType: 'reminder',
      resourceId: reminder.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { seniorId, reminderType: type },
    });
    res.json(decryptReminderPhi(reminder));
  } catch (error) {
    routeError(res, error, 'POST /api/reminders');
  }
});

// Create reminders in batch (for chatbot proposals with many items)
router.post('/api/reminders/batch', requireAuth, validateBody(createReminderBatchSchema), writeLimiter, async (req, res) => {
  try {
    const { seniorId, reminders: reminderItems } = req.body;
    if (!await canAccessSenior(req.auth, seniorId)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    const seniorProfile = await getSeniorTimezoneProfile(seniorId);

    const values = reminderItems.map(item => {
      const cronExpression = item.isRecurring
        ? dailyCronFromScheduledTime(item.scheduledTime, seniorProfile)
        : undefined;
      return {
        ...encryptReminderPhi({ seniorId, type: item.type || 'custom', title: item.title, description: item.description }),
        scheduledTime: dateFromScheduledTime(item.scheduledTime),
        isRecurring: item.isRecurring || false,
        isActive: true,
        deactivatedAt: null,
        cronExpression,
        ...(item.recurringDays && { recurringDays: item.recurringDays }),
      };
    });

    const created = await db.insert(reminders).values(values).returning();

    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'create',
      resourceType: 'reminder',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { seniorId, count: created.length, batch: true },
    });

    res.json({ reminders: created.map(decryptReminderPhi) });
  } catch (error) {
    routeError(res, error, 'POST /api/reminders/batch');
  }
});

// Update a reminder
router.patch('/api/reminders/:id', requireAuth, validateParams(reminderIdParamSchema), validateBody(updateReminderSchema), idempotencyMiddleware, writeLimiter, async (req, res) => {
  try {
    // Get the reminder to check senior access
    const [existing] = await db.select({
      seniorId: reminders.seniorId,
      scheduledTime: reminders.scheduledTime,
      isRecurring: reminders.isRecurring,
    })
      .from(reminders).where(eq(reminders.id, req.params.id));
    if (!existing) {
      return sendError(res, 404, { error: 'Reminder not found' });
    }
    if (!await canAccessSenior(req.auth, existing.seniorId)) {
      return sendError(res, 403, { error: 'Access denied to this reminder' });
    }

    const { title, description, scheduledTime, isRecurring, cronExpression, isActive } = req.body;
    const updateData = {};
    if (title !== undefined || description !== undefined) {
      Object.assign(updateData, encryptReminderPhi({ title, description }));
      if (title === undefined) {
        delete updateData.title;
        delete updateData.titleEncrypted;
      }
      if (description === undefined) {
        delete updateData.description;
        delete updateData.descriptionEncrypted;
      }
    }
    if (scheduledTime !== undefined) updateData.scheduledTime = dateFromScheduledTime(scheduledTime);
    if (isRecurring !== undefined) updateData.isRecurring = isRecurring;
    if (cronExpression !== undefined) {
      updateData.cronExpression = cronExpression;
    } else {
      const nextIsRecurring = isRecurring !== undefined ? isRecurring : existing.isRecurring;
      const nextScheduledTime = scheduledTime !== undefined ? scheduledTime : existing.scheduledTime;
      if (nextIsRecurring && nextScheduledTime) {
        const seniorProfile = await getSeniorTimezoneProfile(existing.seniorId);
        const nextCronExpression = dailyCronFromScheduledTime(nextScheduledTime, seniorProfile);
        if (nextCronExpression) updateData.cronExpression = nextCronExpression;
      }
    }
    if (isActive !== undefined) {
      updateData.isActive = isActive;
      updateData.deactivatedAt = isActive ? null : new Date();
    }

    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'update',
      resourceType: 'reminder',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { fields: Object.keys(updateData) },
    });

    const [reminder] = await db.update(reminders)
      .set(updateData)
      .where(eq(reminders.id, req.params.id))
      .returning();
    res.json(decryptReminderPhi(reminder));
  } catch (error) {
    routeError(res, error, 'PATCH /api/reminders/:id');
  }
});

// Strip a deleted reminder ID from the senior's preferred_call_times.schedule.
// If a schedule item was created via voice and ends up with no remaining
// reminder, drop the whole item — caregiver-edited items are kept (the
// caregiver gets to decide whether the call still makes sense without it).
async function cleanupScheduleItemsForDeletedReminder(seniorId, reminderId) {
  const senior = await seniorService.getById(seniorId);
  const schedule = senior?.preferredCallTimes?.schedule;
  if (!Array.isArray(schedule) || schedule.length === 0) return;

  let changed = false;
  const updatedSchedule = [];
  for (const item of schedule) {
    if (!Array.isArray(item.reminderIds) || !item.reminderIds.includes(reminderId)) {
      updatedSchedule.push(item);
      continue;
    }
    const remaining = item.reminderIds.filter((id) => id !== reminderId);
    changed = true;
    if (remaining.length === 0 && item.createdVia === 'voice') continue;
    updatedSchedule.push({ ...item, reminderIds: remaining });
  }

  if (!changed) return;
  await seniorService.update(seniorId, {
    preferredCallTimes: { ...senior.preferredCallTimes, schedule: updatedSchedule },
  });
}

// Delete a reminder
router.delete('/api/reminders/:id', requireAuth, validateParams(reminderIdParamSchema), idempotencyMiddleware, writeLimiter, async (req, res) => {
  try {
    // Get the reminder to check senior access
    const [existing] = await db.select({ seniorId: reminders.seniorId })
      .from(reminders).where(eq(reminders.id, req.params.id));
    if (!existing) {
      return sendError(res, 404, { error: 'Reminder not found' });
    }
    if (!await canAccessSenior(req.auth, existing.seniorId)) {
      return sendError(res, 403, { error: 'Access denied to this reminder' });
    }

    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'delete',
      resourceType: 'reminder',
      resourceId: req.params.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    await db.delete(reminderDeliveries).where(eq(reminderDeliveries.reminderId, req.params.id));
    await db.delete(reminders).where(eq(reminders.id, req.params.id));
    await cleanupScheduleItemsForDeletedReminder(existing.seniorId, req.params.id);
    res.json({ success: true });
  } catch (error) {
    routeError(res, error, 'DELETE /api/reminders/:id');
  }
});

export default router;
