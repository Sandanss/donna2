import net from 'node:net';
import tls from 'node:tls';

const PIPECAT_HEARTBEAT_KEY_PREFIX = 'pipecat:instance:';
const PIPECAT_RESERVATION_KEY_PREFIX = 'pipecat:reservation:';
const PIPECAT_QUEUE_RESERVATION_KEY_PREFIX = 'pipecat:queue-reservations:';
const PIPECAT_RESERVATION_SLOT_KEY_PREFIX = 'pipecat:reservation-slot:';
const DEFAULT_HEARTBEAT_MAX_AGE_SECONDS = 15;
const DEFAULT_REDIS_TIMEOUT_MS = 5000;
const DEFAULT_RESERVATION_TTL_SECONDS = 300;

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function parseInteger(value, defaultValue = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function parsePositiveInteger(value, defaultValue = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseFloatSeconds(value, defaultValue = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function parseJsonHashValue(value) {
  if (value == null) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeHash(rawHash) {
  if (!rawHash) return null;

  const entries = Array.isArray(rawHash)
    ? rawHash.reduce((pairs, value, index, values) => {
      if (index % 2 === 0) pairs.push([value, values[index + 1]]);
      return pairs;
    }, [])
    : Object.entries(rawHash);

  return Object.fromEntries(entries.map(([key, value]) => [
    String(key),
    parseJsonHashValue(value),
  ]));
}

function normalizeUpstashUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  return trimmed.includes('://') ? trimmed.replace(/\/+$/, '') : `https://${trimmed.replace(/\/+$/, '')}`;
}

function requireString(value, fieldName) {
  const stringValue = String(value || '').trim();
  if (!stringValue) {
    throw new Error(`${fieldName} is required`);
  }
  return stringValue;
}

function redisSetNxSucceeded(result) {
  return result === 'OK' || result === '1' || result === 1 || result === true;
}

function redisBackendFromEnv(env = process.env) {
  const redisUrl = String(env.REDIS_URL || '').trim();
  const upstashUrl = String(env.UPSTASH_REDIS_REST_URL || '').trim();
  const upstashToken = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (redisUrl) return { backend: 'redis', redisUrl };
  if (upstashUrl && upstashToken) return { backend: 'upstash', upstashUrl, upstashToken };
  return { backend: 'none' };
}

function redisAuthArgs(url) {
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  if (!password) return [];
  if (username) return ['AUTH', username, password];
  return ['AUTH', password];
}

function redisDbIndex(url) {
  const db = String(url.pathname || '').replace(/^\//, '');
  if (!db) return null;
  const parsed = Number.parseInt(db, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function encodeRedisCommand(parts) {
  const values = parts.map(part => Buffer.from(String(part)));
  return Buffer.concat([
    Buffer.from(`*${values.length}\r\n`),
    ...values.flatMap(value => [
      Buffer.from(`$${value.length}\r\n`),
      value,
      Buffer.from('\r\n'),
    ]),
  ]);
}

class RedisRespConnection {
  constructor(redisUrl, { timeoutMs = DEFAULT_REDIS_TIMEOUT_MS } = {}) {
    this.url = new URL(redisUrl);
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.lastError = null;
  }

  async connect() {
    if (this.socket) return;

    const port = Number.parseInt(this.url.port || '', 10) || (this.url.protocol === 'rediss:' ? 6380 : 6379);
    const options = {
      host: this.url.hostname,
      port,
      timeout: this.timeoutMs,
    };

    const socket = this.url.protocol === 'rediss:'
      ? tls.connect(options)
      : net.connect(options);

    this.socket = socket;
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    });
    socket.on('error', error => {
      this.lastError = error;
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis connection timed out')), this.timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const auth = redisAuthArgs(this.url);
    if (auth.length > 0) {
      await this.command(...auth);
    }

    const db = redisDbIndex(this.url);
    if (db != null && db > 0) {
      await this.command('SELECT', db);
    }
  }

  async close() {
    if (!this.socket) return;
    this.socket.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }

  async command(...parts) {
    await this.connect();
    this.socket.write(encodeRedisCommand(parts));
    return this.readValue();
  }

  async readValue() {
    const prefix = await this.readBytes(1);
    const marker = prefix.toString('utf8');

    if (marker === '+') return this.readLine();
    if (marker === '-') throw new Error(await this.readLine());
    if (marker === ':') return Number.parseInt(await this.readLine(), 10);
    if (marker === '$') {
      const length = Number.parseInt(await this.readLine(), 10);
      if (length === -1) return null;
      const value = await this.readBytes(length);
      await this.readBytes(2);
      return value.toString('utf8');
    }
    if (marker === '*') {
      const count = Number.parseInt(await this.readLine(), 10);
      if (count === -1) return null;
      const values = [];
      for (let index = 0; index < count; index++) {
        values.push(await this.readValue());
      }
      return values;
    }

    throw new Error(`Unsupported Redis response marker: ${marker}`);
  }

  async readLine() {
    while (true) {
      const index = this.buffer.indexOf('\r\n');
      if (index >= 0) {
        const line = this.buffer.slice(0, index).toString('utf8');
        this.buffer = this.buffer.slice(index + 2);
        return line;
      }
      await this.waitForData();
    }
  }

  async readBytes(length) {
    while (this.buffer.length < length) {
      await this.waitForData();
    }
    const value = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return value;
  }

  async waitForData() {
    if (!this.socket) {
      throw new Error('Redis connection is closed');
    }
    if (this.lastError) {
      throw this.lastError;
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Redis read timed out')), this.timeoutMs);
      this.socket.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

async function upstashCommand(env, ...parts) {
  const url = normalizeUpstashUrl(env.UPSTASH_REDIS_REST_URL);
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parts),
  });
  if (!response.ok) {
    throw new Error(`Upstash command failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(payload.error);
  }
  return payload?.result;
}

function createPipecatRedisCommand({
  env = process.env,
  command = null,
} = {}) {
  if (command) {
    return {
      backend: 'injected',
      configured: true,
      command,
      close: async () => {},
    };
  }

  const backend = redisBackendFromEnv(env);
  if (backend.backend === 'none') {
    return {
      backend: 'none',
      configured: false,
      command: null,
      close: async () => {},
    };
  }

  let connection = null;
  if (backend.backend === 'redis') {
    return {
      backend: 'redis',
      configured: true,
      command: async (...parts) => {
        if (!connection) connection = new RedisRespConnection(backend.redisUrl);
        return connection.command(...parts);
      },
      close: async () => {
        await connection?.close();
      },
    };
  }

  return {
    backend: 'upstash',
    configured: true,
    command: (...parts) => upstashCommand(env, ...parts),
    close: async () => {},
  };
}

async function scanKeys(command, pattern) {
  let cursor = '0';
  const keys = [];

  do {
    const result = await command('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100);
    if (!Array.isArray(result) || result.length !== 2) {
      return keys;
    }
    cursor = String(result[0]);
    if (Array.isArray(result[1])) {
      keys.push(...result[1].map(String));
    }
  } while (cursor !== '0');

  return keys;
}

export function buildPipecatCapacityReservation({
  reservationId,
  queueId,
  createdAt = new Date(),
  ttlSeconds = DEFAULT_RESERVATION_TTL_SECONDS,
  slotIndex = null,
  slotKey = null,
} = {}) {
  const reservedAt = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(reservedAt.getTime())) {
    throw new Error('createdAt must be a valid date');
  }
  const safeTtl = parsePositiveInteger(ttlSeconds, DEFAULT_RESERVATION_TTL_SECONDS);
  return {
    reservation_id: requireString(reservationId, 'reservationId'),
    queue_id: requireString(queueId, 'queueId'),
    reserved_capacity: 1,
    created_at: reservedAt.toISOString(),
    expires_at: new Date(reservedAt.getTime() + safeTtl * 1000).toISOString(),
    ...(slotIndex == null ? {} : { slot_index: slotIndex }),
    ...(slotKey == null ? {} : { slot_key: slotKey }),
  };
}

export async function acquirePipecatCapacityReservation({
  reservationId,
  queueId,
  maxReservations = null,
  ttlSeconds = DEFAULT_RESERVATION_TTL_SECONDS,
  createdAt = new Date(),
  env = process.env,
  command = null,
} = {}) {
  const reservation = buildPipecatCapacityReservation({
    reservationId,
    queueId,
    ttlSeconds,
    createdAt,
  });
  const safeTtl = parsePositiveInteger(ttlSeconds, DEFAULT_RESERVATION_TTL_SECONDS);
  const runtime = createPipecatRedisCommand({ env, command });
  if (!runtime.configured) {
    throw new Error('Redis/shared state is required for capacity reservations');
  }

  const reservationKey = `${PIPECAT_RESERVATION_KEY_PREFIX}${reservation.reservation_id}`;
  const queueKey = `${PIPECAT_QUEUE_RESERVATION_KEY_PREFIX}${reservation.queue_id}`;
  const boundedMaxReservations = maxReservations == null
    ? null
    : parsePositiveInteger(maxReservations, 0);
  let slotKey = null;
  let slotIndex = null;

  try {
    const queueClaim = await runtime.command(
      'SET',
      queueKey,
      reservation.reservation_id,
      'EX',
      safeTtl,
      'NX',
    );
    if (!redisSetNxSucceeded(queueClaim)) {
      return {
        acquired: false,
        reason: 'queue_already_reserved',
        reservation,
        reservationKey,
        queueKey,
      };
    }

    if (boundedMaxReservations != null) {
      if (boundedMaxReservations <= 0) {
        await runtime.command('DEL', queueKey);
        return {
          acquired: false,
          reason: 'capacity_full',
          reservation,
          reservationKey,
          queueKey,
        };
      }

      for (let index = 0; index < boundedMaxReservations; index++) {
        const candidateSlotKey = `${PIPECAT_RESERVATION_SLOT_KEY_PREFIX}${index}`;
        const slotClaim = await runtime.command(
          'SET',
          candidateSlotKey,
          reservation.reservation_id,
          'EX',
          safeTtl,
          'NX',
        );
        if (redisSetNxSucceeded(slotClaim)) {
          slotKey = candidateSlotKey;
          slotIndex = index;
          break;
        }
      }

      if (!slotKey) {
        await runtime.command('DEL', queueKey);
        return {
          acquired: false,
          reason: 'capacity_full',
          reservation,
          reservationKey,
          queueKey,
        };
      }
    }

    const storedReservation = {
      ...reservation,
      ...(slotIndex == null ? {} : { slot_index: slotIndex }),
      ...(slotKey == null ? {} : { slot_key: slotKey }),
    };

    const reservationClaim = await runtime.command(
      'SET',
      reservationKey,
      JSON.stringify(storedReservation),
      'EX',
      safeTtl,
      'NX',
    );
    if (!redisSetNxSucceeded(reservationClaim)) {
      await runtime.command('DEL', ...[queueKey, slotKey].filter(Boolean));
      return {
        acquired: false,
        reason: 'reservation_already_exists',
        reservation: storedReservation,
        reservationKey,
        queueKey,
        ...(slotKey ? { slotKey } : {}),
      };
    }

    return {
      acquired: true,
      reservation: storedReservation,
      reservationKey,
      queueKey,
      ...(slotKey ? { slotKey, slotIndex } : {}),
    };
  } finally {
    await runtime.close();
  }
}

export async function releasePipecatCapacityReservation({
  reservationId,
  queueId = null,
  env = process.env,
  command = null,
} = {}) {
  const reservation = requireString(reservationId, 'reservationId');
  const runtime = createPipecatRedisCommand({ env, command });
  if (!runtime.configured) {
    return { released: false, backend: runtime.backend };
  }

  const keys = [`${PIPECAT_RESERVATION_KEY_PREFIX}${reservation}`];
  let slotKey = null;

  try {
    const storedReservation = await runtime.command('GET', keys[0]);
    if (storedReservation) {
      const parsed = JSON.parse(storedReservation);
      if (parsed?.slot_key) {
        slotKey = String(parsed.slot_key);
      }
    }
  } catch {
    // Reservation releases are best-effort; deleting the known keys still
    // lets TTL clean up an unreadable slot claim.
  }

  if (queueId) {
    keys.push(`${PIPECAT_QUEUE_RESERVATION_KEY_PREFIX}${requireString(queueId, 'queueId')}`);
  }
  if (slotKey) {
    keys.push(slotKey);
  }

  try {
    const deleted = await runtime.command('DEL', ...keys);
    return {
      released: parseInteger(deleted) > 0,
      deleted: parseInteger(deleted),
      backend: runtime.backend,
    };
  } finally {
    await runtime.close();
  }
}

export function normalizePipecatCapacityHeartbeat(rawHash, {
  key = '',
  nowSeconds = Date.now() / 1000,
  maxAgeSeconds = DEFAULT_HEARTBEAT_MAX_AGE_SECONDS,
} = {}) {
  const row = normalizeHash(rawHash);
  if (!row) return null;

  const updatedAt = parseFloatSeconds(row.updated_at);
  if (!updatedAt || nowSeconds - updatedAt > maxAgeSeconds) {
    return null;
  }

  const instanceId = String(
    row.instance_id ||
    (String(key).startsWith(PIPECAT_HEARTBEAT_KEY_PREFIX)
      ? String(key).slice(PIPECAT_HEARTBEAT_KEY_PREFIX.length)
      : '')
  );

  if (!instanceId) return null;

  const activeCalls = parseInteger(row.active_calls);
  const maxCalls = parseInteger(row.max_calls);
  const draining = parseBoolean(row.draining);
  const healthy = parseBoolean(row.healthy);
  const ready = row.ready == null
    ? healthy && !draining && activeCalls < maxCalls
    : parseBoolean(row.ready);
  const pendingStartCount = parseInteger(row.pending_start_count);
  return {
    instanceId,
    service: String(row.service || 'donna-pipecat'),
    serviceVersion: String(row.service_version || 'unknown'),
    activeCalls,
    maxCalls,
    inboundActiveCalls: parseInteger(row.inbound_active_calls),
    pendingStartCount,
    pendingReservations: pendingStartCount,
    draining,
    healthy,
    ready,
    dbPoolStatsAvailable: row.db_pool_stats_available == null
      ? true
      : parseBoolean(row.db_pool_stats_available),
    dbPoolSize: parseInteger(row.db_pool_size),
    dbPoolIdle: parseInteger(row.db_pool_idle),
    circuitBreakersOpen: parseInteger(row.circuit_breakers_open),
    warmupGateGreen: row.warmup_gate_green == null
      ? null
      : parseBoolean(row.warmup_gate_green),
    startedAt: parseFloatSeconds(row.started_at, updatedAt),
    updatedAt,
  };
}

export async function readPipecatCapacityRegistry({
  env = process.env,
  command = null,
  now = new Date(),
  maxAgeSeconds = DEFAULT_HEARTBEAT_MAX_AGE_SECONDS,
} = {}) {
  const runtime = createPipecatRedisCommand({ env, command });
  if (!runtime.configured) {
    return {
      configured: false,
      backend: runtime.backend,
      instances: [],
      scanned: 0,
    };
  }

  try {
    const pattern = `${PIPECAT_HEARTBEAT_KEY_PREFIX}*`;
    const keys = await scanKeys(runtime.command, pattern);
    const nowSeconds = now instanceof Date ? now.getTime() / 1000 : Number(now) / 1000;
    const instances = [];

    for (const key of keys) {
      const row = await runtime.command('HGETALL', key);
      const instance = normalizePipecatCapacityHeartbeat(row, {
        key,
        nowSeconds,
        maxAgeSeconds,
      });
      if (instance) {
        instances.push(instance);
      }
    }

    return {
      configured: runtime.configured,
      backend: runtime.backend,
      instances,
      scanned: keys.length,
    };
  } catch (error) {
    return {
      configured: runtime.configured,
      backend: runtime.backend,
      instances: [],
      scanned: 0,
      error: 'capacity_registry_unavailable',
      message: error.message,
    };
  } finally {
    await runtime.close();
  }
}

export {
  createPipecatRedisCommand,
  DEFAULT_HEARTBEAT_MAX_AGE_SECONDS,
  DEFAULT_RESERVATION_TTL_SECONDS,
  PIPECAT_HEARTBEAT_KEY_PREFIX,
  PIPECAT_QUEUE_RESERVATION_KEY_PREFIX,
  PIPECAT_RESERVATION_SLOT_KEY_PREFIX,
  PIPECAT_RESERVATION_KEY_PREFIX,
};
