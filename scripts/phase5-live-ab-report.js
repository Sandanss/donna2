#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

const MEDIA_START_RATE_TARGET = 0.95;
const ANSWER_RATE_BASELINE_FACTOR = 0.8;
const DEFAULT_MIN_ANSWER_CANARY_ATTEMPTS = 250;

function parseArgs(argv) {
  const args = {
    testRunId: null,
    answerRateBaseline: null,
    minAnswerCanaryAttempts: DEFAULT_MIN_ANSWER_CANARY_ATTEMPTS,
    rollbackStartedAt: null,
    rollbackCompletedAt: null,
    rollbackTargetSeconds: null,
    out: null,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--test-run-id=')) args.testRunId = arg.slice('--test-run-id='.length);
    else if (arg.startsWith('--answer-rate-baseline=')) {
      const parsed = Number.parseFloat(arg.slice('--answer-rate-baseline='.length));
      if (Number.isFinite(parsed)) args.answerRateBaseline = parsed;
    } else if (arg.startsWith('--min-answer-canary-attempts=')) {
      const parsed = Number.parseInt(arg.slice('--min-answer-canary-attempts='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) args.minAnswerCanaryAttempts = parsed;
    } else if (arg.startsWith('--rollback-started-at=')) {
      args.rollbackStartedAt = arg.slice('--rollback-started-at='.length);
    } else if (arg.startsWith('--rollback-completed-at=')) {
      args.rollbackCompletedAt = arg.slice('--rollback-completed-at='.length);
    } else if (arg.startsWith('--rollback-target-seconds=')) {
      const parsed = Number.parseInt(arg.slice('--rollback-target-seconds='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) args.rollbackTargetSeconds = parsed;
    } else if (arg.startsWith('--out=')) {
      args.out = arg.slice('--out='.length);
    }
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  npm run phase5:live-ab-report -- --test-run-id=<id>',
    '  npm run phase5:live-ab-report -- --test-run-id=<id> --answer-rate-baseline=0.72',
    '  npm run phase5:live-ab-report -- --test-run-id=<id> --rollback-started-at=<iso> --rollback-completed-at=<iso> --rollback-target-seconds=300',
    '',
    'Output is PHI-safe aggregate counts only: no names, phone numbers, transcripts, reminder text, notes, prompts, or raw senior IDs.',
  ].join('\n');
}

function normalizeValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, normalizeValue(inner)])
    );
  }
  return value;
}

function rowsFrom(result) {
  return (result?.rows || []).map(normalizeValue);
}

function firstRow(result) {
  return rowsFrom(result)[0] || {};
}

function intValue(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function roundedRate(value) {
  return value == null ? null : Math.round(value * 10000) / 10000;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function elapsedSeconds(startedAt, completedAt) {
  const start = startedAt ? new Date(startedAt) : null;
  const end = completedAt ? new Date(completedAt) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

function passedCheck(name, passed, details = {}) {
  return { name, status: passed ? 'passed' : 'failed', ...details };
}

function skippedCheck(name, reason, details = {}) {
  return { name, status: 'skipped', reason, ...details };
}

export function evaluatePhase5Report({
  attemptSummary,
  duplicateSummary,
  conversationSummary,
  reminderDeliverySummary,
  rollbackSummary = null,
  cohortDriftSummary = null,
  answerRateBaseline = null,
  minAnswerCanaryAttempts = DEFAULT_MIN_ANSWER_CANARY_ATTEMPTS,
} = {}) {
  const attempts = intValue(attemptSummary.totalAttempts);
  const answered = intValue(attemptSummary.answeredAttempts);
  const mediaStarted = intValue(attemptSummary.mediaStartedAttempts);
  const answerRate = ratio(answered, attempts);
  const mediaStartRate = ratio(mediaStarted, answered);
  const duplicateOutboundRows = intValue(duplicateSummary.duplicateQueueAttemptRows) +
    intValue(duplicateSummary.duplicateCallControlRows);
  const duplicateConversationRows = intValue(conversationSummary.duplicateConversationRows);
  const duplicateReminderDeliveryRows = intValue(reminderDeliverySummary.duplicateReminderDeliveryRows);

  const checks = [
    passedCheck('attempts_present', attempts > 0, { attempts }),
    passedCheck('duplicate_outbound_calls', duplicateOutboundRows === 0, {
      duplicateQueueAttemptRows: intValue(duplicateSummary.duplicateQueueAttemptRows),
      duplicateCallControlRows: intValue(duplicateSummary.duplicateCallControlRows),
    }),
    passedCheck('duplicate_conversations', duplicateConversationRows === 0, {
      duplicateConversationRows,
    }),
    passedCheck('duplicate_reminder_deliveries', duplicateReminderDeliveryRows === 0, {
      duplicateReminderDeliveryRows,
    }),
    passedCheck('media_start_rate', mediaStartRate != null && mediaStartRate >= MEDIA_START_RATE_TARGET, {
      answeredAttempts: answered,
      mediaStartedAttempts: mediaStarted,
      mediaStartRate: roundedRate(mediaStartRate),
      target: MEDIA_START_RATE_TARGET,
    }),
  ];

  if (answerRateBaseline == null) {
    checks.push(skippedCheck('caller_id_answer_rate', 'answer-rate baseline not provided', {
      attempts,
      answeredAttempts: answered,
      answerRate: roundedRate(answerRate),
    }));
  } else {
    const target = answerRateBaseline * ANSWER_RATE_BASELINE_FACTOR;
    checks.push(passedCheck(
      'caller_id_answer_rate',
      attempts >= minAnswerCanaryAttempts && answerRate != null && answerRate >= target,
      {
        attempts,
        minAttempts: minAnswerCanaryAttempts,
        answeredAttempts: answered,
        answerRate: roundedRate(answerRate),
        baseline: answerRateBaseline,
        target: roundedRate(target),
      }
    ));
  }

  if (rollbackSummary) {
    const drainClean = intValue(rollbackSummary.activeQueueRows) === 0 &&
      intValue(rollbackSummary.activeAttempts) === 0;
    checks.push(passedCheck('rollback_drain', drainClean, {
      activeQueueRows: intValue(rollbackSummary.activeQueueRows),
      activeAttempts: intValue(rollbackSummary.activeAttempts),
      elapsedSeconds: rollbackSummary.elapsedSeconds,
    }));
    // Phase 5 §4 — rollback must complete inside a configured SLO target.
    // When rollback timestamps are present, the target is mandatory so the
    // drill cannot pass by merely recording elapsed time.
    if (rollbackSummary.targetSeconds != null) {
      const elapsed = rollbackSummary.elapsedSeconds;
      const elapsedNumeric = typeof elapsed === 'number' ? elapsed : null;
      const withinTarget = elapsedNumeric != null &&
        elapsedNumeric >= 0 &&
        elapsedNumeric <= rollbackSummary.targetSeconds;
      checks.push(passedCheck('rollback_within_target', withinTarget, {
        targetSeconds: rollbackSummary.targetSeconds,
        elapsedSeconds: elapsedNumeric,
      }));
    } else {
      checks.push(passedCheck('rollback_within_target', false, {
        reason: 'no --rollback-target-seconds SLO declared',
        elapsedSeconds: rollbackSummary.elapsedSeconds,
      }));
    }
  } else {
    checks.push(skippedCheck('rollback_drain', 'rollback timestamps not provided'));
    checks.push(skippedCheck('rollback_within_target', 'rollback timestamps not provided'));
  }

  // Phase 5 §6 — every due-call decision records {architecture, cohort,
  // test_run_id} and a senior cannot move cohorts mid-flight. If a senior
  // appears in more than one (architecture, cohort) tuple within the test
  // window, the cohort split is bleeding — fail loudly.
  if (cohortDriftSummary) {
    const driftingSeniors = intValue(cohortDriftSummary.driftingSeniors);
    checks.push(passedCheck('cohort_no_drift', driftingSeniors === 0, {
      driftingSeniors,
    }));
  } else {
    checks.push(skippedCheck('cohort_no_drift', 'cohort drift summary not provided'));
  }

  const required = checks.filter(check => check.status !== 'skipped');
  const failed = required.filter(check => check.status !== 'passed');

  return {
    ok: failed.length === 0,
    checks,
    summary: {
      attempts,
      answeredAttempts: answered,
      mediaStartedAttempts: mediaStarted,
      answerRate: roundedRate(answerRate),
      mediaStartRate: roundedRate(mediaStartRate),
      failedChecks: failed.length,
    },
  };
}

export async function buildPhase5LiveAbReport({
  database = db,
  testRunId,
  answerRateBaseline = null,
  minAnswerCanaryAttempts = DEFAULT_MIN_ANSWER_CANARY_ATTEMPTS,
  rollbackStartedAt = null,
  rollbackCompletedAt = null,
  rollbackTargetSeconds = null,
  now = new Date(),
} = {}) {
  if (!testRunId) throw new Error('testRunId is required');

  const attemptSummary = firstRow(await database.execute(sql`
    SELECT
      COUNT(*)::int AS "totalAttempts",
      COUNT(*) FILTER (WHERE answered_at IS NOT NULL)::int AS "answeredAttempts",
      COUNT(*) FILTER (WHERE media_started_at IS NOT NULL)::int AS "mediaStartedAttempts",
      COUNT(*) FILTER (WHERE ended_at IS NOT NULL)::int AS "endedAttempts",
      COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedAttempts"
    FROM call_attempts
    WHERE test_run_id = ${testRunId}
  `));

  const cohortBreakdown = rowsFrom(await database.execute(sql`
    SELECT
      COALESCE(architecture, 'unknown') AS architecture,
      COALESCE(cohort, 'unknown') AS cohort,
      COUNT(*)::int AS attempts,
      COUNT(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered,
      COUNT(*) FILTER (WHERE media_started_at IS NOT NULL)::int AS "mediaStarted"
    FROM call_attempts
    WHERE test_run_id = ${testRunId}
    GROUP BY COALESCE(architecture, 'unknown'), COALESCE(cohort, 'unknown')
    ORDER BY architecture, cohort
  `));

  const duplicateQueueAttempts = firstRow(await database.execute(sql`
    SELECT
      COUNT(*)::int AS "duplicateQueueAttemptKeys",
      COALESCE(SUM(row_count - 1), 0)::int AS "duplicateQueueAttemptRows"
    FROM (
      SELECT queue_id, COUNT(*)::int AS row_count
      FROM call_attempts
      WHERE test_run_id = ${testRunId}
        AND queue_id IS NOT NULL
      GROUP BY queue_id
      HAVING COUNT(*) > 1
    ) grouped
  `));

  const duplicateCallControls = firstRow(await database.execute(sql`
    SELECT
      COUNT(*)::int AS "duplicateCallControlKeys",
      COALESCE(SUM(row_count - 1), 0)::int AS "duplicateCallControlRows"
    FROM (
      SELECT call_control_id, COUNT(*)::int AS row_count
      FROM call_attempts
      WHERE test_run_id = ${testRunId}
        AND call_control_id IS NOT NULL
      GROUP BY call_control_id
      HAVING COUNT(*) > 1
    ) grouped
  `));

  const conversationSummary = firstRow(await database.execute(sql`
    WITH test_call_sids AS (
      SELECT DISTINCT call_control_id
      FROM call_attempts
      WHERE test_run_id = ${testRunId}
        AND call_control_id IS NOT NULL
    ),
    scoped_conversations AS (
      SELECT c.id, c.status, c.call_sid
      FROM conversations c
      JOIN test_call_sids t ON t.call_control_id = c.call_sid
    ),
    duplicate_rows AS (
      SELECT call_sid, COUNT(*)::int AS row_count
      FROM scoped_conversations
      WHERE call_sid IS NOT NULL
      GROUP BY call_sid
      HAVING COUNT(*) > 1
    )
    SELECT
      (SELECT COUNT(DISTINCT id)::int FROM scoped_conversations) AS conversations,
      (SELECT COUNT(DISTINCT id)::int FROM scoped_conversations WHERE status = 'completed') AS "completedConversations",
      COALESCE((SELECT SUM(row_count - 1)::int FROM duplicate_rows), 0)::int AS "duplicateConversationRows"
  `));

  const reminderDeliverySummary = firstRow(await database.execute(sql`
    WITH test_call_sids AS (
      SELECT DISTINCT call_control_id
      FROM call_attempts
      WHERE test_run_id = ${testRunId}
        AND call_control_id IS NOT NULL
    ),
    scoped_deliveries AS (
      SELECT rd.id, rd.delivery_key
      FROM reminder_deliveries rd
      JOIN test_call_sids t ON t.call_control_id = rd.call_sid
    ),
    duplicate_rows AS (
      SELECT delivery_key, COUNT(*)::int AS row_count
      FROM scoped_deliveries
      WHERE delivery_key IS NOT NULL
      GROUP BY delivery_key
      HAVING COUNT(*) > 1
    )
    SELECT
      (SELECT COUNT(DISTINCT id)::int FROM scoped_deliveries) AS "reminderDeliveries",
      COALESCE((SELECT SUM(row_count - 1)::int FROM duplicate_rows), 0)::int AS "duplicateReminderDeliveryRows"
  `));

  let rollbackSummary = null;
  if (rollbackStartedAt || rollbackCompletedAt) {
    const activeQueue = firstRow(await database.execute(sql`
      SELECT COUNT(*)::int AS "activeQueueRows"
      FROM call_queue
      WHERE id IN (
        SELECT queue_id
        FROM call_attempts
        WHERE test_run_id = ${testRunId}
          AND queue_id IS NOT NULL
      )
        AND status IN ('leased', 'initiating')
    `));
    const activeAttempts = firstRow(await database.execute(sql`
      SELECT COUNT(*)::int AS "activeAttempts"
      FROM call_attempts
      WHERE test_run_id = ${testRunId}
        AND status IN ('initiating')
    `));
    rollbackSummary = {
      rollbackStartedAt: isoOrNull(rollbackStartedAt),
      rollbackCompletedAt: isoOrNull(rollbackCompletedAt),
      elapsedSeconds: elapsedSeconds(rollbackStartedAt, rollbackCompletedAt),
      activeQueueRows: intValue(activeQueue.activeQueueRows),
      activeAttempts: intValue(activeAttempts.activeAttempts),
      targetSeconds: rollbackTargetSeconds,
    };
  }

  // Cohort drift detection — Phase 5 §6 invariant. Any senior whose call
  // attempts within this test_run_id span more than one
  // (architecture, cohort) tuple is bleeding across the A/B boundary and
  // the test is no longer measuring what it claims to measure.
  const cohortDrift = firstRow(await database.execute(sql`
    WITH per_senior AS (
      SELECT senior_id,
             COUNT(DISTINCT COALESCE(architecture, 'unknown') || ':' || COALESCE(cohort, 'unknown')) AS tuples
      FROM call_attempts
      WHERE test_run_id = ${testRunId}
      GROUP BY senior_id
    )
    SELECT
      COUNT(*) FILTER (WHERE tuples > 1)::int AS "driftingSeniors",
      COUNT(*)::int AS "seniorsObserved"
    FROM per_senior
  `));
  const cohortDriftSummary = {
    driftingSeniors: intValue(cohortDrift.driftingSeniors),
    seniorsObserved: intValue(cohortDrift.seniorsObserved),
  };

  const duplicateSummary = {
    ...duplicateQueueAttempts,
    ...duplicateCallControls,
  };
  const evaluation = evaluatePhase5Report({
    attemptSummary,
    duplicateSummary,
    conversationSummary,
    reminderDeliverySummary,
    rollbackSummary,
    cohortDriftSummary,
    answerRateBaseline,
    minAnswerCanaryAttempts,
  });

  return {
    ok: evaluation.ok,
    testRunId,
    generatedAt: now.toISOString(),
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: 'Aggregate counts only. No senior IDs, names, phone numbers, transcripts, reminder text, notes, prompts, or raw call payloads.',
    },
    metrics: {
      attempts: {
        total: intValue(attemptSummary.totalAttempts),
        answered: intValue(attemptSummary.answeredAttempts),
        mediaStarted: intValue(attemptSummary.mediaStartedAttempts),
        ended: intValue(attemptSummary.endedAttempts),
        failed: intValue(attemptSummary.failedAttempts),
      },
      cohortBreakdown,
      duplicates: {
        duplicateQueueAttemptKeys: intValue(duplicateSummary.duplicateQueueAttemptKeys),
        duplicateQueueAttemptRows: intValue(duplicateSummary.duplicateQueueAttemptRows),
        duplicateCallControlKeys: intValue(duplicateSummary.duplicateCallControlKeys),
        duplicateCallControlRows: intValue(duplicateSummary.duplicateCallControlRows),
        duplicateConversationRows: intValue(conversationSummary.duplicateConversationRows),
        duplicateReminderDeliveryRows: intValue(reminderDeliverySummary.duplicateReminderDeliveryRows),
      },
      conversations: {
        total: intValue(conversationSummary.conversations),
        completed: intValue(conversationSummary.completedConversations),
      },
      reminderDeliveries: {
        total: intValue(reminderDeliverySummary.reminderDeliveries),
      },
      rollback: rollbackSummary,
      cohortDrift: cohortDriftSummary,
    },
    checks: evaluation.checks,
    summary: evaluation.summary,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const report = await buildPhase5LiveAbReport(args);
  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    await fs.writeFile(args.out, `${json}\n`);
  }
  console.log(json);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({
      ok: false,
      error: String(error?.message || error || 'unknown_error').slice(0, 240),
      phiPolicy: {
        outputContainsRawPhi: false,
      },
    }, null, 2));
    process.exit(1);
  });
}
