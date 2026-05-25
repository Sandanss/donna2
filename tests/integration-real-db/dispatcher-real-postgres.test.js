/**
 * Tier-2 — real Postgres exercise of the dispatcher's concurrency exit
 * criteria. Runs only when `TEST_DATABASE_URL` is set; otherwise every test
 * skips cleanly via `skipIfNoDb()`.
 *
 * The target DB MUST already have the full Donna schema applied (drizzle
 * push or equivalent — base tables `seniors`, `reminders`, `caregivers`,
 * etc.). The harness's `getPool()` will additionally apply
 * `db/migrations/*.sql` so any queue-side migrations not yet captured by
 * drizzle's schema are in place.
 *
 * Wire a Neon dev branch URL via:
 *   TEST_DATABASE_URL=postgres://... npx vitest run tests/integration-real-db
 *
 * These tests exercise the **production** `services/call-queue.js` code
 * paths against the production SQL — not the in-process fake-db simulation
 * used by Tier-1 in `tests/services/dispatcher-concurrency.test.js`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';

import {
  closePool,
  getPool,
  skipIfNoDb,
  truncateOpsTables,
} from '../integration-harness/postgres.js';

// Lazy imports — call-queue.js + scheduler.js bring in many transitive
// dependencies that we only want to load when the harness is actually
// going to run, so the suite stays cheap to collect when TEST_DATABASE_URL
// is unset.
let callQueue;
let drizzleDb;

const SUITE_SENIOR_PREFIX = '01234567-89ab-cdef-0123';

beforeAll(async () => {
  if (skipIfNoDb()) return;
  callQueue = await import('../../services/call-queue.js');
  const pool = await getPool();
  drizzleDb = drizzle(pool);
});

afterAll(async () => {
  if (!skipIfNoDb()) await closePool();
});

beforeEach(async () => {
  if (skipIfNoDb()) return;
  await truncateOpsTables();
});

async function seedSenior(pool, suffix, { isActive = true } = {}) {
  // We need a row in `seniors` so the FK on call_queue.senior_id holds and
  // markOutboundCallGuardInitiatingIfCallable can JOIN it. Use a stable UUID
  // pattern so cleanup via truncate cascades work. Derive a unique phone
  // from the suffix so the seniors_phone_unique constraint doesn't reject
  // bulk seeding within one test run.
  const seniorId = `${SUITE_SENIOR_PREFIX}-${String(suffix).padStart(12, '0')}`;
  const phone = `+1555${String(2_000_000 + Number(suffix)).slice(-7)}`;
  await pool.query(
    `INSERT INTO seniors (id, name, phone, is_active)
     VALUES ($1, 'TEST_SENIOR', $2, $3)
     ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [seniorId, phone, isActive],
  );
  return seniorId;
}

async function seedQueueRow(pool, seniorId, idx, {
  status = 'queued',
  windowMinutes = 60,
} = {}) {
  const now = new Date();
  const earliest = new Date(now.getTime() - windowMinutes * 60_000);
  const latest = new Date(now.getTime() + windowMinutes * 60_000);
  const dedupeKey = `tier2-test:${seniorId}:${idx}`;
  const { rows } = await pool.query(
    `INSERT INTO call_queue (
       senior_id, call_type, priority_lane, priority_score,
       target_at, earliest_at, latest_at, status, dedupe_key
     ) VALUES ($1, 'schedule', 'scheduled_checkin', 0, $2, $3, $4, $5, $6)
     RETURNING id`,
    [seniorId, now, earliest, latest, status, dedupeKey],
  );
  return rows[0].id;
}

describe.skipIf(skipIfNoDb())('Tier-2 real Postgres — dispatcher exit criteria', () => {
  it('leaseQueuedCalls at 8 concurrent workers — zero duplicate leases against real FOR UPDATE SKIP LOCKED', async () => {
    const pool = await getPool();
    const seniorIds = [];
    for (let i = 0; i < 32; i++) {
      seniorIds.push(await seedSenior(pool, i));
    }
    for (let i = 0; i < 32; i++) {
      await seedQueueRow(pool, seniorIds[i], i);
    }

    const WORKER_COUNT = 8;
    const workers = Array.from({ length: WORKER_COUNT }, (_, idx) =>
      callQueue.leaseQueuedCalls(
        { leaseOwner: `tier2-worker-${idx}`, limit: 10 },
        { database: drizzleDb },
      ),
    );
    const results = await Promise.all(workers);

    const leasedIds = results.flat().map(row => row.id);
    const uniqueIds = new Set(leasedIds);
    expect(uniqueIds.size).toBe(leasedIds.length);
    expect(uniqueIds.size).toBe(32);
  });

  it('acquireOutboundCallGuard against UNIQUE(guard_key) constraint — exactly one of two racers wins', async () => {
    const pool = await getPool();
    const seniorId = await seedSenior(pool, 100);
    const guardKey = `tier2:schedule:${seniorId}:race`;
    const targetAt = new Date();
    const expiresAt = new Date(targetAt.getTime() + 24 * 60 * 60_000);

    const racer = () => callQueue.acquireOutboundCallGuard(
      {
        seniorId,
        guardKey,
        callType: 'schedule',
        architecture: 'queue',
        targetAt,
        expiresAt,
      },
      { database: drizzleDb },
    );

    const [a, b] = await Promise.all([racer(), racer()]);
    const wins = [a.acquired, b.acquired].filter(Boolean).length;
    expect(wins).toBe(1);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM outbound_call_guards WHERE guard_key = $1`,
      [guardKey],
    );
    expect(rows[0].n).toBe(1);
  });

  // 50 trials × ~4 sequential PG round-trips against Neon ≈ 200 round-trips.
  // At realistic CI-to-Neon latency (40-60ms each) this comfortably exceeds
  // the default 10s Vitest timeout. Bump to 30s so a slightly slower CI
  // network doesn't fail the run.
  it('senior-delete race: deactivating senior before markGuardInitiating yields cancelled across 50 trials', { timeout: 30000 }, async () => {
    const pool = await getPool();
    const TRIALS = 50;
    const initiatedDespiteDeactivation = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      const seniorId = await seedSenior(pool, 200 + trial);
      const guardKey = `tier2:delete-race:${seniorId}:${trial}`;
      const targetAt = new Date();

      const acquireResult = await callQueue.acquireOutboundCallGuard(
        {
          seniorId,
          guardKey,
          callType: 'manual',
          architecture: 'queue',
          targetAt,
          expiresAt: new Date(targetAt.getTime() + 60_000),
        },
        { database: drizzleDb },
      );
      expect(acquireResult.acquired).toBe(true);

      // Deterministic interleave: deactivation lands first; the flip's
      // SELECT ... FOR UPDATE inside the same transaction must observe
      // is_active=false and choose the cancelled branch.
      await pool.query(`UPDATE seniors SET is_active = false WHERE id = $1`, [seniorId]);

      const flip = await callQueue.markOutboundCallGuardInitiatingIfCallable(
        { guardKey },
        { database: drizzleDb },
      );

      if (flip.initiated) {
        initiatedDespiteDeactivation.push({ trial, guard: flip.guard });
      } else {
        expect(flip.suppressReason).toBe('senior_inactive_or_missing');
      }
    }

    expect(initiatedDespiteDeactivation).toHaveLength(0);
  });

  it('reconcileQueueLeases recovers an actually-expired lease within one cycle against real timestamps', async () => {
    const pool = await getPool();
    const seniorId = await seedSenior(pool, 300);
    const queueId = await seedQueueRow(pool, seniorId, 0);

    const pastExpiry = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE call_queue
         SET status = 'leased',
             lease_owner = 'tier2-stale-worker',
             lease_expires_at = $1
       WHERE id = $2`,
      [pastExpiry, queueId],
    );

    const result = await callQueue.reconcileQueueLeases(
      { limit: 100 },
      { database: drizzleDb },
    );
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(
      `SELECT status, lease_owner, lease_expires_at FROM call_queue WHERE id = $1`,
      [queueId],
    );
    expect(rows[0].status).toBe('queued');
    expect(rows[0].lease_owner).toBeNull();
    expect(rows[0].lease_expires_at).toBeNull();
  });
});
