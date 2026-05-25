import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { createLogger } from '../lib/logger.js';
import { writeAudit } from './audit.js';
import { initiateTelnyxOutboundCall } from './telnyx.js';
import {
  DEFAULT_RESERVATION_TTL_SECONDS,
  acquirePipecatCapacityReservation,
  releasePipecatCapacityReservation,
} from './pipecat-capacity.js';
import {
  getReplicaAffinityHint,
  isPromptCacheAffinityEnabled,
  pickAffinityReplica,
  recordReplicaAffinity,
} from './dispatcher-affinity.js';

const log = createLogger('CallQueue');

export const CALL_ARCHITECTURE_MODES = Object.freeze({
  LEGACY_ONLY: 'legacy_only',
  SHADOW_MATERIALIZE: 'shadow_materialize',
  SHADOW_DISPATCH: 'shadow_dispatch',
  CANARY_QUEUE: 'canary_queue',
  QUEUE_PRIMARY: 'queue_primary',
  LEGACY_ROLLBACK: 'legacy_rollback',
});

export const CALL_QUEUE_STATUSES = Object.freeze({
  QUEUED: 'queued',
  LEASED: 'leased',
  INITIATING: 'initiating',
  STARTED: 'started',
  COMPLETED: 'completed',
  DEFERRED: 'deferred',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

export const PRIORITY_LANES = Object.freeze({
  MANUAL: 'manual',
  HARD_REMINDER: 'hard_reminder',
  REMINDER_RETRY: 'reminder_retry',
  SCHEDULED_CHECKIN: 'scheduled_checkin',
  WELFARE: 'welfare',
  LOW_PRIORITY_RETRY: 'low_priority_retry',
});

const LANES_IN_DISPATCH_ORDER = Object.freeze([
  PRIORITY_LANES.MANUAL,
  PRIORITY_LANES.HARD_REMINDER,
  PRIORITY_LANES.REMINDER_RETRY,
  PRIORITY_LANES.SCHEDULED_CHECKIN,
  PRIORITY_LANES.WELFARE,
  PRIORITY_LANES.LOW_PRIORITY_RETRY,
]);

export const DEFAULT_LANE_RESERVE_POLICY = Object.freeze({
  [PRIORITY_LANES.MANUAL]: 0.10,
  [PRIORITY_LANES.HARD_REMINDER]: 0.35,
  [PRIORITY_LANES.REMINDER_RETRY]: 0.15,
  [PRIORITY_LANES.SCHEDULED_CHECKIN]: 0.35,
  [PRIORITY_LANES.WELFARE]: 0.05,
  [PRIORITY_LANES.LOW_PRIORITY_RETRY]: 0,
});

const REAL_DIAL_MODES = new Set([
  CALL_ARCHITECTURE_MODES.CANARY_QUEUE,
  CALL_ARCHITECTURE_MODES.QUEUE_PRIMARY,
]);

const LEGACY_DECISIONS = new Set([
  'planned',
  'skipped',
  'suppressed_duplicate',
  'not_evaluated',
]);

const QUEUE_DECISIONS = new Set([
  'inserted',
  'existing',
  'failed',
  'skipped',
  'leased',
  'not_evaluated',
]);

const SHADOW_SKIP_REASONS = new Set([
  'none',
  'invalid_spec',
  'enqueue_failed',
  'call_type_disabled',
  'unknown',
]);

const CAPACITY_DECISIONS = new Set([
  'not_evaluated',
  'available',
  'unavailable',
  'dry_run',
  'reserved',
  'deferred',
]);

let queueDispatcherDraining = false;
const activeQueueDispatches = new Set();
const inFlightCapacityReservations = new Map();

const PHI_SENTINEL_PATTERN = /Donna Phi Sentinel|PHI_SENTINEL_[A-Z_]+/;
const ALLOWED_ENCRYPTED_KEYS = new Set([
  'contextnotesencrypted',
  'payloadencrypted',
]);

const DISALLOWED_OPERATIONAL_KEYS = [
  'name',
  'phone',
  'title',
  'description',
  'medical',
  'family',
  'additionalinfo',
  'transcript',
  'summary',
  'content',
  'contextnotes',
  'caregivernote',
  'userresponse',
  'prompt',
];

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[_-]/g, '');
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function normalizeMode(value) {
  const mode = String(value || CALL_ARCHITECTURE_MODES.LEGACY_ONLY).trim();
  return Object.values(CALL_ARCHITECTURE_MODES).includes(mode)
    ? mode
    : CALL_ARCHITECTURE_MODES.LEGACY_ONLY;
}

function requireDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return date;
}

function requireString(value, fieldName) {
  const stringValue = String(value || '').trim();
  if (!stringValue) {
    throw new Error(`${fieldName} is required`);
  }
  return stringValue;
}

function safePositiveInteger(value, defaultValue, maxValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function optionalNonNegativeInteger(value, maxValue) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, maxValue);
}

function parseIdList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
  }
  return [...new Set(String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean))];
}

function safePositiveNumber(value, defaultValue, maxValue) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function rowsFrom(result) {
  return result?.rows || [];
}

function enumValue(value, allowedValues, defaultValue) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowedValues.has(normalized) ? normalized : defaultValue;
}

function boundedInteger(value, defaultValue, minValue, maxValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(minValue, Math.min(maxValue, parsed));
}

function failureSkipReason(error) {
  const message = String(error?.message || '');
  if (message.includes('required') || message.includes('valid date')) {
    return 'invalid_spec';
  }
  return 'enqueue_failed';
}

function queueRowValue(row, camelKey, snakeKey) {
  return row?.[camelKey] ?? row?.[snakeKey] ?? null;
}

function countValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function emptyDispatchResult(extra = {}) {
  return {
    requested: 0,
    leased: 0,
    reserved: 0,
    dialed: 0,
    suppressed: 0,
    failed: 0,
    releasedReservations: 0,
    ...extra,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trackQueueDispatch() {
  const token = Symbol('queue-dispatch');
  activeQueueDispatches.add(token);
  return () => {
    activeQueueDispatches.delete(token);
  };
}

function trackCapacityReservation({ reservationId, queueId }) {
  inFlightCapacityReservations.set(reservationId, {
    reservationId,
    queueId,
    createdAt: new Date(),
  });
}

function untrackCapacityReservation(reservationId) {
  inFlightCapacityReservations.delete(reservationId);
}

async function releaseTrackedCapacityReservation(entry, releaseReservation) {
  await releaseReservation({
    reservationId: entry.reservationId,
    queueId: entry.queueId,
  });
  untrackCapacityReservation(entry.reservationId);
  return true;
}

function rowId(row) {
  return queueRowValue(row, 'id', 'id');
}

function guardIdFromRow(guard) {
  return guard?.id || null;
}

function guardKeyFromRow(guard) {
  return guard?.guardKey || guard?.guard_key || null;
}

function normalizeLane(lane) {
  const normalized = String(lane || '').trim();
  return LANES_IN_DISPATCH_ORDER.includes(normalized) ? normalized : null;
}

export function setQueueDispatcherDraining(value = true) {
  queueDispatcherDraining = Boolean(value);
}

export function getQueueDispatcherDrainState() {
  return {
    draining: queueDispatcherDraining,
    activeDispatches: activeQueueDispatches.size,
    inFlightReservations: inFlightCapacityReservations.size,
  };
}

export async function waitForQueueDispatcherIdle({
  timeoutMs = 30000,
  pollIntervalMs = 50,
} = {}) {
  const startedAt = Date.now();
  while (activeQueueDispatches.size > 0) {
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        idle: false,
        activeDispatches: activeQueueDispatches.size,
      };
    }
    await sleep(pollIntervalMs);
  }
  return {
    idle: true,
    activeDispatches: 0,
  };
}

export async function drainQueueDispatcherReservations({
  releaseReservation = releasePipecatCapacityReservation,
  waitForDispatches = true,
  timeoutMs = 30000,
  pollIntervalMs = 50,
} = {}) {
  const idle = waitForDispatches
    ? await waitForQueueDispatcherIdle({ timeoutMs, pollIntervalMs })
    : {
      idle: activeQueueDispatches.size === 0,
      activeDispatches: activeQueueDispatches.size,
    };

  let released = 0;
  let failed = 0;
  const reservations = [...inFlightCapacityReservations.values()];
  for (const reservation of reservations) {
    try {
      await releaseTrackedCapacityReservation(reservation, releaseReservation);
      released++;
    } catch {
      failed++;
    }
  }

  return {
    idle: idle.idle,
    activeDispatches: idle.activeDispatches,
    released,
    failed,
    remaining: inFlightCapacityReservations.size,
  };
}

export function canaryBucketForSeniorId(seniorId) {
  const id = String(seniorId || '').trim();
  if (!id) return 100;
  // Use 16 bits of the md5 prefix (65536 buckets) instead of 8 bits (256).
  // At canary_percent=1%, the old version included buckets [0,0]
  // → ~0.39% real coverage. The new version includes [0..654]
  // → 0.998% real coverage. Bias at any single-digit percent < 0.05%.
  const digestPrefix = crypto.createHash('md5').update(id).digest('hex').slice(0, 4);
  return Number.parseInt(digestPrefix, 16) % 100;
}

export function isSeniorInQueueCanaryCohort(seniorId, {
  canaryPercent = 0,
  canarySeniorIds = [],
} = {}) {
  const id = String(seniorId || '').trim();
  if (!id) return false;
  if (parseIdList(canarySeniorIds).includes(id)) return true;
  const safeCanaryPercent = boundedInteger(canaryPercent, 0, 0, 100);
  if (safeCanaryPercent >= 100) return true;
  if (safeCanaryPercent <= 0) return false;
  return canaryBucketForSeniorId(id) < safeCanaryPercent;
}

function canaryCohortFilterSql({
  canaryPercent = 100,
  canarySeniorIds = [],
} = {}) {
  const safeCanaryPercent = boundedInteger(canaryPercent, 100, 0, 100);
  if (safeCanaryPercent >= 100) return sql``;

  const clauses = [];
  if (safeCanaryPercent > 0) {
    // Mirror canaryBucketForSeniorId: 16-bit md5 prefix mod 100.
    // bit(16)::int gives 0..65535 (zero-padded, always non-negative),
    // mod 100 yields the same bucket the JS helper computes.
    clauses.push(sql`
      (('x' || substr(md5(senior_id::text), 1, 4))::bit(16)::int) % 100 < ${safeCanaryPercent}
    `);
  }

  const allowlist = parseIdList(canarySeniorIds);
  if (allowlist.length > 0) {
    clauses.push(sql`senior_id IN (${sql.join(allowlist.map(id => sql`${id}`), sql`, `)})`);
  }

  if (clauses.length === 0) return sql`AND false`;
  return sql`AND (${sql.join(clauses, sql` OR `)})`;
}

function emptyLaneCounts() {
  return Object.fromEntries(LANES_IN_DISPATCH_ORDER.map(lane => [lane, 0]));
}

export function normalizeLanePressure(lanePressure = {}) {
  const counts = emptyLaneCounts();
  for (const lane of LANES_IN_DISPATCH_ORDER) {
    counts[lane] = countValue(lanePressure[lane]);
  }
  return counts;
}

export function estimateAvailablePipecatCapacity({
  instances = null,
  maxCalls = 0,
  activeCalls = 0,
  pendingReservations = 0,
  overbookFactor = 1,
} = {}) {
  const factor = safePositiveNumber(overbookFactor, 1, 2);
  let totalMaxCalls = countValue(maxCalls);
  let totalActiveCalls = countValue(activeCalls);
  let totalPendingReservations = countValue(pendingReservations);

  if (Array.isArray(instances)) {
    totalMaxCalls = 0;
    totalActiveCalls = 0;
    totalPendingReservations = 0;

    for (const instance of instances) {
      if (!instance?.healthy || instance?.draining) continue;
      if (instance.ready === false) continue;
      totalMaxCalls += countValue(instance.maxCalls ?? instance.max_calls);
      totalActiveCalls += Math.max(
        countValue(instance.activeCalls ?? instance.active_calls),
        countValue(instance.inboundActiveCalls ?? instance.inbound_active_calls)
      );
      totalPendingReservations += countValue(
        instance.pendingReservations ??
        instance.pending_reservations ??
        instance.pendingStartCount ??
        instance.pending_start_count
      );
    }
  }

  const effectiveCapacity = Math.floor(totalMaxCalls * factor);
  return Math.max(0, effectiveCapacity - totalActiveCalls - totalPendingReservations);
}

function buildReserveSlots(capacitySlots, lanePolicy) {
  const safeCapacitySlots = boundedInteger(capacitySlots, 0, 0, 10000);
  const reserves = emptyLaneCounts();
  if (safeCapacitySlots <= 0) return reserves;

  const exact = LANES_IN_DISPATCH_ORDER.map((lane, index) => {
    const percent = Math.max(0, Number(lanePolicy[lane]) || 0);
    const slots = safeCapacitySlots * percent;
    return {
      lane,
      index,
      floor: Math.floor(slots),
      remainder: slots - Math.floor(slots),
    };
  });

  let assigned = 0;
  for (const item of exact) {
    reserves[item.lane] = item.floor;
    assigned += item.floor;
  }

  const remainderOrder = [...exact].sort((left, right) =>
    right.remainder - left.remainder || left.index - right.index
  );
  let remaining = Math.max(0, safeCapacitySlots - assigned);
  for (const item of remainderOrder) {
    if (remaining <= 0 || item.remainder <= 0) break;
    reserves[item.lane]++;
    remaining--;
  }

  return reserves;
}

export function buildLaneCapacityPlan({
  capacitySlots = 0,
  lanePressure = {},
  lanePolicy = DEFAULT_LANE_RESERVE_POLICY,
} = {}) {
  const safeCapacitySlots = boundedInteger(capacitySlots, 0, 0, 10000);
  const pressure = normalizeLanePressure(lanePressure);
  const reservedByLane = buildReserveSlots(safeCapacitySlots, lanePolicy);
  const plannedByLane = emptyLaneCounts();
  let remainingCapacity = safeCapacitySlots;

  for (const lane of LANES_IN_DISPATCH_ORDER) {
    const guaranteed = Math.min(pressure[lane], reservedByLane[lane], remainingCapacity);
    plannedByLane[lane] = guaranteed;
    remainingCapacity -= guaranteed;
  }

  for (const lane of LANES_IN_DISPATCH_ORDER) {
    if (remainingCapacity <= 0) break;
    const remainingPressure = Math.max(0, pressure[lane] - plannedByLane[lane]);
    const additional = Math.min(remainingPressure, remainingCapacity);
    plannedByLane[lane] += additional;
    remainingCapacity -= additional;
  }

  const planned = Object.values(plannedByLane).reduce((sum, count) => sum + count, 0);
  return {
    capacitySlots: safeCapacitySlots,
    reservedByLane,
    pressureByLane: pressure,
    plannedByLane,
    planned,
    unusedSlots: Math.max(0, safeCapacitySlots - planned),
  };
}

// Process-level cache for resolveCallArchitectureConfig when called with
// the default process.env (hot path: per-senior-write hook in services/seniors.js
// + per-dispatch tick in scheduler.js + per-dispatchQueuedCalls call).
// Production env vars don't change at runtime; tests do mutate them, so the
// cache auto-invalidates when any tracked env value changes. The "tracked"
// set covers every env var read by this function so we're correct by
// construction. Callers that pass an explicit env bypass the cache entirely.
const _ARCH_ENV_KEYS = [
  'CALL_ARCHITECTURE_MODE', 'CALL_QUEUE_ALLOW_REAL_DIAL', 'CALL_QUEUE_SHADOW_MATERIALIZE',
  'CALL_QUEUE_SHADOW_DISPATCH', 'CALL_QUEUE_REQUIRE_DIAL_GUARD', 'CALL_QUEUE_COMPARE_WITH_LEGACY',
  'CALL_QUEUE_CANARY_PERCENT', 'CALL_QUEUE_COHORT_ALLOWLIST', 'CALL_QUEUE_TEST_RUN_ID',
  'CALL_QUEUE_MATERIALIZER_LIMIT', 'CALL_QUEUE_DISPATCHER_ENABLED', 'CALL_QUEUE_RECONCILER_ENABLED',
  'CALL_DISPATCH_MAX_BATCH_SIZE', 'CALL_DISPATCH_LEASE_SECONDS', 'CALL_DISPATCH_OVERBOOK_FACTOR',
  'CALL_QUEUE_USE_CAPACITY_REGISTRY', 'CALL_QUEUE_REQUIRE_CAPACITY_REGISTRY',
  'CALL_LANE_POLICY_VERSION', 'CALL_QUEUE_SHADOW_CAPACITY', 'CALL_QUEUE_ENABLED_CALL_TYPES',
];
let _callArchitectureConfigCache = null;
let _callArchitectureConfigCacheKey = '';
function envSnapshot(env) {
  return _ARCH_ENV_KEYS.map(k => `${k}=${env[k] || ''}`).join('|');
}
export function resetCallArchitectureConfigCache() {
  _callArchitectureConfigCache = null;
  _callArchitectureConfigCacheKey = '';
}

export function resolveCallArchitectureConfig(env = process.env) {
  if (env === process.env && _callArchitectureConfigCache) {
    const snap = envSnapshot(env);
    if (snap === _callArchitectureConfigCacheKey) return _callArchitectureConfigCache;
  }
  const mode = normalizeMode(env.CALL_ARCHITECTURE_MODE);
  const requestedRealDial = parseBoolean(env.CALL_QUEUE_ALLOW_REAL_DIAL, false);
  const allowRealDial = requestedRealDial && REAL_DIAL_MODES.has(mode);

  const resolved = {
    mode,
    shadowMaterialize: mode === CALL_ARCHITECTURE_MODES.SHADOW_MATERIALIZE ||
      mode === CALL_ARCHITECTURE_MODES.SHADOW_DISPATCH ||
      mode === CALL_ARCHITECTURE_MODES.CANARY_QUEUE ||
      mode === CALL_ARCHITECTURE_MODES.QUEUE_PRIMARY ||
      parseBoolean(env.CALL_QUEUE_SHADOW_MATERIALIZE, false),
    shadowDispatch: mode === CALL_ARCHITECTURE_MODES.SHADOW_DISPATCH ||
      parseBoolean(env.CALL_QUEUE_SHADOW_DISPATCH, false),
    allowRealDial,
    requireDialGuard: parseBoolean(env.CALL_QUEUE_REQUIRE_DIAL_GUARD, true),
    compareWithLegacy: parseBoolean(env.CALL_QUEUE_COMPARE_WITH_LEGACY, false),
    canaryPercent: Math.max(0, Math.min(100, Number.parseInt(env.CALL_QUEUE_CANARY_PERCENT || '0', 10) || 0)),
    canarySeniorIds: parseIdList(env.CALL_QUEUE_COHORT_ALLOWLIST),
    testRunId: String(env.CALL_QUEUE_TEST_RUN_ID || '').trim() || null,
    materializerLimit: safePositiveInteger(env.CALL_QUEUE_MATERIALIZER_LIMIT, 1000, 10000),
    dispatcherEnabled: mode === CALL_ARCHITECTURE_MODES.SHADOW_DISPATCH ||
      parseBoolean(env.CALL_QUEUE_DISPATCHER_ENABLED, false),
    reconcilerEnabled: mode === CALL_ARCHITECTURE_MODES.SHADOW_DISPATCH ||
      parseBoolean(env.CALL_QUEUE_RECONCILER_ENABLED, false),
    dispatcherBatchSize: safePositiveInteger(env.CALL_DISPATCH_MAX_BATCH_SIZE, 100, 1000),
    // Cap at 60 min (was 15 min). Dispatch batches up to ~200 rows with
    // affinity lookups + Telnyx HTTP can take >15min in the slowest case;
    // a longer ceiling lets operators tune the lease without recompiling.
    // Default stays 60s for normal batches.
    dispatchLeaseSeconds: safePositiveInteger(env.CALL_DISPATCH_LEASE_SECONDS, 60, 60 * 60),
    dispatchOverbookFactor: safePositiveNumber(env.CALL_DISPATCH_OVERBOOK_FACTOR, 1, 2),
    useCapacityRegistry: parseBoolean(env.CALL_QUEUE_USE_CAPACITY_REGISTRY, true),
    requireCapacityRegistry: parseBoolean(env.CALL_QUEUE_REQUIRE_CAPACITY_REGISTRY, false),
    lanePolicyVersion: String(env.CALL_LANE_POLICY_VERSION || 'v1').trim() || 'v1',
    shadowCapacitySlots: optionalNonNegativeInteger(env.CALL_QUEUE_SHADOW_CAPACITY, 10000),
    enabledCallTypes: String(env.CALL_QUEUE_ENABLED_CALL_TYPES || 'manual,reminder,schedule,welfare')
      .split(',')
      .map(type => type.trim())
      .filter(Boolean),
  };

  if (env === process.env) {
    _callArchitectureConfigCache = resolved;
    _callArchitectureConfigCacheKey = envSnapshot(env);
  }
  return resolved;
}

export function validateCallArchitectureConfig(env = process.env) {
  const config = resolveCallArchitectureConfig(env);
  const requestedRealDial = parseBoolean(env.CALL_QUEUE_ALLOW_REAL_DIAL, false);
  const errors = [];
  const warnings = [];

  if (requestedRealDial && !REAL_DIAL_MODES.has(config.mode)) {
    errors.push('CALL_QUEUE_ALLOW_REAL_DIAL=true is only valid in canary_queue or queue_primary');
  }

  if (config.mode === CALL_ARCHITECTURE_MODES.SHADOW_MATERIALIZE && config.dispatcherEnabled) {
    warnings.push('shadow_materialize should not enable dispatcher work; use shadow_dispatch for dry-run leasing');
  }

  if (config.mode === CALL_ARCHITECTURE_MODES.CANARY_QUEUE && config.allowRealDial) {
    if (config.canaryPercent <= 0 && config.canarySeniorIds.length === 0) {
      errors.push('canary_queue real dialing requires CALL_QUEUE_COHORT_ALLOWLIST or CALL_QUEUE_CANARY_PERCENT > 0');
    }
    if (!config.dispatcherEnabled) {
      errors.push('canary_queue real dialing requires CALL_QUEUE_DISPATCHER_ENABLED=true');
    }
    if (!config.requireDialGuard) {
      errors.push('canary_queue real dialing requires CALL_QUEUE_REQUIRE_DIAL_GUARD=true');
    }
    if (!config.useCapacityRegistry) {
      errors.push('canary_queue real dialing should use the Pipecat capacity registry');
    }
  }

  if (config.mode === CALL_ARCHITECTURE_MODES.QUEUE_PRIMARY && config.allowRealDial) {
    if (!config.dispatcherEnabled) {
      errors.push('queue_primary requires CALL_QUEUE_DISPATCHER_ENABLED=true');
    }
    if (!config.requireDialGuard) {
      errors.push('queue_primary requires CALL_QUEUE_REQUIRE_DIAL_GUARD=true');
    }
    if (!config.useCapacityRegistry || !config.requireCapacityRegistry) {
      errors.push('queue_primary requires CALL_QUEUE_USE_CAPACITY_REGISTRY=true and CALL_QUEUE_REQUIRE_CAPACITY_REGISTRY=true');
    }
  }

  if (config.mode === CALL_ARCHITECTURE_MODES.LEGACY_ROLLBACK && config.dispatcherEnabled) {
    warnings.push('legacy_rollback should stop dispatcher workers after the mode flip');
  }

  return {
    ok: errors.length === 0,
    mode: config.mode,
    errors,
    warnings,
    summary: {
      allowRealDial: config.allowRealDial,
      dispatcherEnabled: config.dispatcherEnabled,
      reconcilerEnabled: config.reconcilerEnabled,
      requireDialGuard: config.requireDialGuard,
      compareWithLegacy: config.compareWithLegacy,
      canaryPercent: config.canaryPercent,
      canaryAllowlistCount: config.canarySeniorIds.length,
      useCapacityRegistry: config.useCapacityRegistry,
      requireCapacityRegistry: config.requireCapacityRegistry,
    },
  };
}

export function assertOperationalPayloadHasNoPlainPhi(value, path = []) {
  if (value == null) return;

  if (typeof value === 'string') {
    if (PHI_SENTINEL_PATTERN.test(value)) {
      throw new Error(`Plain PHI sentinel is not allowed in call queue operational data at ${path.join('.') || '<root>'}`);
    }
    return;
  }

  if (value instanceof Date) return;
  if (typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertOperationalPayloadHasNoPlainPhi(item, [...path, String(index)]));
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (!ALLOWED_ENCRYPTED_KEYS.has(normalized) &&
      DISALLOWED_OPERATIONAL_KEYS.some(disallowed => normalized.includes(disallowed))) {
      throw new Error(`PHI-bearing field "${key}" is not allowed in call queue operational data`);
    }
    assertOperationalPayloadHasNoPlainPhi(nestedValue, [...path, key]);
  }
}

export function buildDispatchWindow(targetAt, windowMinutes = 15) {
  const target = requireDate(targetAt, 'targetAt');
  const safeWindowMinutes = safePositiveInteger(windowMinutes, 15, 24 * 60);
  const halfWindowMs = Math.floor((safeWindowMinutes * 60 * 1000) / 2);
  return {
    targetAt: target,
    earliestAt: new Date(target.getTime() - halfWindowMs),
    latestAt: new Date(target.getTime() + halfWindowMs),
  };
}

export function getLocalDateKey(dateValue, timezone = 'UTC') {
  const date = requireDate(dateValue, 'dateValue');
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function buildCallDedupeKey({
  callType,
  seniorId,
  scheduleId,
  reminderId,
  requestId,
  targetAt,
  localDate,
}) {
  const type = requireString(callType, 'callType');
  const senior = requireString(seniorId, 'seniorId');
  const target = targetAt ? requireDate(targetAt, 'targetAt') : null;
  const dateKey = localDate || target?.toISOString().slice(0, 10);

  if (type === 'schedule') {
    return `schedule:${senior}:${dateKey}:${requireString(scheduleId || target?.toISOString(), 'scheduleId or targetAt')}`;
  }
  if (type === 'reminder') {
    return `reminder:${requireString(reminderId, 'reminderId')}:${requireString(target?.toISOString(), 'targetAt')}`;
  }
  if (type === 'welfare') {
    return `welfare:${senior}:${requireString(dateKey, 'localDate or targetAt')}`;
  }
  if (type === 'manual') {
    return `manual:${senior}:${requireString(requestId, 'requestId')}`;
  }
  return `${type}:${senior}:${requireString(requestId || scheduleId || reminderId || target?.toISOString(), 'dedupe discriminator')}`;
}

export function buildOutboundGuardKey(input) {
  return buildCallDedupeKey(input);
}

export function normalizeQueueRow(input) {
  const window = buildDispatchWindow(input.targetAt, input.windowMinutes || 15);
  const row = {
    seniorId: requireString(input.seniorId, 'seniorId'),
    scheduleId: input.scheduleId || null,
    reminderId: input.reminderId || null,
    callType: requireString(input.callType, 'callType'),
    priorityLane: requireString(input.priorityLane, 'priorityLane'),
    priorityScore: Number.parseInt(input.priorityScore || '0', 10) || 0,
    targetAt: window.targetAt,
    earliestAt: input.earliestAt ? requireDate(input.earliestAt, 'earliestAt') : window.earliestAt,
    latestAt: input.latestAt ? requireDate(input.latestAt, 'latestAt') : window.latestAt,
    status: input.status || CALL_QUEUE_STATUSES.QUEUED,
    dedupeKey: input.dedupeKey || buildCallDedupeKey(input),
  };

  assertOperationalPayloadHasNoPlainPhi(row);
  return row;
}

export function priorityLaneForCallSpec(spec) {
  if (spec?.type === 'manual') return PRIORITY_LANES.MANUAL;
  if (spec?.type === 'reminder') {
    return spec.existingDelivery?.id ? PRIORITY_LANES.REMINDER_RETRY : PRIORITY_LANES.HARD_REMINDER;
  }
  if (spec?.type === 'schedule') return PRIORITY_LANES.SCHEDULED_CHECKIN;
  if (spec?.type === 'welfare') return PRIORITY_LANES.WELFARE;
  return PRIORITY_LANES.LOW_PRIORITY_RETRY;
}

export function buildQueueInputFromLegacyCallSpec(spec, {
  now = new Date(),
  architecture = 'legacy_shadow',
} = {}) {
  const seniorId = requireString(spec?.senior?.id || spec?.seniorId, 'seniorId');
  const callType = requireString(spec?.type, 'callType');
  const timezone = spec?.senior?.timezone || 'UTC';
  const targetAt = callType === 'reminder' && spec.scheduledFor
    ? requireDate(spec.scheduledFor, 'scheduledFor')
    : requireDate(now, 'now');
  const localDate = getLocalDateKey(targetAt, timezone);

  const queueInput = {
    seniorId,
    scheduleId: spec?.scheduleItem?.id || null,
    reminderId: spec?.reminder?.id || null,
    callType,
    priorityLane: priorityLaneForCallSpec(spec),
    priorityScore: 0,
    targetAt,
    windowMinutes: callType === 'reminder' ? 7 : 15,
    dedupeKey: buildCallDedupeKey({
      callType,
      seniorId,
      scheduleId: spec?.scheduleItem?.id || spec?.dedupKey,
      reminderId: spec?.reminder?.id,
      requestId: spec?.requestId,
      targetAt,
      localDate,
    }),
  };

  assertOperationalPayloadHasNoPlainPhi(queueInput);
  return {
    ...queueInput,
    architecture,
    localDate,
  };
}

export async function materializeLegacyCallPlan(callPlan, {
  database = db,
  now = new Date(),
  architecture = 'legacy_shadow',
  recordComparisons = false,
  testRunId = null,
  capacityDecision = 'not_evaluated',
} = {}) {
  const specs = Array.isArray(callPlan) ? callPlan : [];
  let inserted = 0;
  let existing = 0;
  let failed = 0;
  let comparisonInserted = 0;
  let comparisonFailed = 0;
  const failures = [];

  for (const spec of specs) {
    try {
      const input = buildQueueInputFromLegacyCallSpec(spec, { now, architecture });
      const result = await enqueueCall(input, { database });
      if (result.inserted) inserted++;
      else existing++;

      if (recordComparisons) {
        try {
          await recordSchedulerShadowComparison({
            testRunId,
            seniorId: input.seniorId,
            queueId: result.row?.id || null,
            callType: input.callType,
            priorityLane: input.priorityLane,
            legacyDedupKey: spec?.dedupKey || null,
            queueDedupeKey: input.dedupeKey,
            targetAt: input.targetAt,
            legacyDecision: 'planned',
            queueDecision: result.inserted ? 'inserted' : 'existing',
            skipReason: 'none',
            capacityDecision,
          }, { database });
          comparisonInserted++;
        } catch {
          comparisonFailed++;
        }
      }
    } catch (error) {
      failed++;
      failures.push({
        type: spec?.type || 'unknown',
        seniorId: spec?.senior?.id || spec?.seniorId || null,
        reason: failureSkipReason(error),
      });

      if (recordComparisons) {
        try {
          await recordSchedulerShadowComparison({
            testRunId,
            seniorId: spec?.senior?.id || spec?.seniorId || null,
            callType: spec?.type || 'unknown',
            priorityLane: priorityLaneForCallSpec(spec),
            legacyDedupKey: spec?.dedupKey || null,
            legacyDecision: 'planned',
            queueDecision: 'failed',
            skipReason: failureSkipReason(error),
            capacityDecision,
          }, { database });
          comparisonInserted++;
        } catch {
          comparisonFailed++;
        }
      }
    }
  }

  if (inserted > 0 || existing > 0 || failed > 0) {
    log.info('Queue shadow materialization complete', {
      planned: specs.length,
      inserted,
      existing,
      failed,
      comparisons: comparisonInserted,
      comparisonFailed,
    });
  }
  if (failures.length > 0) {
    log.warn('Queue shadow materialization failures', { count: failures.length });
  }

  return {
    planned: specs.length,
    inserted,
    existing,
    failed,
    comparisonInserted,
    comparisonFailed,
    failures,
  };
}

export async function enqueueCall(input, { database = db } = {}) {
  assertOperationalPayloadHasNoPlainPhi(input);
  const row = normalizeQueueRow(input);

  const inserted = await database.execute(sql`
    INSERT INTO call_queue (
      senior_id,
      schedule_id,
      reminder_id,
      call_type,
      priority_lane,
      priority_score,
      target_at,
      earliest_at,
      latest_at,
      status,
      dedupe_key
    )
    VALUES (
      ${row.seniorId},
      ${row.scheduleId},
      ${row.reminderId},
      ${row.callType},
      ${row.priorityLane},
      ${row.priorityScore},
      ${row.targetAt},
      ${row.earliestAt},
      ${row.latestAt},
      ${row.status},
      ${row.dedupeKey}
    )
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING *
  `);

  const insertedRow = rowsFrom(inserted)[0];
  if (insertedRow) {
    return { inserted: true, row: insertedRow };
  }

  const existing = await database.execute(sql`
    SELECT *
    FROM call_queue
    WHERE dedupe_key = ${row.dedupeKey}
    LIMIT 1
  `);
  return { inserted: false, row: rowsFrom(existing)[0] || null };
}

export async function leaseQueuedCalls({
  limit = 10,
  leaseOwner,
  now = new Date(),
  leaseSeconds = 60,
  priorityLane = null,
  canaryPercent = 100,
  canarySeniorIds = [],
} = {}, { database = db } = {}) {
  const safeLimit = safePositiveInteger(limit, 10, 1000);
  // 60 min ceiling (was 15 min) — matches dispatchLeaseSeconds cap so
  // large batches with affinity + Telnyx HTTP latency have headroom.
  const safeLeaseSeconds = safePositiveInteger(leaseSeconds, 60, 60 * 60);
  const owner = requireString(leaseOwner, 'leaseOwner');
  const currentTime = requireDate(now, 'now');
  const lane = priorityLane == null ? null : normalizeLane(priorityLane);
  if (priorityLane != null && !lane) {
    throw new Error('priorityLane must be a valid queue lane');
  }
  const safeCanaryPercent = boundedInteger(canaryPercent, 100, 0, 100);
  const cohortFilter = canaryCohortFilterSql({
    canaryPercent: safeCanaryPercent,
    canarySeniorIds,
  });

  const result = await database.execute(sql`
    WITH candidates AS (
      SELECT id
      FROM call_queue
      WHERE status = ${CALL_QUEUE_STATUSES.QUEUED}
        ${lane ? sql`AND priority_lane = ${lane}` : sql``}
        ${cohortFilter}
        AND earliest_at <= ${currentTime}
        AND latest_at > ${currentTime}
      ORDER BY
        CASE priority_lane
          WHEN ${PRIORITY_LANES.MANUAL} THEN 1
          WHEN ${PRIORITY_LANES.HARD_REMINDER} THEN 2
          WHEN ${PRIORITY_LANES.REMINDER_RETRY} THEN 3
          WHEN ${PRIORITY_LANES.SCHEDULED_CHECKIN} THEN 4
          WHEN ${PRIORITY_LANES.WELFARE} THEN 5
          WHEN ${PRIORITY_LANES.LOW_PRIORITY_RETRY} THEN 6
          ELSE 7
        END,
        priority_score DESC,
        target_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${safeLimit}
    )
    UPDATE call_queue q
    SET status = ${CALL_QUEUE_STATUSES.LEASED},
        lease_owner = ${owner},
        lease_expires_at = ${currentTime}::timestamp + make_interval(secs => ${safeLeaseSeconds}),
        updated_at = NOW()
    FROM candidates
    WHERE q.id = candidates.id
    RETURNING q.*
  `);

  return rowsFrom(result);
}

export async function countReadyQueuedCallsByLane({
  now = new Date(),
  canaryPercent = 100,
  canarySeniorIds = [],
} = {}, { database = db } = {}) {
  const currentTime = requireDate(now, 'now');
  const safeCanaryPercent = boundedInteger(canaryPercent, 100, 0, 100);
  const cohortFilter = canaryCohortFilterSql({
    canaryPercent: safeCanaryPercent,
    canarySeniorIds,
  });
  const result = await database.execute(sql`
    SELECT priority_lane, COUNT(*)::int AS count
    FROM call_queue
    WHERE status = ${CALL_QUEUE_STATUSES.QUEUED}
      ${cohortFilter}
      AND earliest_at <= ${currentTime}
      AND latest_at > ${currentTime}
    GROUP BY priority_lane
  `);

  const counts = emptyLaneCounts();
  for (const row of rowsFrom(result)) {
    const lane = normalizeLane(row.priorityLane ?? row.priority_lane);
    if (lane) {
      counts[lane] = countValue(row.count);
    }
  }
  return counts;
}

export function estimateQueueLagSeconds(row, now = new Date()) {
  const currentTime = requireDate(now, 'now');
  const targetAt = queueRowValue(row, 'targetAt', 'target_at');
  if (!targetAt) return null;
  const target = requireDate(targetAt, 'targetAt');
  return Math.max(0, Math.floor((currentTime.getTime() - target.getTime()) / 1000));
}

export async function dryRunDispatchQueuedCalls({
  leaseOwner,
  capacitySlots = null,
  instances = null,
  limit = 10,
  now = new Date(),
  leaseSeconds = 60,
  testRunId = null,
  recordComparisons = true,
  respectLanePolicy = false,
  lanePressure = null,
  lanePolicy = DEFAULT_LANE_RESERVE_POLICY,
  overbookFactor = 1,
  canaryPercent = 100,
  canarySeniorIds = [],
} = {}, { database = db } = {}) {
  const resolvedCapacitySlots = capacitySlots == null
    ? estimateAvailablePipecatCapacity({ instances, overbookFactor })
    : capacitySlots;
  const safeCapacitySlots = boundedInteger(resolvedCapacitySlots, 0, 0, 1000);
  if (safeCapacitySlots <= 0) {
    return {
      requested: 0,
      leased: 0,
      comparisonInserted: 0,
      comparisonFailed: 0,
    };
  }

  const safeLimit = Math.min(safePositiveInteger(limit, 10, 1000), safeCapacitySlots);
  const currentTime = requireDate(now, 'now');
  let capacityPlan = null;
  let leasedRows = [];

  if (respectLanePolicy) {
    const pressure = lanePressure
      ? normalizeLanePressure(lanePressure)
      : await countReadyQueuedCallsByLane({ now: currentTime, canaryPercent, canarySeniorIds }, { database });
    capacityPlan = buildLaneCapacityPlan({
      capacitySlots: safeLimit,
      lanePressure: pressure,
      lanePolicy,
    });

    for (const lane of LANES_IN_DISPATCH_ORDER) {
      const laneLimit = capacityPlan.plannedByLane[lane];
      if (laneLimit <= 0) continue;
      const laneRows = await leaseQueuedCalls({
        leaseOwner,
        limit: laneLimit,
        now: currentTime,
        leaseSeconds,
        priorityLane: lane,
        canaryPercent,
        canarySeniorIds,
      }, { database });
      leasedRows = leasedRows.concat(laneRows);
    }
  } else {
    leasedRows = await leaseQueuedCalls({
      leaseOwner,
      limit: safeLimit,
      now: currentTime,
      leaseSeconds,
      canaryPercent,
      canarySeniorIds,
    }, { database });
  }

  let comparisonInserted = 0;
  let comparisonFailed = 0;

  if (recordComparisons) {
    for (const row of leasedRows) {
      try {
        await recordSchedulerShadowComparison({
          testRunId,
          seniorId: queueRowValue(row, 'seniorId', 'senior_id'),
          queueId: queueRowValue(row, 'id', 'id'),
          callType: queueRowValue(row, 'callType', 'call_type') || 'unknown',
          priorityLane: queueRowValue(row, 'priorityLane', 'priority_lane'),
          queueDedupeKey: queueRowValue(row, 'dedupeKey', 'dedupe_key'),
          targetAt: queueRowValue(row, 'targetAt', 'target_at'),
          legacyDecision: 'not_evaluated',
          queueDecision: 'leased',
          skipReason: 'none',
          capacityDecision: 'dry_run',
          estimatedQueueLagSeconds: estimateQueueLagSeconds(row, currentTime),
        }, { database });
        comparisonInserted++;
      } catch {
        comparisonFailed++;
      }
    }
  }

  if (leasedRows.length > 0) {
    log.info('Queue dry-run dispatch leased rows', {
      requested: safeLimit,
      leased: leasedRows.length,
      comparisons: comparisonInserted,
      comparisonFailed,
    });
  }

  return {
    requested: safeLimit,
    leased: leasedRows.length,
    comparisonInserted,
    comparisonFailed,
    ...(capacityPlan ? { capacityPlan } : {}),
  };
}

export async function recoverExpiredQueueLeases({
  limit = 100,
  now = new Date(),
} = {}, { database = db } = {}) {
  const safeLimit = safePositiveInteger(limit, 100, 5000);
  const currentTime = requireDate(now, 'now');

  const result = await database.execute(sql`
    WITH candidates AS (
      SELECT id
      FROM call_queue
      WHERE status = ${CALL_QUEUE_STATUSES.LEASED}
        AND lease_expires_at <= ${currentTime}
        AND latest_at > ${currentTime}
      ORDER BY lease_expires_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${safeLimit}
    )
    UPDATE call_queue q
    SET status = ${CALL_QUEUE_STATUSES.QUEUED},
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = NOW()
    FROM candidates
    WHERE q.id = candidates.id
    RETURNING q.*
  `);

  const recovered = rowsFrom(result);
  if (recovered.length > 0) {
    log.info('Recovered expired queue leases', { count: recovered.length });
  }
  return recovered;
}

export async function expireOverdueQueuedCalls({
  limit = 100,
  now = new Date(),
} = {}, { database = db } = {}) {
  const safeLimit = safePositiveInteger(limit, 100, 5000);
  const currentTime = requireDate(now, 'now');

  const result = await database.execute(sql`
    WITH candidates AS (
      SELECT id
      FROM call_queue
      WHERE status IN (${CALL_QUEUE_STATUSES.QUEUED}, ${CALL_QUEUE_STATUSES.LEASED})
        AND latest_at <= ${currentTime}
      ORDER BY latest_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${safeLimit}
    )
    UPDATE call_queue q
    SET status = ${CALL_QUEUE_STATUSES.EXPIRED},
        lease_owner = NULL,
        lease_expires_at = NULL,
        cancel_reason = 'dispatch_window_expired',
        updated_at = NOW()
    FROM candidates
    WHERE q.id = candidates.id
    RETURNING q.*
  `);

  const expired = rowsFrom(result);
  if (expired.length > 0) {
    log.info('Expired overdue queued calls', { count: expired.length });
  }
  return expired;
}

export async function reconcileQueueLeases(options = {}, { database = db } = {}) {
  const recoveredRows = await recoverExpiredQueueLeases(options, { database });
  const expiredRows = await expireOverdueQueuedCalls(options, { database });

  return {
    recovered: recoveredRows.length,
    expired: expiredRows.length,
  };
}

// ---------------------------------------------------------------------------
// Outbound dial-authority guard expiry reconciler (Phase 4 work items 6b/6c)
//
// A guard is one-shot dial authority. If a process crashes between
// `acquireOutboundCallGuard` and `markOutboundCallGuardInitiated`, the row
// stays in `active`/`initiating` forever, permanently blocking that senior +
// time window from being dialed again. `releaseExpiredOutboundCallGuards`
// walks expired guards that never attached to a real `call_attempt` and
// flips them to `released_expired` so the next scheduled call can acquire a
// fresh guard.
// ---------------------------------------------------------------------------

/**
 * Default `expires_at` for a newly-acquired outbound guard.
 *
 * Rev 2 retrospective tightened this from `targetAt + 24h` to
 * `targetAt + max(60s, 2 * leaseSeconds + 30s)`. The 24h default meant a
 * crashed dispatcher locked the senior out for a whole day; the tighter
 * window means the next reconciler cycle inside the same lease window
 * recovers the row.
 */
export function defaultGuardExpiry({ targetAt, leaseSeconds }) {
  const target = targetAt instanceof Date ? targetAt : new Date(targetAt);
  const lease = Number.isFinite(leaseSeconds) && leaseSeconds > 0 ? Number(leaseSeconds) : 60;
  const cushionSeconds = Math.max(60, 2 * lease + 30);
  return new Date(target.getTime() + cushionSeconds * 1000);
}

export async function releaseExpiredOutboundCallGuards({
  limit = 100,
  now = new Date(),
} = {}, { database = db } = {}) {
  const safeLimit = safePositiveInteger(limit, 100, 5000);
  const currentTime = requireDate(now, 'now');

  // A guard is safe to release when it's past its expires_at AND its
  // call_control_id never produced a non-failed call_attempt — i.e. no real
  // dial completed under this guard's authority. Guards already in terminal
  // states ('initiated', 'completed', 'cancelled', 'released_expired') are
  // excluded.
  const result = await database.execute(sql`
    WITH candidates AS (
      SELECT g.id, g.guard_key, g.senior_id, g.architecture, g.queue_id
      FROM outbound_call_guards g
      WHERE g.status IN ('active', 'initiating')
        AND g.expires_at < ${currentTime}
        AND (
          g.call_control_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM call_attempts ca
            WHERE ca.call_control_id = g.call_control_id
              AND ca.status NOT IN ('failed', 'expired', 'suppressed')
          )
        )
      ORDER BY g.expires_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${safeLimit}
    )
    UPDATE outbound_call_guards g
    SET status = 'released_expired',
        updated_at = NOW()
    FROM candidates
    WHERE g.id = candidates.id
    RETURNING g.id, g.guard_key, g.senior_id, g.architecture, g.queue_id
  `);

  const released = rowsFrom(result);
  if (released.length > 0) {
    log.info('Released expired outbound call guards', { count: released.length });
  }
  return released;
}

export async function reconcileOutboundCallGuards(
  options = {},
  { database = db, auditWriter = writeAudit } = {},
) {
  const released = await releaseExpiredOutboundCallGuards(options, { database });

  // Fire-and-forget audit per released guard. Guard rows are PHI-free
  // (senior_id is a UUID, guard_key is a dedupe key built from non-PHI
  // components). Never await — audit durability is not on the reconcile
  // path's critical path.
  for (const guard of released) {
    Promise.resolve(
      auditWriter({
        userId: null,
        userRole: 'system',
        action: 'outbound_guard_released_expired',
        resourceType: 'outbound_call_guard',
        resourceId: guard.id,
        metadata: {
          guardKey: guard.guard_key,
          seniorId: guard.senior_id,
          architecture: guard.architecture,
          queueId: guard.queue_id || null,
        },
      }),
    ).catch((err) => log.warn('Outbound guard release audit failed', { error: err?.message }));
  }

  return { released: released.length };
}

export async function acquireOutboundCallGuard(input, { database = db } = {}) {
  assertOperationalPayloadHasNoPlainPhi(input);
  const seniorId = requireString(input.seniorId, 'seniorId');
  const guardKey = requireString(input.guardKey || buildOutboundGuardKey(input), 'guardKey');
  const callType = requireString(input.callType, 'callType');
  const architecture = requireString(input.architecture, 'architecture');
  const targetAt = requireDate(input.targetAt, 'targetAt');
  const expiresAt = requireDate(
    input.expiresAt || defaultGuardExpiry({ targetAt, leaseSeconds: input.leaseSeconds }),
    'expiresAt',
  );

  const inserted = await database.execute(sql`
    INSERT INTO outbound_call_guards (
      senior_id,
      guard_key,
      call_type,
      architecture,
      queue_id,
      legacy_dedup_key,
      target_at,
      expires_at,
      status
    )
    VALUES (
      ${seniorId},
      ${guardKey},
      ${callType},
      ${architecture},
      ${input.queueId || null},
      ${input.legacyDedupKey || null},
      ${targetAt},
      ${expiresAt},
      ${input.status || 'active'}
    )
    ON CONFLICT (guard_key) DO NOTHING
    RETURNING *
  `);

  const insertedRow = rowsFrom(inserted)[0];
  if (insertedRow) {
    return { acquired: true, guard: insertedRow };
  }

  const existing = await database.execute(sql`
    SELECT *
    FROM outbound_call_guards
    WHERE guard_key = ${guardKey}
    LIMIT 1
  `);

  return { acquired: false, guard: rowsFrom(existing)[0] || null };
}

export async function markOutboundCallGuardInitiated(input, { database = db } = {}) {
  const guardId = input.guardId || input.guard_id || null;
  const guardKey = input.guardKey || input.guard_key || null;
  const selector = guardId
    ? sql`id = ${guardId}`
    : sql`guard_key = ${requireString(guardKey, 'guardKey')}`;

  const result = await database.execute(sql`
    UPDATE outbound_call_guards
    SET status = 'initiated',
        call_control_id = ${input.callControlId || input.call_control_id || null},
        updated_at = NOW()
    WHERE ${selector}
    RETURNING *
  `);

  return rowsFrom(result)[0] || null;
}

export async function markOutboundCallGuardInitiatingIfCallable(input, { database = db } = {}) {
  const guardId = input.guardId || input.guard_id || null;
  const guardKey = input.guardKey || input.guard_key || null;
  const selector = guardId
    ? sql`g.id = ${guardId}`
    : sql`g.guard_key = ${requireString(guardKey, 'guardKey')}`;

  const result = await database.execute(sql`
    WITH target_guard AS (
      SELECT g.*
      FROM outbound_call_guards g
      WHERE ${selector}
      FOR UPDATE
    ),
    callable_guard AS (
      SELECT tg.*
      FROM target_guard tg
      JOIN seniors s ON s.id = tg.senior_id
      WHERE s.is_active = true
        AND NOT EXISTS (
          SELECT 1
          FROM caregivers c
          JOIN notification_preferences np ON np.caregiver_id = c.id
          WHERE c.senior_id = tg.senior_id
            AND np.pause_calls = true
        )
    ),
    updated AS (
      UPDATE outbound_call_guards g
      SET status = 'initiating',
          updated_at = NOW()
      FROM callable_guard cg
      WHERE g.id = cg.id
      RETURNING g.*
    ),
    cancelled AS (
      UPDATE outbound_call_guards g
      SET status = 'cancelled',
          updated_at = NOW()
      FROM target_guard tg
      WHERE g.id = tg.id
        AND NOT EXISTS (SELECT 1 FROM updated)
      RETURNING g.*
    )
    SELECT updated.*, true AS initiated, NULL::text AS suppress_reason
    FROM updated
    UNION ALL
    SELECT cancelled.*,
           false AS initiated,
           CASE
             WHEN NOT EXISTS (
               SELECT 1
               FROM seniors s
               WHERE s.id = cancelled.senior_id
                 AND s.is_active = true
             )
               THEN 'senior_inactive_or_missing'
             WHEN EXISTS (
               SELECT 1
               FROM caregivers c
               JOIN notification_preferences np ON np.caregiver_id = c.id
               WHERE c.senior_id = cancelled.senior_id
                 AND np.pause_calls = true
             )
               THEN 'caregiver_paused'
             ELSE 'guard_unavailable'
           END AS suppress_reason
    FROM cancelled
  `);

  const row = rowsFrom(result)[0] || null;
  return {
    initiated: Boolean(row?.initiated),
    guard: row,
    suppressReason: row?.suppress_reason || null,
  };
}

export async function releaseOutboundCallGuard(input, { database = db } = {}) {
  const guardId = input.guardId || input.guard_id || null;
  const guardKey = input.guardKey || input.guard_key || null;
  const selector = guardId
    ? sql`id = ${guardId}`
    : sql`guard_key = ${requireString(guardKey, 'guardKey')}`;

  // DELETE rather than mark released: keeps the unique-conflict path
  // (ON CONFLICT (guard_key) DO NOTHING in acquireOutboundCallGuard)
  // working so the next attempt can re-acquire the same guard_key.
  // Only deletes guards that never produced a real dial. For forensics,
  // the deleted row is returned so callers can audit if they want — and
  // the surrounding error context is logged at the call site.
  const result = await database.execute(sql`
    DELETE FROM outbound_call_guards
    WHERE ${selector}
      AND call_control_id IS NULL
    RETURNING *
  `);

  const deleted = rowsFrom(result)[0] || null;
  if (deleted) {
    log.info('Released outbound call guard (no dial occurred)', {
      guardId: deleted.id,
      guardKey: deleted.guard_key,
      seniorId: deleted.senior_id,
      architecture: deleted.architecture,
    });
  }
  return deleted;
}

// markQueuedCallInitiating and markQueuedCallStarted require leaseOwner so
// they no-op (return null) if the lease was recovered by another dispatcher
// while we were processing. Without this guard, the row's state machine can
// be corrupted by a stale dispatcher writing INITIATING/STARTED after a
// second dispatcher already CANCELLED it (guard-loser path).
export async function markQueuedCallInitiating(input, { database = db } = {}) {
  const queueId = requireString(input.queueId, 'queueId');
  const leaseOwner = requireString(input.leaseOwner, 'leaseOwner');
  const attemptId = input.attemptId || null;

  const result = await database.execute(sql`
    UPDATE call_queue
    SET status = ${CALL_QUEUE_STATUSES.INITIATING},
        attempt_count = attempt_count + 1,
        last_attempt_id = ${attemptId},
        updated_at = NOW()
    WHERE id = ${queueId}
      AND lease_owner = ${leaseOwner}
      AND status = ${CALL_QUEUE_STATUSES.LEASED}
    RETURNING *
  `);

  return rowsFrom(result)[0] || null;
}

export async function markQueuedCallStarted(input, { database = db } = {}) {
  const queueId = requireString(input.queueId, 'queueId');
  const leaseOwner = requireString(input.leaseOwner, 'leaseOwner');
  const attemptId = input.attemptId || null;
  const callControlId = input.callControlId || null;

  const queueResult = await database.execute(sql`
    UPDATE call_queue
    SET status = ${CALL_QUEUE_STATUSES.STARTED},
        last_attempt_id = ${attemptId},
        updated_at = NOW()
    WHERE id = ${queueId}
      AND lease_owner = ${leaseOwner}
      AND status = ${CALL_QUEUE_STATUSES.INITIATING}
    RETURNING *
  `);

  let attempt = null;
  if (attemptId) {
    const attemptResult = await database.execute(sql`
      UPDATE call_attempts
      SET status = 'initiated',
          call_control_id = ${callControlId},
          updated_at = NOW()
      WHERE id = ${attemptId}
      RETURNING *
    `);
    attempt = rowsFrom(attemptResult)[0] || null;
  }

  return {
    queue: rowsFrom(queueResult)[0] || null,
    attempt,
  };
}

export async function releaseQueuedCallForRetry(input, { database = db } = {}) {
  const queueId = requireString(input.queueId, 'queueId');
  const errorCode = String(input.errorCode || 'dispatch_deferred').slice(0, 200);

  const result = await database.execute(sql`
    UPDATE call_queue
    SET status = ${CALL_QUEUE_STATUSES.QUEUED},
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = ${errorCode},
        last_error_at = NOW(),
        updated_at = NOW()
    WHERE id = ${queueId}
    RETURNING *
  `);

  return rowsFrom(result)[0] || null;
}

export async function cancelQueuedCall(input, { database = db } = {}) {
  const queueId = requireString(input.queueId, 'queueId');
  const cancelReason = String(input.cancelReason || 'cancelled').slice(0, 200);

  const result = await database.execute(sql`
    UPDATE call_queue
    SET status = ${CALL_QUEUE_STATUSES.CANCELLED},
        lease_owner = NULL,
        lease_expires_at = NULL,
        cancel_reason = ${cancelReason},
        updated_at = NOW()
    WHERE id = ${queueId}
    RETURNING *
  `);

  return rowsFrom(result)[0] || null;
}

export async function recordCallAttempt(input, { database = db } = {}) {
  assertOperationalPayloadHasNoPlainPhi(input);
  const queueId = requireString(input.queueId, 'queueId');
  const seniorId = requireString(input.seniorId, 'seniorId');
  const attemptNumber = safePositiveInteger(input.attemptNumber, 1, 100);
  const architecture = requireString(input.architecture, 'architecture');
  const status = input.status || 'initiating';

  const inserted = await database.execute(sql`
    INSERT INTO call_attempts (
      queue_id,
      senior_id,
      attempt_number,
      provider,
      call_control_id,
      status,
      reservation_id,
      reserved_capacity,
      architecture,
      cohort,
      test_run_id,
      dispatch_decision_id,
      dial_started_at
    )
    VALUES (
      ${queueId},
      ${seniorId},
      ${attemptNumber},
      ${input.provider || 'telnyx'},
      ${input.callControlId || null},
      ${status},
      ${input.reservationId || null},
      ${safePositiveInteger(input.reservedCapacity, 1, 100)},
      ${architecture},
      ${input.cohort || null},
      ${input.testRunId || null},
      ${input.dispatchDecisionId || null},
      ${input.dialStartedAt ? requireDate(input.dialStartedAt, 'dialStartedAt') : new Date()}
    )
    ON CONFLICT (queue_id, attempt_number) DO NOTHING
    RETURNING *
  `);

  const insertedRow = rowsFrom(inserted)[0];
  if (insertedRow) {
    return { inserted: true, row: insertedRow };
  }

  const existing = await database.execute(sql`
    SELECT *
    FROM call_attempts
    WHERE queue_id = ${queueId}
      AND attempt_number = ${attemptNumber}
    LIMIT 1
  `);
  return { inserted: false, row: rowsFrom(existing)[0] || null };
}

export async function markCallAttemptSuppressed(input, { database = db } = {}) {
  const attemptId = input.attemptId || input.attempt_id || null;
  if (!attemptId) return null;
  const providerErrorCode = String(input.providerErrorCode || 'dispatch_suppressed').slice(0, 200);

  const result = await database.execute(sql`
    UPDATE call_attempts
    SET status = 'suppressed',
        provider_error_code = ${providerErrorCode},
        provider_error_class = 'suppressed',
        updated_at = NOW()
    WHERE id = ${attemptId}
    RETURNING *
  `);

  return rowsFrom(result)[0] || null;
}

export function buildQueueOutboundCallParams(row, {
  baseUrl,
  reservationId,
  serviceLabel = 'dispatcher',
  affinityInstanceId = null,
} = {}) {
  const callType = queueRowValue(row, 'callType', 'call_type');
  const seniorId = requireString(queueRowValue(row, 'seniorId', 'senior_id'), 'seniorId');
  const queueId = requireString(rowId(row), 'queueId');
  const targetAt = queueRowValue(row, 'targetAt', 'target_at');
  const reminderId = queueRowValue(row, 'reminderId', 'reminder_id');

  const pipecatCallType = callType === 'schedule'
    ? 'schedule'
    : callType === 'reminder'
      ? 'reminder'
      : 'check-in';

  const params = {
    seniorId,
    callType: pipecatCallType,
    queueId,
    ...(reservationId ? { reservationId } : {}),
    ...(serviceLabel ? { serviceLabel } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(affinityInstanceId ? { affinityInstanceId } : {}),
  };

  if (callType === 'reminder' && reminderId) {
    params.reminderId = reminderId;
    if (targetAt) {
      params.scheduledFor = requireDate(targetAt, 'targetAt').toISOString();
    }
  }

  assertOperationalPayloadHasNoPlainPhi(params);
  return params;
}

function errorCodeFrom(error) {
  const name = String(error?.name || '').trim();
  if (name) return name;
  const message = String(error?.message || 'dispatch_failed').trim();
  return message.split(/\s+/).slice(0, 4).join('_').toLowerCase() || 'dispatch_failed';
}

export async function dispatchQueuedCalls({
  leaseOwner,
  capacitySlots = null,
  instances = null,
  limit = 10,
  now = new Date(),
  leaseSeconds = 60,
  baseUrl = null,
  testRunId = null,
  canaryPercent = 100,
  respectLanePolicy = true,
  lanePressure = null,
  lanePolicy = DEFAULT_LANE_RESERVE_POLICY,
  overbookFactor = 1,
  reservationTtlSeconds = DEFAULT_RESERVATION_TTL_SECONDS,
  architecture = 'queue',
  cohort = null,
  canarySeniorIds = [],
} = {}, {
  database = db,
  dialCall = initiateTelnyxOutboundCall,
  acquireReservation = acquirePipecatCapacityReservation,
  releaseReservation = releasePipecatCapacityReservation,
} = {}) {
  if (queueDispatcherDraining) {
    return emptyDispatchResult({ draining: true });
  }

  // Defense-in-depth: refuse to dial in modes where the rollout contract
  // says the queue path must not place real Telnyx calls. The dispatcher
  // worker in scripts/run-dispatcher-worker.js gates on allowRealDial, but
  // any direct caller of dispatchQueuedCalls must also be protected so a
  // future scheduler or test harness can't accidentally dial in
  // shadow_dispatch / shadow_materialize / legacy_only / legacy_rollback.
  const architectureConfig = resolveCallArchitectureConfig();
  if (!architectureConfig.allowRealDial) {
    return emptyDispatchResult({ skipped: 'real_dial_not_permitted', mode: architectureConfig.mode });
  }

  const resolvedCapacitySlots = capacitySlots == null
    ? estimateAvailablePipecatCapacity({ instances, overbookFactor })
    : capacitySlots;
  const safeCapacitySlots = boundedInteger(resolvedCapacitySlots, 0, 0, 1000);
  if (safeCapacitySlots <= 0) {
    return emptyDispatchResult();
  }

  const safeLimit = Math.min(safePositiveInteger(limit, 10, 1000), safeCapacitySlots);
  const currentTime = requireDate(now, 'now');
  const owner = requireString(leaseOwner, 'leaseOwner');
  const safeCanaryPercent = boundedInteger(canaryPercent, 100, 0, 100);
  const finishDispatch = trackQueueDispatch();

  try {
  let capacityPlan = null;
  let leasedRows = [];

  if (respectLanePolicy) {
    const pressure = lanePressure
      ? normalizeLanePressure(lanePressure)
      : await countReadyQueuedCallsByLane({
        now: currentTime,
        canaryPercent: safeCanaryPercent,
        canarySeniorIds,
      }, { database });
    capacityPlan = buildLaneCapacityPlan({
      capacitySlots: safeLimit,
      lanePressure: pressure,
      lanePolicy,
    });

    for (const lane of LANES_IN_DISPATCH_ORDER) {
      const laneLimit = capacityPlan.plannedByLane[lane];
      if (laneLimit <= 0) continue;
      const laneRows = await leaseQueuedCalls({
        leaseOwner: owner,
        limit: laneLimit,
        now: currentTime,
        leaseSeconds,
        priorityLane: lane,
        canaryPercent: safeCanaryPercent,
        canarySeniorIds,
      }, { database });
      leasedRows = leasedRows.concat(laneRows);
    }
  } else {
    leasedRows = await leaseQueuedCalls({
      leaseOwner: owner,
      limit: safeLimit,
      now: currentTime,
      leaseSeconds,
      canaryPercent: safeCanaryPercent,
      canarySeniorIds,
    }, { database });
  }

  const result = {
    requested: safeLimit,
    leased: leasedRows.length,
    reserved: 0,
    dialed: 0,
    suppressed: 0,
    failed: 0,
    releasedReservations: 0,
    ...(capacityPlan ? { capacityPlan } : {}),
  };

  const affinityEnabled = isPromptCacheAffinityEnabled();
  const affinityInstancesById = new Map();
  if (affinityEnabled && Array.isArray(instances)) {
    for (const instance of instances) {
      const id = String(instance?.instanceId || instance?.instance_id || '');
      if (id) affinityInstancesById.set(id, instance);
    }
  }

  for (const row of leasedRows) {
    const queueId = rowId(row);
    const seniorId = queueRowValue(row, 'seniorId', 'senior_id');
    const callType = queueRowValue(row, 'callType', 'call_type') || 'unknown';
    const targetAt = queueRowValue(row, 'targetAt', 'target_at');
    const attemptNumber = countValue(queueRowValue(row, 'attemptCount', 'attempt_count')) + 1;
    const reservationId = `queue:${queueId}:${crypto.randomUUID()}`;
    let reservationAcquired = false;
    let guard = null;
    let attempt = null;
    let affinityHintInstanceId = null;
    if (affinityEnabled && seniorId) {
      try {
        const hint = await getReplicaAffinityHint(seniorId);
        if (hint) {
          affinityHintInstanceId = pickAffinityReplica({
            instances: affinityInstancesById.size > 0
              ? [...affinityInstancesById.values()]
              : instances || [],
            affinityInstanceId: hint,
          });
        }
      } catch {
        // Affinity is best-effort; missing hints fall back to capacity-only selection.
      }
    }

    try {
      if (queueDispatcherDraining) {
        result.draining = true;
        await releaseQueuedCallForRetry({
          queueId,
          errorCode: 'dispatcher_draining',
        }, { database });
        continue;
      }

      const reservation = await acquireReservation({
        reservationId,
        queueId,
        ttlSeconds: reservationTtlSeconds,
        createdAt: currentTime,
      });
      if (!reservation.acquired) {
        await releaseQueuedCallForRetry({
          queueId,
          errorCode: reservation.reason || 'capacity_reservation_unavailable',
        }, { database });
        continue;
      }
      reservationAcquired = true;
      trackCapacityReservation({ reservationId, queueId });
      result.reserved++;

      // Pass leaseSeconds so defaultGuardExpiry can compute the tight
      // expiry window (`targetAt + max(60s, 2 * leaseSeconds + 30s)`).
      // A previous version hardcoded a 24h expiry here, which defeated the
      // reconciler — a crashed dispatcher locked the senior for 24h.
      const guardResult = await acquireOutboundCallGuard({
        seniorId,
        queueId,
        guardKey: queueRowValue(row, 'dedupeKey', 'dedupe_key'),
        callType,
        architecture,
        targetAt,
        leaseSeconds,
      }, { database });

      if (!guardResult.acquired) {
        result.suppressed++;
        await cancelQueuedCall({
          queueId,
          cancelReason: 'outbound_guard_already_held',
        }, { database });
        await releaseReservation({ reservationId, queueId });
        untrackCapacityReservation(reservationId);
        reservationAcquired = false;
        result.releasedReservations++;
        continue;
      }
      guard = guardResult.guard;

      const attemptResult = await recordCallAttempt({
        queueId,
        seniorId,
        attemptNumber,
        provider: 'telnyx',
        status: 'initiating',
        reservationId,
        reservedCapacity: 1,
        architecture,
        cohort,
        testRunId,
        dialStartedAt: currentTime,
      }, { database });
      attempt = attemptResult.row;
      const initiating = await markQueuedCallInitiating({
        queueId,
        leaseOwner: owner,
        attemptId: attempt?.id || null,
      }, { database });
      if (!initiating) {
        // Lease was recovered by another dispatcher mid-dial. Release our
        // capacity reservation, mark the attempt suppressed, and skip the
        // dial. The dial-authority guard would have caught a double-dial
        // anyway, but bailing here avoids burning the Telnyx HTTP call.
        result.suppressed++;
        await markCallAttemptSuppressed({
          attemptId: attempt?.id || null,
          providerErrorCode: 'lease_lost_before_initiate',
        }, { database });
        await releaseReservation({ reservationId, queueId });
        untrackCapacityReservation(reservationId);
        reservationAcquired = false;
        result.releasedReservations++;
        continue;
      }

      const guardInitiating = await markOutboundCallGuardInitiatingIfCallable({
        guardId: guardIdFromRow(guard),
        guardKey: guardKeyFromRow(guard),
      }, { database });
      if (!guardInitiating.initiated) {
        const suppressReason = guardInitiating.suppressReason || 'guard_recheck_failed';
        result.suppressed++;
        await markCallAttemptSuppressed({
          attemptId: attempt?.id || null,
          providerErrorCode: suppressReason,
        }, { database });
        await cancelQueuedCall({
          queueId,
          cancelReason: suppressReason,
        }, { database });
        await releaseReservation({ reservationId, queueId });
        untrackCapacityReservation(reservationId);
        reservationAcquired = false;
        result.releasedReservations++;
        continue;
      }
      guard = guardInitiating.guard || guard;

      const call = await dialCall(buildQueueOutboundCallParams(row, {
        baseUrl,
        reservationId,
        affinityInstanceId: affinityHintInstanceId,
      }));
      const callControlId = call?.callControlId || call?.callSid || call?.sid || null;

      untrackCapacityReservation(reservationId);
      reservationAcquired = false;
      result.dialed++;

      if (affinityEnabled && seniorId) {
        const handledByInstance = call?.instanceId || call?.instance_id || affinityHintInstanceId;
        if (handledByInstance) {
          try {
            await recordReplicaAffinity(seniorId, handledByInstance);
          } catch {
            // Affinity persistence is operational metadata; failures must not abort the call.
          }
        }
      }
      try {
        await markOutboundCallGuardInitiated({
          guardId: guardIdFromRow(guard),
          guardKey: guardKeyFromRow(guard),
          callControlId,
        }, { database });
      } catch (error) {
        log.warn('Failed to mark queue outbound guard initiated after Telnyx call started', {
          queueId,
          error: error.message,
        });
      }
      try {
        const started = await markQueuedCallStarted({
          queueId,
          leaseOwner: owner,
          attemptId: attempt?.id || null,
          callControlId,
        }, { database });
        if (!started.queue) {
          // Row was cancelled / recovered by another dispatcher while we
          // were dialing. Log loudly so we can correlate against the
          // real Telnyx call that's now in flight; the dial-authority
          // guard ensures it's actually ours.
          log.warn('Queue row state changed mid-dial; STARTED filter did not match', {
            queueId,
            leaseOwner: owner,
            callControlId,
          });
        }
      } catch (error) {
        log.warn('Failed to mark queue call started after Telnyx call started', {
          queueId,
          error: error.message,
        });
      }
    } catch (error) {
      result.failed++;
      if (reservationAcquired) {
        if (inFlightCapacityReservations.has(reservationId)) {
          let reservationReleased = false;
          try {
            await releaseReservation({ reservationId, queueId });
            reservationReleased = true;
            result.releasedReservations++;
          } catch {
            // TTL is the fallback cleanup path for Redis reservations.
          } finally {
            if (reservationReleased) {
              untrackCapacityReservation(reservationId);
            }
            reservationAcquired = false;
          }
        } else {
          reservationAcquired = false;
        }
      }
      if (guard) {
        try {
          await releaseOutboundCallGuard({
            guardId: guardIdFromRow(guard),
            guardKey: guardKeyFromRow(guard),
          }, { database });
        } catch {
          // Guard retention is covered by the outbound guard table cleanup path.
        }
      }
      await releaseQueuedCallForRetry({
        queueId,
        errorCode: errorCodeFrom(error),
      }, { database });
    }
  }

  if (result.dialed > 0 || result.failed > 0 || result.suppressed > 0) {
    log.info('Queue live dispatch cycle', {
      requested: result.requested,
      leased: result.leased,
      reserved: result.reserved,
      dialed: result.dialed,
      suppressed: result.suppressed,
      failed: result.failed,
    });
  }

  return result;
  } finally {
    finishDispatch();
  }
}

function buildShadowDecisionAuditMetadata(row) {
  const metadata = {
    testRunId: row.testRunId,
    queueId: row.queueId,
    callType: row.callType,
    priorityLane: row.priorityLane,
    legacyDecision: row.legacyDecision,
    queueDecision: row.queueDecision,
    skipReason: row.skipReason,
    capacityDecision: row.capacityDecision,
    estimatedQueueLagSeconds: row.estimatedQueueLagSeconds,
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value != null)
  );
}

export async function recordSchedulerShadowComparison(input, {
  database = db,
  auditWriter = writeAudit,
} = {}) {
  const row = {
    testRunId: input.testRunId || null,
    seniorId: input.seniorId || null,
    queueId: input.queueId || null,
    callType: requireString(input.callType || 'unknown', 'callType'),
    priorityLane: input.priorityLane || null,
    legacyDedupKey: input.legacyDedupKey || null,
    queueDedupeKey: input.queueDedupeKey || null,
    targetAt: input.targetAt ? requireDate(input.targetAt, 'targetAt') : null,
    legacyDecision: enumValue(input.legacyDecision, LEGACY_DECISIONS, 'not_evaluated'),
    queueDecision: enumValue(input.queueDecision, QUEUE_DECISIONS, 'not_evaluated'),
    skipReason: enumValue(input.skipReason, SHADOW_SKIP_REASONS, 'unknown'),
    capacityDecision: enumValue(input.capacityDecision, CAPACITY_DECISIONS, 'not_evaluated'),
    estimatedQueueLagSeconds: input.estimatedQueueLagSeconds == null
      ? null
      : boundedInteger(input.estimatedQueueLagSeconds, null, 0, 24 * 60 * 60),
  };

  assertOperationalPayloadHasNoPlainPhi(row);

  const inserted = await database.execute(sql`
    INSERT INTO scheduler_shadow_comparisons (
      test_run_id,
      senior_id,
      queue_id,
      call_type,
      priority_lane,
      legacy_dedup_key,
      queue_dedupe_key,
      target_at,
      legacy_decision,
      queue_decision,
      skip_reason,
      capacity_decision,
      estimated_queue_lag_seconds
    )
    VALUES (
      ${row.testRunId},
      ${row.seniorId},
      ${row.queueId},
      ${row.callType},
      ${row.priorityLane},
      ${row.legacyDedupKey},
      ${row.queueDedupeKey},
      ${row.targetAt},
      ${row.legacyDecision},
      ${row.queueDecision},
      ${row.skipReason},
      ${row.capacityDecision},
      ${row.estimatedQueueLagSeconds}
    )
    RETURNING *
  `);

  const insertedRow = rowsFrom(inserted)[0] || null;
  if (auditWriter) {
    await auditWriter({
      userId: 'system',
      userRole: 'system',
      action: 'shadow_decision',
      resourceType: 'senior',
      resourceId: row.seniorId,
      metadata: buildShadowDecisionAuditMetadata(row),
    });
  }

  return insertedRow;
}

export function getPriorityLaneOrder() {
  return [...LANES_IN_DISPATCH_ORDER];
}
