/**
 * Category A Tier-1 — concurrent-N + race coverage of the dispatcher's lease,
 * guard, and senior-delete paths against the in-process fake DB.
 *
 * The fake DB serializes every transaction through a single JS mutex, which
 * is a faithful behavioral analog of FOR UPDATE SKIP LOCKED for the
 * application logic we care about (no two workers claim the same row, exactly
 * one guard wins per dedupe_key, the recheck-inside-tx catches an interleaved
 * senior deactivation). For real-vendor lock semantics, see the Tier-2 tests
 * in tests/integration-real-db/ which skip without TEST_DATABASE_URL.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeDb } from '../integration-harness/fake-db.js';

function seedQueue(db, count, { seniorPrefix = 's', laneSequence = ['scheduled_checkin'] } = {}) {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const seniorId = `${seniorPrefix}-${i}`;
    db.seedSenior(seniorId);
    db.state.callQueue.push({
      id: `q-seed-${i}`,
      senior_id: seniorId,
      call_type: 'schedule',
      priority_lane: laneSequence[i % laneSequence.length],
      priority_score: 0,
      target_at: new Date(now),
      earliest_at: new Date(now - 60_000),
      latest_at: new Date(now + 60 * 60_000),
      status: 'queued',
      dedupe_key: `dedupe:${i}`,
      lease_owner: null,
      lease_expires_at: null,
      attempt_count: 0,
      last_attempt_id: null,
    });
  }
}

describe('Category A — leaseRows concurrent-N exit criteria', () => {
  for (const workerCount of [4, 8, 16]) {
    it(`zero duplicate leases at ${workerCount} concurrent workers`, async () => {
      const db = createFakeDb();
      const totalRows = workerCount * 20;
      seedQueue(db, totalRows);

      const workers = Array.from({ length: workerCount }, (_, idx) =>
        db.leaseRows({
          owner: `worker-${idx}`,
          limit: 50,
          now: new Date(),
          leaseSeconds: 60,
        })
      );
      const results = await Promise.all(workers);

      const leasedIds = results.flat().map(row => row.id);
      const uniqueIds = new Set(leasedIds);
      expect(uniqueIds.size).toBe(leasedIds.length);
      expect(uniqueIds.size).toBe(totalRows);

      const stillQueued = db.state.callQueue.filter(r => r.status === 'queued').length;
      expect(stillQueued).toBe(0);
    });
  }
});

describe('Category A — guard race contention', () => {
  it('legacy + queue dialers contend for the same dedupe_key — exactly one winner', async () => {
    const db = createFakeDb();
    db.seedSenior('s-1');

    const targetAt = new Date();
    const expiresAt = new Date(targetAt.getTime() + 24 * 60 * 60_000);

    const legacy = db.acquireGuard({
      guardKey: 'schedule:s-1:2026-05-23:morning',
      seniorId: 's-1',
      callType: 'schedule',
      architecture: 'legacy',
      targetAt,
      expiresAt,
    });
    const queueAttempt = db.acquireGuard({
      guardKey: 'schedule:s-1:2026-05-23:morning',
      seniorId: 's-1',
      callType: 'schedule',
      architecture: 'queue',
      targetAt,
      expiresAt,
    });
    const [legacyResult, queueResult] = await Promise.all([legacy, queueAttempt]);

    const acquiredCount = [legacyResult.acquired, queueResult.acquired].filter(Boolean).length;
    expect(acquiredCount).toBe(1);

    const winner = legacyResult.acquired ? legacyResult : queueResult;
    const loser = legacyResult.acquired ? queueResult : legacyResult;
    expect(winner.guard.guard_key).toBe('schedule:s-1:2026-05-23:morning');
    expect(loser.guard).toBeTruthy();
    expect(loser.guard.guard_key).toBe('schedule:s-1:2026-05-23:morning');
    expect(loser.acquired).toBe(false);
  });
});

describe('Category A — senior-delete race × 1000 trials', () => {
  it('senior deactivation during guard-initiating-flip resolves to cancelled 100% when deactivation lands first', async () => {
    const TRIALS = 1000;
    const initiatedDespiteDeactivation = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      const db = createFakeDb();
      const seniorId = `s-trial-${trial}`;
      db.seedSenior(seniorId);

      const acquireResult = await db.acquireGuard({
        guardKey: `manual:${seniorId}:trial-${trial}`,
        seniorId,
        callType: 'manual',
        architecture: 'queue',
        targetAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(acquireResult.acquired).toBe(true);

      // Deterministically interleave: deactivate THEN flip. Because the fake DB
      // serializes transactions, the deactivation lands first; the flip's
      // recheck must observe the inactive senior and return cancelled.
      db.deactivateSenior(seniorId);

      const flipResult = await db.markGuardInitiatingIfCallable({
        guardKey: `manual:${seniorId}:trial-${trial}`,
      });

      if (flipResult.initiated) {
        initiatedDespiteDeactivation.push({ trial, guard: flipResult.guard });
      } else {
        expect(flipResult.suppressReason).toBe('senior_inactive_or_missing');
      }
    }

    expect(initiatedDespiteDeactivation).toHaveLength(0);
  });

  it('senior deactivation AFTER flip returns initiated:true (no false-negative cancellations)', async () => {
    const TRIALS = 200;
    const cancelledDespiteActive = [];

    for (let trial = 0; trial < TRIALS; trial++) {
      const db = createFakeDb();
      const seniorId = `s-active-${trial}`;
      db.seedSenior(seniorId);

      await db.acquireGuard({
        guardKey: `manual:${seniorId}:active-${trial}`,
        seniorId,
        callType: 'manual',
        architecture: 'queue',
        targetAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      const flipResult = await db.markGuardInitiatingIfCallable({
        guardKey: `manual:${seniorId}:active-${trial}`,
      });

      db.deactivateSenior(seniorId);

      if (!flipResult.initiated) {
        cancelledDespiteActive.push({ trial, reason: flipResult.suppressReason });
      }
    }

    expect(cancelledDespiteActive).toHaveLength(0);
  });
});

describe('Category A — reconciler one-cycle correctness', () => {
  beforeEach(() => {});

  it('recoverExpiredLeases flips a lease whose expiry is past back to queued in one cycle', async () => {
    const db = createFakeDb();
    db.seedSenior('s-recov');
    const targetAt = new Date();
    db.state.callQueue.push({
      id: 'q-recov-1',
      senior_id: 's-recov',
      call_type: 'schedule',
      priority_lane: 'scheduled_checkin',
      priority_score: 0,
      target_at: targetAt,
      earliest_at: new Date(targetAt.getTime() - 60_000),
      latest_at: new Date(targetAt.getTime() + 60 * 60_000),
      status: 'leased',
      dedupe_key: 'dedupe:recov:1',
      lease_owner: 'worker-stale',
      lease_expires_at: new Date(targetAt.getTime() - 10_000),
      attempt_count: 0,
      last_attempt_id: null,
    });

    const recovered = await db.recoverExpiredLeases({ now: targetAt });
    expect(recovered).toHaveLength(1);
    expect(recovered[0].id).toBe('q-recov-1');

    const row = db.state.callQueue.find(r => r.id === 'q-recov-1');
    expect(row.status).toBe('queued');
    expect(row.lease_owner).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });

  it('expireOverdueQueuedCalls retires rows whose dispatch window has closed', async () => {
    const db = createFakeDb();
    db.seedSenior('s-exp');
    const now = new Date();
    db.state.callQueue.push({
      id: 'q-exp-1',
      senior_id: 's-exp',
      call_type: 'schedule',
      priority_lane: 'scheduled_checkin',
      priority_score: 0,
      target_at: new Date(now.getTime() - 60 * 60_000),
      earliest_at: new Date(now.getTime() - 120 * 60_000),
      latest_at: new Date(now.getTime() - 60_000),
      status: 'queued',
      dedupe_key: 'dedupe:exp:1',
      lease_owner: null,
      lease_expires_at: null,
      attempt_count: 0,
      last_attempt_id: null,
    });

    const expired = await db.expireOverdueQueuedCalls({ now });
    expect(expired).toHaveLength(1);

    const counts = db.countByStatus();
    expect(counts.expired).toBe(1);
    expect(counts.queued).toBe(0);
  });
});
