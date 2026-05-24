/**
 * Data retention service -- scheduled purge of expired PHI data.
 *
 * HIPAA requires defined retention periods for protected health information.
 * This service runs once per day (integrated into the Node.js scheduler) and
 * deletes data older than the configured retention period for each table.
 *
 * Retention periods are configurable via environment variables.
 * Purges use batched deletes via CTEs to avoid long-running transactions.
 */

import { db } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { createLogger } from '../lib/logger.js';

const log = createLogger('DataRetention');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BATCH_SIZE = 5000;

/**
 * Retention periods in days, configurable via environment variables.
 * Set a value to 0 to disable purge for that table.
 */
const RETENTION_DAYS = {
  conversation_phi:      parseInt(process.env.RETENTION_CONVERSATIONS_DAYS              || '365', 10),
  conversations:         parseInt(process.env.RETENTION_CONVERSATION_METADATA_DAYS      || '1095', 10),
  memories:              parseInt(process.env.RETENTION_MEMORIES_DAYS                   || '730', 10),
  call_analyses:         parseInt(process.env.RETENTION_CALL_ANALYSES_DAYS              || '365', 10),
  daily_call_context:    parseInt(process.env.RETENTION_DAILY_CONTEXT_DAYS              || '90',  10),
  call_metrics:          parseInt(process.env.RETENTION_CALL_METRICS_DAYS               || '180', 10),
  inactive_reminders:    parseInt(process.env.RETENTION_INACTIVE_REMINDERS_DAYS         || '365', 10),
  expired_onetime_reminders: parseInt(process.env.RETENTION_EXPIRED_ONETIME_REMINDERS_DAYS || '1', 10),
  reminder_deliveries:   parseInt(process.env.RETENTION_REMINDER_DELIVERIES_DAYS        || '90',  10),
  notifications:         parseInt(process.env.RETENTION_NOTIFICATIONS_DAYS              || '180', 10),
  caregiver_notes:       parseInt(process.env.RETENTION_CAREGIVER_NOTES_DAYS            || '365', 10),
  prospects:             parseInt(process.env.RETENTION_PROSPECTS_DAYS                  || '90',  10),
  senior_profile_review: parseInt(process.env.RETENTION_INACTIVE_SENIOR_REVIEW_DAYS     || '365', 10),
  idempotency_keys:      parseInt(process.env.RETENTION_IDEMPOTENCY_KEYS_DAYS           || '1',   10),
  call_queue:            parseInt(process.env.RETENTION_CALL_QUEUE_DAYS                 || '90',  10),
  call_attempts:         parseInt(process.env.RETENTION_CALL_ATTEMPTS_DAYS              || '180', 10),
  post_call_jobs:        parseInt(process.env.RETENTION_POST_CALL_JOBS_DAYS             || '180', 10),
  outbound_call_guards:  parseInt(process.env.RETENTION_OUTBOUND_CALL_GUARDS_DAYS       || '30',  10),
  scheduler_shadow_comparisons: parseInt(process.env.RETENTION_SCHEDULER_SHADOW_COMPARISONS_DAYS || '30', 10),
  waitlist:              parseInt(process.env.RETENTION_WAITLIST_DAYS                   || '365', 10),
  audit_logs:            parseInt(process.env.RETENTION_AUDIT_LOGS_DAYS                 || '2190', 10),
};

/**
 * Map of table name -> date column used for age comparison.
 * Only tables listed here will be purged.
 */
const TABLE_DATE_COLUMNS = {
  conversations:        'started_at',
  memories:             'created_at',
  call_analyses:        'created_at',
  daily_call_context:   'call_date',
  call_metrics:         'created_at',
  reminder_deliveries:  'created_at',
  notifications:        'sent_at',
  caregiver_notes:      'created_at',
  prospects:            'updated_at',
  call_queue:           'created_at',
  call_attempts:        'created_at',
  post_call_jobs:       'created_at',
  outbound_call_guards: 'created_at',
  scheduler_shadow_comparisons: 'created_at',
  waitlist:             'created_at',
  audit_logs:           'created_at',
};

const ALLOWED_TABLES = new Set(Object.keys(TABLE_DATE_COLUMNS));

const LEGAL_HOLD_RESOURCE_TYPES = {
  conversations: 'conversation',
  memories: 'memory',
  call_analyses: 'call_analysis',
  daily_call_context: 'daily_call_context',
  call_metrics: 'call_metric',
  reminder_deliveries: 'reminder_delivery',
  notifications: 'notification',
  caregiver_notes: 'caregiver_note',
  prospects: 'prospect',
  call_queue: 'call_queue',
  call_attempts: 'call_attempt',
  post_call_jobs: 'post_call_job',
  outbound_call_guards: 'outbound_call_guard',
  scheduler_shadow_comparisons: 'scheduler_shadow_comparison',
  waitlist: 'waitlist',
  audit_logs: 'audit_log',
};

function legalHoldExclusion(alias, table) {
  const resourceType = LEGAL_HOLD_RESOURCE_TYPES[table];
  if (!resourceType) return sql`TRUE`;
  return sql`
    NOT EXISTS (
      SELECT 1
      FROM legal_holds lh
      WHERE lh.released_at IS NULL
        AND lh.resource_type = ${resourceType}
        AND lh.resource_id = ${sql.raw(`${alias}.id::text`)}
    )
  `;
}

// ---------------------------------------------------------------------------
// Core purge logic
// ---------------------------------------------------------------------------

/**
 * Purge rows from a single table older than `days` days, in batches.
 * @param {string} table - Table name (must be in ALLOWED_TABLES)
 * @param {string} dateColumn - Column to compare against
 * @param {number} days - Retention period in days
 * @returns {Promise<number>} Total number of rows deleted
 */
async function purgeTable(table, dateColumn, days) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Table ${table} is not in ALLOWED_TABLES`);
  }

  let totalDeleted = 0;

  while (true) {
    // The table and column names come from our own hardcoded config (not user
    // input), so embedding them in the query string is safe.
    const result = await db.execute(sql`
      WITH batch AS (
        SELECT target.ctid
        FROM ${sql.raw(table)} AS target
        WHERE target.${sql.raw(dateColumn)} < NOW() - make_interval(days => ${days})
          AND ${legalHoldExclusion('target', table)}
        ORDER BY target.${sql.raw(dateColumn)}
        LIMIT ${BATCH_SIZE}
      ),
      deleted AS (
        DELETE FROM ${sql.raw(table)} AS target
        USING batch
        WHERE target.ctid = batch.ctid
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `);

    const batchCount = result.rows?.[0]?.count ?? 0;
    totalDeleted += batchCount;

    // If we deleted fewer than the batch size, we're done.
    if (batchCount < BATCH_SIZE) break;

    // Yield between batches to avoid blocking the event loop.
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return totalDeleted;
}

/**
 * Null PHI-bearing conversation fields older than the transcript retention
 * period while preserving non-PHI metadata for longer analytics/compliance.
 */
async function redactConversationPhi(days) {
  let totalRedacted = 0;

  while (true) {
    const result = await db.execute(sql`
      WITH batch AS (
        SELECT target.ctid
        FROM conversations AS target
        WHERE target.started_at < NOW() - make_interval(days => ${days})
          AND (
            target.summary IS NOT NULL
            OR target.summary_encrypted IS NOT NULL
            OR target.transcript IS NOT NULL
            OR target.transcript_encrypted IS NOT NULL
            OR target.transcript_text_encrypted IS NOT NULL
            OR target.concerns IS NOT NULL
          )
          AND ${legalHoldExclusion('target', 'conversations')}
        ORDER BY target.started_at
        LIMIT ${BATCH_SIZE}
      ),
      redacted AS (
        UPDATE conversations AS target
        SET summary = NULL,
            summary_encrypted = NULL,
            transcript = NULL,
            transcript_encrypted = NULL,
            transcript_text_encrypted = NULL,
            concerns = NULL
        FROM batch
        WHERE target.ctid = batch.ctid
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM redacted
    `);

    const batchCount = result.rows?.[0]?.count ?? 0;
    totalRedacted += batchCount;
    if (batchCount < BATCH_SIZE) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return totalRedacted;
}

/**
 * Purge inactive reminder definitions after their deactivation retention window.
 */
async function purgeInactiveReminders(days) {
  let totalDeleted = 0;

  while (true) {
    const result = await db.execute(sql`
      WITH batch AS (
        SELECT r.id
        FROM reminders r
        WHERE r.is_active = false
          AND COALESCE(r.deactivated_at, r.last_delivered_at, r.created_at) < NOW() - make_interval(days => ${days})
          AND NOT EXISTS (
            SELECT 1
            FROM legal_holds lh
            WHERE lh.released_at IS NULL
              AND lh.resource_type = 'reminder'
              AND lh.resource_id = r.id::text
          )
          AND NOT EXISTS (
            SELECT 1
            FROM reminder_deliveries rd
            JOIN legal_holds lh
              ON lh.released_at IS NULL
             AND lh.resource_type = 'reminder_delivery'
             AND lh.resource_id = rd.id::text
            WHERE rd.reminder_id = r.id
          )
        ORDER BY COALESCE(r.deactivated_at, r.last_delivered_at, r.created_at)
        LIMIT ${BATCH_SIZE}
      ),
      deleted_deliveries AS (
        DELETE FROM reminder_deliveries rd
        USING batch
        WHERE rd.reminder_id = batch.id
        RETURNING 1
      ),
      deleted_reminders AS (
        DELETE FROM reminders r
        USING batch
        WHERE r.id = batch.id
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted_reminders
    `);

    const batchCount = result.rows?.[0]?.count ?? 0;
    totalDeleted += batchCount;
    if (batchCount < BATCH_SIZE) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return totalDeleted;
}

/**
 * Delete one-time reminders whose scheduled event passed more than `days` days
 * ago. Recurring reminders are never touched. Deletes associated
 * reminder_deliveries first (no FK cascade in schema). Respects legal_holds.
 *
 * Designed to expire one-time reminders the day after their event so the
 * mobile UI doesn't keep showing past events.
 */
async function purgeExpiredOnetimeReminders(days) {
  let totalDeleted = 0;

  while (true) {
    const result = await db.execute(sql`
      WITH batch AS (
        SELECT r.id
        FROM reminders r
        WHERE r.is_recurring = false
          AND r.scheduled_time IS NOT NULL
          AND r.scheduled_time < NOW() - make_interval(days => ${days})
          AND NOT EXISTS (
            SELECT 1
            FROM legal_holds lh
            WHERE lh.released_at IS NULL
              AND lh.resource_type = 'reminder'
              AND lh.resource_id = r.id::text
          )
          AND NOT EXISTS (
            SELECT 1
            FROM reminder_deliveries rd
            JOIN legal_holds lh
              ON lh.released_at IS NULL
             AND lh.resource_type = 'reminder_delivery'
             AND lh.resource_id = rd.id::text
            WHERE rd.reminder_id = r.id
          )
        ORDER BY r.scheduled_time
        LIMIT ${BATCH_SIZE}
      ),
      deleted_deliveries AS (
        DELETE FROM reminder_deliveries rd
        USING batch
        WHERE rd.reminder_id = batch.id
        RETURNING 1
      ),
      deleted_reminders AS (
        DELETE FROM reminders r
        USING batch
        WHERE r.id = batch.id
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted_reminders
    `);

    const batchCount = result.rows?.[0]?.count ?? 0;
    totalDeleted += batchCount;
    if (batchCount < BATCH_SIZE) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return totalDeleted;
}

/**
 * Count inactive senior profiles ready for manual review. This intentionally
 * does not delete profile rows because policy requires review before purge.
 */
async function countSeniorProfileReviewCandidates(days) {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM seniors s
    WHERE s.is_active = false
      AND COALESCE(
        (SELECT MAX(c.started_at) FROM conversations c WHERE c.senior_id = s.id),
        s.updated_at,
        s.created_at
      ) < NOW() - make_interval(days => ${days})
      AND NOT EXISTS (
        SELECT 1
        FROM legal_holds lh
        WHERE lh.released_at IS NULL
          AND lh.resource_type = 'senior'
          AND lh.resource_id = s.id::text
      )
  `);
  return result.rows?.[0]?.count ?? 0;
}

/**
 * Delete idempotency replay cache entries after their explicit expiration.
 * Cached responses are encrypted, but they can still contain PHI after
 * authorized decrypt-at-boundary replay, so they must not outlive their TTL.
 */
async function purgeExpiredIdempotencyKeys() {
  let totalDeleted = 0;

  while (true) {
    const result = await db.execute(sql`
      WITH batch AS (
        SELECT ctid
        FROM idempotency_keys
        WHERE expires_at < NOW()
        ORDER BY expires_at
        LIMIT ${BATCH_SIZE}
      ),
      deleted AS (
        DELETE FROM idempotency_keys AS target
        USING batch
        WHERE target.ctid = batch.ctid
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `);

    const batchCount = result.rows?.[0]?.count ?? 0;
    totalDeleted += batchCount;
    if (batchCount < BATCH_SIZE) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return totalDeleted;
}

/**
 * Delete rows older than their retention period from all PHI tables.
 * @returns {Promise<Object>} Map of table name -> number of rows deleted
 */
export async function purgeExpiredData() {
  const results = {};

  for (const [table, days] of Object.entries(RETENTION_DAYS)) {
    if (days <= 0) continue; // 0 = disabled

    try {
      if (table === 'conversation_phi') {
        results[table] = await redactConversationPhi(days);
        continue;
      }

      if (table === 'inactive_reminders') {
        results[table] = await purgeInactiveReminders(days);
        continue;
      }

      if (table === 'expired_onetime_reminders') {
        results[table] = await purgeExpiredOnetimeReminders(days);
        continue;
      }

      if (table === 'senior_profile_review') {
        results.senior_profile_review_candidates = await countSeniorProfileReviewCandidates(days);
        continue;
      }

      if (table === 'idempotency_keys') {
        results[table] = await purgeExpiredIdempotencyKeys();
        continue;
      }

      const dateColumn = TABLE_DATE_COLUMNS[table];
      if (!dateColumn) continue;

      results[table] = await purgeTable(table, dateColumn, days);
    } catch (err) {
      // Log the error but continue with remaining tables so a single
      // missing table (e.g. audit_logs not yet created) doesn't block
      // the whole purge cycle.
      log.warn(`Failed to purge ${table}`, { error: err.message });
      results[table] = -1;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scheduler integration
// ---------------------------------------------------------------------------

let lastPurgeDate = null;

/**
 * Run the daily purge if it hasn't been run today.
 * Designed to be called from the scheduler's polling loop (every 60s).
 * The date check ensures it only actually runs once per calendar day.
 */
export async function runDailyPurgeIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastPurgeDate === today) return; // Already ran today

  log.info('Starting daily data retention purge');
  lastPurgeDate = today;

  try {
    const results = await purgeExpiredData();
    const total = Object.values(results).reduce((sum, v) => sum + Math.max(v, 0), 0);

    if (total > 0) {
      log.info('Data retention purge complete', { results, total });
    } else {
      log.info('Data retention purge: nothing to delete');
    }
  } catch (err) {
    log.error('Data retention purge failed', { error: err.message });
    // Reset so we retry next cycle
    lastPurgeDate = null;
  }
}

export const dataRetentionService = {
  purgeExpiredData,
  runDailyPurgeIfNeeded,
  RETENTION_DAYS,
  purgeInactiveReminders,
  purgeExpiredOnetimeReminders,
  countSeniorProfileReviewCandidates,
};
