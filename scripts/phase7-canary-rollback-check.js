#!/usr/bin/env node

/**
 * Phase 7 — automated rollback-check trigger.
 *
 * Wraps `phase7-canary-daily-report` and turns its JSON output into a
 * compact alert + recommended action. Designed to run from cron / Railway
 * scheduled job and to alert (via non-zero exit) when SLO breaches require
 * operator attention.
 *
 * IMPORTANT — this script does NOT auto-flip the dispatcher. It prints the
 * exact `CALL_ARCHITECTURE_MODE=legacy_rollback` flip an operator should
 * execute. Auto-flip needs a discussion about how much agency a cron job
 * should have over production dial traffic; for now, the human stays in
 * the loop.
 *
 * Usage:
 *   npm run phase7:canary-rollback-check
 *   npm run phase7:canary-rollback-check -- --window-hours=48
 *   npm run phase7:canary-rollback-check -- --quiet  (no output when clean)
 *
 * Exit codes:
 *   0 — clean, no rollback recommended
 *   1 — breaches present, rollback RECOMMENDED — operator must execute manually
 *   2 — script failure (DB unreachable, etc.)
 */

import 'dotenv/config';
import { pathToFileURL } from 'node:url';

import { buildCanaryDailyReport } from './phase7-canary-daily-report.js';

const DEFAULT_WINDOW_HOURS = 24;

function parseArgs(argv) {
  const args = {
    windowHours: DEFAULT_WINDOW_HOURS,
    quiet: false,
    json: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--quiet' || arg === '-q') args.quiet = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--window-hours=')) {
      const parsed = Number.parseInt(arg.slice('--window-hours='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 24 * 14) args.windowHours = parsed;
    }
  }

  return args;
}

function usage() {
  return [
    'Phase 7 canary rollback-check (operator alert wrapper)',
    '',
    'Usage:',
    '  npm run phase7:canary-rollback-check',
    '  npm run phase7:canary-rollback-check -- --window-hours=48',
    '  npm run phase7:canary-rollback-check -- --quiet',
    '',
    'Reads the same canary_cohort_membership table as the daily report,',
    'evaluates §1.3 SLOs over the last N hours, and prints a compact',
    'alert + recommended manual rollback command when breaches exist.',
    'This script never flips CALL_ARCHITECTURE_MODE on its own.',
  ].join('\n');
}

function describeBreaches(breaches) {
  return breaches.map((breach) => {
    const meta = Object.entries(breach)
      .filter(([key]) => key !== 'name' && key !== 'status' && key !== 'cohort')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return `  - ${breach.name} (${breach.cohort || '?'}) ${meta}`;
  }).join('\n');
}

function rollbackInstructions() {
  return [
    'Recommended action — manual two-level rollback:',
    '',
    '  Level 1 (per-senior, no deploy):',
    "    DELETE /api/canary/members/<senior-uuid>  body={\"reason\":\"ramp_back\"}",
    '',
    '  Level 2 (systemic, requires deploy):',
    '    railway variable set --service donna-api --environment production \\',
    '      CALL_ARCHITECTURE_MODE=legacy_rollback',
    '    make deploy-prod-nodejs',
    '',
    'Then capture the rollback drain stat:',
    '    npm run phase5:live-ab-report -- --rollback-started-at=<iso> --rollback-completed-at=<iso>',
    '',
    'See docs/operations/scale-2000-phase7-canary-runbook.md for the full procedure.',
  ].join('\n');
}

export function summarizeRollbackCheck(report) {
  const evaluation = report?.evaluation || {};
  const breaches = evaluation.breaches || [];
  return {
    ok: Boolean(evaluation.ok),
    windowStart: report.windowStart,
    windowEnd: report.windowEnd,
    canaryCohortSize: report.canaryCohortSize || 0,
    canaryRampPhases: report.canaryRampPhases || [],
    breachCount: breaches.length,
    breaches,
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
    console.error('phase7-canary-rollback-check failed to build report:', error.message);
    process.exit(2);
  }

  const summary = summarizeRollbackCheck(report);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (!summary.ok) {
    console.error('ALERT — Phase 7 canary SLO breach detected');
    console.error(`  window: ${summary.windowStart} → ${summary.windowEnd}`);
    console.error(`  canary cohort size: ${summary.canaryCohortSize} (phases: ${summary.canaryRampPhases.join(',') || '-'})`);
    console.error(`  breaches (${summary.breachCount}):`);
    console.error(describeBreaches(summary.breaches));
    console.error('');
    console.error(rollbackInstructions());
  } else if (!args.quiet) {
    console.log(`OK — Phase 7 canary clean over ${args.windowHours}h window (cohort=${summary.canaryCohortSize})`);
  }

  process.exit(summary.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error('phase7-canary-rollback-check fatal:', error.message);
    process.exit(2);
  });
}
