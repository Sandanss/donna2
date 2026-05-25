import crypto from 'node:crypto';
import { createPipecatRedisCommand } from './pipecat-capacity.js';

const DEFAULT_PREFIX = 'rate-limit';

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function redisRateLimitBackendConfigured(env = process.env) {
  return Boolean(
    env.REDIS_URL ||
    (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN)
  );
}

export function redisRateLimitsEnabled(env = process.env) {
  return parseBoolean(env.REDIS_RATE_LIMITS_ENABLED);
}

function redisRateLimitKey(rawKey, prefix) {
  const digest = crypto
    .createHash('sha256')
    .update(String(rawKey || ''))
    .digest('hex');
  return `${DEFAULT_PREFIX}:${prefix}:${digest}`;
}

function parseInteger(value, defaultValue = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export class RedisRateLimitStore {
  constructor({
    prefix,
    env = process.env,
    command = null,
  } = {}) {
    this.prefix = String(prefix || 'api').replace(/[^a-z0-9:-]/gi, '-').toLowerCase();
    this.env = env;
    this.command = command;
    this.windowMs = 60_000;
    this.localKeys = false;
  }

  init(options = {}) {
    this.windowMs = Math.max(1, Number.parseInt(options.windowMs, 10) || this.windowMs);
  }

  async _withRuntime(callback) {
    const runtime = createPipecatRedisCommand({
      env: this.env,
      command: this.command,
    });
    if (!runtime.configured) {
      throw new Error('Redis/shared state is required when REDIS_RATE_LIMITS_ENABLED=true');
    }

    try {
      return await callback(runtime.command);
    } finally {
      await runtime.close();
    }
  }

  async increment(key) {
    const redisKey = redisRateLimitKey(key, this.prefix);
    const now = Date.now();
    const totalHits = await this._withRuntime(async (command) => {
      const hits = parseInteger(await command('INCR', redisKey), 1);
      if (hits === 1) {
        await command('PEXPIRE', redisKey, this.windowMs);
      }
      return hits;
    });

    let ttlMs = await this._withRuntime(async (command) => parseInteger(await command('PTTL', redisKey), -1));
    if (ttlMs < 0) {
      await this._withRuntime(async (command) => command('PEXPIRE', redisKey, this.windowMs));
      ttlMs = this.windowMs;
    }

    return {
      totalHits,
      resetTime: new Date(now + ttlMs),
    };
  }

  async decrement(key) {
    const redisKey = redisRateLimitKey(key, this.prefix);
    await this._withRuntime(async (command) => {
      const hits = parseInteger(await command('DECR', redisKey), 0);
      if (hits < 0) {
        await command('DEL', redisKey);
      }
    });
  }

  async resetKey(key) {
    const redisKey = redisRateLimitKey(key, this.prefix);
    await this._withRuntime(async (command) => command('DEL', redisKey));
  }

  async resetAll() {
    const pattern = `${DEFAULT_PREFIX}:${this.prefix}:*`;
    await this._withRuntime(async (command) => {
      let cursor = '0';
      do {
        const result = await command('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100);
        if (!Array.isArray(result) || result.length !== 2) return;
        cursor = String(result[0]);
        const keys = Array.isArray(result[1]) ? result[1] : [];
        if (keys.length > 0) {
          await command('DEL', ...keys);
        }
      } while (cursor !== '0');
    });
  }

  shutdown() {
    return undefined;
  }
}

export function createRedisRateLimitStore({ prefix, env = process.env } = {}) {
  if (!redisRateLimitsEnabled(env)) return undefined;
  if (!redisRateLimitBackendConfigured(env)) {
    throw new Error('REDIS_URL or UPSTASH_REDIS_REST_URL/TOKEN is required when REDIS_RATE_LIMITS_ENABLED=true');
  }
  return new RedisRateLimitStore({ prefix, env });
}
