#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { buildPhase5LiveAbReport } from './phase5-live-ab-report.js';

const MEDIA_START_RATE_TARGET = 0.95;
const ANSWER_RATE_BASELINE_FACTOR = 0.8;
const DEFAULT_REQUIRED_CONTINUOUS_DAYS = 7;
const DEFAULT_MIN_CANARY_SENIORS = 5;
const DEFAULT_MAX_CANARY_SENIORS = 25;
const DEFAULT_MIN_DAILY_CANARY_ATTEMPTS = 1;

function intValue(value) {
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedInt(value, defaultValue, minValue = 0, maxValue = 100000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(minValue, Math.min(maxValue, parsed));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function roundedRate(value) {
  return value == null ? null : Math.round(value * 10000) / 10000;
}

function rowsFrom(result) {
  return result?.rows || [];
}

function firstRow(result) {
  return rowsFrom(result)[0] || {};
}

function dayString(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function dayTimestamp(day) {
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function passedCheck(name, passed, details = {}) {
  return { name, status: passed ? 'passed' : 'failed', ...details };
}

function normalizeDailyCohortRows(rows = []) {
  return rows.map(row => ({
    day: dayString(row.day),
    architecture: String(row.architecture || 'unknown'),
    cohort: String(row.cohort || 'unknown'),
    attempts: intValue(row.attempts),
    answered: intValue(row.answered),
    mediaStarted: intValue(row.mediaStarted ?? row.media_started),
  }));
}

function treatmentRowsByDay(rows = []) {
  const byDay = new Map();
  for (const row of normalizeDailyCohortRows(rows)) {
    if (row.architecture !== 'queue') continue;
    const current = byDay.get(row.day) || {
      day: row.day,
      attempts: 0,
      answered: 0,
      mediaStarted: 0,
    };
    current.attempts += row.attempts;
    current.answered += row.answered;
    current.mediaStarted += row.mediaStarted;
    byDay.set(row.day, current);
  }
  return [...byDay.values()]
    .map(row => ({
      ...row,
      answerRate: roundedRate(ratio(row.answered, row.attempts)),
      mediaStartRate: roundedRate(ratio(row.mediaStarted, row.answered)),
    }))
    .sort((left, right) => left.day.localeCompare(right.day));
}

export function evaluateDailyCanarySlo({
  dailyCohortRows = [],
  answerRateBaseline = null,
  requiredContinuousDays = DEFAULT_REQUIRED_CONTINUOUS_DAYS,
  minDailyCanaryAttempts = DEFAULT_MIN_DAILY_CANARY_ATTEMPTS,
} = {}) {
  const answerRateTarget = answerRateBaseline == null
    ? null
    : answerRateBaseline * ANSWER_RATE_BASELINE_FACTOR;
  const dailyTreatment = treatmentRowsByDay(dailyCohortRows).map(row => {
    const answerRate = ratio(row.answered, row.attempts);
    const mediaStartRate = ratio(row.mediaStarted, row.answered);
    const hasEnoughAttempts = row.attempts >= minDailyCanaryAttempts;
    const answerOk = answerRateTarget == null || (answerRate != null && answerRate >= answerRateTarget);
    const mediaOk = mediaStartRate != null && mediaStartRate >= MEDIA_START_RATE_TARGET;
    return {
      ...row,
      passed: hasEnoughAttempts && answerOk && mediaOk,
      answerRateTarget: roundedRate(answerRateTarget),
      mediaStartRateTarget: MEDIA_START_RATE_TARGET,
      minDailyCanaryAttempts,
    };
  });

  let longestPassingStreak = 0;
  let currentStreak = 0;
  let previousDayTs = null;
  for (const row of dailyTreatment) {
    const currentDayTs = dayTimestamp(row.day);
    const consecutive = previousDayTs != null &&
      currentDayTs != null &&
      currentDayTs - previousDayTs === 24 * 60 * 60 * 1000;
    currentStreak = row.passed
      ? (consecutive ? currentStreak + 1 : 1)
      : 0;
    longestPassingStreak = Math.max(longestPassingStreak, currentStreak);
    previousDayTs = currentDayTs;
  }

  return {
    passed: longestPassingStreak >= requiredContinuousDays,
    requiredContinuousDays,
    longestPassingStreak,
    dailyTreatment,
  };
}

export function evaluatePhase7Canary({
  phase5Report,
  canarySeniors = 0,
  dailyCohortRows = [],
  answerRateBaseline = null,
  requiredContinuousDays = DEFAULT_REQUIRED_CONTINUOUS_DAYS,
  minCanarySeniors = DEFAULT_MIN_CANARY_SENIORS,
  maxCanarySeniors = DEFAULT_MAX_CANARY_SENIORS,
  minDailyCanaryAttempts = DEFAULT_MIN_DAILY_CANARY_ATTEMPTS,
  phiSentinelFindings = 0,
  p0p1Incidents = 0,
} = {}) {
  const canaryCount = intValue(canarySeniors);
  const daily = evaluateDailyCanarySlo({
    dailyCohortRows,
    answerRateBaseline,
    requiredContinuousDays,
    minDailyCanaryAttempts,
  });
  const rollbackCheck = (phase5Report?.checks || []).find(check => check.name === 'rollback_within_target');
  const baseRequiredFailures = (phase5Report?.checks || [])
    .filter(check => check.status === 'failed')
    .map(check => check.name);
  const checks = [
    passedCheck('phase5_rollout_checks', phase5Report?.ok === true, {
      failedPhase5Checks: baseRequiredFailures,
    }),
    passedCheck('canary_allowlist_size', canaryCount >= minCanarySeniors && canaryCount <= maxCanarySeniors, {
      canarySeniors: canaryCount,
      minCanarySeniors,
      maxCanarySeniors,
    }),
    passedCheck('seven_day_canary_slo', daily.passed, {
      requiredContinuousDays,
      longestPassingStreak: daily.longestPassingStreak,
    }),
    passedCheck('phi_sentinel_clear', intValue(phiSentinelFindings) === 0, {
      phiSentinelFindings: intValue(phiSentinelFindings),
    }),
    passedCheck('no_p0_p1_incidents', intValue(p0p1Incidents) === 0, {
      p0p1Incidents: intValue(p0p1Incidents),
    }),
  ];

  if (rollbackCheck) {
    checks.push(passedCheck('rollback_within_target', rollbackCheck.status === 'passed', {
      sourceStatus: rollbackCheck.status,
      elapsedSeconds: rollbackCheck.elapsedSeconds,
      targetSeconds: rollbackCheck.targetSeconds,
    }));
  } else {
    checks.push(passedCheck('rollback_within_target', false, {
      reason: 'phase5 report did not include rollback evidence',
    }));
  }

  const failed = checks.filter(check => check.status === 'failed');
  return {
    ok: failed.length === 0,
    checks,
    daily,
    summary: {
      canarySeniors: canaryCount,
      longestPassingStreak: daily.longestPassingStreak,
      failedChecks: failed.length,
    },
  };
}

export async function buildPhase7CanaryReport({
  database = db,
  testRunId,
  answerRateBaseline = null,
  rollbackStartedAt = null,
  rollbackCompletedAt = null,
  rollbackTargetSeconds = null,
  requiredContinuousDays = DEFAULT_REQUIRED_CONTINUOUS_DAYS,
  minCanarySeniors = DEFAULT_MIN_CANARY_SENIORS,
  maxCanarySeniors = DEFAULT_MAX_CANARY_SENIORS,
  minDailyCanaryAttempts = DEFAULT_MIN_DAILY_CANARY_ATTEMPTS,
  phiSentinelFindings = 0,
  p0p1Incidents = 0,
  now = new Date(),
} = {}) {
  if (!testRunId) throw new Error('testRunId is required');

  const phase5Report = await buildPhase5LiveAbReport({
    database,
    testRunId,
    answerRateBaseline,
    minAnswerCanaryAttempts: minCanarySeniors,
    rollbackStartedAt,
    rollbackCompletedAt,
    rollbackTargetSeconds,
    now,
  });
  const canarySummary = firstRow(await database.execute(sql`
    SELECT COUNT(DISTINCT senior_id)::int AS "canarySeniors"
    FROM call_attempts
    WHERE test_run_id = ${testRunId}
      AND architecture = 'queue'
  `));
  const dailyCohortRows = normalizeDailyCohortRows(rowsFrom(await database.execute(sql`
    SELECT
      date_trunc('day', COALESCE(dial_started_at, created_at))::date AS day,
      COALESCE(architecture, 'unknown') AS architecture,
      COALESCE(cohort, 'unknown') AS cohort,
      COUNT(*)::int AS attempts,
      COUNT(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered,
      COUNT(*) FILTER (WHERE media_started_at IS NOT NULL)::int AS "mediaStarted"
    FROM call_attempts
    WHERE test_run_id = ${testRunId}
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `)));
  const evaluation = evaluatePhase7Canary({
    phase5Report,
    canarySeniors: canarySummary.canarySeniors,
    dailyCohortRows,
    answerRateBaseline,
    requiredContinuousDays,
    minCanarySeniors,
    maxCanarySeniors,
    minDailyCanaryAttempts,
    phiSentinelFindings,
    p0p1Incidents,
  });

  return {
    ok: evaluation.ok,
    testRunId,
    generatedAt: now.toISOString(),
    phase5: {
      ok: phase5Report.ok,
      summary: phase5Report.summary,
      checks: phase5Report.checks,
      metrics: phase5Report.metrics,
    },
    phase7: {
      canarySeniors: intValue(canarySummary.canarySeniors),
      dailyTreatment: evaluation.daily.dailyTreatment,
      requiredContinuousDays,
      longestPassingStreak: evaluation.daily.longestPassingStreak,
    },
    checks: evaluation.checks,
    summary: evaluation.summary,
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: 'Aggregate canary counts only. No senior IDs, names, phone numbers, transcripts, reminder text, notes, prompts, or raw call payloads.',
    },
  };
}

export function parseArgs(argv) {
  const args = {
    testRunId: null,
    answerRateBaseline: null,
    rollbackStartedAt: null,
    rollbackCompletedAt: null,
    rollbackTargetSeconds: null,
    requiredContinuousDays: DEFAULT_REQUIRED_CONTINUOUS_DAYS,
    minCanarySeniors: DEFAULT_MIN_CANARY_SENIORS,
    maxCanarySeniors: DEFAULT_MAX_CANARY_SENIORS,
    minDailyCanaryAttempts: DEFAULT_MIN_DAILY_CANARY_ATTEMPTS,
    phiSentinelFindings: 0,
    p0p1Incidents: 0,
    out: null,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--test-run-id=')) args.testRunId = arg.slice('--test-run-id='.length);
    else if (arg.startsWith('--answer-rate-baseline=')) args.answerRateBaseline = optionalNumber(arg.slice('--answer-rate-baseline='.length));
    else if (arg.startsWith('--rollback-started-at=')) args.rollbackStartedAt = arg.slice('--rollback-started-at='.length);
    else if (arg.startsWith('--rollback-completed-at=')) args.rollbackCompletedAt = arg.slice('--rollback-completed-at='.length);
    else if (arg.startsWith('--rollback-target-seconds=')) args.rollbackTargetSeconds = boundedInt(arg.slice('--rollback-target-seconds='.length), null, 1, 86400);
    else if (arg.startsWith('--required-continuous-days=')) args.requiredContinuousDays = boundedInt(arg.slice('--required-continuous-days='.length), DEFAULT_REQUIRED_CONTINUOUS_DAYS, 1, 30);
    else if (arg.startsWith('--min-canary-seniors=')) args.minCanarySeniors = boundedInt(arg.slice('--min-canary-seniors='.length), DEFAULT_MIN_CANARY_SENIORS, 1, 1000);
    else if (arg.startsWith('--max-canary-seniors=')) args.maxCanarySeniors = boundedInt(arg.slice('--max-canary-seniors='.length), DEFAULT_MAX_CANARY_SENIORS, 1, 1000);
    else if (arg.startsWith('--min-daily-canary-attempts=')) args.minDailyCanaryAttempts = boundedInt(arg.slice('--min-daily-canary-attempts='.length), DEFAULT_MIN_DAILY_CANARY_ATTEMPTS, 1, 10000);
    else if (arg.startsWith('--phi-sentinel-findings=')) args.phiSentinelFindings = boundedInt(arg.slice('--phi-sentinel-findings='.length), 0, 0, 100000);
    else if (arg.startsWith('--p0p1-incidents=')) args.p0p1Incidents = boundedInt(arg.slice('--p0p1-incidents='.length), 0, 0, 100000);
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  npm run phase7:canary-report -- --test-run-id=<id> --answer-rate-baseline=0.72',
    '  npm run phase7:canary-report -- --test-run-id=<id> --required-continuous-days=7 --min-canary-seniors=5 --max-canary-seniors=25 --rollback-target-seconds=300',
    '',
    'Output is PHI-safe aggregate canary counts only.',
  ].join('\n');
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

  const report = await buildPhase7CanaryReport(args);
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
      phiPolicy: { outputContainsRawPhi: false },
    }, null, 2));
    process.exit(1);
  });
}
