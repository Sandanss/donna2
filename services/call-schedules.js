import { createHash } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { encrypt } from '../lib/encryption.js';
import {
  DEFAULT_TIMEZONE,
  getDatePartsInTimezone,
  parseTimeString,
  resolveTimezoneFromProfile,
  zonedWallTimeToUtcDate,
} from '../lib/timezone.js';
import {
  PRIORITY_LANES,
  buildCallDedupeKey,
  buildDispatchWindow,
  enqueueCall,
  getLocalDateKey,
} from './call-queue.js';

const DEFAULT_WINDOW_MINUTES = 15;
const MAX_LOOKAHEAD_DAYS = 370;
export const CALL_SCHEDULE_MATERIALIZER_LOCK_ID = 8675310;

function rowsFrom(result) {
  return result?.rows || [];
}

async function tryAcquireMaterializerTransactionLock(executor) {
  const result = await executor.execute(sql`
    SELECT pg_try_advisory_xact_lock(${CALL_SCHEDULE_MATERIALIZER_LOCK_ID}) AS acquired
  `);
  return rowsFrom(result)[0]?.acquired === true;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashScheduleSource(seniorId, item, index) {
  const minimized = {
    seniorId,
    index,
    id: item?.id || null,
    frequency: item?.frequency || null,
    recurringDays: Array.isArray(item?.recurringDays) ? [...item.recurringDays].sort() : null,
    date: item?.date || null,
    time: item?.time || null,
    reminderIds: Array.isArray(item?.reminderIds) ? [...item.reminderIds].sort() : null,
  };
  return createHash('sha256').update(stableJson(minimized)).digest('hex');
}

function localDateFromString(dateString) {
  const match = String(dateString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function addLocalDays(parts, offset) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function dayOfWeek(parts) {
  return new Date(parts.year, parts.month - 1, parts.day).getDay();
}

function normalizeDays(days) {
  if (!Array.isArray(days)) return null;
  const unique = [...new Set(days.map(day => Number.parseInt(day, 10)).filter(day => day >= 0 && day <= 6))];
  return unique.sort((a, b) => a - b);
}

function parseDbTime(timeValue) {
  if (!timeValue) return null;
  const normalized = String(timeValue).trim().replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
  return parseTimeString(normalized);
}

function formatDbTime(time) {
  return `${String(time.hours).padStart(2, '0')}:${String(time.minutes).padStart(2, '0')}:00`;
}

function encryptContextNotes(contextNotes) {
  if (!contextNotes) return null;
  const encrypted = encrypt(contextNotes);
  return typeof encrypted === 'string' && encrypted.startsWith('enc:') ? encrypted : null;
}

export function computeNextScheduleRunAt(schedule, now = new Date()) {
  const timezone = schedule.timezone || DEFAULT_TIMEZONE;
  const wallTime = schedule.targetLocalTime
    ? parseDbTime(schedule.targetLocalTime)
    : parseTimeString(schedule.time);
  if (!wallTime) return null;

  const frequency = schedule.frequency || 'daily';
  const oneTimeDate = localDateFromString(schedule.oneTimeDate || schedule.date);
  if (frequency === 'one-time') {
    if (!oneTimeDate) return null;
    const candidate = zonedWallTimeToUtcDate({ ...oneTimeDate, ...wallTime }, timezone);
    return candidate.getTime() >= now.getTime() ? candidate : null;
  }

  const recurringDays = frequency === 'recurring'
    ? normalizeDays(schedule.daysOfWeek || schedule.recurringDays)
    : null;
  if (frequency === 'recurring' && (!recurringDays || recurringDays.length === 0)) {
    return null;
  }

  const localNow = getDatePartsInTimezone(now, timezone);
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const localDate = addLocalDays(localNow, offset);
    if (recurringDays && !recurringDays.includes(dayOfWeek(localDate))) continue;

    const candidate = zonedWallTimeToUtcDate({ ...localDate, ...wallTime }, timezone);
    if (candidate.getTime() >= now.getTime()) return candidate;
  }

  return null;
}

export function normalizeSeniorCallScheduleRows(senior, now = new Date()) {
  const seniorId = senior?.id;
  if (!seniorId) throw new Error('senior.id is required');

  const schedule = senior?.preferredCallTimes?.schedule;
  if (!Array.isArray(schedule) || schedule.length === 0) return [];

  const timezone = resolveTimezoneFromProfile(senior);
  return schedule
    .map((item, index) => {
      const time = parseTimeString(item?.time);
      if (!time) return null;

      const frequency = item.frequency || 'daily';
      const normalizedDays = frequency === 'recurring' ? normalizeDays(item.recurringDays) : null;
      const oneTimeDate = frequency === 'one-time' ? localDateFromString(item.date) : null;
      const nextRunAt = computeNextScheduleRunAt({
        frequency,
        recurringDays: normalizedDays,
        date: item.date,
        time: item.time,
        timezone,
      }, now);
      if (!nextRunAt) return null;

      return {
        seniorId,
        sourceProfileHash: hashScheduleSource(seniorId, item, index),
        callType: 'schedule',
        timezone,
        targetLocalTime: formatDbTime(time),
        windowMinutes: DEFAULT_WINDOW_MINUTES,
        frequency,
        daysOfWeek: normalizedDays,
        oneTimeDate: oneTimeDate
          ? `${oneTimeDate.year}-${String(oneTimeDate.month).padStart(2, '0')}-${String(oneTimeDate.day).padStart(2, '0')}`
          : null,
        priorityLane: PRIORITY_LANES.SCHEDULED_CHECKIN,
        reminderIds: Array.isArray(item.reminderIds) ? item.reminderIds : null,
        contextNotesEncrypted: encryptContextNotes(item.contextNotes),
        nextRunAt,
      };
    })
    .filter(Boolean);
}

export async function syncSeniorCallSchedulesFromPreferredCallTimes(senior, {
  database = db,
  now = new Date(),
} = {}) {
  const rows = normalizeSeniorCallScheduleRows(senior, now);
  const seniorId = senior?.id;
  if (!seniorId) throw new Error('senior.id is required');

  const writeSchedules = async (executor) => {
    await executor.execute(sql`
      UPDATE senior_call_schedules
      SET is_active = false,
          updated_at = NOW()
      WHERE senior_id = ${seniorId}
    `);

    let upserted = 0;
    for (const row of rows) {
      await executor.execute(sql`
        INSERT INTO senior_call_schedules (
          senior_id,
          source_profile_hash,
          call_type,
          timezone,
          target_local_time,
          window_minutes,
          frequency,
          days_of_week,
          one_time_date,
          priority_lane,
          reminder_ids,
          context_notes_encrypted,
          next_run_at,
          is_active
        )
        VALUES (
          ${row.seniorId},
          ${row.sourceProfileHash},
          ${row.callType},
          ${row.timezone},
          ${row.targetLocalTime},
          ${row.windowMinutes},
          ${row.frequency},
          ${row.daysOfWeek},
          ${row.oneTimeDate},
          ${row.priorityLane},
          ${row.reminderIds},
          ${row.contextNotesEncrypted},
          ${row.nextRunAt},
          true
        )
        ON CONFLICT (senior_id, source_profile_hash) WHERE source_profile_hash IS NOT NULL
        DO UPDATE SET
          call_type = EXCLUDED.call_type,
          timezone = EXCLUDED.timezone,
          target_local_time = EXCLUDED.target_local_time,
          window_minutes = EXCLUDED.window_minutes,
          frequency = EXCLUDED.frequency,
          days_of_week = EXCLUDED.days_of_week,
          one_time_date = EXCLUDED.one_time_date,
          priority_lane = EXCLUDED.priority_lane,
          reminder_ids = EXCLUDED.reminder_ids,
          context_notes_encrypted = EXCLUDED.context_notes_encrypted,
          next_run_at = EXCLUDED.next_run_at,
          is_active = true,
          updated_at = NOW()
      `);
      upserted += 1;
    }

    return upserted;
  };

  const upserted = typeof database.transaction === 'function'
    ? await database.transaction(writeSchedules)
    : await writeSchedules(database);

  return {
    seniorId,
    total: rows.length,
    upserted,
  };
}

function deterministicJitterMs(seed, windowMinutes) {
  const safeWindowMinutes = Number.isFinite(windowMinutes) && windowMinutes > 0
    ? windowMinutes
    : DEFAULT_WINDOW_MINUTES;
  const halfWindowMs = Math.floor((safeWindowMinutes * 60 * 1000) / 2);
  if (halfWindowMs <= 0) return 0;
  const digest = createHash('sha256').update(seed).digest();
  const bucket = digest.readUInt32BE(0) / 0xffffffff;
  return Math.round((bucket * 2 - 1) * halfWindowMs);
}

export function buildQueueInputFromNormalizedSchedule(schedule) {
  const nextRunAt = new Date(schedule.nextRunAt);
  if (Number.isNaN(nextRunAt.getTime())) {
    throw new Error('schedule.nextRunAt must be a valid date');
  }

  const localDate = getLocalDateKey(nextRunAt, schedule.timezone);
  const window = buildDispatchWindow(nextRunAt, schedule.windowMinutes || DEFAULT_WINDOW_MINUTES);
  const jitterMs = deterministicJitterMs(`${schedule.id}:${localDate}`, schedule.windowMinutes || DEFAULT_WINDOW_MINUTES);

  return {
    seniorId: schedule.seniorId,
    scheduleId: schedule.id,
    callType: schedule.callType || 'schedule',
    priorityLane: schedule.priorityLane || PRIORITY_LANES.SCHEDULED_CHECKIN,
    priorityScore: 0,
    targetAt: new Date(nextRunAt.getTime() + jitterMs),
    earliestAt: window.earliestAt,
    latestAt: window.latestAt,
    dedupeKey: buildCallDedupeKey({
      callType: 'schedule',
      seniorId: schedule.seniorId,
      scheduleId: schedule.id,
      targetAt: nextRunAt,
      localDate,
    }),
  };
}

async function materializeDueNormalizedSchedulesUnlocked({
  database = db,
  now = new Date(),
  horizonMinutes = 45,
  limit = 500,
} = {}) {
  const horizon = new Date(now.getTime() + horizonMinutes * 60 * 1000);
  const result = await database.execute(sql`
    SELECT
      scs.id,
      scs.senior_id AS "seniorId",
      scs.call_type AS "callType",
      scs.timezone,
      scs.target_local_time AS "targetLocalTime",
      scs.window_minutes AS "windowMinutes",
      scs.frequency,
      scs.days_of_week AS "daysOfWeek",
      scs.one_time_date AS "oneTimeDate",
      scs.priority_lane AS "priorityLane",
      scs.reminder_ids AS "reminderIds",
      scs.next_run_at AS "nextRunAt"
    FROM senior_call_schedules scs
    JOIN seniors s ON s.id = scs.senior_id
    WHERE scs.is_active = true
      AND s.is_active = true
      AND scs.next_run_at <= ${horizon}
      AND NOT EXISTS (
        SELECT 1
        FROM caregivers c
        JOIN notification_preferences np ON np.caregiver_id = c.id
        WHERE c.senior_id = scs.senior_id
          AND np.pause_calls = true
      )
    ORDER BY scs.next_run_at ASC
    LIMIT ${limit}
  `);

  let inserted = 0;
  let existing = 0;
  let failed = 0;

  for (const schedule of rowsFrom(result)) {
    try {
      const queueInput = buildQueueInputFromNormalizedSchedule(schedule);
      const materializedFor = new Date(schedule.nextRunAt);
      const enqueueResult = await enqueueCall(queueInput, { database });
      if (enqueueResult.inserted) inserted += 1;
      else existing += 1;

      const nextRunAt = computeNextScheduleRunAt(schedule, new Date(materializedFor.getTime() + 60 * 1000));
      await database.execute(sql`
        UPDATE senior_call_schedules
        SET last_materialized_for = ${materializedFor},
            next_run_at = ${nextRunAt || materializedFor},
            is_active = ${Boolean(nextRunAt)},
            updated_at = NOW()
        WHERE id = ${schedule.id}
      `);
    } catch {
      failed += 1;
    }
  }

  return {
    scanned: rowsFrom(result).length,
    inserted,
    existing,
    failed,
  };
}

export async function materializeDueNormalizedSchedules({
  database = db,
  useAdvisoryLock = true,
  ...options
} = {}) {
  if (useAdvisoryLock && typeof database.transaction === 'function') {
    return database.transaction(async (tx) => {
      const acquired = await tryAcquireMaterializerTransactionLock(tx);
      if (!acquired) {
        return {
          scanned: 0,
          inserted: 0,
          existing: 0,
          failed: 0,
        };
      }
      return materializeDueNormalizedSchedulesUnlocked({
        ...options,
        database: tx,
      });
    });
  }

  return materializeDueNormalizedSchedulesUnlocked({
    ...options,
    database,
  });
}
