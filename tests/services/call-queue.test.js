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
  CALL_ARCHITECTURE_MODES,
  CALL_QUEUE_STATUSES,
  DEFAULT_LANE_RESERVE_POLICY,
  PRIORITY_LANES,
  acquireOutboundCallGuard,
  assertOperationalPayloadHasNoPlainPhi,
  defaultGuardExpiry,
  releaseExpiredOutboundCallGuards,
  reconcileOutboundCallGuards,
  buildQueueOutboundCallParams,
  buildCallDedupeKey,
  buildDispatchWindow,
  buildLaneCapacityPlan,
  canaryBucketForSeniorId,
  buildQueueInputFromLegacyCallSpec,
  countReadyQueuedCallsByLane,
  drainQueueDispatcherReservations,
  dispatchQueuedCalls,
  dryRunDispatchQueuedCalls,
  enqueueCall,
  estimateQueueLagSeconds,
  estimateAvailablePipecatCapacity,
  expireOverdueQueuedCalls,
  leaseQueuedCalls,
  markCallAttemptSuppressed,
  markOutboundCallGuardInitiated,
  markOutboundCallGuardInitiatingIfCallable,
  markQueuedCallInitiating,
  markQueuedCallStarted,
  materializeLegacyCallPlan,
  normalizeLanePressure,
  recoverExpiredQueueLeases,
  recordSchedulerShadowComparison,
  recordCallAttempt,
  reconcileQueueLeases,
  releaseQueuedCallForRetry,
  releaseOutboundCallGuard,
  getQueueDispatcherDrainState,
  isSeniorInQueueCanaryCohort,
  resolveCallArchitectureConfig,
  setQueueDispatcherDraining,
  validateCallArchitectureConfig,
  waitForQueueDispatcherIdle,
} = await import('../../services/call-queue.js');

const _prevArchEnv = {
  mode: process.env.CALL_ARCHITECTURE_MODE,
  allow: process.env.CALL_QUEUE_ALLOW_REAL_DIAL,
};

beforeEach(async () => {
  setQueueDispatcherDraining(false);
  // dispatchQueuedCalls now early-returns when allowRealDial is false
  // (defense-in-depth per Phase 4 §2.7 dual-path rollout contract). Tests
  // in this file exercise the function's end-to-end dispatch behavior, so
  // we run them in canary_queue with real-dial allowed. Architecture-config
  // tests above explicitly override via resolveCallArchitectureConfig({...}).
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

function mockDatabase(results) {
  const execute = vi.fn();
  for (const result of results) {
    execute.mockResolvedValueOnce({ rows: result });
  }
  return { execute };
}

describe('call queue architecture config', () => {
  it('defaults to legacy-only with real queue dialing disabled', () => {
    const config = resolveCallArchitectureConfig({});

    expect(config.mode).toBe(CALL_ARCHITECTURE_MODES.LEGACY_ONLY);
    expect(config.allowRealDial).toBe(false);
    expect(config.requireDialGuard).toBe(true);
    expect(config.dispatcherEnabled).toBe(false);
    expect(config.reconcilerEnabled).toBe(false);
    expect(config.useCapacityRegistry).toBe(true);
    expect(config.requireCapacityRegistry).toBe(false);
  });

  it('does not allow real dialing in shadow modes even when requested', () => {
    const config = resolveCallArchitectureConfig({
      CALL_ARCHITECTURE_MODE: CALL_ARCHITECTURE_MODES.SHADOW_DISPATCH,
      CALL_QUEUE_ALLOW_REAL_DIAL: 'true',
    });

    expect(config.shadowDispatch).toBe(true);
    expect(config.dispatcherEnabled).toBe(true);
    expect(config.reconcilerEnabled).toBe(true);
    expect(config.allowRealDial).toBe(false);
  });

  it('allows real queue dialing only in live queue modes', () => {
    const config = resolveCallArchitectureConfig({
      CALL_ARCHITECTURE_MODE: CALL_ARCHITECTURE_MODES.CANARY_QUEUE,
      CALL_QUEUE_ALLOW_REAL_DIAL: 'true',
      CALL_QUEUE_CANARY_PERCENT: '5',
      CALL_QUEUE_COHORT_ALLOWLIST: 'senior-1, senior-2,senior-1',
      CALL_QUEUE_TEST_RUN_ID: 'shadow-run-1',
      CALL_QUEUE_MATERIALIZER_LIMIT: '667',
    });

    expect(config.allowRealDial).toBe(true);
    expect(config.canaryPercent).toBe(5);
    expect(config.canarySeniorIds).toEqual(['senior-1', 'senior-2']);
    expect(config.testRunId).toBe('shadow-run-1');
    expect(config.materializerLimit).toBe(667);
  });

  it('parses dispatcher and reconciler dry-run controls', () => {
    const config = resolveCallArchitectureConfig({
      CALL_QUEUE_DISPATCHER_ENABLED: 'true',
      CALL_QUEUE_RECONCILER_ENABLED: 'true',
      CALL_DISPATCH_MAX_BATCH_SIZE: '250',
      CALL_DISPATCH_LEASE_SECONDS: '45',
      CALL_DISPATCH_OVERBOOK_FACTOR: '1.25',
      CALL_QUEUE_SHADOW_CAPACITY: '50',
      CALL_LANE_POLICY_VERSION: 'v1',
    });

    expect(config.dispatcherEnabled).toBe(true);
    expect(config.reconcilerEnabled).toBe(true);
    expect(config.dispatcherBatchSize).toBe(250);
    expect(config.dispatchLeaseSeconds).toBe(45);
    expect(config.dispatchOverbookFactor).toBe(1.25);
    expect(config.shadowCapacitySlots).toBe(50);
    expect(config.lanePolicyVersion).toBe('v1');
  });

  it('uses a deterministic ID-only canary cohort for legacy/queue split decisions', () => {
    expect(isSeniorInQueueCanaryCohort('senior-1', {
      canaryPercent: 0,
      canarySeniorIds: ['senior-1'],
    })).toBe(true);
    expect(isSeniorInQueueCanaryCohort('senior-2', {
      canaryPercent: 0,
      canarySeniorIds: ['senior-1'],
    })).toBe(false);
    expect(isSeniorInQueueCanaryCohort('senior-2', {
      canaryPercent: 100,
      canarySeniorIds: [],
    })).toBe(true);
    expect(canaryBucketForSeniorId('senior-2')).toBeGreaterThanOrEqual(0);
    expect(canaryBucketForSeniorId('senior-2')).toBeLessThan(100);
  });

  it('fails rollout preflight for unsafe real-dial mode combinations', () => {
    const shadow = validateCallArchitectureConfig({
      CALL_ARCHITECTURE_MODE: CALL_ARCHITECTURE_MODES.SHADOW_DISPATCH,
      CALL_QUEUE_ALLOW_REAL_DIAL: 'true',
    });

    expect(shadow.ok).toBe(false);
    expect(shadow.errors).toContain('CALL_QUEUE_ALLOW_REAL_DIAL=true is only valid in canary_queue or queue_primary');

    const canary = validateCallArchitectureConfig({
      CALL_ARCHITECTURE_MODE: CALL_ARCHITECTURE_MODES.CANARY_QUEUE,
      CALL_QUEUE_ALLOW_REAL_DIAL: 'true',
      CALL_QUEUE_DISPATCHER_ENABLED: 'true',
      CALL_QUEUE_REQUIRE_DIAL_GUARD: 'true',
      CALL_QUEUE_USE_CAPACITY_REGISTRY: 'true',
    });

    expect(canary.ok).toBe(false);
    expect(canary.errors).toContain('canary_queue real dialing requires CALL_QUEUE_COHORT_ALLOWLIST or CALL_QUEUE_CANARY_PERCENT > 0');
  });

  it('passes rollout preflight for allowlisted canary queue dialing', () => {
    const result = validateCallArchitectureConfig({
      CALL_ARCHITECTURE_MODE: CALL_ARCHITECTURE_MODES.CANARY_QUEUE,
      CALL_QUEUE_ALLOW_REAL_DIAL: 'true',
      CALL_QUEUE_DISPATCHER_ENABLED: 'true',
      CALL_QUEUE_REQUIRE_DIAL_GUARD: 'true',
      CALL_QUEUE_USE_CAPACITY_REGISTRY: 'true',
      CALL_QUEUE_COHORT_ALLOWLIST: 'senior-1',
      CALL_QUEUE_CANARY_PERCENT: '0',
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual(expect.objectContaining({
      allowRealDial: true,
      canaryAllowlistCount: 1,
    }));
  });
});

describe('call queue operational PHI guard', () => {
  it('rejects synthetic PHI sentinels in operational rows', () => {
    expect(() => assertOperationalPayloadHasNoPlainPhi({
      seniorId: 'senior-1',
      callType: 'schedule',
      skipReason: 'PHI_SENTINEL_REMINDER_DO_NOT_LOG',
    })).toThrow(/Plain PHI sentinel/);
  });

  it('rejects raw PHI-shaped fields while allowing encrypted payload keys', () => {
    expect(() => assertOperationalPayloadHasNoPlainPhi({
      seniorId: 'senior-1',
      reminderTitle: 'test reminder',
    })).toThrow(/PHI-bearing field/);

    expect(() => assertOperationalPayloadHasNoPlainPhi({
      seniorId: 'senior-1',
      contextNotesEncrypted: 'enc:test',
      payloadEncrypted: 'enc:test',
    })).not.toThrow();
  });
});

describe('call queue keys and windows', () => {
  it('builds stable ID-only dedupe keys for scheduled, reminder, welfare, and manual work', () => {
    const targetAt = new Date('2035-03-11T13:30:00.000Z');

    expect(buildCallDedupeKey({
      callType: 'schedule',
      seniorId: 'senior-1',
      scheduleId: 'schedule-1',
      targetAt,
      localDate: '2035-03-11',
    })).toBe('schedule:senior-1:2035-03-11:schedule-1');

    expect(buildCallDedupeKey({
      callType: 'reminder',
      seniorId: 'senior-1',
      reminderId: 'reminder-1',
      targetAt,
    })).toBe('reminder:reminder-1:2035-03-11T13:30:00.000Z');

    expect(buildCallDedupeKey({
      callType: 'welfare',
      seniorId: 'senior-1',
      localDate: '2035-03-11',
    })).toBe('welfare:senior-1:2035-03-11');

    expect(buildCallDedupeKey({
      callType: 'manual',
      seniorId: 'senior-1',
      requestId: 'request-1',
    })).toBe('manual:senior-1:request-1');
  });

  it('creates a 15 minute dispatch window around the target time by default', () => {
    const window = buildDispatchWindow('2035-03-11T13:30:00.000Z');

    expect(window.earliestAt.toISOString()).toBe('2035-03-11T13:22:30.000Z');
    expect(window.latestAt.toISOString()).toBe('2035-03-11T13:37:30.000Z');
  });
});

describe('call queue capacity planning', () => {
  it('estimates available Pipecat capacity from healthy non-draining instances', () => {
    const available = estimateAvailablePipecatCapacity({
      instances: [
        {
          healthy: true,
          draining: false,
          maxCalls: 100,
          activeCalls: 20,
          pendingStartCount: 5,
        },
        {
          healthy: true,
          draining: true,
          maxCalls: 100,
          activeCalls: 10,
          pendingReservations: 0,
        },
        {
          healthy: false,
          draining: false,
          maxCalls: 100,
          activeCalls: 10,
          pendingReservations: 0,
        },
      ],
      overbookFactor: 1.1,
    });

    expect(available).toBe(85);
  });

  it('subtracts inbound activity from outbound dispatch capacity when heartbeat active calls lag', () => {
    const available = estimateAvailablePipecatCapacity({
      instances: [
        {
          healthy: true,
          draining: false,
          maxCalls: 10,
          activeCalls: 1,
          inboundActiveCalls: 4,
          pendingReservations: 2,
        },
      ],
    });

    expect(available).toBe(4);
  });

  it('does not count replicas that have not passed the readiness gate', () => {
    const available = estimateAvailablePipecatCapacity({
      instances: [
        {
          healthy: true,
          draining: false,
          ready: false,
          maxCalls: 100,
          activeCalls: 0,
        },
      ],
    });

    expect(available).toBe(0);
  });

  it('normalizes lane pressure to known priority lanes only', () => {
    expect(normalizeLanePressure({
      [PRIORITY_LANES.MANUAL]: '2',
      [PRIORITY_LANES.HARD_REMINDER]: 3,
      unknown: 99,
    })).toEqual(expect.objectContaining({
      [PRIORITY_LANES.MANUAL]: 2,
      [PRIORITY_LANES.HARD_REMINDER]: 3,
      [PRIORITY_LANES.SCHEDULED_CHECKIN]: 0,
    }));
  });

  it('builds a lane reserve plan with spillover in dispatch order', () => {
    const plan = buildLaneCapacityPlan({
      capacitySlots: 10,
      lanePolicy: DEFAULT_LANE_RESERVE_POLICY,
      lanePressure: {
        [PRIORITY_LANES.MANUAL]: 5,
        [PRIORITY_LANES.HARD_REMINDER]: 10,
        [PRIORITY_LANES.SCHEDULED_CHECKIN]: 10,
      },
    });

    expect(plan.reservedByLane).toEqual(expect.objectContaining({
      [PRIORITY_LANES.MANUAL]: 1,
      [PRIORITY_LANES.HARD_REMINDER]: 4,
      [PRIORITY_LANES.REMINDER_RETRY]: 2,
      [PRIORITY_LANES.SCHEDULED_CHECKIN]: 3,
    }));
    expect(plan.plannedByLane).toEqual(expect.objectContaining({
      [PRIORITY_LANES.MANUAL]: 3,
      [PRIORITY_LANES.HARD_REMINDER]: 4,
      [PRIORITY_LANES.SCHEDULED_CHECKIN]: 3,
    }));
    expect(plan.planned).toBe(10);
    expect(plan.unusedSlots).toBe(0);
  });
});

describe('legacy shadow materialization', () => {
  it('converts legacy call specs to ID-only queue inputs', () => {
    const input = buildQueueInputFromLegacyCallSpec({
      type: 'schedule',
      senior: {
        id: 'senior-1',
        timezone: 'America/New_York',
        name: 'Not copied',
      },
      scheduleItem: {
        id: 'schedule-1',
        title: 'Not copied',
      },
      pendingReminders: [
        { id: 'reminder-1', title: 'Not copied' },
      ],
    }, {
      now: new Date('2035-03-11T13:30:00.000Z'),
    });

    expect(input).toEqual(expect.objectContaining({
      seniorId: 'senior-1',
      scheduleId: 'schedule-1',
      callType: 'schedule',
      priorityLane: PRIORITY_LANES.SCHEDULED_CHECKIN,
      dedupeKey: 'schedule:senior-1:2035-03-11:schedule-1',
    }));
    expect(JSON.stringify(input)).not.toContain('Not copied');
  });

  it('materializes a legacy plan without stopping on one bad spec', async () => {
    const database = mockDatabase([
      [{ id: 'queue-1' }],
    ]);

    const result = await materializeLegacyCallPlan([
      {
        type: 'welfare',
        senior: { id: 'senior-1', timezone: 'America/New_York' },
      },
      {
        type: 'schedule',
        senior: { timezone: 'America/New_York' },
      },
    ], {
      database,
      now: new Date('2035-03-11T13:30:00.000Z'),
    });

    expect(result).toEqual(expect.objectContaining({
      planned: 2,
      inserted: 1,
      existing: 0,
      failed: 1,
    }));
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('records ID-only shadow comparisons when enabled', async () => {
    const database = mockDatabase([
      [{ id: 'queue-1' }],
      [{ id: 'comparison-1' }],
    ]);

    const result = await materializeLegacyCallPlan([
      {
        type: 'schedule',
        senior: { id: 'senior-1', timezone: 'America/New_York', name: 'Not copied' },
        scheduleItem: { id: 'schedule-1', title: 'Not copied' },
        dedupKey: 'senior-1:schedule-1',
      },
    ], {
      database,
      now: new Date('2035-03-11T13:30:00.000Z'),
      recordComparisons: true,
      testRunId: 'shadow-run-1',
    });

    expect(result).toEqual(expect.objectContaining({
      planned: 1,
      inserted: 1,
      comparisonInserted: 1,
      comparisonFailed: 0,
    }));
    expect(database.execute).toHaveBeenCalledTimes(2);
  });
});

describe('call queue persistence helpers', () => {
  it('enqueues a call idempotently by dedupe key', async () => {
    const database = mockDatabase([
      [],
      [{ id: 'queue-1', dedupe_key: 'schedule:senior-1:2035-03-11:schedule-1' }],
    ]);

    const result = await enqueueCall({
      seniorId: 'senior-1',
      scheduleId: 'schedule-1',
      callType: 'schedule',
      priorityLane: PRIORITY_LANES.SCHEDULED_CHECKIN,
      targetAt: '2035-03-11T13:30:00.000Z',
      localDate: '2035-03-11',
    }, { database });

    expect(result.inserted).toBe(false);
    expect(result.row.id).toBe('queue-1');
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it('leases queued calls with a caller-provided owner', async () => {
    const database = mockDatabase([
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.LEASED, lease_owner: 'worker-1' }],
    ]);

    const rows = await leaseQueuedCalls({
      leaseOwner: 'worker-1',
      limit: 25,
      now: '2035-03-11T13:22:30.000Z',
    }, { database });

    expect(rows).toHaveLength(1);
    expect(rows[0].lease_owner).toBe('worker-1');
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('calculates queue lag without returning negative values', () => {
    expect(estimateQueueLagSeconds({
      target_at: '2035-03-11T13:30:00.000Z',
    }, '2035-03-11T13:31:15.000Z')).toBe(75);

    expect(estimateQueueLagSeconds({
      target_at: '2035-03-11T13:35:00.000Z',
    }, '2035-03-11T13:31:15.000Z')).toBe(0);
  });

  it('does not lease or write comparisons when dry-run capacity is zero', async () => {
    const database = mockDatabase([]);

    const result = await dryRunDispatchQueuedCalls({
      capacitySlots: 0,
      limit: 10,
      now: '2035-03-11T13:31:15.000Z',
    }, { database });

    expect(result).toEqual({
      requested: 0,
      leased: 0,
      comparisonInserted: 0,
      comparisonFailed: 0,
    });
    expect(database.execute).not.toHaveBeenCalled();
  });

  it('leases capacity-bounded rows and records ID-only dry-run comparisons', async () => {
    const database = mockDatabase([
      [{
        id: 'queue-1',
        senior_id: 'senior-1',
        call_type: 'schedule',
        priority_lane: PRIORITY_LANES.SCHEDULED_CHECKIN,
        dedupe_key: 'schedule:senior-1:2035-03-11:schedule-1',
        target_at: '2035-03-11T13:30:00.000Z',
      }],
      [{ id: 'comparison-1' }],
    ]);

    const result = await dryRunDispatchQueuedCalls({
      leaseOwner: 'shadow-dispatcher-1',
      capacitySlots: 5,
      limit: 10,
      now: '2035-03-11T13:31:15.000Z',
      leaseSeconds: 45,
      testRunId: 'shadow-run-1',
    }, { database });

    expect(result).toEqual({
      requested: 5,
      leased: 1,
      comparisonInserted: 1,
      comparisonFailed: 0,
    });
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it('counts ready queued calls by lane for dry-run capacity planning', async () => {
    const database = mockDatabase([
      [
        { priority_lane: PRIORITY_LANES.MANUAL, count: 2 },
        { priority_lane: PRIORITY_LANES.HARD_REMINDER, count: '3' },
        { priority_lane: 'unknown', count: 99 },
      ],
    ]);

    const counts = await countReadyQueuedCallsByLane({
      now: '2035-03-11T13:31:15.000Z',
    }, { database });

    expect(counts).toEqual(expect.objectContaining({
      [PRIORITY_LANES.MANUAL]: 2,
      [PRIORITY_LANES.HARD_REMINDER]: 3,
      [PRIORITY_LANES.SCHEDULED_CHECKIN]: 0,
    }));
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('leases dry-run rows by lane policy when requested', async () => {
    const database = mockDatabase([
      [{
        id: 'queue-manual-1',
        senior_id: 'senior-1',
        call_type: 'manual',
        priority_lane: PRIORITY_LANES.MANUAL,
        dedupe_key: 'manual:senior-1:request-1',
        target_at: '2035-03-11T13:30:00.000Z',
      }],
      [{
        id: 'queue-hard-1',
        senior_id: 'senior-2',
        call_type: 'reminder',
        priority_lane: PRIORITY_LANES.HARD_REMINDER,
        dedupe_key: 'reminder:reminder-1:2035-03-11T13:30:00.000Z',
        target_at: '2035-03-11T13:30:00.000Z',
      }],
      [{
        id: 'queue-schedule-1',
        senior_id: 'senior-3',
        call_type: 'schedule',
        priority_lane: PRIORITY_LANES.SCHEDULED_CHECKIN,
        dedupe_key: 'schedule:senior-3:2035-03-11:schedule-1',
        target_at: '2035-03-11T13:30:00.000Z',
      }],
      [{ id: 'comparison-manual-1' }],
      [{ id: 'comparison-hard-1' }],
      [{ id: 'comparison-schedule-1' }],
    ]);

    const result = await dryRunDispatchQueuedCalls({
      leaseOwner: 'shadow-dispatcher-1',
      capacitySlots: 6,
      limit: 6,
      now: '2035-03-11T13:31:15.000Z',
      testRunId: 'shadow-run-1',
      respectLanePolicy: true,
      lanePressure: {
        [PRIORITY_LANES.MANUAL]: 1,
        [PRIORITY_LANES.HARD_REMINDER]: 10,
        [PRIORITY_LANES.SCHEDULED_CHECKIN]: 10,
      },
    }, { database });

    expect(result.leased).toBe(3);
    expect(result.comparisonInserted).toBe(3);
    expect(result.capacityPlan.plannedByLane).toEqual(expect.objectContaining({
      [PRIORITY_LANES.MANUAL]: 1,
      [PRIORITY_LANES.HARD_REMINDER]: 3,
      [PRIORITY_LANES.SCHEDULED_CHECKIN]: 2,
    }));
    expect(database.execute).toHaveBeenCalledTimes(6);
  });

  it('recovers expired leases that are still inside the dispatch window', async () => {
    const database = mockDatabase([
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.QUEUED }],
    ]);

    const rows = await recoverExpiredQueueLeases({
      limit: 25,
      now: '2035-03-11T13:31:15.000Z',
    }, { database });

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(CALL_QUEUE_STATUSES.QUEUED);
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('expires queued or leased calls after their dispatch window closes', async () => {
    const database = mockDatabase([
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.EXPIRED, cancel_reason: 'dispatch_window_expired' }],
    ]);

    const rows = await expireOverdueQueuedCalls({
      limit: 25,
      now: '2035-03-11T13:45:00.000Z',
    }, { database });

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(CALL_QUEUE_STATUSES.EXPIRED);
    expect(rows[0].cancel_reason).toBe('dispatch_window_expired');
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('reconciles recoverable and overdue queue rows by count only', async () => {
    const database = mockDatabase([
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.QUEUED }],
      [{ id: 'queue-2', status: CALL_QUEUE_STATUSES.EXPIRED }],
    ]);

    const result = await reconcileQueueLeases({
      limit: 25,
      now: '2035-03-11T13:45:00.000Z',
    }, { database });

    expect(result).toEqual({ recovered: 1, expired: 1 });
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it('acquires the durable guard once and suppresses the second dialer', async () => {
    const insertedGuard = { id: 'guard-1', guard_key: 'schedule:senior-1:2035-03-11:schedule-1' };
    const database = mockDatabase([
      [insertedGuard],
      [],
      [insertedGuard],
    ]);

    const input = {
      seniorId: 'senior-1',
      scheduleId: 'schedule-1',
      callType: 'schedule',
      architecture: 'legacy',
      targetAt: '2035-03-11T13:30:00.000Z',
      localDate: '2035-03-11',
    };

    await expect(acquireOutboundCallGuard(input, { database }))
      .resolves.toEqual({ acquired: true, guard: insertedGuard });

    await expect(acquireOutboundCallGuard({ ...input, architecture: 'queue' }, { database }))
      .resolves.toEqual({ acquired: false, guard: insertedGuard });
  });

  it('defaultGuardExpiry returns target_at + max(60s, 2*lease + 30s)', () => {
    const target = new Date('2035-03-11T13:30:00.000Z');

    // 60s lease -> 2*60 + 30 = 150s cushion
    const tight = defaultGuardExpiry({ targetAt: target, leaseSeconds: 60 });
    expect(tight.getTime() - target.getTime()).toBe(150 * 1000);

    // 30s lease -> 2*30 + 30 = 90s, but floor of 60s applies (since 60 > 90? no, 60 < 90; floor wins when arg is smaller)
    // The floor is max(60, 2*lease + 30). With lease=10 -> max(60, 50) = 60s.
    const floored = defaultGuardExpiry({ targetAt: target, leaseSeconds: 10 });
    expect(floored.getTime() - target.getTime()).toBe(60 * 1000);

    // Long lease -> longer cushion
    const long = defaultGuardExpiry({ targetAt: target, leaseSeconds: 300 });
    expect(long.getTime() - target.getTime()).toBe((2 * 300 + 30) * 1000);

    // Missing/invalid lease -> defaults to 60s -> 150s cushion
    const fallback = defaultGuardExpiry({ targetAt: target });
    expect(fallback.getTime() - target.getTime()).toBe(150 * 1000);
  });

  it('acquireOutboundCallGuard uses the tightened expires_at default (not 24h)', async () => {
    const captured = { dates: [] };
    const database = {
      execute: vi.fn((query) => {
        // Drizzle's `sql` tag interleaves StringChunk + raw bound values
        // (Numbers, Strings, Dates, nulls) in `queryChunks`. Pull out the
        // Date chunks so we can verify the computed expires_at policy.
        if (query?.queryChunks) {
          for (const chunk of query.queryChunks) {
            if (chunk instanceof Date) captured.dates.push(chunk);
          }
        }
        return Promise.resolve({ rows: [{ id: 'guard-x' }] });
      }),
    };

    const targetAt = new Date('2035-03-11T13:30:00.000Z');
    await acquireOutboundCallGuard({
      seniorId: 'senior-1',
      scheduleId: 'schedule-1',
      callType: 'schedule',
      architecture: 'legacy',
      targetAt,
      localDate: '2035-03-11',
      leaseSeconds: 90,
    }, { database });

    // Tightened policy: target_at + max(60, 2*90 + 30) = target_at + 210s.
    const expectedExpiry = new Date(targetAt.getTime() + 210 * 1000);
    const hasTightExpiry = captured.dates.some((d) => d.getTime() === expectedExpiry.getTime());
    expect(hasTightExpiry).toBe(true);

    // And critically, the old 24h expires_at must NOT be present.
    const oldDefault = new Date(targetAt.getTime() + 24 * 60 * 60 * 1000);
    const hasOldExpiry = captured.dates.some((d) => d.getTime() === oldDefault.getTime());
    expect(hasOldExpiry).toBe(false);
  });

  it('releaseExpiredOutboundCallGuards releases stuck guards and returns the freed rows', async () => {
    const released = [
      { id: 'guard-1', guard_key: 'k1', senior_id: 's1', architecture: 'legacy', queue_id: null },
      { id: 'guard-2', guard_key: 'k2', senior_id: 's2', architecture: 'queue', queue_id: 'q-2' },
    ];
    const database = mockDatabase([released]);

    const rows = await releaseExpiredOutboundCallGuards({
      limit: 50,
      now: '2035-03-11T13:45:00.000Z',
    }, { database });

    expect(rows).toEqual(released);
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('releaseExpiredOutboundCallGuards returns empty list when no stuck guards exist', async () => {
    const database = mockDatabase([[]]);

    const rows = await releaseExpiredOutboundCallGuards({}, { database });

    expect(rows).toEqual([]);
  });

  it('reconcileOutboundCallGuards writes an audit row per freed guard (fire-and-forget)', async () => {
    const released = [
      { id: 'guard-1', guard_key: 'k1', senior_id: 's1', architecture: 'legacy', queue_id: null },
      { id: 'guard-2', guard_key: 'k2', senior_id: 's2', architecture: 'queue', queue_id: 'q-2' },
    ];
    const database = mockDatabase([released]);
    const auditWriter = vi.fn(async () => undefined);

    const result = await reconcileOutboundCallGuards(
      { limit: 25, now: '2035-03-11T13:45:00.000Z' },
      { database, auditWriter },
    );

    expect(result).toEqual({ released: 2 });
    // Let fire-and-forget audit microtasks settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(auditWriter).toHaveBeenCalledTimes(2);
    expect(auditWriter).toHaveBeenCalledWith(expect.objectContaining({
      action: 'outbound_guard_released_expired',
      resourceType: 'outbound_call_guard',
      resourceId: 'guard-1',
      metadata: expect.objectContaining({ guardKey: 'k1', seniorId: 's1', architecture: 'legacy' }),
    }));
  });

  it('reconcileOutboundCallGuards survives audit writer failures without raising', async () => {
    const released = [
      { id: 'guard-1', guard_key: 'k1', senior_id: 's1', architecture: 'legacy', queue_id: null },
    ];
    const database = mockDatabase([released]);
    const auditWriter = vi.fn(async () => {
      throw new Error('audit_durability_blip');
    });

    const result = await reconcileOutboundCallGuards(
      {},
      { database, auditWriter },
    );

    expect(result).toEqual({ released: 1 });
    await new Promise((r) => setTimeout(r, 0));
    // Audit was attempted; failure does not propagate.
    expect(auditWriter).toHaveBeenCalledTimes(1);
  });

  it('marks an acquired guard initiated and can release an unstarted guard', async () => {
    const database = mockDatabase([
      [{ id: 'guard-1', status: 'initiated', call_control_id: 'v3:test-call' }],
      [{ id: 'guard-2', guard_key: 'schedule:senior-1:2035-03-11:schedule-2' }],
    ]);

    await expect(markOutboundCallGuardInitiated({
      guardId: 'guard-1',
      callControlId: 'v3:test-call',
    }, { database })).resolves.toEqual({
      id: 'guard-1',
      status: 'initiated',
      call_control_id: 'v3:test-call',
    });

    await expect(releaseOutboundCallGuard({
      guardKey: 'schedule:senior-1:2035-03-11:schedule-2',
    }, { database })).resolves.toEqual({
      id: 'guard-2',
      guard_key: 'schedule:senior-1:2035-03-11:schedule-2',
    });
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it('records one attempt per queue and attempt number', async () => {
    const existingAttempt = { id: 'attempt-1', queue_id: 'queue-1', attempt_number: 1 };
    const database = mockDatabase([
      [],
      [existingAttempt],
    ]);

    const result = await recordCallAttempt({
      queueId: 'queue-1',
      seniorId: 'senior-1',
      attemptNumber: 1,
      architecture: 'queue',
      status: 'initiating',
      reservationId: 'reservation-1',
    }, { database });

    expect(result.inserted).toBe(false);
    expect(result.row.id).toBe('attempt-1');
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it('updates queue and attempt state for live dispatch', async () => {
    const database = mockDatabase([
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.INITIATING, attempt_count: 1 }],
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.STARTED }],
      [{ id: 'attempt-1', status: 'initiated', call_control_id: 'v3:test-call' }],
      [{ id: 'queue-2', status: CALL_QUEUE_STATUSES.QUEUED }],
      [{ id: 'attempt-2', status: 'suppressed', provider_error_code: 'senior_inactive_or_missing' }],
    ]);

    await expect(markQueuedCallInitiating({
      queueId: 'queue-1',
      leaseOwner: 'test-worker',
      attemptId: 'attempt-1',
    }, { database })).resolves.toEqual({
      id: 'queue-1',
      status: CALL_QUEUE_STATUSES.INITIATING,
      attempt_count: 1,
    });

    await expect(markQueuedCallStarted({
      queueId: 'queue-1',
      leaseOwner: 'test-worker',
      attemptId: 'attempt-1',
      callControlId: 'v3:test-call',
    }, { database })).resolves.toEqual({
      queue: { id: 'queue-1', status: CALL_QUEUE_STATUSES.STARTED },
      attempt: { id: 'attempt-1', status: 'initiated', call_control_id: 'v3:test-call' },
    });

    await expect(releaseQueuedCallForRetry({
      queueId: 'queue-2',
      errorCode: 'temporary_failure',
    }, { database })).resolves.toEqual({
      id: 'queue-2',
      status: CALL_QUEUE_STATUSES.QUEUED,
    });
    await expect(markCallAttemptSuppressed({
      attemptId: 'attempt-2',
      providerErrorCode: 'senior_inactive_or_missing',
    }, { database })).resolves.toEqual({
      id: 'attempt-2',
      status: 'suppressed',
      provider_error_code: 'senior_inactive_or_missing',
    });
    expect(database.execute).toHaveBeenCalledTimes(5);
  });

  it('flips an outbound guard to initiating only after rechecking senior state', async () => {
    const database = mockDatabase([
      [{ id: 'guard-1', status: 'initiating', initiated: true, suppress_reason: null }],
    ]);

    const result = await markOutboundCallGuardInitiatingIfCallable({
      guardId: 'guard-1',
    }, { database });

    expect(result).toEqual({
      initiated: true,
      guard: { id: 'guard-1', status: 'initiating', initiated: true, suppress_reason: null },
      suppressReason: null,
    });
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('builds queue outbound call params without PHI-bearing context', () => {
    const params = buildQueueOutboundCallParams({
      id: 'queue-1',
      senior_id: 'senior-1',
      call_type: 'reminder',
      reminder_id: 'reminder-1',
      target_at: '2035-03-11T13:30:00.000Z',
    }, {
      baseUrl: 'https://pipecat.example.test',
      reservationId: 'reservation-1',
    });

    expect(params).toEqual({
      seniorId: 'senior-1',
      callType: 'reminder',
      queueId: 'queue-1',
      reservationId: 'reservation-1',
      serviceLabel: 'dispatcher',
      baseUrl: 'https://pipecat.example.test',
      reminderId: 'reminder-1',
      scheduledFor: '2035-03-11T13:30:00.000Z',
    });
    expect(JSON.stringify(params)).not.toMatch(/title|description|phone|medical|transcript/i);
  });

  it('does not lease live queue rows while the dispatcher is draining', async () => {
    setQueueDispatcherDraining(true);
    const database = mockDatabase([]);
    const acquireReservation = vi.fn();
    const releaseReservation = vi.fn();
    const dialCall = vi.fn();

    const result = await dispatchQueuedCalls({
      leaseOwner: 'queue-dispatcher-1',
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

    expect(result).toEqual({
      requested: 0,
      leased: 0,
      reserved: 0,
      dialed: 0,
      suppressed: 0,
      failed: 0,
      releasedReservations: 0,
      draining: true,
    });
    expect(database.execute).not.toHaveBeenCalled();
    expect(acquireReservation).not.toHaveBeenCalled();
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(dialCall).not.toHaveBeenCalled();
    expect(getQueueDispatcherDrainState()).toEqual({
      draining: true,
      activeDispatches: 0,
      inFlightReservations: 0,
    });
  });

  it('tracks unconfirmed capacity reservations and releases them on forced drain', async () => {
    const queueRow = {
      id: 'queue-1',
      senior_id: 'senior-1',
      call_type: 'schedule',
      priority_lane: PRIORITY_LANES.SCHEDULED_CHECKIN,
      dedupe_key: 'schedule:senior-1:2035-03-11:schedule-1',
      target_at: '2035-03-11T13:30:00.000Z',
      attempt_count: 0,
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [queueRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'guard-1', guard_key: queueRow.dedupe_key }] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', queue_id: 'queue-1', attempt_number: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.INITIATING }] })
      .mockResolvedValueOnce({ rows: [{ id: 'guard-1', status: 'initiating', initiated: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'guard-1', status: 'initiated', call_control_id: 'v3:test-call' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.STARTED }] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', status: 'initiated', call_control_id: 'v3:test-call' }] });
    const database = { execute };
    const acquireReservation = vi.fn(async ({ reservationId, queueId }) => ({
      acquired: true,
      reservation: { reservation_id: reservationId, queue_id: queueId },
    }));
    const releaseReservation = vi.fn(async () => ({ released: true }));
    let resolveDial;
    let resolveDialEntered;
    const dialEntered = new Promise(resolve => {
      resolveDialEntered = resolve;
    });
    const dialBlocked = new Promise(resolve => {
      resolveDial = resolve;
    });
    const dialCall = vi.fn(async () => {
      resolveDialEntered();
      await dialBlocked;
      return {
        callSid: 'v3:test-call',
        callControlId: 'v3:test-call',
      };
    });

    const dispatchPromise = dispatchQueuedCalls({
      leaseOwner: 'queue-dispatcher-1',
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

    await dialEntered;
    expect(getQueueDispatcherDrainState()).toEqual({
      draining: false,
      activeDispatches: 1,
      inFlightReservations: 1,
    });
    await expect(waitForQueueDispatcherIdle({
      timeoutMs: 1,
      pollIntervalMs: 1,
    })).resolves.toEqual({
      idle: false,
      activeDispatches: 1,
    });

    const drainResult = await drainQueueDispatcherReservations({
      releaseReservation,
      timeoutMs: 1,
      pollIntervalMs: 1,
    });

    expect(drainResult).toEqual({
      idle: false,
      activeDispatches: 1,
      released: 1,
      failed: 0,
      remaining: 0,
    });
    expect(releaseReservation).toHaveBeenCalledWith(expect.objectContaining({
      queueId: 'queue-1',
      reservationId: expect.stringMatching(/^queue:queue-1:/),
    }));

    resolveDial();
    const dispatchResult = await dispatchPromise;
    expect(dispatchResult.dialed).toBe(1);
    expect(getQueueDispatcherDrainState()).toEqual({
      draining: false,
      activeDispatches: 0,
      inFlightReservations: 0,
    });
  });

  it('dispatches leased queue rows with capacity reservation, guard, attempt, and Pipecat dial', async () => {
    const queueRow = {
      id: 'queue-1',
      senior_id: 'senior-1',
      call_type: 'reminder',
      priority_lane: PRIORITY_LANES.HARD_REMINDER,
      reminder_id: 'reminder-1',
      dedupe_key: 'reminder:reminder-1:2035-03-11T13:30:00.000Z',
      target_at: '2035-03-11T13:30:00.000Z',
      attempt_count: 0,
    };
    const database = mockDatabase([
      [queueRow],
      [{ id: 'guard-1', guard_key: queueRow.dedupe_key }],
      [{ id: 'attempt-1', queue_id: 'queue-1', attempt_number: 1 }],
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.INITIATING }],
      [{ id: 'guard-1', status: 'initiating', initiated: true, guard_key: queueRow.dedupe_key }],
      [{ id: 'guard-1', status: 'initiated', call_control_id: 'v3:test-call' }],
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.STARTED }],
      [{ id: 'attempt-1', status: 'initiated', call_control_id: 'v3:test-call' }],
    ]);
    const acquireReservation = vi.fn(async ({ reservationId, queueId }) => ({
      acquired: true,
      reservation: { reservation_id: reservationId, queue_id: queueId },
    }));
    const releaseReservation = vi.fn();
    const dialCall = vi.fn(async () => ({
      callSid: 'v3:test-call',
      callControlId: 'v3:test-call',
    }));

    const result = await dispatchQueuedCalls({
      leaseOwner: 'queue-dispatcher-1',
      capacitySlots: 1,
      limit: 1,
      now: '2035-03-11T13:31:15.000Z',
      baseUrl: 'https://pipecat.example.test',
      respectLanePolicy: false,
      testRunId: 'canary-1',
      cohort: 'canary_queue',
    }, {
      database,
      acquireReservation,
      releaseReservation,
      dialCall,
    });

    expect(result).toEqual(expect.objectContaining({
      requested: 1,
      leased: 1,
      reserved: 1,
      dialed: 1,
      suppressed: 0,
      failed: 0,
    }));
    expect(acquireReservation).toHaveBeenCalledWith(expect.objectContaining({
      queueId: 'queue-1',
      ttlSeconds: expect.any(Number),
    }));
    expect(dialCall).toHaveBeenCalledWith(expect.objectContaining({
      seniorId: 'senior-1',
      callType: 'reminder',
      reminderId: 'reminder-1',
      queueId: 'queue-1',
      reservationId: expect.stringMatching(/^queue:queue-1:/),
      serviceLabel: 'dispatcher',
    }));
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(database.execute).toHaveBeenCalledTimes(8);
  });

  it('cancels leased queue rows and releases reservations when the outbound guard is held', async () => {
    const queueRow = {
      id: 'queue-1',
      senior_id: 'senior-1',
      call_type: 'schedule',
      priority_lane: PRIORITY_LANES.SCHEDULED_CHECKIN,
      dedupe_key: 'schedule:senior-1:2035-03-11:schedule-1',
      target_at: '2035-03-11T13:30:00.000Z',
      attempt_count: 0,
    };
    const existingGuard = { id: 'guard-1', guard_key: queueRow.dedupe_key };
    const database = mockDatabase([
      [queueRow],
      [],
      [existingGuard],
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.CANCELLED }],
    ]);
    const acquireReservation = vi.fn(async ({ reservationId, queueId }) => ({
      acquired: true,
      reservation: { reservation_id: reservationId, queue_id: queueId },
    }));
    const releaseReservation = vi.fn(async () => ({ released: true }));
    const dialCall = vi.fn();

    const result = await dispatchQueuedCalls({
      leaseOwner: 'queue-dispatcher-1',
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

    expect(result.suppressed).toBe(1);
    expect(result.dialed).toBe(0);
    expect(result.releasedReservations).toBe(1);
    expect(releaseReservation).toHaveBeenCalledWith(expect.objectContaining({
      queueId: 'queue-1',
      reservationId: expect.stringMatching(/^queue:queue-1:/),
    }));
    expect(dialCall).not.toHaveBeenCalled();
    expect(database.execute).toHaveBeenCalledTimes(4);
  });

  it('cancels and releases capacity if the senior is inactive at the final guard recheck', async () => {
    const queueRow = {
      id: 'queue-1',
      senior_id: 'senior-1',
      call_type: 'schedule',
      priority_lane: PRIORITY_LANES.SCHEDULED_CHECKIN,
      dedupe_key: 'schedule:senior-1:2035-03-11:schedule-1',
      target_at: '2035-03-11T13:30:00.000Z',
      attempt_count: 0,
    };
    const database = mockDatabase([
      [queueRow],
      [{ id: 'guard-1', guard_key: queueRow.dedupe_key }],
      [{ id: 'attempt-1', queue_id: 'queue-1', attempt_number: 1 }],
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.INITIATING }],
      [{ id: 'guard-1', status: 'cancelled', initiated: false, suppress_reason: 'senior_inactive_or_missing' }],
      [{ id: 'attempt-1', status: 'suppressed', provider_error_code: 'senior_inactive_or_missing' }],
      [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.CANCELLED }],
    ]);
    const acquireReservation = vi.fn(async ({ reservationId, queueId }) => ({
      acquired: true,
      reservation: { reservation_id: reservationId, queue_id: queueId },
    }));
    const releaseReservation = vi.fn(async () => ({ released: true }));
    const dialCall = vi.fn();

    const result = await dispatchQueuedCalls({
      leaseOwner: 'queue-dispatcher-1',
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

    expect(result).toEqual(expect.objectContaining({
      requested: 1,
      leased: 1,
      reserved: 1,
      dialed: 0,
      suppressed: 1,
      failed: 0,
      releasedReservations: 1,
    }));
    expect(dialCall).not.toHaveBeenCalled();
    expect(releaseReservation).toHaveBeenCalledWith(expect.objectContaining({
      queueId: 'queue-1',
      reservationId: expect.stringMatching(/^queue:queue-1:/),
    }));
    expect(database.execute).toHaveBeenCalledTimes(7);
  });

  it('does not requeue after Telnyx accepts a call if post-dial status updates fail', async () => {
    const queueRow = {
      id: 'queue-1',
      senior_id: 'senior-1',
      call_type: 'schedule',
      priority_lane: PRIORITY_LANES.SCHEDULED_CHECKIN,
      dedupe_key: 'schedule:senior-1:2035-03-11:schedule-1',
      target_at: '2035-03-11T13:30:00.000Z',
      attempt_count: 0,
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [queueRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'guard-1', guard_key: queueRow.dedupe_key }] })
      .mockResolvedValueOnce({ rows: [{ id: 'attempt-1', queue_id: 'queue-1', attempt_number: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'queue-1', status: CALL_QUEUE_STATUSES.INITIATING }] })
      .mockResolvedValueOnce({ rows: [{ id: 'guard-1', status: 'initiating', initiated: true }] })
      .mockRejectedValueOnce(new Error('guard update unavailable'))
      .mockRejectedValueOnce(new Error('queue update unavailable'));
    const database = { execute };
    const acquireReservation = vi.fn(async ({ reservationId, queueId }) => ({
      acquired: true,
      reservation: { reservation_id: reservationId, queue_id: queueId },
    }));
    const releaseReservation = vi.fn();
    const dialCall = vi.fn(async () => ({
      callSid: 'v3:test-call',
      callControlId: 'v3:test-call',
    }));

    const result = await dispatchQueuedCalls({
      leaseOwner: 'queue-dispatcher-1',
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

    expect(result.dialed).toBe(1);
    expect(result.failed).toBe(0);
    expect(releaseReservation).not.toHaveBeenCalled();
    expect(dialCall).toHaveBeenCalledTimes(1);
  });

  it('writes shadow comparison rows and audit entries with bounded operational values', async () => {
    const database = mockDatabase([
      [{ id: 'comparison-1' }],
    ]);
    const auditWriter = vi.fn(async () => undefined);

    const row = await recordSchedulerShadowComparison({
      testRunId: 'shadow-run-1',
      seniorId: 'senior-1',
      queueId: 'queue-1',
      callType: 'schedule',
      priorityLane: PRIORITY_LANES.SCHEDULED_CHECKIN,
      legacyDedupKey: 'senior-1:schedule-1',
      queueDedupeKey: 'schedule:senior-1:2035-03-11:schedule-1',
      targetAt: '2035-03-11T13:30:00.000Z',
      legacyDecision: 'planned',
      queueDecision: 'inserted',
      skipReason: 'none',
      capacityDecision: 'not_evaluated',
      estimatedQueueLagSeconds: 90,
    }, { database, auditWriter });

    expect(row.id).toBe('comparison-1');
    expect(database.execute).toHaveBeenCalledTimes(1);
    expect(auditWriter).toHaveBeenCalledWith({
      userId: 'system',
      userRole: 'system',
      action: 'shadow_decision',
      resourceType: 'senior',
      resourceId: 'senior-1',
      metadata: {
        testRunId: 'shadow-run-1',
        queueId: 'queue-1',
        callType: 'schedule',
        priorityLane: PRIORITY_LANES.SCHEDULED_CHECKIN,
        legacyDecision: 'planned',
        queueDecision: 'inserted',
        skipReason: 'none',
        capacityDecision: 'not_evaluated',
        estimatedQueueLagSeconds: 90,
      },
    });
    expect(JSON.stringify(auditWriter.mock.calls[0][0].metadata)).not.toContain('dedupe');
  });
});

describe('queue state-machine lease-owner guards (C3 review fix)', () => {
  it('markQueuedCallInitiating returns null when lease is owned by another worker', async () => {
    // Empty rows simulates the WHERE clause not matching (lease_owner mismatch
    // or status no longer LEASED). The function must return null without
    // mutating state.
    const database = mockDatabase([[]]);

    const result = await markQueuedCallInitiating({
      queueId: 'queue-1',
      leaseOwner: 'worker-stale',
      attemptId: 'attempt-1',
    }, { database });

    expect(result).toBeNull();
    const sqlText = database.execute.mock.calls[0][0]?.toQuery
      ? database.execute.mock.calls[0][0]
      : database.execute.mock.calls[0][0];
    // Both clauses must appear in the SQL.
    const inspected = JSON.stringify(sqlText);
    expect(inspected).toContain('lease_owner');
    expect(inspected).toContain('status');
  });

  it('markQueuedCallStarted returns null queue when status is not INITIATING', async () => {
    // First call (queue UPDATE) returns empty rows — no row matched the
    // status=INITIATING + lease_owner filter. Second call should NOT happen
    // because there's no attemptId, so we expect a single execute() invocation.
    const database = mockDatabase([[]]);

    const result = await markQueuedCallStarted({
      queueId: 'queue-1',
      leaseOwner: 'worker-stale',
      attemptId: null,
      callControlId: 'v3:test-call',
    }, { database });

    expect(result.queue).toBeNull();
    expect(result.attempt).toBeNull();
  });

  it('markQueuedCallInitiating and markQueuedCallStarted reject missing leaseOwner', async () => {
    const database = mockDatabase([]);

    await expect(markQueuedCallInitiating({
      queueId: 'queue-1',
      attemptId: 'attempt-1',
    }, { database })).rejects.toThrow(/leaseOwner/);

    await expect(markQueuedCallStarted({
      queueId: 'queue-1',
      attemptId: 'attempt-1',
      callControlId: 'v3:x',
    }, { database })).rejects.toThrow(/leaseOwner/);
  });
});

describe('queue dispatcher guard expiry (C2 review fix)', () => {
  it('defaultGuardExpiry uses targetAt + max(60s, 2*lease+30s) cushion, never +24h', () => {
    const targetAt = new Date('2026-01-01T12:00:00Z');
    const lease60 = defaultGuardExpiry({ targetAt, leaseSeconds: 60 });
    // 2 * 60 + 30 = 150s
    expect(lease60.getTime() - targetAt.getTime()).toBe(150 * 1000);

    const lease120 = defaultGuardExpiry({ targetAt, leaseSeconds: 120 });
    // 2 * 120 + 30 = 270s
    expect(lease120.getTime() - targetAt.getTime()).toBe(270 * 1000);

    // Floor at 60s when lease is tiny
    const lease5 = defaultGuardExpiry({ targetAt, leaseSeconds: 5 });
    expect(lease5.getTime() - targetAt.getTime()).toBe(60 * 1000);

    // Crucially: never 24 hours
    expect(lease60.getTime() - targetAt.getTime()).toBeLessThan(60 * 60 * 1000);
  });
});
