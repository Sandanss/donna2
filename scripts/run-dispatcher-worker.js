#!/usr/bin/env node
/**
 * Standalone Node dispatcher worker (Phase 4 §3, Phase 3 §9).
 *
 * Runs the queue dispatcher + reconciler loops in a process separate from the
 * Express API server, so each can scale independently. Materializer and
 * reconciler are still singletons (advisory-locked inside the DB query);
 * multiple worker replicas are safe because leasing uses FOR UPDATE SKIP
 * LOCKED.
 *
 * Mode and cohort selection are read from the call-architecture config the
 * same way the integrated scheduler reads them, so this worker shares all the
 * shadow_dispatch / canary_queue / queue_primary semantics already defined.
 *
 * Required env:
 *   PIPECAT_PUBLIC_URL — destination for /telnyx/outbound dialing
 *   DONNA_API_KEYS=dispatcher:<key>,... — service auth (see security-config)
 *   REDIS_URL or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *
 * Optional env:
 *   DISPATCHER_TICK_MS                (default 2000)
 *   DISPATCHER_RECONCILER_TICK_MS     (default 15000)
 *   DISPATCHER_WORKER_ID              (default `dispatcher:${pid}`)
 *   NODE_DISPATCHER_DRAIN_TIMEOUT_MS  (default 30000)
 */

import 'dotenv/config';
import {
  CALL_ARCHITECTURE_MODES,
  dispatchQueuedCalls,
  drainQueueDispatcherReservations,
  dryRunDispatchQueuedCalls,
  getQueueDispatcherDrainState,
  reconcileQueueLeases,
  reconcileOutboundCallGuards,
  resolveCallArchitectureConfig,
  setQueueDispatcherDraining,
  validateCallArchitectureConfig,
} from '../services/call-queue.js';
import { readPipecatCapacityRegistry } from '../services/pipecat-capacity.js';
import { initGrowthBook, closeGrowthBook } from '../lib/growthbook.js';
import { getPipecatPublicUrl } from '../lib/security-config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('DispatcherWorker');

const TICK_MS = Math.max(500, Number.parseInt(process.env.DISPATCHER_TICK_MS || '2000', 10) || 2000);
const RECONCILER_TICK_MS = Math.max(
  TICK_MS,
  Number.parseInt(process.env.DISPATCHER_RECONCILER_TICK_MS || '15000', 10) || 15000,
);
const DRAIN_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.NODE_DISPATCHER_DRAIN_TIMEOUT_MS || '30000', 10) || 30000,
);
const WORKER_ID = String(process.env.DISPATCHER_WORKER_ID || `dispatcher:${process.pid}`);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function loadCapacityInputs(config) {
  const capacityInputs = {};
  if (config.shadowCapacitySlots != null) {
    capacityInputs.capacitySlots = config.shadowCapacitySlots;
    return capacityInputs;
  }
  if (!config.useCapacityRegistry) {
    capacityInputs.capacitySlots = config.dispatcherBatchSize;
    return capacityInputs;
  }
  const registry = await readPipecatCapacityRegistry();
  if (registry.error || !registry.configured) {
    if (config.requireCapacityRegistry) {
      throw new Error(`Capacity registry unavailable: ${registry.error || registry.backend}`);
    }
    log.warn('Capacity registry unavailable; falling back to batch-size cap', {
      backend: registry.backend,
      error: registry.error || null,
    });
    capacityInputs.capacitySlots = config.dispatcherBatchSize;
    return capacityInputs;
  }
  capacityInputs.instances = registry.instances;
  if (registry.instances.length === 0) {
    log.warn('Capacity registry has no fresh heartbeats', {
      backend: registry.backend,
      scanned: registry.scanned,
    });
  }
  return capacityInputs;
}

export async function dispatchOnce({ baseUrl }) {
  const config = resolveCallArchitectureConfig();
  if (!config.dispatcherEnabled) return { skipped: 'dispatcher_disabled', mode: config.mode };

  const canaryPercent = config.mode === CALL_ARCHITECTURE_MODES.CANARY_QUEUE
    ? config.canaryPercent
    : 100;
  const canarySeniorIds = config.mode === CALL_ARCHITECTURE_MODES.CANARY_QUEUE
    ? config.canarySeniorIds
    : [];

  const capacityInputs = await loadCapacityInputs(config);

  if (config.allowRealDial) {
    const result = await dispatchQueuedCalls({
      leaseOwner: WORKER_ID,
      ...capacityInputs,
      limit: config.dispatcherBatchSize,
      leaseSeconds: config.dispatchLeaseSeconds,
      baseUrl,
      testRunId: config.testRunId,
      canaryPercent,
      canarySeniorIds,
      respectLanePolicy: true,
      overbookFactor: config.dispatchOverbookFactor,
      architecture: 'queue',
      cohort: config.mode,
    });
    return { mode: config.mode, live: true, ...result };
  }

  const result = await dryRunDispatchQueuedCalls({
    leaseOwner: `${WORKER_ID}:dry-run`,
    ...capacityInputs,
    limit: config.dispatcherBatchSize,
    leaseSeconds: config.dispatchLeaseSeconds,
    testRunId: config.testRunId,
    respectLanePolicy: true,
    overbookFactor: config.dispatchOverbookFactor,
    canaryPercent,
    canarySeniorIds,
  });
  return { mode: config.mode, live: false, ...result };
}

export async function reconcileOnce() {
  const config = resolveCallArchitectureConfig();
  if (!config.reconcilerEnabled) return { skipped: 'reconciler_disabled' };

  const leases = await reconcileQueueLeases({ limit: config.dispatcherBatchSize });
  let guards = { released: 0 };
  try {
    guards = await reconcileOutboundCallGuards({ limit: config.dispatcherBatchSize });
  } catch (error) {
    log.warn('Outbound guard reconciliation failed', { error: error.message });
  }
  return { ...leases, guardsReleased: guards.released };
}

let stopped = false;

async function dispatchLoop({ baseUrl }) {
  while (!stopped) {
    try {
      const result = await dispatchOnce({ baseUrl });
      const noisy = result.dialed > 0
        || result.failed > 0
        || result.suppressed > 0
        || result.leased > 0;
      if (noisy) {
        log.info('Dispatcher tick', result);
      }
    } catch (error) {
      log.error('Dispatcher tick failed', { error: error.message });
    }
    if (stopped) break;
    await sleep(TICK_MS);
  }
}

async function reconcilerLoop() {
  while (!stopped) {
    try {
      const result = await reconcileOnce();
      if (result?.recovered > 0 || result?.expired > 0) {
        log.info('Reconciler tick', result);
      }
    } catch (error) {
      log.error('Reconciler tick failed', { error: error.message });
    }
    if (stopped) break;
    await sleep(RECONCILER_TICK_MS);
  }
}

async function main() {
  const baseUrl = getPipecatPublicUrl() || process.env.PIPECAT_PUBLIC_URL || '';
  if (!baseUrl) {
    throw new Error('PIPECAT_PUBLIC_URL is required for the dispatcher worker');
  }

  const validation = validateCallArchitectureConfig();
  if (!validation.ok) {
    log.error('Architecture config validation failed; refusing to start worker', {
      errors: validation.errors,
      warnings: validation.warnings,
    });
    process.exit(1);
  }
  for (const warning of validation.warnings || []) {
    log.warn('Architecture config warning', { warning });
  }

  await initGrowthBook().catch(error => {
    log.warn('GrowthBook init failed; continuing without flags', { error: error.message });
  });

  log.info('Starting dispatcher worker', {
    workerId: WORKER_ID,
    mode: validation.mode,
    tickMs: TICK_MS,
    reconcilerTickMs: RECONCILER_TICK_MS,
  });

  await Promise.all([
    dispatchLoop({ baseUrl }),
    reconcilerLoop(),
  ]);
}

async function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  log.info('Dispatcher worker draining', { signal });
  setQueueDispatcherDraining(true);
  try {
    const drain = await drainQueueDispatcherReservations({ timeoutMs: DRAIN_TIMEOUT_MS });
    log.info('Dispatcher worker drained', { drain, state: getQueueDispatcherDrainState() });
  } catch (error) {
    log.error('Dispatcher worker drain failed', {
      error: error.message,
      state: getQueueDispatcherDrainState(),
    });
  } finally {
    try { closeGrowthBook(); } catch {}
    process.exit(0);
  }
}

function isEntrypoint() {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  try {
    const entry = process.argv[1].replace(/\\/g, '/');
    return entry.endsWith('scripts/run-dispatcher-worker.js');
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  main().catch(error => {
    log.error('Dispatcher worker crashed', { error: error.message });
    process.exit(1);
  });
}
