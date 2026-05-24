#!/usr/bin/env node

/**
 * Phase 7 — Small Live Canary daily review report.
 *
 * Aggregates call activity over a configurable window (default: last 24h)
 * and splits seniors into "treatment" (currently in canary_cohort_membership)
 * vs "control" (everyone else). Computes the §1.3 SLO row set the runtime
 * can observe directly, returns a PHI-free JSON report and a punch list of
 * SLO breaches.
 *
 * Output is intentionally aggregate counts + percentiles only. No senior
 * names, phone numbers, transcripts, reminder text, caregiver notes, raw
 * call SIDs, or guard keys appear in the output.
 *
 * Usage:
 *   npm run phase7:canary-daily-report -- --window-hours=24
 *   npm run phase7:canary-daily-report -- --window-hours=48 --out=tmp/phase7-daily.json
 *   npm run phase7:canary-daily-report -- --include-senior-id-hashes  # for cohort-cohort joins
 *
 * Exit codes:
 *   0 — report generated, no SLO breaches
 *   1 — report generated, SLO breaches present (operator review required)
 *   2 — invalid arguments / runtime failure
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { listActiveCanaryMembers } from '../services/canary-cohort.js';

// Plan §1.3 SLO thresholds the simulation can observe directly.
const SETUP_P95_TARGET_MS = 1500;
const SETUP_SUCCESS_FLOOR = 0.95;
const POST_CALL_COMPLETION_FLOOR = 0.95;
const DUPLICATE_OUTBOUND_TARGET = 0;

const DEFAULT_WINDOW_HOURS = 24;

function parseArgs(argv) {
  const args = {
    windowHours: DEFAULT_WINDOW_HOURS,
    out: null,
    includeSeniorIdHashes: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--window-hours=')) {
      const parsed = Number.parseInt(arg.slice('--window-hours='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 24 * 14) args.windowHours = parsed;
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    } else if (arg === '--include-senior-id-hashes') {
      args.includeSeniorIdHashes = true;
    }
  }

  return args;
}

function usage() {
  return [
    'Phase 7 canary daily review report',
    '',
    'Usage:',
    '  npm run phase7:canary-daily-report -- --window-hours=24',
    '  npm run phase7:canary-daily-report -- --window-hours=48 --out=tmp/phase7-daily.json',
    '',
    'Output is PHI-safe: aggregate counts, percentiles, and (optionally) SHA-256-truncated',
    'senior-id hashes. No names, phone numbers, transcripts, reminder text, caregiver notes,',
    'raw senior IDs, or guard keys are emitted.',
  ].join('\n');
}

function rowsFrom(result) {
  return result?.rows || [];
}

function intValue(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function floatValue(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function rounded(value, digits = 4) {
  if (value == null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hashSeniorId(seniorId) {
  return crypto.createHash('sha256').update(String(seniorId)).digest('hex').slice(0, 12);
}

function passedCheck(name, passed, details = {}) {
  return { name, status: passed ? 'passed' : 'failed', ...details };
}

function skippedCheck(name, reason, details = {}) {
  return { name, status: 'skipped', reason, ...details };
}

export async function queryCohortAttempts({
  windowStart,
  windowEnd,
  canarySeniorIds,
  database = db,
} = {}) {
  // Postgres ANY/= ARRAY pattern only works when we pass an array; for empty
  // arrays we fall back to `WHERE FALSE` so the COUNT(*) returns 0 cleanly.
  const canaryList = Array.from(canarySeniorIds || []);
  const isCanary = canaryList.length > 0
    ? sql`ca.senior_id = ANY(${canaryList}::uuid[])`
    : sql`FALSE`;

  const result = await database.execute(sql`
    SELECT
      CASE WHEN ${isCanary} THEN 'treatment' ELSE 'control' END AS cohort,
      COUNT(*)::int AS total_attempts,
      COUNT(*) FILTER (WHERE ca.answered_at IS NOT NULL)::int AS answered_attempts,
      COUNT(*) FILTER (WHERE ca.media_started_at IS NOT NULL)::int AS media_started_attempts,
      COUNT(*) FILTER (WHERE ca.status IN ('failed', 'expired', 'suppressed'))::int AS failed_attempts,
      COUNT(DISTINCT ca.senior_id)::int AS distinct_seniors,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (ca.media_started_at - ca.dial_started_at)) * 1000
      ) AS setup_p50_ms,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (ca.media_started_at - ca.dial_started_at)) * 1000
      ) AS setup_p95_ms
    FROM call_attempts ca
    WHERE ca.created_at >= ${windowStart}
      AND ca.created_at < ${windowEnd}
      AND ca.dial_started_at IS NOT NULL
    GROUP BY 1
  `);
  return rowsFrom(result);
}

export async function queryDuplicateOutbound({
  windowStart,
  windowEnd,
  canarySeniorIds,
  database = db,
} = {}) {
  const canaryList = Array.from(canarySeniorIds || []);
  const isCanary = canaryList.length > 0
    ? sql`ca.senior_id = ANY(${canaryList}::uuid[])`
    : sql`FALSE`;

  // Two duplicate flavors per cohort: (queue_id, attempt_number) and
  // call_control_id. Both should be 0 under §1.3. The synthetic column is
  // named `report_cohort` to avoid collision with `call_attempts.cohort`
  // (which is a real column used by the legacy/queue test_run_id labeling).
  const result = await database.execute(sql`
    WITH attempts AS (
      SELECT ca.queue_id, ca.attempt_number, ca.call_control_id,
             CASE WHEN ${isCanary} THEN 'treatment' ELSE 'control' END AS report_cohort
      FROM call_attempts ca
      WHERE ca.created_at >= ${windowStart}
        AND ca.created_at < ${windowEnd}
    ),
    queue_attempt_dups AS (
      SELECT report_cohort, queue_id, attempt_number, COUNT(*) AS dup_count
      FROM attempts
      GROUP BY report_cohort, queue_id, attempt_number
      HAVING COUNT(*) > 1
    ),
    call_control_dups AS (
      SELECT report_cohort, call_control_id, COUNT(*) AS dup_count
      FROM attempts
      WHERE call_control_id IS NOT NULL
      GROUP BY report_cohort, call_control_id
      HAVING COUNT(*) > 1
    )
    SELECT
      cohorts.cohort,
      COALESCE((SELECT SUM(dup_count - 1)::int FROM queue_attempt_dups q WHERE q.report_cohort = cohorts.cohort), 0) AS duplicate_queue_attempt_rows,
      COALESCE((SELECT SUM(dup_count - 1)::int FROM call_control_dups c WHERE c.report_cohort = cohorts.cohort), 0) AS duplicate_call_control_rows
    FROM (VALUES ('control'), ('treatment')) AS cohorts(cohort)
  `);

  return rowsFrom(result);
}

export async function queryPostCallCompletion({
  windowStart,
  windowEnd,
  canarySeniorIds,
  database = db,
} = {}) {
  const canaryList = Array.from(canarySeniorIds || []);
  const isCanary = canaryList.length > 0
    ? sql`pcj.senior_id = ANY(${canaryList}::uuid[])`
    : sql`FALSE`;

  // For each call_sid (one per call) compute completion for the critical
  // path jobs: analysis + reminder_recovery (Phase 6 plan calls these
  // "critical jobs p95 ≤ 5 min"). A call is "fully completed" if both
  // critical jobs reached 'completed'. Cohort assignment uses senior_id.
  const result = await database.execute(sql`
    WITH critical_jobs AS (
      SELECT
        pcj.call_sid,
        pcj.senior_id,
        CASE WHEN ${isCanary} THEN 'treatment' ELSE 'control' END AS cohort,
        bool_and(pcj.status = 'completed') FILTER (WHERE pcj.job_type IN ('analysis','reminder_recovery'))
          AS critical_all_completed,
        max(pcj.completed_at) FILTER (WHERE pcj.job_type IN ('analysis','reminder_recovery'))
          AS critical_last_completed_at,
        max(pcj.created_at) AS first_critical_created_at
      FROM post_call_jobs pcj
      WHERE pcj.created_at >= ${windowStart}
        AND pcj.created_at < ${windowEnd}
        AND pcj.job_type IN ('analysis','reminder_recovery')
      GROUP BY pcj.call_sid, pcj.senior_id, cohort
    )
    SELECT
      cohort,
      COUNT(*)::int AS total_calls_with_critical_jobs,
      COUNT(*) FILTER (WHERE critical_all_completed)::int AS calls_critical_complete,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (critical_last_completed_at - first_critical_created_at))
      ) FILTER (WHERE critical_all_completed) AS critical_p95_seconds
    FROM critical_jobs
    GROUP BY 1
  `);

  return rowsFrom(result);
}

export function evaluateCanaryReport({ cohorts, duplicates, postCall, thresholds = {} } = {}) {
  const setupTargetMs = thresholds.setupP95TargetMs ?? SETUP_P95_TARGET_MS;
  const setupFloor = thresholds.setupSuccessFloor ?? SETUP_SUCCESS_FLOOR;
  const postCallFloor = thresholds.postCallCompletionFloor ?? POST_CALL_COMPLETION_FLOOR;

  const byCohort = (rows, name) => rows.find((r) => r.cohort === name) || {};
  const checks = [];

  for (const cohort of ['control', 'treatment']) {
    const attempts = byCohort(cohorts, cohort);
    const total = intValue(attempts.total_attempts);
    const failed = intValue(attempts.failed_attempts);
    const setupP95 = floatValue(attempts.setup_p95_ms);
    const successRate = ratio(total - failed, total);

    if (total === 0) {
      checks.push(skippedCheck(`${cohort}_setup_success_rate`, 'no attempts in window', { cohort }));
      checks.push(skippedCheck(`${cohort}_setup_p95_ms`, 'no attempts in window', { cohort }));
    } else {
      checks.push(passedCheck(`${cohort}_setup_success_rate`, successRate != null && successRate >= setupFloor, {
        cohort,
        totalAttempts: total,
        failedAttempts: failed,
        setupSuccessRate: rounded(successRate),
        floor: setupFloor,
      }));
      checks.push(passedCheck(`${cohort}_setup_p95_ms`, setupP95 != null && setupP95 <= setupTargetMs, {
        cohort,
        setupP95Ms: rounded(setupP95, 1),
        target: setupTargetMs,
      }));
    }

    const dup = byCohort(duplicates, cohort);
    const dupTotal = intValue(dup.duplicate_queue_attempt_rows) + intValue(dup.duplicate_call_control_rows);
    checks.push(passedCheck(`${cohort}_duplicate_outbound`, dupTotal === DUPLICATE_OUTBOUND_TARGET, {
      cohort,
      duplicateQueueAttemptRows: intValue(dup.duplicate_queue_attempt_rows),
      duplicateCallControlRows: intValue(dup.duplicate_call_control_rows),
      target: DUPLICATE_OUTBOUND_TARGET,
    }));

    const pc = byCohort(postCall, cohort);
    const pcTotal = intValue(pc.total_calls_with_critical_jobs);
    const pcComplete = intValue(pc.calls_critical_complete);
    const pcRate = ratio(pcComplete, pcTotal);
    const pcP95 = floatValue(pc.critical_p95_seconds);

    if (pcTotal === 0) {
      checks.push(skippedCheck(`${cohort}_post_call_completion_rate`, 'no post-call jobs in window', { cohort }));
    } else {
      checks.push(passedCheck(`${cohort}_post_call_completion_rate`, pcRate != null && pcRate >= postCallFloor, {
        cohort,
        totalCallsWithCriticalJobs: pcTotal,
        callsCriticalComplete: pcComplete,
        completionRate: rounded(pcRate),
        floor: postCallFloor,
        criticalP95Seconds: pcP95 == null ? null : Math.round(pcP95),
      }));
    }
  }

  const required = checks.filter((c) => c.status !== 'skipped');
  const failed = required.filter((c) => c.status !== 'passed');
  return {
    ok: failed.length === 0,
    failedCount: failed.length,
    checks,
    breaches: failed.map(({ name, status: _status, ...rest }) => ({ name, ...rest })),
  };
}

export async function buildCanaryDailyReport({
  windowHours = DEFAULT_WINDOW_HOURS,
  now = new Date(),
  database = db,
  members = null,
} = {}) {
  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - windowHours * 3600 * 1000);

  const canaryRows = members ?? (await listActiveCanaryMembers({ limit: 2000 }, { database }));
  const canarySeniorIds = new Set(canaryRows.map((row) => row.senior_id));

  const [cohorts, duplicates, postCall] = await Promise.all([
    queryCohortAttempts({ windowStart, windowEnd, canarySeniorIds, database }),
    queryDuplicateOutbound({ windowStart, windowEnd, canarySeniorIds, database }),
    queryPostCallCompletion({ windowStart, windowEnd, canarySeniorIds, database }),
  ]);

  const evaluation = evaluateCanaryReport({ cohorts, duplicates, postCall });

  return {
    generatedAt: windowEnd.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    canaryCohortSize: canarySeniorIds.size,
    canaryRampPhases: Array.from(new Set(canaryRows.map((row) => row.ramp_phase))).sort(),
    cohorts,
    duplicates,
    postCall,
    evaluation,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  let report;
  try {
    report = await buildCanaryDailyReport({ windowHours: args.windowHours });
  } catch (error) {
    console.error('phase7-canary-daily-report failed:', error.message);
    process.exit(2);
  }

  if (args.includeSeniorIdHashes) {
    const members = await listActiveCanaryMembers({ limit: 2000 });
    report.canarySeniorIdHashes = members.map((row) => hashSeniorId(row.senior_id));
  }

  const output = JSON.stringify(report, null, 2);
  if (args.out) {
    await fs.writeFile(args.out, output, 'utf8');
    console.error(`wrote ${args.out}`);
  } else {
    console.log(output);
  }

  process.exit(report.evaluation.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error('phase7-canary-daily-report fatal:', error.message);
    process.exit(2);
  });
}
