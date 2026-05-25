#!/usr/bin/env node

import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  CALL_QUEUE_STATUSES,
  PRIORITY_LANES,
  buildLaneCapacityPlan,
  estimateAvailablePipecatCapacity,
  normalizeLanePressure,
} from './call-queue.js';
import { readPipecatCapacityRegistry } from './pipecat-capacity.js';
import {
  POST_CALL_JOB_STATUSES,
  POST_CALL_JOB_TYPES,
} from './post-call-jobs.js';

const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_WARMUP_MINUTES = 20;
const DEFAULT_READY_MINUTES_BEFORE_WINDOW = 10;
const DEFAULT_MIN_REPLICAS = 2;
const DEFAULT_MAX_CALLS_PER_REPLICA = 50;
const PHI_POLICY_NOTE = [
  'Aggregate operational report only.',
  'No senior IDs, phone numbers, transcripts, summaries, reminder text, notes, prompts, or payload bodies are selected or emitted.',
].join(' ');

function parseNumber(value, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function parseInteger(value, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function parseOptionalInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
}

function parseOptionalNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
}

function parseDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO date`);
  }
  return date;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function subtractMinutes(date, minutes) {
  return new Date(date.getTime() - minutes * 60 * 1000);
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function countValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function laneValue(value) {
  const lane = String(value || '').trim();
  return Object.values(PRIORITY_LANES).includes(lane) ? lane : null;
}

function statusValue(value) {
  const status = String(value || '').trim();
  return Object.values(CALL_QUEUE_STATUSES).includes(status) ? status : null;
}

function rowsFrom(result) {
  return result?.rows || [];
}

function firstRow(result) {
  return rowsFrom(result)[0] || {};
}

function sum(values) {
  return values.reduce((total, value) => total + countValue(value), 0);
}

function queueDemandRowsToSummary(rows = []) {
  const byLane = normalizeLanePressure();
  const byStatus = {};
  let unknownLane = 0;
  let total = 0;

  for (const row of rows) {
    const count = countValue(row.count);
    if (count <= 0) continue;

    total += count;

    const lane = laneValue(row.priorityLane ?? row.priority_lane);
    if (lane) {
      byLane[lane] += count;
    } else {
      unknownLane += count;
    }

    const status = statusValue(row.status) || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + count;
  }

  return {
    total,
    byLane,
    byStatus,
    unknownLane,
  };
}

function mergeQueueDemandSummaries(...summaries) {
  const merged = {
    total: 0,
    byLane: normalizeLanePressure(),
    byStatus: {},
    unknownLane: 0,
  };

  for (const summary of summaries) {
    if (!summary) continue;
    merged.total += countValue(summary.total);
    merged.unknownLane += countValue(summary.unknownLane);
    for (const lane of Object.values(PRIORITY_LANES)) {
      merged.byLane[lane] += countValue(summary.byLane?.[lane]);
    }
    for (const [status, count] of Object.entries(summary.byStatus || {})) {
      merged.byStatus[status] = (merged.byStatus[status] || 0) + countValue(count);
    }
  }

  return merged;
}

function instanceActiveCalls(instance) {
  return Math.max(
    countValue(instance?.activeCalls ?? instance?.active_calls),
    countValue(instance?.inboundActiveCalls ?? instance?.inbound_active_calls),
  );
}

function instancePendingReservations(instance) {
  return countValue(
    instance?.pendingReservations ??
    instance?.pending_reservations ??
    instance?.pendingStartCount ??
    instance?.pending_start_count,
  );
}

function instanceMaxCalls(instance) {
  return countValue(instance?.maxCalls ?? instance?.max_calls);
}

function isAvailableReplica(instance) {
  if (!instance) return false;
  if (instance.healthy === false) return false;
  if (instance.draining === true) return false;
  if (instance.ready === false) return false;
  if (instance.warmupGateGreen === false) return false;
  return true;
}

export function summarizeCapacityRegistry(registry = {}, {
  overbookFactor = 1,
  fallbackMaxCallsPerReplica = DEFAULT_MAX_CALLS_PER_REPLICA,
} = {}) {
  const instances = Array.isArray(registry?.instances) ? registry.instances : [];
  const availableInstances = instances.filter(isAvailableReplica);
  const activeCalls = sum(instances.map(instanceActiveCalls));
  const pendingReservations = sum(instances.map(instancePendingReservations));
  const totalMaxCalls = sum(instances.map(instanceMaxCalls));
  const configuredMaxCalls = totalMaxCalls || instances.length * fallbackMaxCallsPerReplica;

  return {
    configured: registry?.configured !== false,
    backend: registry?.backend || 'unknown',
    totalReplicas: instances.length,
    readyReplicas: availableInstances.length,
    drainingReplicas: instances.filter(instance => instance?.draining === true).length,
    warmupGateRedReplicas: instances.filter(instance => instance?.warmupGateGreen === false).length,
    activeCalls,
    pendingReservations,
    maxCalls: configuredMaxCalls,
    availableSlots: estimateAvailablePipecatCapacity({
      instances: availableInstances,
      overbookFactor,
    }),
    registryError: registry?.error || null,
  };
}

export function buildScaleRecommendation({
  now = new Date(),
  windowStart,
  queuedDemand = 0,
  availableSlots = 0,
  currentReplicas = 0,
  readyReplicas = 0,
  activeCalls = 0,
  pendingReservations = 0,
  criticalPostCallBacklog = 0,
  minReplicas = DEFAULT_MIN_REPLICAS,
  maxCallsPerReplica = DEFAULT_MAX_CALLS_PER_REPLICA,
  warmupMinutes = DEFAULT_WARMUP_MINUTES,
  readyMinutesBeforeWindow = DEFAULT_READY_MINUTES_BEFORE_WINDOW,
  criticalBacklogThreshold = 0,
  costPerReplicaHour = null,
  hourlyBudget = null,
} = {}) {
  const safeNow = parseDate(now, 'now');
  const safeWindowStart = parseDate(windowStart, 'windowStart');
  const safeQueuedDemand = countValue(queuedDemand);
  const safeActiveCalls = countValue(activeCalls);
  const safePendingReservations = countValue(pendingReservations);
  const safeCriticalBacklog = countValue(criticalPostCallBacklog);
  const safeMaxCallsPerReplica = Math.max(1, countValue(maxCallsPerReplica) || DEFAULT_MAX_CALLS_PER_REPLICA);
  const safeMinReplicas = Math.max(0, countValue(minReplicas));
  const safeCurrentReplicas = Math.max(0, countValue(currentReplicas));
  const safeAvailableSlots = Math.max(0, countValue(availableSlots));
  const demandWithLiveLoad = safeQueuedDemand + safeActiveCalls + safePendingReservations;
  const requiredReplicas = Math.max(
    safeMinReplicas,
    Math.ceil(demandWithLiveLoad / safeMaxCallsPerReplica),
  );
  const scaleUpAt = subtractMinutes(safeWindowStart, warmupMinutes);
  const targetReadyAt = subtractMinutes(safeWindowStart, readyMinutesBeforeWindow);
  const scaleDownSafe = safeQueuedDemand === 0 &&
    safeActiveCalls === 0 &&
    safePendingReservations === 0 &&
    safeCriticalBacklog <= criticalBacklogThreshold;
  const scaleUpLate = safeNow.getTime() > scaleUpAt.getTime();

  let action = 'hold';
  let targetReplicas = safeCurrentReplicas;
  let reason = 'current_capacity_matches_window_demand';

  if (safeCurrentReplicas < requiredReplicas) {
    action = 'scale_up';
    targetReplicas = requiredReplicas;
    reason = 'future_window_demand_exceeds_current_replica_count';
  } else if (safeQueuedDemand > safeAvailableSlots) {
    action = 'wait_for_readiness';
    targetReplicas = safeCurrentReplicas;
    reason = 'configured_replicas_exist_but_ready_capacity_is_not_green';
  } else if (scaleDownSafe && safeCurrentReplicas > safeMinReplicas) {
    action = 'scale_down';
    targetReplicas = safeMinReplicas;
    reason = 'off_peak_idle_and_backlog_clear';
  } else if (!scaleDownSafe && safeQueuedDemand === 0 && safeCurrentReplicas > safeMinReplicas) {
    reason = 'scale_down_blocked_by_active_calls_reservations_or_critical_backlog';
  }

  const projectedHourlyCost = costPerReplicaHour == null
    ? null
    : round4(targetReplicas * costPerReplicaHour);
  const withinHourlyBudget = hourlyBudget == null || projectedHourlyCost == null
    ? null
    : projectedHourlyCost <= hourlyBudget;

  return {
    action,
    reason,
    targetReplicas,
    requiredReplicas,
    currentReplicas: safeCurrentReplicas,
    readyReplicas: countValue(readyReplicas),
    scaleUpBy: Math.max(0, targetReplicas - safeCurrentReplicas),
    scaleDownBy: Math.max(0, safeCurrentReplicas - targetReplicas),
    scaleDownSafe,
    scaleUpLate: action === 'scale_up' ? scaleUpLate : false,
    scaleUpAt: scaleUpAt.toISOString(),
    targetReadyAt: targetReadyAt.toISOString(),
    cost: {
      costPerReplicaHour,
      projectedHourlyCost,
      hourlyBudget,
      withinHourlyBudget,
    },
  };
}

async function fetchFutureQueueDemand({ database, windowStart, windowEnd }) {
  const result = await database.execute(sql`
    SELECT priority_lane, status, COUNT(*)::int AS count
    FROM call_queue
    WHERE status IN (${CALL_QUEUE_STATUSES.QUEUED}, ${CALL_QUEUE_STATUSES.DEFERRED})
      AND target_at >= ${windowStart}
      AND target_at < ${windowEnd}
    GROUP BY priority_lane, status
  `);

  return queueDemandRowsToSummary(rowsFrom(result));
}

async function fetchCurrentQueueBacklog({ database, now, windowStart }) {
  const result = await database.execute(sql`
    SELECT priority_lane, status, COUNT(*)::int AS count
    FROM call_queue
    WHERE status IN (
      ${CALL_QUEUE_STATUSES.QUEUED},
      ${CALL_QUEUE_STATUSES.DEFERRED},
      ${CALL_QUEUE_STATUSES.LEASED},
      ${CALL_QUEUE_STATUSES.INITIATING}
    )
      AND earliest_at <= ${now}
      AND target_at < ${windowStart}
    GROUP BY priority_lane, status
  `);

  return queueDemandRowsToSummary(rowsFrom(result));
}

async function fetchCriticalPostCallBacklog({ database }) {
  const result = await database.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM post_call_jobs
    WHERE status IN (
      ${POST_CALL_JOB_STATUSES.QUEUED},
      ${POST_CALL_JOB_STATUSES.LEASED},
      ${POST_CALL_JOB_STATUSES.RUNNING},
      ${POST_CALL_JOB_STATUSES.FAILED}
    )
      AND job_type IN (
        ${POST_CALL_JOB_TYPES.METRICS_FINALIZE},
        ${POST_CALL_JOB_TYPES.REMINDER_RECOVERY}
      )
  `);
  return countValue(firstRow(result).count);
}

function buildChecks({ recommendation, cost, now, scaleUpAt }) {
  const checks = [
    {
      name: 'warmup_gate_consumed',
      status: 'passed',
      detail: 'Replicas with warmupGateGreen=false are excluded from available capacity.',
    },
    {
      name: 'scale_down_guard',
      status: recommendation.action === 'scale_down' && !recommendation.scaleDownSafe ? 'failed' : 'passed',
      detail: 'Scale-down is allowed only when demand, active calls, reservations, and critical post-call backlog are clear.',
    },
  ];

  if (recommendation.action === 'scale_up') {
    checks.push({
      name: 'scale_up_schedule',
      status: new Date(now).getTime() <= new Date(scaleUpAt).getTime() ? 'passed' : 'failed',
      detail: 'Scale-up should be scheduled before the configured warm-up lead time.',
    });
  }

  if (cost.withinHourlyBudget != null) {
    checks.push({
      name: 'hourly_cost_budget',
      status: cost.withinHourlyBudget ? 'passed' : 'failed',
      detail: 'Projected target replica hourly cost is compared with the Phase 0 budget input.',
    });
  } else {
    checks.push({
      name: 'hourly_cost_budget',
      status: 'skipped',
      detail: 'Pass --cost-per-replica-hour and --hourly-budget to evaluate the budget gate.',
    });
  }

  return checks;
}

export async function buildPhase8CapacityPlan({
  database = db,
  capacityRegistryReader = readPipecatCapacityRegistry,
  now = new Date(),
  windowStart = null,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
  currentReplicas = null,
  minReplicas = DEFAULT_MIN_REPLICAS,
  maxCallsPerReplica = DEFAULT_MAX_CALLS_PER_REPLICA,
  overbookFactor = 1,
  warmupMinutes = DEFAULT_WARMUP_MINUTES,
  readyMinutesBeforeWindow = DEFAULT_READY_MINUTES_BEFORE_WINDOW,
  criticalBacklogThreshold = 0,
  costPerReplicaHour = null,
  hourlyBudget = null,
} = {}) {
  const safeNow = parseDate(now, 'now');
  const safeWindowStart = windowStart
    ? parseDate(windowStart, 'windowStart')
    : addMinutes(safeNow, warmupMinutes);
  const safeWindowMinutes = parseInteger(windowMinutes, DEFAULT_WINDOW_MINUTES, { min: 1, max: 240 });
  const safeWindowEnd = addMinutes(safeWindowStart, safeWindowMinutes);

  const [futureDemand, currentBacklog, criticalBacklog, registry] = await Promise.all([
    fetchFutureQueueDemand({ database, windowStart: safeWindowStart, windowEnd: safeWindowEnd }),
    fetchCurrentQueueBacklog({ database, now: safeNow, windowStart: safeWindowStart }),
    fetchCriticalPostCallBacklog({ database }),
    capacityRegistryReader({ now: safeNow }),
  ]);
  const demand = mergeQueueDemandSummaries(futureDemand, currentBacklog);
  const capacity = summarizeCapacityRegistry(registry, {
    overbookFactor,
    fallbackMaxCallsPerReplica: maxCallsPerReplica,
  });
  const resolvedCurrentReplicas = currentReplicas == null
    ? capacity.totalReplicas
    : currentReplicas;
  const recommendation = buildScaleRecommendation({
    now: safeNow,
    windowStart: safeWindowStart,
    queuedDemand: demand.total,
    availableSlots: capacity.availableSlots,
    currentReplicas: resolvedCurrentReplicas,
    readyReplicas: capacity.readyReplicas,
    activeCalls: capacity.activeCalls,
    pendingReservations: capacity.pendingReservations,
    criticalPostCallBacklog: criticalBacklog,
    minReplicas,
    maxCallsPerReplica,
    warmupMinutes,
    readyMinutesBeforeWindow,
    criticalBacklogThreshold,
    costPerReplicaHour,
    hourlyBudget,
  });
  const lanePlan = buildLaneCapacityPlan({
    capacitySlots: capacity.availableSlots,
    lanePressure: demand.byLane,
  });
  const checks = buildChecks({
    recommendation,
    cost: recommendation.cost,
    now: safeNow,
    scaleUpAt: recommendation.scaleUpAt,
  });

  return {
    ok: checks.every(check => check.status !== 'failed'),
    generatedAt: safeNow.toISOString(),
    window: {
      start: safeWindowStart.toISOString(),
      end: safeWindowEnd.toISOString(),
      minutes: safeWindowMinutes,
      warmupMinutes,
      readyMinutesBeforeWindow,
    },
    demand,
    demandBreakdown: {
      futureWindow: futureDemand,
      currentBacklog,
    },
    capacity: {
      ...capacity,
      currentReplicas: resolvedCurrentReplicas,
      overbookFactor,
      maxCallsPerReplica,
    },
    lanePlan,
    postCall: {
      criticalBacklog,
      criticalBacklogThreshold,
    },
    recommendation,
    checks,
    phiPolicy: {
      outputContainsRawPhi: false,
      notes: PHI_POLICY_NOTE,
    },
  };
}

export function parseArgs(argv) {
  const args = {
    out: null,
    windowStart: null,
    now: null,
    windowMinutes: DEFAULT_WINDOW_MINUTES,
    currentReplicas: null,
    minReplicas: DEFAULT_MIN_REPLICAS,
    maxCallsPerReplica: DEFAULT_MAX_CALLS_PER_REPLICA,
    overbookFactor: 1,
    warmupMinutes: DEFAULT_WARMUP_MINUTES,
    readyMinutesBeforeWindow: DEFAULT_READY_MINUTES_BEFORE_WINDOW,
    criticalBacklogThreshold: 0,
    costPerReplicaHour: null,
    hourlyBudget: null,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg.startsWith('--window-start=')) args.windowStart = arg.slice('--window-start='.length);
    else if (arg.startsWith('--now=')) args.now = arg.slice('--now='.length);
    else if (arg.startsWith('--window-minutes=')) {
      args.windowMinutes = parseInteger(arg.slice('--window-minutes='.length), DEFAULT_WINDOW_MINUTES, { min: 1, max: 240 });
    } else if (arg.startsWith('--current-replicas=')) {
      args.currentReplicas = parseOptionalInteger(arg.slice('--current-replicas='.length), { min: 0, max: 500 });
    } else if (arg.startsWith('--min-replicas=')) {
      args.minReplicas = parseInteger(arg.slice('--min-replicas='.length), DEFAULT_MIN_REPLICAS, { min: 0, max: 500 });
    } else if (arg.startsWith('--max-calls-per-replica=')) {
      args.maxCallsPerReplica = parseInteger(arg.slice('--max-calls-per-replica='.length), DEFAULT_MAX_CALLS_PER_REPLICA, { min: 1, max: 10000 });
    } else if (arg.startsWith('--overbook-factor=')) {
      args.overbookFactor = parseNumber(arg.slice('--overbook-factor='.length), 1, { min: 0.1, max: 2 });
    } else if (arg.startsWith('--warmup-minutes=')) {
      args.warmupMinutes = parseInteger(arg.slice('--warmup-minutes='.length), DEFAULT_WARMUP_MINUTES, { min: 1, max: 120 });
    } else if (arg.startsWith('--ready-minutes-before-window=')) {
      args.readyMinutesBeforeWindow = parseInteger(arg.slice('--ready-minutes-before-window='.length), DEFAULT_READY_MINUTES_BEFORE_WINDOW, { min: 1, max: 120 });
    } else if (arg.startsWith('--critical-backlog-threshold=')) {
      args.criticalBacklogThreshold = parseInteger(arg.slice('--critical-backlog-threshold='.length), 0, { min: 0, max: 100000 });
    } else if (arg.startsWith('--cost-per-replica-hour=')) {
      args.costPerReplicaHour = parseOptionalNumber(arg.slice('--cost-per-replica-hour='.length), { min: 0, max: 10000 });
    } else if (arg.startsWith('--hourly-budget=')) {
      args.hourlyBudget = parseOptionalNumber(arg.slice('--hourly-budget='.length), { min: 0, max: 1000000 });
    }
  }

  return args;
}

function usage() {
  return [
    'Usage:',
    '  npm run phase8:capacity-plan -- --window-start=2035-03-18T14:00:00.000Z --current-replicas=2',
    '  npm run phase8:capacity-plan -- --window-minutes=15 --max-calls-per-replica=50 --warmup-minutes=20 --cost-per-replica-hour=0.12 --hourly-budget=1.00',
    '',
    'Output is PHI-free aggregate scheduled-demand, capacity, readiness, and cost data only.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const report = await buildPhase8CapacityPlan({
    now: args.now ? new Date(args.now) : new Date(),
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
