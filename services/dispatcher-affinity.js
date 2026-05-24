/**
 * Prompt-cache replica affinity (Phase 4 §10).
 *
 * Anthropic's 5-minute prompt-cache TTL is per-replica because each Pipecat
 * instance maintains its own connection-level cache. If Phase 0 measurement
 * shows cross-call cache hit rate is materially positive, grouping calls for
 * one senior on one replica increases the within-window cache reuse rate.
 *
 * The dispatcher records `senior_id -> instance_id` in Redis after each
 * successful dial, and reads the hint back next time it dispatches for that
 * senior. The hint is operational metadata only — no PHI; the senior ID is
 * the canonical reference everywhere else in operational state.
 *
 * Today there is no cross-replica routing layer; even with a hint, the call
 * lands on whichever Pipecat replica Telnyx routes the WebSocket to. This
 * module ships the hint pipeline so the eventual routing work item is one
 * routing-layer change, not a dispatcher rewrite. Enable via
 * `DISPATCHER_PROMPT_CACHE_AFFINITY=true`.
 */

import { createPipecatRedisCommand } from './pipecat-capacity.js';

const AFFINITY_KEY_PREFIX = 'dispatcher:affinity:senior:';
// Anthropic prompt-cache TTL is 5 min; affinity lifetime tracks that ceiling.
const DEFAULT_AFFINITY_TTL_SECONDS = 5 * 60;

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function parsePositiveInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function requireString(value, fieldName) {
  const stringValue = String(value || '').trim();
  if (!stringValue) throw new Error(`${fieldName} is required`);
  return stringValue;
}

function affinityKey(seniorId) {
  return `${AFFINITY_KEY_PREFIX}${requireString(seniorId, 'seniorId')}`;
}

export function isPromptCacheAffinityEnabled(env = process.env) {
  return parseBoolean(env.DISPATCHER_PROMPT_CACHE_AFFINITY);
}

export function resolveAffinityTtlSeconds(env = process.env) {
  // Anthropic's prompt-cache TTL is 5 minutes — values above that are
  // operationally meaningless (the cache the hint targets is gone). Clamp
  // upward so a misconfig can't route to a stale replica past the cache
  // window. See Phase 4 §10 in the scale-2000 plan.
  const requested = parsePositiveInteger(
    env.DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS,
    DEFAULT_AFFINITY_TTL_SECONDS,
  );
  return Math.min(requested, DEFAULT_AFFINITY_TTL_SECONDS);
}

/**
 * Read the current senior->replica hint, if any. Returns null when the hint
 * pipeline is disabled, Redis is not configured, or no hint exists.
 */
export async function getReplicaAffinityHint(seniorId, {
  env = process.env,
  command = null,
} = {}) {
  if (!isPromptCacheAffinityEnabled(env)) return null;
  const runtime = createPipecatRedisCommand({ env, command });
  if (!runtime.configured) return null;
  try {
    const value = await runtime.command('GET', affinityKey(seniorId));
    return value ? String(value) : null;
  } finally {
    await runtime.close();
  }
}

/**
 * Record senior->replica affinity after a successful dial. Idempotent: a TTL
 * reset on every successful dial keeps the hint fresh for the 5-minute window.
 */
export async function recordReplicaAffinity(seniorId, instanceId, {
  env = process.env,
  command = null,
  ttlSeconds = null,
} = {}) {
  if (!isPromptCacheAffinityEnabled(env)) return { recorded: false, reason: 'affinity_disabled' };
  if (!seniorId || !instanceId) return { recorded: false, reason: 'missing_input' };
  const runtime = createPipecatRedisCommand({ env, command });
  if (!runtime.configured) return { recorded: false, reason: 'no_shared_state' };
  const ttl = parsePositiveInteger(ttlSeconds, resolveAffinityTtlSeconds(env));
  try {
    await runtime.command('SET', affinityKey(seniorId), String(instanceId), 'EX', ttl);
    return { recorded: true, ttlSeconds: ttl };
  } finally {
    await runtime.close();
  }
}

/**
 * Choose the best replica for a senior given the capacity registry. Returns
 * the affinity replica's instance_id when it has free capacity, otherwise null
 * so the caller can fall back to capacity-only selection.
 */
export function pickAffinityReplica({
  instances = [],
  affinityInstanceId = null,
} = {}) {
  if (!affinityInstanceId) return null;
  if (!Array.isArray(instances)) return null;
  const candidate = instances.find(instance =>
    String(instance?.instanceId || instance?.instance_id || '') === String(affinityInstanceId)
  );
  if (!candidate) return null;
  if (candidate.draining || candidate.healthy === false) return null;
  if (candidate.ready === false) return null;
  const max = Number(candidate.maxCalls ?? candidate.max_calls ?? 0);
  const active = Number(candidate.activeCalls ?? candidate.active_calls ?? 0);
  const inbound = Number(candidate.inboundActiveCalls ?? candidate.inbound_active_calls ?? 0);
  const pending = Number(
    candidate.pendingReservations ??
    candidate.pending_reservations ??
    candidate.pendingStartCount ??
    candidate.pending_start_count ?? 0
  );
  const inUse = Math.max(active, inbound) + pending;
  if (inUse >= max) return null;
  return String(candidate.instanceId || candidate.instance_id);
}
