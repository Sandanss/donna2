import { db } from '../db/client.js';
import { reminders, seniors, reminderDeliveries, conversations, notificationPreferences, notifications, caregivers } from '../db/schema.js';
import { eq, and, lte, isNull, or, sql, ne, lt, gte, gt, desc } from 'drizzle-orm';
import { contextCacheService } from './context-cache.js';
import { runDailyPurgeIfNeeded } from './data-retention.js';
import { createLogger } from '../lib/logger.js';
import { decryptReminderPhi, decryptSeniorPhi, encryptReminderDeliveryPhi } from '../lib/phi.js';
import { resolveFlags, getValue } from '../lib/growthbook.js';
import {
  DEFAULT_TIMEZONE,
  getDatePartsInTimezone,
  parseDailyCronExpression,
  parseTimeString,
  resolveTimezoneFromProfile,
  zonedWallTimeToUtcDate,
} from '../lib/timezone.js';
import { initiateTelnyxOutboundCall, prewarmTelnyxOutboundContext } from './telnyx.js';

const log = createLogger('Scheduler');

// Retry Telnyx outbound requests with exponential backoff (3 attempts, 1s -> 2s -> 4s).
async function retryTelnyxCall(params, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await initiateTelnyxOutboundCall(params);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      log.warn('Telnyx call retry', { attempt, maxAttempts, delay_ms: delay, error: err.message });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Welfare check tracking — prevents calling the same senior twice per day
const welfareCalledToday = new Set();
let lastWelfareClearDate = new Date().toISOString().slice(0, 10);

// Schedule call tracking — prevents triggering the same schedule item twice per day
// Key format: "seniorId:scheduleItemId" or "seniorId:time-frequency" for items without id
const scheduleCalledToday = new Set();
let lastScheduleClearDate = new Date().toISOString().slice(0, 10);

// Per-senior cooldown — prevents any call to the same senior within 10 minutes of the last trigger.
// Maps seniorId → timestamp (ms) of last call trigger.
const seniorLastCallTime = new Map();

const REMINDER_PREWARM_TARGET_LEAD_MS = 2 * 60 * 1000;
const REMINDER_PREWARM_LOOKAHEAD_MS = REMINDER_PREWARM_TARGET_LEAD_MS + 60 * 1000;
const REMINDER_PREWARM_TTL_MS = 10 * 60 * 1000;
const REMINDER_PREWARM_MAX_CONCURRENCY = 5;
const REMINDER_PREWARM_SCHEDULE_TOLERANCE_MS = 60 * 1000;
const reminderPrewarmCache = new Map();

function coerceDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function reminderPrewarmKey(reminderId, scheduledFor) {
  const scheduledAt = coerceDate(scheduledFor);
  if (!reminderId || !scheduledAt) return null;
  return `${reminderId}:${scheduledAt.toISOString()}`;
}

function cleanupReminderPrewarmCache(nowMs = Date.now()) {
  let removed = 0;
  for (const [key, context] of reminderPrewarmCache.entries()) {
    const expiresAt = coerceDate(context?.expiresAt);
    const warmedAt = coerceDate(context?.warmedAt);
    const ttlExpired = warmedAt ? nowMs - warmedAt.getTime() > REMINDER_PREWARM_TTL_MS : true;
    if (!expiresAt || expiresAt.getTime() <= nowMs || ttlExpired) {
      reminderPrewarmCache.delete(key);
      removed++;
    }
  }
  return removed;
}

function datesWithinTolerance(a, b, toleranceMs = REMINDER_PREWARM_SCHEDULE_TOLERANCE_MS) {
  const left = coerceDate(a);
  const right = coerceDate(b);
  if (!left || !right) return false;
  return Math.abs(left.getTime() - right.getTime()) <= toleranceMs;
}

function isReminderPrewarmUsable(spec, prewarmedContext, now = new Date()) {
  if (!prewarmedContext || prewarmedContext.callType !== 'reminder') {
    return false;
  }
  if (!prewarmedContext.hydratedContext) {
    return false;
  }
  if (prewarmedContext.seniorId !== spec?.senior?.id) {
    return false;
  }
  if (prewarmedContext.reminderId !== spec?.reminder?.id) {
    return false;
  }
  if (!datesWithinTolerance(prewarmedContext.scheduledFor, spec?.scheduledFor)) {
    return false;
  }
  const expiresAt = coerceDate(prewarmedContext.expiresAt);
  return Boolean(expiresAt && expiresAt.getTime() > now.getTime());
}

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const current = items[cursor];
      cursor += 1;
      await worker(current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(workers);
}

/**
 * Check if a senior's local time is within the acceptable call window.
 * Default window: 9 AM – 7 PM.
 * If a caregiver explicitly scheduled a reminder in the 5–9 AM range,
 * the early-morning window opens to allow it (earlyAllowed = true).
 */
function isInCallWindow(timezone, { earlyAllowed = false } = {}) {
  try {
    const now = new Date();
    const localHour = parseInt(
      now.toLocaleString('en-US', { timeZone: timezone || DEFAULT_TIMEZONE, hour: 'numeric', hour12: false })
    );
    const earliest = earlyAllowed ? 5 : 9;
    return localHour >= earliest && localHour < 19;
  } catch {
    return true; // Default to allowing if timezone is invalid
  }
}

function getSeniorTimezone(senior) {
  return resolveTimezoneFromProfile(senior || {});
}

function minutesSinceMidnight({ hours, minutes }) {
  return hours * 60 + minutes;
}

function minutesApart(a, b) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 24 * 60 - diff);
}

export function getReminderWallTime(reminder, senior) {
  const cronTime = reminder.isRecurring
    ? parseDailyCronExpression(reminder.cronExpression)
    : null;
  if (cronTime) return cronTime;
  if (!reminder.scheduledTime) return null;

  const scheduled = new Date(reminder.scheduledTime);
  if (Number.isNaN(scheduled.getTime())) return null;
  return getDatePartsInTimezone(scheduled, getSeniorTimezone(senior));
}

export function getScheduledForTimeInTimezone(reminder, senior, now = new Date()) {
  if (!reminder.scheduledTime && !reminder.cronExpression) return null;

  if (reminder.isRecurring) {
    const wallTime = getReminderWallTime(reminder, senior);
    if (!wallTime) return null;
    const timezone = getSeniorTimezone(senior);
    const localToday = getDatePartsInTimezone(now, timezone);
    return zonedWallTimeToUtcDate({
      year: localToday.year,
      month: localToday.month,
      day: localToday.day,
      hours: wallTime.hours,
      minutes: wallTime.minutes,
    }, timezone);
  }

  const scheduled = new Date(reminder.scheduledTime);
  return Number.isNaN(scheduled.getTime()) ? null : scheduled;
}

function isRecurringReminderDueNow(reminder, senior, now) {
  const wallTime = getReminderWallTime(reminder, senior);
  if (!wallTime) return false;

  const nowLocal = getDatePartsInTimezone(now, getSeniorTimezone(senior));
  return minutesApart(
    minutesSinceMidnight(wallTime),
    minutesSinceMidnight(nowLocal)
  ) <= 5;
}

export const schedulerService = {
  /**
   * Calculate the "scheduled for" time for a reminder instance.
   * For recurring reminders, this is today's date with the scheduled time.
   * For non-recurring, it's just the scheduled time.
   */
  getScheduledForTime(reminder, senior, now = new Date()) {
    return getScheduledForTimeInTimezone(reminder, senior, now);
  },

  clearReminderPrewarmCache() {
    reminderPrewarmCache.clear();
  },

  getReminderPrewarmStats() {
    cleanupReminderPrewarmCache();
    return { total: reminderPrewarmCache.size };
  },

  getReminderPrewarm(spec, now = new Date()) {
    cleanupReminderPrewarmCache(now.getTime());
    const key = reminderPrewarmKey(spec?.reminder?.id, spec?.scheduledFor);
    if (!key) return null;

    const prewarmedContext = reminderPrewarmCache.get(key);
    if (!isReminderPrewarmUsable(spec, prewarmedContext, now)) {
      if (prewarmedContext) reminderPrewarmCache.delete(key);
      return null;
    }
    return prewarmedContext;
  },

  async _findReminderDeliveryByStatuses(reminderId, scheduledFor, statuses) {
    const rows = await db.select()
      .from(reminderDeliveries)
      .where(and(
        eq(reminderDeliveries.reminderId, reminderId),
        sql`${reminderDeliveries.scheduledFor} BETWEEN ${new Date(scheduledFor.getTime() - 5 * 60 * 1000)} AND ${new Date(scheduledFor.getTime() + 5 * 60 * 1000)}`,
        or(...statuses.map(status => eq(reminderDeliveries.status, status)))
      ))
      .limit(1);
    return rows[0] || null;
  },

  async getReminderPrewarmCandidates(now = new Date(), lookaheadMs = REMINDER_PREWARM_LOOKAHEAD_MS) {
    cleanupReminderPrewarmCache(now.getTime());

    const dueCutoff = new Date(now.getTime() + 60 * 1000);
    const horizon = new Date(now.getTime() + lookaheadMs);

    const nonRecurring = (await db.select({
      reminder: reminders,
      senior: seniors
    })
      .from(reminders)
      .innerJoin(seniors, eq(reminders.seniorId, seniors.id))
      .where(and(
        eq(reminders.isActive, true),
        eq(reminders.isRecurring, false),
        gt(reminders.scheduledTime, dueCutoff),
        lte(reminders.scheduledTime, horizon),
        eq(seniors.isActive, true)
      ))).map(({ reminder, senior }) => ({
        type: 'reminder',
        reminder: decryptReminderPhi(reminder),
        senior: decryptSeniorPhi(senior),
      }));

    const recurring = (await db.select({
      reminder: reminders,
      senior: seniors
    })
      .from(reminders)
      .innerJoin(seniors, eq(reminders.seniorId, seniors.id))
      .where(and(
        eq(reminders.isActive, true),
        eq(reminders.isRecurring, true),
        eq(seniors.isActive, true)
      ))).map(({ reminder, senior }) => ({
        type: 'reminder',
        reminder: decryptReminderPhi(reminder),
        senior: decryptSeniorPhi(senior),
      }));

    const recurringSoon = recurring
      .map(candidate => ({
        ...candidate,
        scheduledFor: this.getScheduledForTime(candidate.reminder, candidate.senior, now),
      }))
      .filter(candidate => {
        const scheduledAt = coerceDate(candidate.scheduledFor);
        return Boolean(
          scheduledAt &&
          scheduledAt.getTime() > dueCutoff.getTime() &&
          scheduledAt.getTime() <= horizon.getTime()
        );
      });

    const candidates = [];
    for (const candidate of [...nonRecurring, ...recurringSoon]) {
      const scheduledFor = candidate.scheduledFor || this.getScheduledForTime(candidate.reminder, candidate.senior, now);
      if (!scheduledFor) continue;

      const spec = { ...candidate, scheduledFor };
      if (this.getReminderPrewarm(spec, now)) continue;

      const completedDelivery = await this._findReminderDeliveryByStatuses(
        candidate.reminder.id,
        scheduledFor,
        ['acknowledged', 'confirmed', 'max_attempts'],
      );
      if (completedDelivery) continue;

      const pendingDelivery = await this._findReminderDeliveryByStatuses(
        candidate.reminder.id,
        scheduledFor,
        ['delivered', 'retry_pending'],
      );
      if (pendingDelivery) continue;

      candidates.push(spec);
    }

    return candidates;
  },

  async prewarmReminderCalls(specs, baseUrl) {
    cleanupReminderPrewarmCache();

    const reminderSpecs = specs.filter(spec =>
      spec?.type === 'reminder' &&
      spec?.reminder?.id &&
      spec?.senior?.id &&
      coerceDate(spec?.scheduledFor)
    );
    if (reminderSpecs.length === 0) {
      return { attempted: 0, warmed: 0, cacheHits: 0, failed: 0 };
    }

    let warmed = 0;
    let cacheHits = 0;
    let failed = 0;

    await runWithConcurrency(reminderSpecs, REMINDER_PREWARM_MAX_CONCURRENCY, async (spec) => {
      if (this.getReminderPrewarm(spec)) {
        cacheHits++;
        return;
      }

      try {
        const response = await prewarmTelnyxOutboundContext({
          seniorId: spec.senior.id,
          callType: 'reminder',
          reminderId: spec.reminder.id,
          scheduledFor: coerceDate(spec.scheduledFor)?.toISOString(),
          baseUrl,
        });
        const prewarmedContext = response?.prewarmedContext;
        if (!isReminderPrewarmUsable(spec, prewarmedContext)) {
          failed++;
          return;
        }

        const key = reminderPrewarmKey(spec.reminder.id, spec.scheduledFor);
        if (key) {
          reminderPrewarmCache.set(key, prewarmedContext);
        }
        warmed++;
      } catch (error) {
        failed++;
        log.warn('Reminder prewarm failed', {
          seniorId: spec.senior.id,
          reminderId: spec.reminder.id,
          error: error.message,
        });
      }
    });

    if (warmed > 0 || failed > 0) {
      log.info('Reminder prewarm sweep', {
        attempted: reminderSpecs.length,
        warmed,
        cacheHits,
        failed,
      });
    }

    return { attempted: reminderSpecs.length, warmed, cacheHits, failed };
  },

  /**
   * Find reminders that are due now
   * - scheduledTime is in the past or within next minute
   * - No acknowledged/confirmed delivery for this scheduled instance
   * - Also includes retry_pending deliveries that are ready for retry
   */
  async getDueReminders() {
    const now = new Date();
    const oneMinuteFromNow = new Date(now.getTime() + 60 * 1000);
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Find non-recurring reminders due now
    const nonRecurring = (await db.select({
      reminder: reminders,
      senior: seniors
    })
      .from(reminders)
      .innerJoin(seniors, eq(reminders.seniorId, seniors.id))
      .where(and(
        eq(reminders.isActive, true),
        eq(reminders.isRecurring, false),
        lte(reminders.scheduledTime, oneMinuteFromNow),
        eq(seniors.isActive, true)
      ))).map(({ reminder, senior }) => ({
        reminder: decryptReminderPhi(reminder),
        senior: decryptSeniorPhi(senior),
      }));

    // Find recurring reminders where scheduled time-of-day matches now
    const recurring = (await db.select({
      reminder: reminders,
      senior: seniors
    })
      .from(reminders)
      .innerJoin(seniors, eq(reminders.seniorId, seniors.id))
      .where(and(
        eq(reminders.isActive, true),
        eq(reminders.isRecurring, true),
        eq(seniors.isActive, true)
      ))).map(({ reminder, senior }) => ({
        reminder: decryptReminderPhi(reminder),
        senior: decryptSeniorPhi(senior),
      }));

    // Filter recurring to those whose time-of-day matches now (within 5 min window)
    const recurringDue = recurring.filter(r => isRecurringReminderDueNow(r.reminder, r.senior, now));

    const allCandidates = [...nonRecurring, ...recurringDue];

    // Filter out reminders that already have acknowledged/confirmed delivery for this instance
    const dueReminders = [];
    for (const candidate of allCandidates) {
      const scheduledFor = this.getScheduledForTime(candidate.reminder, candidate.senior, now);
      if (!scheduledFor) continue;

      const existingDelivery = await this._findReminderDeliveryByStatuses(
        candidate.reminder.id,
        scheduledFor,
        ['acknowledged', 'confirmed', 'max_attempts'],
      );
      if (existingDelivery) continue;

      const pendingDelivery = await this._findReminderDeliveryByStatuses(
        candidate.reminder.id,
        scheduledFor,
        ['delivered', 'retry_pending'],
      );
      if (pendingDelivery) continue;

      // No delivery yet for this instance - it's due
      dueReminders.push({ ...candidate, scheduledFor });
    }

    // Also find retry_pending deliveries that are ready for retry (>30 min since last attempt)
    const retriesReady = await db.select({
      delivery: reminderDeliveries,
      reminder: reminders,
      senior: seniors
    })
      .from(reminderDeliveries)
      .innerJoin(reminders, eq(reminderDeliveries.reminderId, reminders.id))
      .innerJoin(seniors, eq(reminders.seniorId, seniors.id))
      .where(and(
        eq(reminderDeliveries.status, 'retry_pending'),
        lt(reminderDeliveries.deliveredAt, thirtyMinutesAgo),
        eq(reminders.isActive, true),
        eq(seniors.isActive, true)
      ));

    // Add retries to due reminders with their delivery record
    for (const retry of retriesReady) {
      dueReminders.push({
        reminder: decryptReminderPhi(retry.reminder),
        senior: decryptSeniorPhi(retry.senior),
        scheduledFor: retry.delivery.scheduledFor,
        existingDelivery: retry.delivery // Include the delivery record for update
      });
    }

    return dueReminders;
  },

  /**
   * Merge due scheduled calls and welfare-eligible seniors into a deduplicated call plan.
   * Scheduled calls take priority — if a senior has a scheduled call and needs welfare,
   * only the scheduled call fires (it counts as contact).
   * Returns an array of CallSpec objects: { type, senior, scheduleItem?, pendingReminders?, dedupKey? }
   */
  buildCallPlan(dueScheduledCalls, welfareSeniors) {
    const specs = [];
    const seniorIdsWithSchedule = new Set();

    // Scheduled call specs first (higher priority)
    for (const { senior, scheduleItem, dedupKey, pendingReminders } of dueScheduledCalls) {
      // Only one call per senior per cycle even if multiple schedule items match
      if (seniorIdsWithSchedule.has(senior.id)) continue;

      specs.push({
        type: 'schedule',
        senior,
        scheduleItem,
        dedupKey,
        pendingReminders,
      });
      seniorIdsWithSchedule.add(senior.id);
    }

    // Welfare specs — skip seniors already getting a scheduled call or already called today
    for (const senior of welfareSeniors) {
      if (seniorIdsWithSchedule.has(senior.id)) continue;
      if (welfareCalledToday.has(senior.id)) continue;

      specs.push({
        type: 'welfare',
        senior
      });
    }

    return specs;
  },

  /**
   * Unified outbound call trigger for both reminder and welfare calls.
   * Gates ALL calls through isInCallWindow(). Handles context prefetch,
   * Telnyx call creation, and type-specific bookkeeping.
   */
  async triggerOutboundCall(spec, baseUrl) {
    const { type, senior } = spec;

    // Scheduled calls bypass the call window — the caregiver explicitly chose that time.
    // Welfare calls are gated through the default 9 AM – 7 PM window.
    if (type !== 'schedule') {
      const timezone = getSeniorTimezone(senior);
      if (!isInCallWindow(timezone)) {
        log.info('Outside call window, skipping', { type, name: senior.name, timezone });
        return null;
      }
    }

    try {
      if (type === 'schedule') {
        return await this._triggerSchedulePath(spec, baseUrl);
      } else {
        return await this._triggerWelfarePath(spec, baseUrl);
      }
    } catch (error) {
      log.error('Failed to initiate call', { type, name: senior.name, error: error.message });
      return null;
    }
  },

  /**
   * Scheduled call path: create a Telnyx call through Pipecat.
   * Passes pending reminders as context so Donna can mention them during the call.
   */
  async _triggerSchedulePath(spec, baseUrl) {
    const { senior, scheduleItem, pendingReminders } = spec;

    const reminderIds = (pendingReminders || []).map(r => r.id);
    log.info('Triggering Telnyx scheduled call', {
      seniorId: senior.id,
      scheduleTime: scheduleItem.time,
      pendingReminders: reminderIds.length,
    });

    const call = await retryTelnyxCall({
      seniorId: senior.id,
      callType: 'schedule',
      reminderIds,
      contextNotes: scheduleItem.contextNotes || null,
      baseUrl,
    });

    log.info('Scheduled call initiated', { callSid: call.callSid, seniorId: senior.id });
    return { sid: call.callSid, callSid: call.callSid, callControlId: call.callControlId };
  },

  /**
   * Welfare call path: create a Telnyx call through Pipecat.
   * Pipecat hydrates context on the voice service side.
   */
  async _triggerWelfarePath(spec, baseUrl) {
    const { senior } = spec;

    log.info('Triggering Telnyx welfare call', { seniorId: senior.id });

    const call = await retryTelnyxCall({
      seniorId: senior.id,
      callType: 'check-in',
      baseUrl,
    });

    log.info('Welfare check call initiated', { callSid: call.callSid, seniorId: senior.id });
    return { sid: call.callSid, callSid: call.callSid, callControlId: call.callControlId };
  },

  /**
   * Mark a reminder as delivered (legacy - updates lastDeliveredAt on reminder)
   */
  async markDelivered(reminderId) {
    await db.update(reminders)
      .set({ lastDeliveredAt: new Date() })
      .where(eq(reminders.id, reminderId));

    log.info('Marked reminder as delivered', { reminderId });
  },

  /**
   * Mark a reminder delivery as acknowledged or confirmed
   * Called when user says "okay I'll take it" or "I already took it"
   */
  async markReminderAcknowledged(deliveryId, status, userResponse) {
    if (!deliveryId) {
      log.error('No delivery ID provided for acknowledgment');
      return null;
    }

    const validStatuses = ['acknowledged', 'confirmed'];
    if (!validStatuses.includes(status)) {
      log.error('Invalid status', { status });
      return null;
    }

    try {
      const [updated] = await db.update(reminderDeliveries)
        .set(encryptReminderDeliveryPhi({
          status,
          acknowledgedAt: new Date(),
          userResponse
        }))
        .where(eq(reminderDeliveries.id, deliveryId))
        .returning();

      log.info('Reminder delivery marked', { deliveryId, status });
      return updated;
    } catch (error) {
      log.error('Failed to mark acknowledgment', { error: error.message });
      return null;
    }
  },

  /**
   * Handle call end without acknowledgment - set up retry or mark as max_attempts
   * Called when a call completes without the user acknowledging the reminder
   */
  async markCallEndedWithoutAcknowledgment(deliveryId) {
    if (!deliveryId) return;

    try {
      // Get current delivery record
      const [delivery] = await db.select()
        .from(reminderDeliveries)
        .where(eq(reminderDeliveries.id, deliveryId))
        .limit(1);

      if (!delivery) {
        log.info('Delivery not found', { deliveryId });
        return;
      }

      // If already acknowledged/confirmed, don't change
      if (delivery.status === 'acknowledged' || delivery.status === 'confirmed') {
        log.info('Delivery already handled, skipping', { deliveryId, status: delivery.status });
        return;
      }

      // Determine new status based on attempt count
      const newStatus = delivery.attemptCount >= 2 ? 'max_attempts' : 'retry_pending';

      await db.update(reminderDeliveries)
        .set({ status: newStatus })
        .where(eq(reminderDeliveries.id, deliveryId));

      log.info('Delivery status updated', { deliveryId, status: newStatus, attempt: delivery.attemptCount });

      // Trigger reminder_missed notification when max attempts reached
      if (newStatus === 'max_attempts') {
        try {
          const [reminder] = await db.select()
            .from(reminders)
            .where(eq(reminders.id, delivery.reminderId))
            .limit(1);
          if (reminder) {
            const decryptedReminder = decryptReminderPhi(reminder);
            const { notificationService } = await import('./notifications.js');
            await notificationService.onReminderMissed(decryptedReminder.seniorId, {
              reminderTitle: decryptedReminder.title,
              reminderType: decryptedReminder.type,
              attemptCount: delivery.attemptCount,
            });
          }
        } catch (notifErr) {
          log.error('Failed to send reminder_missed notification', { error: notifErr.message });
        }
      }
    } catch (error) {
      log.error('Failed to update delivery status', { error: error.message });
    }
  },

  /**
   * Find scheduled calls that are due now based on seniors' preferredCallTimes.schedule.
   * Schedule items drive outbound calls; reminders are informational context only.
   */
  async getDueScheduledCalls() {
    const now = new Date();

    // Load all active seniors with their schedule
    const results = await db.execute(sql`
      SELECT s.id, s.name, s.phone, s.timezone, s.interests,
             s.family_info AS "familyInfo",
             s.family_info_encrypted AS "familyInfoEncrypted",
             s.medical_notes AS "medicalNotes",
             s.medical_notes_encrypted AS "medicalNotesEncrypted",
             s.preferred_call_times AS "preferredCallTimes",
             s.preferred_call_times_encrypted AS "preferredCallTimesEncrypted",
             s.is_active AS "isActive",
             s.city, s.state, s.zip_code AS "zipCode",
             s.additional_info AS "additionalInfo",
             s.additional_info_encrypted AS "additionalInfoEncrypted",
             s.call_context_snapshot AS "callContextSnapshot",
             s.call_context_snapshot_encrypted AS "callContextSnapshotEncrypted"
      FROM seniors s
      WHERE s.is_active = true
    `);
    const allSeniors = (results.rows || []).map(decryptSeniorPhi);

    const dueScheduleCalls = [];

    if (allSeniors.length > 0) {
      log.info('Checking schedules', { seniors: allSeniors.length });
    }

    for (const senior of allSeniors) {
      const schedule = senior.preferredCallTimes?.schedule;
      if (!Array.isArray(schedule) || schedule.length === 0) continue;

      const timezone = getSeniorTimezone(senior);
      const nowLocal = getDatePartsInTimezone(now, timezone);
      // Reconstruct a Date in the senior's local wall-clock to get reliable day-of-week
      const nowDayOfWeek = new Date(nowLocal.year, nowLocal.month - 1, nowLocal.day).getDay();

      log.info('Evaluating schedule', {
        senior: senior.name,
        timezone,
        nowLocal: `${nowLocal.hours}:${String(nowLocal.minutes).padStart(2, '0')}`,
        dayOfWeek: nowDayOfWeek,
        items: schedule.length,
      });

      for (const item of schedule) {
        // Check frequency match
        if (item.frequency === 'recurring') {
          if (!item.recurringDays?.includes(nowDayOfWeek)) {
            log.info('Schedule item skipped (wrong day)', { title: item.title, time: item.time, recurringDays: item.recurringDays, today: nowDayOfWeek });
            continue;
          }
        } else if (item.frequency === 'one-time') {
          if (!item.date) continue;
          const itemDate = new Date(item.date);
          const itemLocal = getDatePartsInTimezone(itemDate, timezone);
          if (itemLocal.year !== nowLocal.year || itemLocal.month !== nowLocal.month || itemLocal.day !== nowLocal.day) {
            log.info('Schedule item skipped (wrong date)', { title: item.title, itemDate: item.date });
            continue;
          }
        }
        // frequency === 'daily' always matches

        // Check time match — only trigger AT or AFTER the scheduled time, within a 3-minute window.
        // nowMinutes - schedMinutes > 0 means we're past the scheduled time.
        const wallTime = parseTimeString(item.time);
        if (!wallTime) {
          log.warn('Schedule item skipped (invalid time)', { title: item.title, time: item.time });
          continue;
        }

        const nowMinutes = minutesSinceMidnight(nowLocal);
        const schedMinutes = minutesSinceMidnight(wallTime);
        const minutesPast = nowMinutes - schedMinutes;
        if (minutesPast < 0 || minutesPast > 3) {
          log.info('Schedule item not due', { title: item.title, time: item.time, minutes_past: minutesPast });
          continue;
        }

        // Dedup: skip if already called for this schedule item today
        const dedupKey = `${senior.id}:${item.id || `${item.time}-${item.frequency}`}`;
        if (scheduleCalledToday.has(dedupKey)) continue;

        // Per-senior cooldown: skip if a call was triggered for this senior recently (10 min)
        const lastCall = seniorLastCallTime.get(senior.id);
        if (lastCall && (now.getTime() - lastCall) < 10 * 60 * 1000) {
          log.info('Schedule item skipped (senior cooldown)', { seniorId: senior.id, title: item.title, cooldown_remaining_s: Math.round((10 * 60 * 1000 - (now.getTime() - lastCall)) / 1000) });
          continue;
        }

        // Gather pending reminders for this senior (active reminders whose event is today)
        const seniorReminders = await this._getPendingRemindersForSenior(senior.id, timezone, now, item.reminderIds);

        dueScheduleCalls.push({
          senior,
          scheduleItem: item,
          dedupKey,
          pendingReminders: seniorReminders,
        });
      }
    }

    return dueScheduleCalls;
  },

  /**
   * Get active reminders for a senior that are relevant for today's call.
   * If reminderIds are specified on the schedule item, use those.
   * Otherwise, return all active reminders for today.
   */
  async _getPendingRemindersForSenior(seniorId, timezone, now, linkedReminderIds) {
    const allReminders = (await db.select()
      .from(reminders)
      .where(and(
        eq(reminders.seniorId, seniorId),
        eq(reminders.isActive, true),
      ))).map(decryptReminderPhi);

    if (!allReminders.length) return [];

    // If the schedule item links specific reminders, filter to those
    if (linkedReminderIds?.length) {
      const linked = allReminders.filter(r => linkedReminderIds.includes(r.id));
      if (linked.length) return linked;
    }

    // Otherwise return all active reminders (Donna will mention them naturally)
    return allReminders;
  },

  /**
   * Find active seniors who haven't had a completed conversation in 2+ days.
   * These seniors need a welfare check call.
   */
  async getSeniorsNeedingWelfareCheck() {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const results = await db.execute(sql`
      SELECT s.id, s.name, s.phone, s.timezone, s.interests,
             s.family_info AS "familyInfo",
             s.family_info_encrypted AS "familyInfoEncrypted",
             s.medical_notes AS "medicalNotes",
             s.medical_notes_encrypted AS "medicalNotesEncrypted",
             s.preferred_call_times AS "preferredCallTimes",
             s.preferred_call_times_encrypted AS "preferredCallTimesEncrypted",
             s.is_active AS "isActive",
             s.city, s.state, s.zip_code AS "zipCode",
             s.additional_info AS "additionalInfo",
             s.additional_info_encrypted AS "additionalInfoEncrypted",
             s.call_context_snapshot AS "callContextSnapshot",
             s.call_context_snapshot_encrypted AS "callContextSnapshotEncrypted"
      FROM seniors s
      WHERE s.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.senior_id = s.id
        AND c.status = 'completed'
        AND c.started_at > ${twoDaysAgo}
      )
    `);
    return (results.rows || []).map(decryptSeniorPhi);
  }
};

/**
 * Start the unified scheduler polling loop.
 * Single 60-second loop handles both reminders and welfare checks.
 * Welfare SQL is cheap (NOT EXISTS), so running every minute means
 * newly-eligible seniors get called within ~1 minute instead of ~59.
 */
// Advisory lock ID for scheduler leader election (matches Python scheduler)
const SCHEDULER_LOCK_ID = 8675309;

async function tryAcquireLeaderLock() {
  try {
    const result = await db.execute(
      sql`SELECT pg_try_advisory_lock(${SCHEDULER_LOCK_ID}) AS acquired`
    );
    return result.rows?.[0]?.acquired === true;
  } catch (err) {
    log.warn('Failed to acquire scheduler lock', { error: err.message });
    return false;
  }
}

export function startScheduler(baseUrl, intervalMs = 60000) {
  log.info('Starting unified scheduler', { intervalSeconds: intervalMs / 1000 });
  let isLeader = false;

  const runUnifiedCheck = async () => {
    const cycleStart = Date.now();
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    try {
      // Date-rollover clear of tracking sets
      const today = new Date().toISOString().slice(0, 10);
      if (today !== lastWelfareClearDate) {
        welfareCalledToday.clear();
        lastWelfareClearDate = today;
        log.info('Welfare tracking cleared for new day', { date: today });
      }
      if (today !== lastScheduleClearDate) {
        scheduleCalledToday.clear();
        lastScheduleClearDate = today;
        log.info('Schedule tracking cleared for new day', { date: today });
      }

      // Fetch both sources in parallel
      let [dueScheduledCalls, welfareSeniors] = await Promise.all([
        schedulerService.getDueScheduledCalls(),
        schedulerService.getSeniorsNeedingWelfareCheck(),
      ]);

      // Filter out seniors whose caregiver has paused calls
      const pausedResult = await db.execute(sql`
        SELECT DISTINCT c.senior_id AS "seniorId"
        FROM caregivers c
        JOIN notification_preferences np ON np.caregiver_id = c.id
        WHERE np.pause_calls = true
      `);
      const pausedSeniorIds = new Set((pausedResult.rows || []).map(r => r.seniorId));

      if (pausedSeniorIds.size > 0) {
        dueScheduledCalls = dueScheduledCalls.filter(s => !pausedSeniorIds.has(s.senior.id));
        welfareSeniors = welfareSeniors.filter(s => !pausedSeniorIds.has(s.id));
        log.info('Filtered paused seniors', { count: pausedSeniorIds.size });
      }

      // Merge and deduplicate into a single call plan
      const callPlan = schedulerService.buildCallPlan(dueScheduledCalls, welfareSeniors);

      if (callPlan.length > 0) {
        const scheduleCount = callPlan.filter(s => s.type === 'schedule').length;
        const welfareCount = callPlan.filter(s => s.type === 'welfare').length;
        log.info('Unified call plan', { total: callPlan.length, scheduled: scheduleCount, welfare: welfareCount });
      }

      // Resolve flags once per scheduler cycle
      const flags = await resolveFlags({ source: 'scheduler' });

      // Execute calls in parallel with concurrency limit of 10
      attempted = callPlan.length;
      const CONCURRENCY = 10;
      let inFlight = 0;

      const triggerOne = async (spec) => {
        // Simple semaphore: wait until slot available
        while (inFlight >= CONCURRENCY) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        inFlight++;

        // Mark dedup BEFORE triggering to prevent duplicate calls if the next
        // polling cycle runs while this call is still being initiated.
        if (spec.type === 'schedule') {
          scheduleCalledToday.add(spec.dedupKey);
          seniorLastCallTime.set(spec.senior.id, Date.now());
        } else {
          welfareCalledToday.add(spec.senior.id);
          seniorLastCallTime.set(spec.senior.id, Date.now());
        }

        try {
          const call = await schedulerService.triggerOutboundCall(spec, baseUrl);
          if (call) {
            succeeded++;
          } else {
            // Trigger returned null — revert dedup so it can be retried next cycle
            if (spec.type === 'schedule') {
              scheduleCalledToday.delete(spec.dedupKey);
            } else {
              welfareCalledToday.delete(spec.senior.id);
            }
            seniorLastCallTime.delete(spec.senior.id);
            failed++;
          }
        } catch (err) {
          log.error('Trigger failed', { type: spec.type, error: err.message });
          // Revert dedup on failure so it can be retried next cycle
          if (spec.type === 'schedule') {
            scheduleCalledToday.delete(spec.dedupKey);
          } else {
            welfareCalledToday.delete(spec.senior.id);
          }
          seniorLastCallTime.delete(spec.senior.id);
          failed++;
        } finally {
          inFlight--;
        }
      };

      const results = await Promise.allSettled(callPlan.map(triggerOne));

      if (succeeded > 0) {
        log.info('Unified check complete', { succeeded, failed, planned: callPlan.length });
      }
    } catch (error) {
      log.error('Unified check error', { error: error.message });
      try { const Sentry = await import('@sentry/node'); Sentry.captureException(error); } catch {}
    } finally {
      const cycleDurationMs = Date.now() - cycleStart;
      if (attempted > 0 || cycleDurationMs > 5000) {
        log.info('Scheduler cycle', {
          duration_ms: cycleDurationMs,
          attempted,
          succeeded,
          failed,
        });
      }
    }
  };

  // Leader election wrapper — only the leader runs the unified check
  const leaderCheck = async () => {
    if (!isLeader) {
      isLeader = await tryAcquireLeaderLock();
      if (isLeader) {
        log.info('Acquired scheduler leader lock — this instance is the scheduler leader');
      }
    }
    if (isLeader) {
      await runUnifiedCheck();
    }
  };

  // Initial check after 5s delay (let server warm up)
  setTimeout(leaderCheck, 5000);

  // Single 60-second polling loop for both reminders and welfare
  const schedulerIntervalId = setInterval(leaderCheck, intervalMs);

  // Hourly context pre-caching (unchanged)
  const prefetchIntervalId = setInterval(async () => {
    try {
      await contextCacheService.runDailyPrefetch();
    } catch (error) {
      log.error('Context pre-fetch error', { error: error.message });
      try { const Sentry = await import('@sentry/node'); Sentry.captureException(error); } catch {}
    }
  }, 60 * 60 * 1000);

  // Run initial pre-fetch check
  contextCacheService.runDailyPrefetch().catch(err => {
    log.error('Initial pre-fetch error', { error: err.message });
    try { import('@sentry/node').then(Sentry => Sentry.captureException(err)); } catch {}
  });

  log.info('Context pre-caching enabled (hourly check for 5 AM local time)');
  log.info('Unified scheduler ready (scheduled calls + welfare every 60s)');

  // Weekly report polling (hourly check)
  const checkWeeklyReports = async () => {
    try {
      // Get all preferences where weekly summary is enabled
      const prefs = await db.select()
        .from(notificationPreferences)
        .where(eq(notificationPreferences.weeklySummary, true));

      for (const pref of prefs) {
        const tz = pref.timezone || 'America/New_York';
        const now = new Date();

        // Get current day/time in caregiver's timezone
        const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
        const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

        const dayStr = dayFormatter.format(now);
        const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const currentDay = dayMap[dayStr] ?? -1;

        if (currentDay !== pref.weeklyReportDay) continue;

        // Check if current time is within 30min of report time
        const timeParts = hourFormatter.formatToParts(now);
        const currentHour = parseInt(timeParts.find(p => p.type === 'hour').value);
        const currentMinute = parseInt(timeParts.find(p => p.type === 'minute').value);
        const currentMinutes = currentHour * 60 + currentMinute;

        const [reportH, reportM] = (pref.weeklyReportTime || '09:00').split(':').map(Number);
        const reportMinutes = reportH * 60 + reportM;

        if (Math.abs(currentMinutes - reportMinutes) > 30) continue;

        // Check if we already sent a weekly report in the last 6 days for this caregiver
        const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
        const [recentReport] = await db.select({ id: notifications.id })
          .from(notifications)
          .where(and(
            eq(notifications.caregiverId, pref.caregiverId),
            eq(notifications.eventType, 'weekly_summary'),
            gte(notifications.sentAt, sixDaysAgo),
          ))
          .limit(1);

        if (recentReport) continue; // Already sent this week

        // Get the senior for this caregiver
        const [cg] = await db.select({ seniorId: caregivers.seniorId })
          .from(caregivers)
          .where(eq(caregivers.id, pref.caregiverId))
          .limit(1);

        if (!cg) continue;

        log.info('Sending weekly report', { caregiverId: pref.caregiverId, seniorId: cg.seniorId });

        const { notificationService } = await import('./notifications.js');
        await notificationService.sendWeeklyReport(pref.caregiverId, cg.seniorId);
      }
    } catch (error) {
      log.error('Weekly report check error', { error: error.message });
    }
  };

  const weeklyReportIntervalId = setInterval(checkWeeklyReports, 60 * 60 * 1000); // hourly

  // Initial weekly report check (delayed 30s to let server warm up)
  setTimeout(checkWeeklyReports, 30000);

  log.info('Weekly report scheduling enabled (hourly check)');

  // Daily data retention purge (HIPAA compliance)
  // Checks hourly but only runs the actual purge once per calendar day.
  const dataRetentionIntervalId = setInterval(async () => {
    if (!isLeader) return; // Only the leader runs purges
    try {
      await runDailyPurgeIfNeeded();
    } catch (error) {
      log.error('Data retention check error', { error: error.message });
    }
  }, 60 * 60 * 1000); // hourly

  // Initial data retention check (delayed 2 minutes to let server warm up)
  setTimeout(async () => {
    if (!isLeader) {
      isLeader = await tryAcquireLeaderLock();
    }
    if (isLeader) {
      runDailyPurgeIfNeeded().catch(err => {
        log.error('Initial data retention check error', { error: err.message });
      });
    }
  }, 120000);

  log.info('Data retention purge enabled (daily, hourly check)');

  return { schedulerIntervalId, prefetchIntervalId, weeklyReportIntervalId, dataRetentionIntervalId };
}
