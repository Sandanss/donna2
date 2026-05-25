/**
 * Category A Tier-1 — materializer concurrency exit criterion.
 *
 * Phase 2 exit criterion: "Concurrent materializer test passes at 10 / 50 / 100"
 * — running multiple materializer cycles in parallel against the same set of
 * due schedules must NOT produce duplicate queue rows. The production code
 * relies on `pg_try_advisory_xact_lock` + the unique constraint on
 * `call_queue.dedupe_key`. The fake DB enforces the same invariant via mutex
 * + dedupe_key check inside `materializeFromSchedule`.
 */

import { describe, expect, it } from 'vitest';

import { createFakeDb } from '../integration-harness/fake-db.js';

function buildSchedules(count) {
  const baseTime = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    seniorId: `s-mat-${i}`,
    scheduleId: `sched-${i}`,
    callType: 'schedule',
    priorityLane: 'scheduled_checkin',
    targetAt: new Date(baseTime + i * 1000),
    earliestAt: new Date(baseTime + i * 1000 - 7 * 60 * 1000),
    latestAt: new Date(baseTime + i * 1000 + 7 * 60 * 1000),
    dedupeKey: `schedule:s-mat-${i}:2026-05-23:sched-${i}`,
  }));
}

describe('Category A — materializer concurrent exit criterion', () => {
  for (const N of [10, 50, 100]) {
    it(`materializing ${N} due schedules via 4 parallel cycles produces exactly ${N} queue rows`, async () => {
      const db = createFakeDb();
      const schedules = buildSchedules(N);
      for (const s of schedules) db.seedSenior(s.seniorId);

      // Four parallel "materializer workers" each try to materialize the SAME
      // set of schedules. Without proper de-duplication, each schedule would
      // produce ≥1 row per worker → 4N rows. With dedupe_key+mutex it must
      // produce exactly N rows.
      const workers = Array.from({ length: 4 }, () =>
        db.materializeDueSchedules(schedules)
      );
      const results = await Promise.all(workers);

      const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0);
      const totalExisting = results.reduce((sum, r) => sum + r.existing, 0);

      expect(totalInserted).toBe(N);
      expect(totalExisting).toBe(3 * N);

      // The queue itself holds exactly N rows, one per dedupe_key.
      expect(db.state.callQueue).toHaveLength(N);
      const uniqueDedupe = new Set(db.state.callQueue.map(r => r.dedupe_key));
      expect(uniqueDedupe.size).toBe(N);
    });
  }

  it('re-running the materializer against the same schedule set produces zero new rows', async () => {
    const db = createFakeDb();
    const schedules = buildSchedules(25);
    for (const s of schedules) db.seedSenior(s.seniorId);

    const first = await db.materializeDueSchedules(schedules);
    const second = await db.materializeDueSchedules(schedules);
    const third = await db.materializeDueSchedules(schedules);

    expect(first.inserted).toBe(25);
    expect(second.inserted).toBe(0);
    expect(third.inserted).toBe(0);
    expect(second.existing).toBe(25);
    expect(third.existing).toBe(25);
    expect(db.state.callQueue).toHaveLength(25);
  });
});
