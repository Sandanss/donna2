#!/usr/bin/env node

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  phase8PlanOptionsFromEnv,
  runPhase8AutoscalerOnce,
} from '../services/phase8-autoscaler.js';

function parseInteger(value, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function parseNumber(value, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseArgs(argv) {
  const args = {
    help: false,
    confirmScale: false,
    dryRun: true,
    now: null,
    windowStart: null,
    windowMinutes: null,
    currentReplicas: null,
    minReplicas: null,
    maxCallsPerReplica: null,
    overbookFactor: null,
    warmupMinutes: null,
    readyMinutesBeforeWindow: null,
    criticalBacklogThreshold: null,
    costPerReplicaHour: null,
    hourlyBudget: null,
    service: null,
    environment: null,
    region: null,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--confirm-scale') {
      args.confirmScale = true;
      args.dryRun = false;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--now=')) args.now = arg.slice('--now='.length);
    else if (arg.startsWith('--window-start=')) args.windowStart = arg.slice('--window-start='.length);
    else if (arg.startsWith('--window-minutes=')) args.windowMinutes = parseInteger(arg.slice('--window-minutes='.length), 15, { min: 1, max: 240 });
    else if (arg.startsWith('--current-replicas=')) args.currentReplicas = parseInteger(arg.slice('--current-replicas='.length), 0, { min: 0, max: 50 });
    else if (arg.startsWith('--min-replicas=')) args.minReplicas = parseInteger(arg.slice('--min-replicas='.length), 2, { min: 0, max: 50 });
    else if (arg.startsWith('--max-calls-per-replica=')) args.maxCallsPerReplica = parseInteger(arg.slice('--max-calls-per-replica='.length), 50, { min: 1, max: 10000 });
    else if (arg.startsWith('--overbook-factor=')) args.overbookFactor = parseNumber(arg.slice('--overbook-factor='.length), 1, { min: 0.1, max: 2 });
    else if (arg.startsWith('--warmup-minutes=')) args.warmupMinutes = parseInteger(arg.slice('--warmup-minutes='.length), 20, { min: 1, max: 120 });
    else if (arg.startsWith('--ready-minutes-before-window=')) args.readyMinutesBeforeWindow = parseInteger(arg.slice('--ready-minutes-before-window='.length), 10, { min: 1, max: 120 });
    else if (arg.startsWith('--critical-backlog-threshold=')) args.criticalBacklogThreshold = parseInteger(arg.slice('--critical-backlog-threshold='.length), 0, { min: 0, max: 100000 });
    else if (arg.startsWith('--cost-per-replica-hour=')) args.costPerReplicaHour = optionalNumber(arg.slice('--cost-per-replica-hour='.length));
    else if (arg.startsWith('--hourly-budget=')) args.hourlyBudget = optionalNumber(arg.slice('--hourly-budget='.length));
    else if (arg.startsWith('--service=')) args.service = arg.slice('--service='.length);
    else if (arg.startsWith('--environment=')) args.environment = arg.slice('--environment='.length);
    else if (arg.startsWith('--region=')) args.region = arg.slice('--region='.length);
  }

  return args;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner != null));
}

function usage() {
  return [
    'Usage:',
    '  npm run phase8:autoscaler-once -- --window-start=2035-03-18T14:00:00.000Z --current-replicas=2',
    '  npm run phase8:autoscaler-once -- --confirm-scale --service=donna-pipecat --environment=production --region=us-west',
    '',
    'Defaults to dry-run. Pass --confirm-scale to let the worker execute `railway scale`.',
    'Output is PHI-free aggregate capacity and scaling data only.',
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

  const envPlanOptions = phase8PlanOptionsFromEnv();
  const cliPlanOptions = compactObject({
    windowStart: args.windowStart,
    windowMinutes: args.windowMinutes,
    currentReplicas: args.currentReplicas,
    minReplicas: args.minReplicas,
    maxCallsPerReplica: args.maxCallsPerReplica,
    overbookFactor: args.overbookFactor,
    warmupMinutes: args.warmupMinutes,
    readyMinutesBeforeWindow: args.readyMinutesBeforeWindow,
    criticalBacklogThreshold: args.criticalBacklogThreshold,
    costPerReplicaHour: args.costPerReplicaHour,
    hourlyBudget: args.hourlyBudget,
  });

  const result = await runPhase8AutoscalerOnce({
    planOptions: {
      ...envPlanOptions,
      ...cliPlanOptions,
    },
    confirmScale: args.confirmScale,
    dryRun: args.dryRun,
    scaleOptions: compactObject({
      service: args.service,
      environment: args.environment,
      region: args.region,
    }),
    now: args.now ? new Date(args.now) : new Date(),
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
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
