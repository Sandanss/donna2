/**
 * Category A Tier-1 — 10,000-row dispatcher load test.
 *
 * Drives the fake DB's lease+guard+attempt pipeline through 10k synthetic
 * queue rows, asserting that every successful dial maps to a unique
 * (queue_id, attempt_number) pair and no `call_control_id` is reused.
 *
 * The fake DB serializes via mutex, so concurrency here is application-level.
 * For real-vendor SKIP LOCKED, see tests/integration-real-db/.
 */

import { describe, expect, it } from 'vitest';

import { createFakeDb } from '../integration-harness/fake-db.js';

const TOTAL_ROWS = 10_000;
const WORKER_COUNT = 16;
const BATCH_PER_WORKER = 50;

describe('Category A — 10k dispatcher load', () => {
  it('zero duplicate dials across 10,000 simulated rows', { timeout: 60_000 }, async () => {
    const db = createFakeDb();
    const seedStart = Date.now();
    for (let i = 0; i < TOTAL_ROWS; i++) {
      const seniorId = `s-load-${i}`;
      db.seedSenior(seniorId);
      db.state.callQueue.push({
        id: `q-load-${i}`,
        senior_id: seniorId,
        call_type: 'schedule',
        priority_lane: 'scheduled_checkin',
        priority_score: 0,
        target_at: new Date(seedStart),
        earliest_at: new Date(seedStart - 60_000),
        latest_at: new Date(seedStart + 60 * 60_000),
        status: 'queued',
        dedupe_key: `dedupe:load:${i}`,
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: 0,
        last_attempt_id: null,
      });
    }

    const callControlIds = new Set();
    const attemptKeys = new Set(); // `${queue_id}:${attempt_number}` — must be unique

    async function runOneWorker(workerId) {
      let nextSequence = 0;
      while (true) {
        const leased = await db.leaseRows({
          owner: `worker-${workerId}`,
          limit: BATCH_PER_WORKER,
          now: new Date(),
          leaseSeconds: 60,
        });
        if (leased.length === 0) return;

        for (const row of leased) {
          const guardResult = await db.acquireGuard({
            guardKey: row.dedupe_key,
            seniorId: row.senior_id,
            callType: row.call_type,
            architecture: 'queue',
            targetAt: row.target_at,
            expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
          });
          if (!guardResult.acquired) continue;

          const flip = await db.markGuardInitiatingIfCallable({
            guardKey: row.dedupe_key,
          });
          if (!flip.initiated) continue;

          const attemptNumber = row.attempt_count + 1;
          const recordResult = await db.recordCallAttempt({
            queueId: row.id,
            seniorId: row.senior_id,
            attemptNumber,
            architecture: 'queue',
            callControlId: `cci-${workerId}-${nextSequence++}`,
          });
          if (recordResult.inserted) {
            callControlIds.add(recordResult.row.call_control_id);
            attemptKeys.add(`${row.id}:${attemptNumber}`);
          }
        }
      }
    }

    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, idx) => runOneWorker(idx))
    );
    const durationMs = Date.now() - startedAt;

    // No call_control_id reused, no (queue_id, attempt_number) reused.
    expect(callControlIds.size).toBe(TOTAL_ROWS);
    expect(attemptKeys.size).toBe(TOTAL_ROWS);
    expect(db.state.callAttempts).toHaveLength(TOTAL_ROWS);

    // Sanity: log runtime so future regressions are visible in CI output.
    // 10k rows in < 30s on a laptop is the soft target; CI may be slower.
    console.log(`[10k-load] ${WORKER_COUNT} workers, ${TOTAL_ROWS} rows, ${durationMs}ms`);
  });
});
