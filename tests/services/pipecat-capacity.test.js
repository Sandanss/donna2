import { describe, expect, it } from 'vitest';

import {
  PIPECAT_HEARTBEAT_KEY_PREFIX,
  PIPECAT_QUEUE_RESERVATION_KEY_PREFIX,
  PIPECAT_RESERVATION_KEY_PREFIX,
  acquirePipecatCapacityReservation,
  buildPipecatCapacityReservation,
  normalizePipecatCapacityHeartbeat,
  readPipecatCapacityRegistry,
  releasePipecatCapacityReservation,
} from '../../services/pipecat-capacity.js';

describe('Pipecat capacity registry', () => {
  it('normalizes fresh PHI-free heartbeat hashes', () => {
    const heartbeat = normalizePipecatCapacityHeartbeat({
      instance_id: JSON.stringify('replica-a'),
      service: JSON.stringify('donna-pipecat'),
      service_version: JSON.stringify('test-sha'),
      active_calls: JSON.stringify(12),
      max_calls: JSON.stringify(50),
      inbound_active_calls: JSON.stringify(2),
      pending_start_count: JSON.stringify(3),
      draining: JSON.stringify(false),
      healthy: JSON.stringify(true),
      ready: JSON.stringify(true),
      db_pool_stats_available: JSON.stringify(true),
      db_pool_size: JSON.stringify(20),
      db_pool_idle: JSON.stringify(7),
      circuit_breakers_open: JSON.stringify(1),
      warmup_gate_green: JSON.stringify(false),
      started_at: JSON.stringify(2_098_000_000),
      updated_at: JSON.stringify(2_098_000_010),
      ignored_name: JSON.stringify('not surfaced'),
    }, {
      key: `${PIPECAT_HEARTBEAT_KEY_PREFIX}replica-a`,
      nowSeconds: 2_098_000_015,
    });

    expect(heartbeat).toEqual({
      instanceId: 'replica-a',
      service: 'donna-pipecat',
      serviceVersion: 'test-sha',
      activeCalls: 12,
      maxCalls: 50,
      inboundActiveCalls: 2,
      pendingStartCount: 3,
      pendingReservations: 3,
      draining: false,
      healthy: true,
      ready: true,
      dbPoolStatsAvailable: true,
      dbPoolSize: 20,
      dbPoolIdle: 7,
      circuitBreakersOpen: 1,
      warmupGateGreen: false,
      startedAt: 2_098_000_000,
      updatedAt: 2_098_000_010,
    });
  });

  it('drops stale heartbeat hashes', () => {
    const heartbeat = normalizePipecatCapacityHeartbeat({
      instance_id: JSON.stringify('replica-a'),
      active_calls: JSON.stringify(1),
      max_calls: JSON.stringify(10),
      updated_at: JSON.stringify(2_098_000_000),
    }, {
      key: `${PIPECAT_HEARTBEAT_KEY_PREFIX}replica-a`,
      nowSeconds: 2_098_000_030,
      maxAgeSeconds: 15,
    });

    expect(heartbeat).toBeNull();
  });

  it('reads Redis-style heartbeat hashes through an injected command runner', async () => {
    const calls = [];
    const command = async (...parts) => {
      calls.push(parts);
      if (parts[0] === 'SCAN') {
        return ['0', [
          `${PIPECAT_HEARTBEAT_KEY_PREFIX}fresh`,
          `${PIPECAT_HEARTBEAT_KEY_PREFIX}stale`,
        ]];
      }
      if (parts[1] === `${PIPECAT_HEARTBEAT_KEY_PREFIX}fresh`) {
        return [
          'instance_id', JSON.stringify('fresh'),
          'active_calls', JSON.stringify(4),
          'max_calls', JSON.stringify(20),
          'inbound_active_calls', JSON.stringify(1),
          'pending_start_count', JSON.stringify(2),
          'draining', JSON.stringify(false),
          'healthy', JSON.stringify(true),
          'ready', JSON.stringify(true),
          'updated_at', JSON.stringify(2_098_000_010),
        ];
      }
      return [
        'instance_id', JSON.stringify('stale'),
        'active_calls', JSON.stringify(4),
        'max_calls', JSON.stringify(20),
        'updated_at', JSON.stringify(2_098_000_000),
      ];
    };

    const snapshot = await readPipecatCapacityRegistry({
      command,
      now: new Date(2_098_000_016 * 1000),
    });

    expect(snapshot).toEqual({
      configured: true,
      backend: 'injected',
      scanned: 2,
      instances: [expect.objectContaining({
        instanceId: 'fresh',
        activeCalls: 4,
        maxCalls: 20,
        inboundActiveCalls: 1,
        pendingReservations: 2,
      })],
    });
    expect(calls[0]).toEqual(['SCAN', '0', 'MATCH', `${PIPECAT_HEARTBEAT_KEY_PREFIX}*`, 'COUNT', 100]);
  });

  it('reports unconfigured capacity registry without opening Redis', async () => {
    const snapshot = await readPipecatCapacityRegistry({
      env: {},
    });

    expect(snapshot).toEqual({
      configured: false,
      backend: 'none',
      instances: [],
      scanned: 0,
    });
  });

  it('builds ID-only capacity reservations with bounded TTL', () => {
    const reservation = buildPipecatCapacityReservation({
      reservationId: 'reservation-1',
      queueId: 'queue-1',
      createdAt: '2035-03-11T13:30:00.000Z',
      ttlSeconds: 120,
    });

    expect(reservation).toEqual({
      reservation_id: 'reservation-1',
      queue_id: 'queue-1',
      reserved_capacity: 1,
      created_at: '2035-03-11T13:30:00.000Z',
      expires_at: '2035-03-11T13:32:00.000Z',
    });
    expect(JSON.stringify(reservation)).not.toMatch(/name|phone|transcript|summary/i);
  });

  it('acquires and releases Redis capacity reservations atomically per queue', async () => {
    const store = new Map();
    const calls = [];
    const command = async (...parts) => {
      calls.push(parts);
      if (parts[0] === 'SET') {
        const [, key, value] = parts;
        const nx = parts.includes('NX');
        if (nx && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      if (parts[0] === 'DEL') {
        let deleted = 0;
        for (const key of parts.slice(1)) {
          if (store.delete(key)) deleted++;
        }
        return deleted;
      }
      throw new Error(`unexpected command ${parts[0]}`);
    };

    const acquired = await acquirePipecatCapacityReservation({
      reservationId: 'reservation-1',
      queueId: 'queue-1',
      ttlSeconds: 120,
      createdAt: '2035-03-11T13:30:00.000Z',
      command,
    });

    expect(acquired.acquired).toBe(true);
    expect(store.has(`${PIPECAT_QUEUE_RESERVATION_KEY_PREFIX}queue-1`)).toBe(true);
    expect(store.has(`${PIPECAT_RESERVATION_KEY_PREFIX}reservation-1`)).toBe(true);

    const duplicate = await acquirePipecatCapacityReservation({
      reservationId: 'reservation-2',
      queueId: 'queue-1',
      command,
    });

    expect(duplicate).toEqual(expect.objectContaining({
      acquired: false,
      reason: 'queue_already_reserved',
    }));

    const released = await releasePipecatCapacityReservation({
      reservationId: 'reservation-1',
      queueId: 'queue-1',
      command,
    });

    expect(released).toEqual(expect.objectContaining({
      released: true,
      deleted: 2,
      backend: 'injected',
    }));
    expect(calls.some(parts => parts[0] === 'SET' && parts.includes('NX'))).toBe(true);
  });
});
