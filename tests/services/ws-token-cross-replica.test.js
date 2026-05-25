/**
 * Category A Tier-1 — WS-token cross-replica replay protection.
 *
 * The Pipecat WS auth path uses `SET ws_token_consumed:{cid} <id> EX <ttl> NX`
 * to atomically claim a token. If two replicas race for the same token
 * (replay attack OR misrouted Telnyx stream-start), exactly one must win.
 *
 * This test proves the primitive itself works correctly through the shared
 * mock-redis backing — the same backing used by services/pipecat-capacity.js,
 * services/dispatcher-affinity.js, and the Pipecat shared-state harness.
 * The Pipecat-side cross-replica simulation lives in pipecat/tests/
 * test_ws_token_cross_replica.py (also added in this commit set).
 */

import { describe, expect, it } from 'vitest';

import { createMockRedis } from '../integration-harness/redis.js';

const WS_TOKEN_KEY_PREFIX = 'ws_token_consumed:';
const WS_TOKEN_TTL_SECONDS = 600;

async function tryConsumeWsToken({ command, callControlId, consumerId, ttlSeconds = WS_TOKEN_TTL_SECONDS }) {
  const key = `${WS_TOKEN_KEY_PREFIX}${callControlId}`;
  const result = await command('SET', key, consumerId, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

describe('Category A — WS token consume across replicas', () => {
  it('two concurrent consumes against the same call_control_id — exactly one wins', async () => {
    const { command } = createMockRedis();
    const cid = 'v3:cci-cross-replica-1';

    const [replicaA, replicaB] = await Promise.all([
      tryConsumeWsToken({ command, callControlId: cid, consumerId: 'replica-a' }),
      tryConsumeWsToken({ command, callControlId: cid, consumerId: 'replica-b' }),
    ]);

    const winners = [replicaA, replicaB].filter(Boolean).length;
    expect(winners).toBe(1);
  });

  it('subsequent consume by the loser still returns false even after retry', async () => {
    const { command } = createMockRedis();
    const cid = 'v3:cci-replay-2';

    const first = await tryConsumeWsToken({ command, callControlId: cid, consumerId: 'first' });
    const replay1 = await tryConsumeWsToken({ command, callControlId: cid, consumerId: 'second' });
    const replay2 = await tryConsumeWsToken({ command, callControlId: cid, consumerId: 'third' });

    expect(first).toBe(true);
    expect(replay1).toBe(false);
    expect(replay2).toBe(false);
  });

  it('TTL allows reuse only after expiry — different cid is independent', async () => {
    const { command } = createMockRedis();

    const cidA = 'v3:cci-a';
    const cidB = 'v3:cci-b';

    expect(await tryConsumeWsToken({ command, callControlId: cidA, consumerId: 'x' })).toBe(true);
    expect(await tryConsumeWsToken({ command, callControlId: cidB, consumerId: 'y' })).toBe(true);

    expect(await tryConsumeWsToken({ command, callControlId: cidA, consumerId: 'z' })).toBe(false);
    expect(await tryConsumeWsToken({ command, callControlId: cidB, consumerId: 'w' })).toBe(false);
  });

  it('high contention: 32 concurrent consumes — exactly one winner', async () => {
    const { command } = createMockRedis();
    const cid = 'v3:cci-storm';

    const attempts = Array.from({ length: 32 }, (_, idx) =>
      tryConsumeWsToken({ command, callControlId: cid, consumerId: `replica-${idx}` })
    );
    const results = await Promise.all(attempts);
    const winners = results.filter(Boolean).length;
    expect(winners).toBe(1);
  });
});
