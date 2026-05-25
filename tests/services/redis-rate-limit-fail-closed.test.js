import { describe, expect, it } from 'vitest';

import { RedisRateLimitStore } from '../../services/redis-rate-limit-store.js';
import { createOutageRedis } from '../integration-harness/redis.js';

describe('node Redis rate limiter fails closed on store outage', () => {
  it('rejects when INCR throws (would otherwise behave as allow-all)', async () => {
    // createOutageRedis returns a command that rejects on every call —
    // the canonical simulation of "Redis is down in scaled mode".
    const { command } = createOutageRedis(new Error('redis_unreachable_incr'));

    const store = new RedisRateLimitStore({
      prefix: 'node-call',
      env: {
        REDIS_RATE_LIMITS_ENABLED: 'true',
        REDIS_URL: 'redis://127.0.0.1:1',
      },
      command,
    });
    store.init({ windowMs: 60_000 });

    // The regression we are guarding against: silently resolving to a success
    // shape under outage, which would let SlowAPI / express-rate-limit treat
    // the request as "under the limit" and admit unbounded traffic.
    await expect(store.increment('203.0.113.10:/api/call')).rejects.toThrow(
      /redis_unreachable_incr/,
    );
  });

  it('rejects when PEXPIRE throws on the cold-key path', async () => {
    // Targeted failure: INCR succeeds returning 1 (cold key), then PEXPIRE
    // fails. The store must propagate, not swallow — otherwise the key would
    // never expire and the limiter window would become permanent.
    const command = async (...parts) => {
      const verb = String(parts[0]).toUpperCase();
      if (verb === 'INCR') return 1;
      if (verb === 'PEXPIRE') {
        throw new Error('redis_unreachable_pexpire');
      }
      if (verb === 'PTTL') return 60_000;
      throw new Error(`unexpected command ${verb}`);
    };

    const store = new RedisRateLimitStore({
      prefix: 'node-call',
      env: {
        REDIS_RATE_LIMITS_ENABLED: 'true',
        REDIS_URL: 'redis://127.0.0.1:1',
      },
      command,
    });
    store.init({ windowMs: 60_000 });

    await expect(store.increment('203.0.113.10:/api/call')).rejects.toThrow(
      /redis_unreachable_pexpire/,
    );
  });

  it('rejects decrement and resetKey when the store is unreachable', async () => {
    const { command } = createOutageRedis(new Error('redis_unreachable_op'));

    const store = new RedisRateLimitStore({
      prefix: 'node-call',
      env: {
        REDIS_RATE_LIMITS_ENABLED: 'true',
        REDIS_URL: 'redis://127.0.0.1:1',
      },
      command,
    });
    store.init({ windowMs: 60_000 });

    await expect(store.decrement('k')).rejects.toThrow(/redis_unreachable_op/);
    await expect(store.resetKey('k')).rejects.toThrow(/redis_unreachable_op/);
  });
});
