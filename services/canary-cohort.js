import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { createLogger } from '../lib/logger.js';
import { writeAudit } from './audit.js';

const log = createLogger('canary-cohort');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RAMP_PHASE_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;
const REMOVED_REASON_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

const ALLOWED_REMOVED_REASONS = new Set([
  'phase_complete',
  'ramp_back',
  'rollback_legacy_only',
  'manual_admin',
  'senior_inactive',
  'caregiver_paused',
]);

function rowsFrom(result) {
  return result?.rows || [];
}

function requireSeniorId(value, field = 'seniorId') {
  const id = String(value || '').trim();
  if (!UUID_PATTERN.test(id)) {
    const err = new Error(`${field} must be a valid UUID`);
    err.code = 'invalid_senior_id';
    throw err;
  }
  return id;
}

function requireRampPhase(value) {
  const phase = String(value || '').trim();
  if (!RAMP_PHASE_PATTERN.test(phase)) {
    const err = new Error('rampPhase must be 1-50 chars of [A-Za-z0-9_-]');
    err.code = 'invalid_ramp_phase';
    throw err;
  }
  return phase;
}

function normalizeRemovedReason(value) {
  const reason = String(value || '').trim();
  if (!reason) {
    return 'manual_admin';
  }
  if (!REMOVED_REASON_PATTERN.test(reason)) {
    const err = new Error('removedReason must be 1-50 chars of [A-Za-z0-9_-]');
    err.code = 'invalid_removed_reason';
    throw err;
  }
  if (!ALLOWED_REMOVED_REASONS.has(reason)) {
    const err = new Error(`removedReason must be one of: ${[...ALLOWED_REMOVED_REASONS].join(', ')}`);
    err.code = 'invalid_removed_reason';
    throw err;
  }
  return reason;
}

function stripCanaryRow(row) {
  if (!row) return row;
  const { notes: _notes, ...safeRow } = row;
  return safeRow;
}

/**
 * Add a senior to the active canary cohort. Idempotent: if the senior is
 * already active in any phase, the existing row is returned unchanged.
 * Re-adding a previously-removed senior creates a new row (audit trail);
 * the unique partial index on active rows means at most one active row
 * per senior exists at a time.
 */
export async function addToCanary(
  { seniorId, rampPhase, addedBy = null } = {},
  { database = db, auditWriter = writeAudit } = {},
) {
  const id = requireSeniorId(seniorId);
  const phase = requireRampPhase(rampPhase);

  // Insert or return the active row in one round-trip. The partial unique
  // index `idx_canary_cohort_active` keeps concurrent adds idempotent while
  // still allowing historical removed rows.
  const result = await database.execute(sql`
    WITH inserted AS (
      INSERT INTO canary_cohort_membership (senior_id, ramp_phase, added_by)
      VALUES (${id}, ${phase}, ${addedBy})
      ON CONFLICT (senior_id) WHERE removed_at IS NULL DO NOTHING
      RETURNING *, true AS "__was_inserted"
    ),
    existing AS (
      SELECT *, false AS "__was_inserted"
      FROM canary_cohort_membership
      WHERE senior_id = ${id}
        AND removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM inserted)
    )
    SELECT * FROM inserted
    UNION ALL
    SELECT * FROM existing
    LIMIT 1
  `);

  const row = rowsFrom(result)[0] || null;
  if (!row) {
    throw new Error('failed to add canary member');
  }

  const wasInserted = row.__was_inserted === true;
  delete row.__was_inserted;
  const safeRow = stripCanaryRow(row);

  // Audit only on real insert (existing rows aren't a state change).
  if (wasInserted) {
    Promise.resolve(auditWriter({
      userId: addedBy,
      userRole: 'admin',
      action: 'canary_cohort_add',
      resourceType: 'canary_cohort_membership',
      resourceId: id,
      metadata: { rampPhase: phase },
    })).catch((err) => log.warn('Canary add audit failed', { error: err?.message }));
  }

  return safeRow;
}

/**
 * Remove a senior from the active canary cohort. No-op when the senior is
 * not currently active; returns null in that case.
 */
export async function removeFromCanary(
  { seniorId, removedBy = null, reason } = {},
  { database = db, auditWriter = writeAudit } = {},
) {
  const id = requireSeniorId(seniorId);
  const normalizedReason = normalizeRemovedReason(reason);

  const result = await database.execute(sql`
    UPDATE canary_cohort_membership
    SET removed_at = NOW(),
        removed_reason = ${normalizedReason}
    WHERE senior_id = ${id}
      AND removed_at IS NULL
    RETURNING *
  `);

  const row = rowsFrom(result)[0] || null;
  if (row) {
    Promise.resolve(auditWriter({
      userId: removedBy,
      userRole: 'admin',
      action: 'canary_cohort_remove',
      resourceType: 'canary_cohort_membership',
      resourceId: id,
      metadata: { rampPhase: row.ramp_phase, reason: normalizedReason },
    })).catch((err) => log.warn('Canary remove audit failed', { error: err?.message }));
  }
  return row;
}

/**
 * List the active canary cohort. Returns one row per active senior with
 * their current ramp_phase and added_at. PHI-safe: no senior names or
 * phone numbers are joined in.
 */
export async function listActiveCanaryMembers({ limit = 500 } = {}, { database = db } = {}) {
  const safeLimit = Math.max(1, Math.min(2000, Number.parseInt(limit, 10) || 500));
  const result = await database.execute(sql`
    SELECT senior_id, ramp_phase, added_at, added_by
    FROM canary_cohort_membership
    WHERE removed_at IS NULL
    ORDER BY added_at DESC
    LIMIT ${safeLimit}
  `);
  return rowsFrom(result).map(stripCanaryRow);
}

/**
 * Return the active ramp_phase for a senior, or null if not currently in
 * the canary cohort. Constant-time-ish via the partial unique index.
 */
export async function getCanaryRampPhase(seniorId, { database = db } = {}) {
  const id = requireSeniorId(seniorId);
  const result = await database.execute(sql`
    SELECT ramp_phase
    FROM canary_cohort_membership
    WHERE senior_id = ${id}
      AND removed_at IS NULL
    LIMIT 1
  `);
  const row = rowsFrom(result)[0];
  return row?.ramp_phase || null;
}

/**
 * Return a Set of active canary senior_ids. Used by the dispatcher (when
 * the canary table is the source of truth) and by the daily report
 * (to split call_attempts into treatment vs control).
 */
export async function getActiveCanarySeniorIds({ database = db } = {}) {
  const result = await database.execute(sql`
    SELECT senior_id
    FROM canary_cohort_membership
    WHERE removed_at IS NULL
  `);
  return new Set(rowsFrom(result).map((row) => row.senior_id));
}

/**
 * Return a deterministic, deduped, sorted list of senior_ids from BOTH the
 * DB canary table and the env-var allowlist (CALL_QUEUE_COHORT_ALLOWLIST).
 *
 * Source-of-truth precedence is "union" — the env var stays as an emergency
 * override path so an operator can ramp without going through the admin
 * endpoint. In steady-state Phase 7 operation the env var is empty and the
 * DB is authoritative.
 *
 * Returns an Array (not a Set) so the dispatcher's canaryPercent + cohort
 * filter logic can index into it deterministically.
 */
export async function resolveMergedCanarySeniorIds(envAllowlist = [], { database = db } = {}) {
  const dbIds = await getActiveCanarySeniorIds({ database });
  const merged = new Set(dbIds);
  for (const id of envAllowlist || []) {
    const trimmed = String(id || '').trim();
    if (trimmed) merged.add(trimmed);
  }
  return Array.from(merged).sort();
}
