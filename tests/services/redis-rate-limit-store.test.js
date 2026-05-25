import { describe, expect, it } from 'vitest';

import {
  RedisRateLimitStore,
  createRedisRateLimitStore,
} from '../../services/redis-rate-limit-store.js';

describe('RedisRateLimitStore', () => {
  it('stores fixed-window counters under hashed PHI-free keys', async () => {
    const store = new Map();
    const expiries = new Map();
    const calls = [];
    const command = async (...parts) => {
      calls.push(parts);
      const [op, key] = parts;
      if (op === 'INCR') {
        const next = Number(store.get(key) || 0) + 1;
        store.set(key, String(next));
        return next;
      }
      if (op === 'PEXPIRE') {
        expiries.set(key, Number(parts[2]));
        return 1;
      }
      if (op === 'PTTL') {
        return expiries.get(key) || -1;
      }
      if (op === 'DEL') {
        let deleted = 0;
        for (const deleteKey of parts.slice(1)) {
          if (store.delete(deleteKey)) deleted++;
          expiries.delete(deleteKey);
        }
        return deleted;
      }
      throw new Error(`unexpected command ${op}`);
    };
    const limiterStore = new RedisRateLimitStore({
      prefix: 'node-call',
      command,
    });
    limiterStore.init({ windowMs: 60_000 });

    const first = await limiterStore.increment('192.0.2.1:/api/call');
    const second = await limiterStore.increment('192.0.2.1:/api/call');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.resetTime).toBeInstanceOf(Date);
    const redisKey = calls.find(parts => parts[0] === 'INCR')[1];
    expect(redisKey).toMatch(/^rate-limit:node-call:[a-f0-9]{64}$/);
    expect(redisKey).not.toContain('192.0.2.1');
    expect(redisKey).not.toContain('/api/call');
    expect(expiries.get(redisKey)).toBe(60_000);
  });

  it('deletes all keys for one limiter prefix', async () => {
    const keys = new Set([
      'rate-limit:node-api:a',
      'rate-limit:node-api:b',
      'rate-limit:node-call:c',
    ]);
    const command = async (...parts) => {
      if (parts[0] === 'SCAN') {
        return ['0', [...keys].filter(key => key.startsWith('rate-limit:node-api:'))];
      }
      if (parts[0] === 'DEL') {
        for (const key of parts.slice(1)) keys.delete(key);
        return parts.length - 1;
      }
      throw new Error(`unexpected command ${parts[0]}`);
    };
    const limiterStore = new RedisRateLimitStore({ prefix: 'node-api', command });

    await limiterStore.resetAll();

    expect([...keys]).toEqual(['rate-limit:node-call:c']);
  });

  it('builds a store only when Redis rate limits are enabled and configured', () => {
    expect(createRedisRateLimitStore({
      prefix: 'node-api',
      env: {},
    })).toBeUndefined();

    expect(() => createRedisRateLimitStore({
      prefix: 'node-api',
      env: { REDIS_RATE_LIMITS_ENABLED: 'true' },
    })).toThrow(/REDIS_URL/);

    expect(createRedisRateLimitStore({
      prefix: 'node-api',
      env: {
        REDIS_RATE_LIMITS_ENABLED: 'true',
        UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
        UPSTASH_REDIS_REST_TOKEN: 'token',
      },
    })).toBeInstanceOf(RedisRateLimitStore);
  });
});
