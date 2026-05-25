import { describe, expect, it } from 'vitest';
import { createMockRedis, createOutageRedis } from './tests/integration-harness/redis.js';
import { isRealDbConfigured, skipIfNoDb } from './tests/integration-harness/postgres.js';
import { createFakeDb } from './tests/integration-harness/fake-db.js';

describe('harness smoke', () => {
  it('mock redis SET NX EX works', async () => {
    const { command } = createMockRedis();
    expect(await command('SET', 'k', 'v', 'EX', 60, 'NX')).toBe('OK');
    expect(await command('SET', 'k', 'v2', 'EX', 60, 'NX')).toBeNull();
    expect(await command('GET', 'k')).toBe('v');
    expect(await command('DEL', 'k')).toBe(1);
  });

  it('outage redis throws', async () => {
    const { command } = createOutageRedis(new Error('redis_unreachable'));
    await expect(command('GET', 'k')).rejects.toThrow('redis_unreachable');
  });

  it('skipIfNoDb reflects env', () => {
    expect(typeof isRealDbConfigured()).toBe('boolean');
    expect(typeof skipIfNoDb()).toBe('boolean');
  });

  it('fake db serializes guard acquisition', async () => {
    const db = createFakeDb();
    db.seedSenior('s1');
    const r1 = await db.acquireGuard({ guardKey: 'k1', seniorId: 's1', callType: 'check-in', architecture: 'queue', targetAt: new Date(), expiresAt: new Date(Date.now() + 60000) });
    const r2 = await db.acquireGuard({ guardKey: 'k1', seniorId: 's1', callType: 'check-in', architecture: 'queue', targetAt: new Date(), expiresAt: new Date(Date.now() + 60000) });
    expect(r1.acquired).toBe(true);
    expect(r2.acquired).toBe(false);
  });
});
