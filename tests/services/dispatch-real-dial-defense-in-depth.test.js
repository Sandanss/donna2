import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  setQueueDispatcherDraining,
} = await import('../../services/call-queue.js');

beforeEach(async () => {
  setQueueDispatcherDraining(false);
  await drainQueueDispatcherReservations({
    releaseReservation: async () => ({ released: true }),
    waitForDispatches: false,
  });
  mocks.execute.mockClear();
  mocks.insert.mockClear();
  mocks.auditValues.mockClear();
});

/**
 * Phase 4 audit gap (defense-in-depth):
 *
 * `scripts/run-dispatcher-worker.js::dispatchOnce` is the only place that
 * checks `config.allowRealDial` before calling `dispatchQueuedCalls`. If any
 * future caller (e.g. a scheduler one-off, a manual replay job, a test
 * harness invocation that leaks into prod) calls `dispatchQueuedCalls`
 * directly under a `shadow_dispatch` config, the function will happily lease
 * rows and call `dialCall` — there is no second-layer gate.
 *
 * Production now early-returns when resolveCallArchitectureConfig() says
 * allowRealDial is false. Flipped from xfail to passing in Phase 4 cleanup.
 */
describe('dispatchQueuedCalls defense-in-depth: shadow_dispatch must never dial', () => {
  it(
    'refuses to dial when CALL_ARCHITECTURE_MODE=shadow_dispatch (defense-in-depth)',
    async () => {
      const prevMode = process.env.CALL_ARCHITECTURE_MODE;
      const prevAllow = process.env.CALL_QUEUE_ALLOW_REAL_DIAL;
      process.env.CALL_ARCHITECTURE_MODE = 'shadow_dispatch';
      process.env.CALL_QUEUE_ALLOW_REAL_DIAL = 'false';

      try {
        const queueRow = {
          id: 'queue-shadow-1',
          senior_id: 'senior-shadow-1',
          call_type: 'schedule',
          priority_lane: PRIORITY_LANES.SCHEDULED_CHECKIN,
          dedupe_key: 'schedule:senior-shadow-1:2035-03-11:schedule-1',
          target_at: '2035-03-11T13:30:00.000Z',
          attempt_count: 0,
        };

        // Build a leased-row pipeline so the dispatcher reaches the dial step.
        // Real defense-in-depth would short-circuit before this even runs.
        const execute = vi.fn()
          .mockResolvedValueOnce({ rows: [queueRow] })
          .mockResolvedValueOnce({ rows: [{ id: 'guard-shadow', guard_key: queueRow.dedupe_key }] })
          .mockResolvedValueOnce({ rows: [{ id: 'attempt-shadow', queue_id: queueRow.id, attempt_number: 1 }] })
          .mockResolvedValueOnce({ rows: [{ id: queueRow.id, status: CALL_QUEUE_STATUSES.INITIATING }] })
          .mockResolvedValueOnce({ rows: [{ id: 'guard-shadow', status: 'initiating', initiated: true }] })
          .mockResolvedValueOnce({ rows: [{ id: 'guard-shadow', status: 'initiated', call_control_id: 'v3:shadow' }] })
          .mockResolvedValueOnce({ rows: [{ id: queueRow.id, status: CALL_QUEUE_STATUSES.STARTED }] })
          .mockResolvedValueOnce({ rows: [{ id: 'attempt-shadow', status: 'initiated', call_control_id: 'v3:shadow' }] });

        const database = { execute };
        const acquireReservation = vi.fn(async ({ reservationId, queueId }) => ({
          acquired: true,
          reservationId,
          queueId,
        }));
        const releaseReservation = vi.fn(async () => ({ released: true }));
        const dialCall = vi.fn(async () => ({ callControlId: 'v3:shadow' }));

        const result = await dispatchQueuedCalls({
          leaseOwner: 'queue-dispatcher-defense-in-depth',
          capacitySlots: 1,
          limit: 1,
          now: new Date('2035-03-11T13:31:15.000Z'),
          respectLanePolicy: false,
        }, {
          database,
          acquireReservation,
          releaseReservation,
          dialCall,
        });

        // The DESIRED behavior: even if a row is leased, dialCall is never
        // invoked under shadow_dispatch. Until the gate exists, dialCall WILL
        // be called and `result.dialed` will be 1 — this assertion fails,
        // which is why the test is `it.fails`.
        expect(dialCall).not.toHaveBeenCalled();
        expect(result.dialed).toBe(0);
      } finally {
        if (prevMode === undefined) delete process.env.CALL_ARCHITECTURE_MODE;
        else process.env.CALL_ARCHITECTURE_MODE = prevMode;
        if (prevAllow === undefined) delete process.env.CALL_QUEUE_ALLOW_REAL_DIAL;
        else process.env.CALL_QUEUE_ALLOW_REAL_DIAL = prevAllow;
      }
    },
  );
});
