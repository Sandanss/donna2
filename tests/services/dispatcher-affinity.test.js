import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getReplicaAffinityHint,
  isPromptCacheAffinityEnabled,
  pickAffinityReplica,
  recordReplicaAffinity,
  resolveAffinityTtlSeconds,
} from '../../services/dispatcher-affinity.js';

function buildInstance(overrides = {}) {
  return {
    instanceId: 'replica-a',
    healthy: true,
    draining: false,
    ready: true,
    maxCalls: 10,
    activeCalls: 0,
    inboundActiveCalls: 0,
    pendingReservations: 0,
    ...overrides,
  };
}

describe('dispatcher prompt-cache affinity', () => {
  beforeEach(() => {
    delete process.env.DISPATCHER_PROMPT_CACHE_AFFINITY;
    delete process.env.DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is disabled by default and returns no hint without the flag', async () => {
    expect(isPromptCacheAffinityEnabled({ DISPATCHER_PROMPT_CACHE_AFFINITY: undefined })).toBe(false);
    const command = vi.fn();
    const hint = await getReplicaAffinityHint('senior-1', {
      env: { DISPATCHER_PROMPT_CACHE_AFFINITY: 'false' },
      command,
    });
    expect(hint).toBeNull();
    expect(command).not.toHaveBeenCalled();
  });

  it('reads the recorded replica when affinity is enabled', async () => {
    const command = vi.fn(async (cmd, key) => (cmd === 'GET' ? `replica-${key.slice(-1)}` : null));
    const hint = await getReplicaAffinityHint('senior-7', {
      env: { DISPATCHER_PROMPT_CACHE_AFFINITY: 'true' },
      command,
    });
    expect(hint).toBe('replica-7');
    expect(command).toHaveBeenCalledWith('GET', 'dispatcher:affinity:senior:senior-7');
  });

  it('writes affinity with a TTL bounded by the 5-minute prompt-cache window', async () => {
    process.env.DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS = '240';
    const calls = [];
    const command = vi.fn(async (...args) => { calls.push(args); return 'OK'; });
    const result = await recordReplicaAffinity('senior-3', 'replica-b', {
      env: { DISPATCHER_PROMPT_CACHE_AFFINITY: 'true', DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS: '240' },
      command,
    });
    expect(result).toEqual({ recorded: true, ttlSeconds: 240 });
    expect(calls[0]).toEqual([
      'SET',
      'dispatcher:affinity:senior:senior-3',
      'replica-b',
      'EX',
      240,
    ]);
    expect(resolveAffinityTtlSeconds({})).toBe(300);
  });

  it('skips writes when affinity is disabled or inputs missing', async () => {
    const command = vi.fn();
    const disabled = await recordReplicaAffinity('senior-1', 'replica-a', {
      env: {},
      command,
    });
    expect(disabled).toEqual({ recorded: false, reason: 'affinity_disabled' });
    const missing = await recordReplicaAffinity('', 'replica-a', {
      env: { DISPATCHER_PROMPT_CACHE_AFFINITY: 'true' },
      command,
    });
    expect(missing).toEqual({ recorded: false, reason: 'missing_input' });
    expect(command).not.toHaveBeenCalled();
  });

  it('picks the affinity replica only when it has free capacity', () => {
    const free = pickAffinityReplica({
      instances: [buildInstance({ instanceId: 'replica-a', maxCalls: 10, activeCalls: 5 })],
      affinityInstanceId: 'replica-a',
    });
    expect(free).toBe('replica-a');

    const saturated = pickAffinityReplica({
      instances: [buildInstance({ instanceId: 'replica-a', maxCalls: 10, activeCalls: 10 })],
      affinityInstanceId: 'replica-a',
    });
    expect(saturated).toBeNull();

    const draining = pickAffinityReplica({
      instances: [buildInstance({ instanceId: 'replica-a', draining: true })],
      affinityInstanceId: 'replica-a',
    });
    expect(draining).toBeNull();

    const unknown = pickAffinityReplica({
      instances: [buildInstance({ instanceId: 'replica-a' })],
      affinityInstanceId: 'replica-b',
    });
    expect(unknown).toBeNull();
  });

  it('skips selection when hint is empty even with healthy replicas', () => {
    const result = pickAffinityReplica({
      instances: [buildInstance({ instanceId: 'replica-a' })],
      affinityInstanceId: null,
    });
    expect(result).toBeNull();
  });
});
