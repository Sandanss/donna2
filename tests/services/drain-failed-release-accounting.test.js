/**
 * drainQueueDispatcherReservations failed-release accounting (Category D).
 *
 * Phase 4 audit item #12: the existing happy-path test in
 * tests/services/call-queue.test.js asserts `{ released: N, failed: 0 }`,
 * but there is no coverage for the case where `releaseReservation` itself
 * throws for one of several tracked reservations.
 *
 * Production guarantee under test:
 *   - drain MUST count each failed release in `failed`
 *   - drain MUST NOT orphan the other reservations (a single rejecting
 *     promise should not short-circuit the loop)
 *   - drain MUST untrack only the reservations that successfully released;
 *     failed ones remain in the in-flight map for the TTL fallback
 *     documented at services/call-queue.js (see the catch block around the
 *     "TTL is the fallback cleanup path for Redis reservations" comment).
 *
 * `trackCapacityReservation` is NOT exported, so we exercise the real
 * tracker via three blocked `dispatchQueuedCalls` calls — exactly the same
 * way it happens in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const auditValues = vi.fn(async () => undefined);
  return {
    execute: vi.fn(),
    insert: vi.fn(() => ({ values: auditValues })),
    auditValues,
  };
});

vi.mock('../../db/client.js', () => ({
  db: {
    execute: mocks.execute,
    insert: mocks.insert,
  },
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const {
  CALL_QUEUE_STATUSES,
  PRIORITY_LANES,
  dispatchQueuedCalls,
  drainQueueDispatcherReservations,
  getQueueDispatcherDrainState,
  setQueueDispatcherDraining,
} = await import('../../services/call-queue.js');

const _prevArchEnv = {
  mode: process.env.CALL_ARCHITECTURE_MODE,
  allow: process.env.CALL_QUEUE_ALLOW_REAL_DIAL,
};

beforeEach(async () => {
  setQueueDispatcherDraining(false);
  // This file exercises dispatchQueuedCalls's reservation accounting, which
  // requires allowRealDial=true after Phase 4 added the defense-in-depth gate.
  process.env.CALL_ARCHITECTURE_MODE = 'canary_queue';
  process.env.CALL_QUEUE_ALLOW_REAL_DIAL = 'true';
  await drainQueueDispatcherReservations({
    releaseReservation: async () => ({ released: true }),
    waitForDispatches: false,
  });
  mocks.execute.mockClear();
  mocks.insert.mockClear();
  mocks.auditValues.mockClear();
});

afterEach(() => {
  if (_prevArchEnv.mode === undefined) delete process.env.CALL_ARCHITECTURE_MODE;
  else process.env.CALL_ARCHITECTURE_MODE = _prevArchEnv.mode;
  if (_prevArchEnv.allow === undefined) delete process.env.CALL_QUEUE_ALLOW_REAL_DIAL;
  else process.env.CALL_QUEUE_ALLOW_REAL_DIAL = _prevArchEnv.allow;
});

function makeQueueRow(suffix) {
  return {
    id: `queue-${suffix}`,
    senior_id: `senior-${suffix}`,
    call_type: 'schedule',
    priority_lane: PRIORITY_LANES.SCHEDULED_CHECKIN,
    dedupe_key: `schedule:senior-${suffix}:2035-03-11:schedule-${suffix}`,
    target_at: '2035-03-11T13:30:00.000Z',
    attempt_count: 0,
  };
}

function makeDatabaseFor(suffix) {
  // Pre-dial sequence per row: lease → guard insert → attempt insert
  // → mark_initiating → guard_initiating. Then dialCall blocks.
  // We never resolve dial in this test, so post-dial rows are not needed.
  const execute = vi.fn()
    .mockResolvedValueOnce({ rows: [makeQueueRow(suffix)] })
    .mockResolvedValueOnce({ rows: [{ id: `guard-${suffix}`, guard_key: `schedule:senior-${suffix}:2035-03-11:schedule-${suffix}` }] })
    .mockResolvedValueOnce({ rows: [{ id: `attempt-${suffix}`, queue_id: `queue-${suffix}`, attempt_number: 1 }] })
    .mockResolvedValueOnce({ rows: [{ id: `queue-${suffix}`, status: CALL_QUEUE_STATUSES.INITIATING }] })
    .mockResolvedValueOnce({ rows: [{ id: `guard-${suffix}`, status: 'initiating', initiated: true }] })
    // Padding for any post-dial activity if a dial DOES resolve mid-test.
    .mockResolvedValue({ rows: [] });
  return { execute };
}

describe('drainQueueDispatcherReservations failure accounting', () => {
  it('counts failed releases without orphaning successful releases (3 tracked, 1 throws)', async () => {
    const suffixes = ['a', 'b', 'c'];
    const dialReleasers = new Map();
    const enteredDials = [];

    // Run three dispatches in parallel, each holds open one reservation
    // by blocking at dialCall().
    const dispatchPromises = suffixes.map(suffix => {
      const database = makeDatabaseFor(suffix);
      const acquireReservation = vi.fn(async ({ reservationId, queueId }) => ({
        acquired: true,
        reservation: { reservation_id: reservationId, queue_id: queueId },
      }));
      // Per-suffix release impl; we will override before drain to inject a failure
      const releaseReservation = vi.fn(async () => ({ released: true }));

      let resolveDialEntered;
      const dialEntered = new Promise(resolve => { resolveDialEntered = resolve; });
      enteredDials.push(dialEntered);

      const dialBlocked = new Promise(resolve => {
        dialReleasers.set(suffix, resolve);
      });
      const dialCall = vi.fn(async () => {
        resolveDialEntered();
        await dialBlocked;
        return { callSid: `v3:test-${suffix}`, callControlId: `v3:test-${suffix}` };
      });

      return dispatchQueuedCalls({
        leaseOwner: `queue-dispatcher-${suffix}`,
        capacitySlots: 1,
        limit: 1,
        now: '2035-03-11T13:31:15.000Z',
        respectLanePolicy: false,
      }, {
        database,
        acquireReservation,
        releaseReservation,
        dialCall,
      });
    });

    // Wait until ALL three dispatches have entered dialCall (= all three
    // reservations are tracked in-flight).
    await Promise.all(enteredDials);

    expect(getQueueDispatcherDrainState()).toEqual({
      draining: false,
      activeDispatches: 3,
      inFlightReservations: 3,
    });

    // Craft a releaseReservation that throws for queue-b, succeeds for the rest.
    let failingTargetSeen = false;
    const releaseDuringDrain = vi.fn(async ({ queueId }) => {
      if (queueId === 'queue-b') {
        failingTargetSeen = true;
        throw new Error('shared-state release failed');
      }
      return { released: true };
    });

    const drainResult = await drainQueueDispatcherReservations({
      releaseReservation: releaseDuringDrain,
      waitForDispatches: false,
      timeoutMs: 1,
      pollIntervalMs: 1,
    });

    expect(failingTargetSeen).toBe(true);
    // Accounting contract: 2 released, 1 failed, 1 remaining in the map.
    expect(drainResult.released).toBe(2);
    expect(drainResult.failed).toBe(1);
    expect(drainResult.remaining).toBe(1);
    // Dispatches are still active because we haven't resolved their dials.
    expect(drainResult.activeDispatches).toBe(3);
    expect(drainResult.idle).toBe(false);

    // Verify the loop did not short-circuit: we should have called release
    // for all three queue ids.
    const queueIdsReleased = releaseDuringDrain.mock.calls.map(args => args[0].queueId);
    expect(new Set(queueIdsReleased)).toEqual(new Set(['queue-a', 'queue-b', 'queue-c']));

    // Cleanup — unblock dials so dispatches don't hang the suite.
    for (const resolve of dialReleasers.values()) resolve();
    // Settle them; we don't assert on their results because the reservations
    // were already released out of band by the drain.
    await Promise.allSettled(dispatchPromises);
  });
});
