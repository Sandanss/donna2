/**
 * ioredis-mock adapter for tests that consume the `command(...parts)`
 * injection point used by services/pipecat-capacity.js,
 * services/dispatcher-affinity.js, and services/redis-rate-limit-store.js.
 *
 * Provides a structurally-compatible Redis without Docker.
 */

import RedisMock from 'ioredis-mock';

const PROTOCOL_LEVEL_COMMANDS = new Set([
  'SET', 'GET', 'DEL', 'EXPIRE', 'PEXPIRE', 'EXISTS', 'INCR', 'DECR',
  'INCRBY', 'DECRBY', 'TTL', 'PTTL',
  'HSET', 'HGET', 'HGETALL', 'HMSET', 'HMGET', 'HDEL',
  'SADD', 'SMEMBERS', 'SREM',
  'KEYS', 'SCAN', 'PING',
]);

/**
 * Build an ioredis-mock instance + a `command(...parts)` adapter that mirrors
 * the wire-level interface our services expect from
 * `createPipecatRedisCommand({ command }).command`.
 *
 * Supports the SET ... NX|EX|PX modifiers used by capacity reservations and
 * the affinity hint pipeline.
 */
export function createMockRedis() {
  const client = new RedisMock();

  async function command(...parts) {
    if (parts.length === 0) return null;
    const verb = String(parts[0]).toUpperCase();
    const args = parts.slice(1).map(String);

    if (verb === 'SET') {
      // Parse [key, value, ...modifiers]
      const [key, value, ...modifiers] = args;
      const upper = modifiers.map(m => String(m).toUpperCase());
      let ttlSeconds = null;
      let ttlMilliseconds = null;
      let nx = false;
      let xx = false;
      for (let i = 0; i < upper.length; i++) {
        if (upper[i] === 'EX') ttlSeconds = Number(modifiers[i + 1]);
        else if (upper[i] === 'PX') ttlMilliseconds = Number(modifiers[i + 1]);
        else if (upper[i] === 'NX') nx = true;
        else if (upper[i] === 'XX') xx = true;
      }
      if (nx) {
        const result = ttlSeconds != null
          ? await client.set(key, value, 'EX', ttlSeconds, 'NX')
          : ttlMilliseconds != null
            ? await client.set(key, value, 'PX', ttlMilliseconds, 'NX')
            : await client.set(key, value, 'NX');
        return result === 'OK' ? 'OK' : null;
      }
      if (xx) {
        const result = ttlSeconds != null
          ? await client.set(key, value, 'EX', ttlSeconds, 'XX')
          : ttlMilliseconds != null
            ? await client.set(key, value, 'PX', ttlMilliseconds, 'XX')
            : await client.set(key, value, 'XX');
        return result === 'OK' ? 'OK' : null;
      }
      if (ttlSeconds != null) return client.set(key, value, 'EX', ttlSeconds);
      if (ttlMilliseconds != null) return client.set(key, value, 'PX', ttlMilliseconds);
      return client.set(key, value);
    }

    if (verb === 'DEL') {
      return client.del(...args);
    }

    if (verb === 'SCAN') {
      // SCAN cursor [MATCH pattern] [COUNT count]
      const cursor = args[0];
      let pattern = '*';
      let count = 100;
      for (let i = 1; i < args.length; i++) {
        const mod = String(args[i]).toUpperCase();
        if (mod === 'MATCH') pattern = args[i + 1];
        if (mod === 'COUNT') count = Number(args[i + 1]);
      }
      return client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    }

    if (verb === 'HGETALL') {
      const result = await client.hgetall(args[0]);
      // ioredis-mock returns {}; the production driver returns null for missing.
      if (!result || Object.keys(result).length === 0) return null;
      // Wire-protocol path returns array form [k, v, k, v]; mock returns object.
      // Our consumer (normalizePipecatCapacityHeartbeat) handles both.
      return result;
    }

    if (verb === 'HSET') {
      // HSET key field value [field value ...]
      const [key, ...rest] = args;
      return client.hset(key, ...rest);
    }

    if (verb === 'PING') {
      return client.ping();
    }

    if (verb === 'EXPIRE') {
      return client.expire(args[0], Number(args[1]));
    }

    if (verb === 'KEYS') {
      return client.keys(args[0]);
    }

    if (verb === 'GET') {
      return client.get(args[0]);
    }

    if (verb === 'INCR') {
      return client.incr(args[0]);
    }

    if (verb === 'INCRBY') {
      return client.incrby(args[0], Number(args[1]));
    }

    if (verb === 'EXISTS') {
      return client.exists(...args);
    }

    if (PROTOCOL_LEVEL_COMMANDS.has(verb) && typeof client[verb.toLowerCase()] === 'function') {
      return client[verb.toLowerCase()](...args);
    }

    throw new Error(`mock redis: unsupported command ${verb}`);
  }

  async function close() {
    // ioredis-mock has no socket; nothing to close. Provide for harness parity.
    return Promise.resolve();
  }

  function flushall() {
    return client.flushall();
  }

  return { client, command, close, flushall };
}

/**
 * Helper for tests that need to force a Redis-outage scenario. Returns a
 * `command` function that throws the given error for every call. Tests can
 * pass this into createPipecatRedisCommand({ command }) to simulate
 * shared-state unreachable in required mode.
 */
export function createOutageRedis(error = new Error('redis_unreachable')) {
  return {
    command: () => Promise.reject(error),
    close: () => Promise.resolve(),
  };
}
