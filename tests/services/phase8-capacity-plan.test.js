import { describe, expect, it, vi } from 'vitest';

const {
  buildPhase8CapacityPlan,
  buildScaleRecommendation,
  summarizeCapacityRegistry,
  parseArgs,
} = await import('../../services/phase8-capacity-plan.js');

function result(rows) {
  return { rows };
}

function readyReplica(overrides = {}) {
  return {
    healthy: true,
    draining: false,
    ready: true,
    warmupGateGreen: true,
    maxCalls: 50,
    activeCalls: 0,
    pendingReservations: 0,
    ...overrides,
  };
}

describe('phase 8 capacity planner', () => {
  it('recommends scale-up before a scheduled call window', () => {
    const recommendation = buildScaleRecommendation({
      now: new Date('2035-03-18T13:30:00.000Z'),
      windowStart: new Date('2035-03-18T14:00:00.000Z'),
      queuedDemand: 180,
      availableSlots: 100,
      currentReplicas: 2,
      readyReplicas: 2,
      maxCallsPerReplica: 50,
      minReplicas: 2,
      warmupMinutes: 20,
    });

    expect(recommendation).toMatchObject({
      action: 'scale_up',
      targetReplicas: 4,
      requiredReplicas: 4,
      scaleUpBy: 2,
      scaleUpLate: false,
      scaleUpAt: '2035-03-18T13:40:00.000Z',
    });
  });

  it('blocks scale-down while live load or critical post-call backlog remains', () => {
    const withActiveCalls = buildScaleRecommendation({
      now: new Date('2035-03-18T13:30:00.000Z'),
      windowStart: new Date('2035-03-18T14:00:00.000Z'),
      queuedDemand: 0,
      availableSlots: 100,
      currentReplicas: 4,
      activeCalls: 1,
      pendingReservations: 0,
      criticalPostCallBacklog: 0,
      minReplicas: 2,
    });
    const withBacklog = buildScaleRecommendation({
      now: new Date('2035-03-18T13:30:00.000Z'),
      windowStart: new Date('2035-03-18T14:00:00.000Z'),
      queuedDemand: 0,
      availableSlots: 100,
      currentReplicas: 4,
      activeCalls: 0,
      pendingReservations: 0,
      criticalPostCallBacklog: 1,
      minReplicas: 2,
    });

    expect(withActiveCalls.action).toBe('hold');
    expect(withActiveCalls.reason).toBe('scale_down_blocked_by_active_calls_reservations_or_critical_backlog');
    expect(withBacklog.action).toBe('hold');
    expect(withBacklog.reason).toBe('scale_down_blocked_by_active_calls_reservations_or_critical_backlog');
  });

  it('allows off-peak scale-down only when demand, reservations, active calls, and critical backlog are clear', () => {
    const recommendation = buildScaleRecommendation({
      now: new Date('2035-03-18T13:30:00.000Z'),
      windowStart: new Date('2035-03-18T14:00:00.000Z'),
      queuedDemand: 0,
      availableSlots: 200,
      currentReplicas: 5,
      activeCalls: 0,
      pendingReservations: 0,
      criticalPostCallBacklog: 0,
      minReplicas: 2,
    });

    expect(recommendation).toMatchObject({
      action: 'scale_down',
      targetReplicas: 2,
      scaleDownBy: 3,
      scaleDownSafe: true,
    });
  });

  it('excludes replicas whose Phase 3 warm-up gate is not green from ready capacity', () => {
    const summary = summarizeCapacityRegistry({
      configured: true,
      backend: 'redis',
      instances: [
        readyReplica({ instanceId: 'green-1', activeCalls: 10 }),
        readyReplica({ instanceId: 'warming-1', warmupGateGreen: false }),
        readyReplica({ instanceId: 'draining-1', draining: true }),
      ],
    });

    expect(summary.totalReplicas).toBe(3);
    expect(summary.readyReplicas).toBe(1);
    expect(summary.warmupGateRedReplicas).toBe(1);
    expect(summary.availableSlots).toBe(40);
  });

  it('builds a PHI-free aggregate plan from database and capacity registry counts', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([
          {
            priority_lane: 'scheduled_checkin',
            status: 'queued',
            count: '120',
            senior_id: 'PHI_SENTINEL_SHOULD_NOT_APPEAR',
            phone: '+15555551212',
          },
          { priority_lane: 'hard_reminder', status: 'deferred', count: 5, name: 'Jane Example' },
          { priority_lane: 'unknown_lane', status: 'queued', count: 3, transcript: 'Donna Phi Sentinel' },
        ]))
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([{ count: 0, reminder_text: 'Donna Phi Sentinel' }])),
    };
    const capacityRegistryReader = vi.fn().mockResolvedValue({
      configured: true,
      backend: 'redis',
      instances: [
        readyReplica({ instanceId: 'a' }),
        readyReplica({ instanceId: 'b' }),
      ],
    });

    const report = await buildPhase8CapacityPlan({
      database,
      capacityRegistryReader,
      now: new Date('2035-03-18T13:30:00.000Z'),
      windowStart: new Date('2035-03-18T14:00:00.000Z'),
      currentReplicas: 2,
      maxCallsPerReplica: 50,
      minReplicas: 2,
      costPerReplicaHour: 0.25,
      hourlyBudget: 2,
    });

    expect(report.ok).toBe(true);
    expect(report.demand).toMatchObject({
      total: 128,
      unknownLane: 3,
    });
    expect(report.demand.byLane.scheduled_checkin).toBe(120);
    expect(report.demand.byLane.hard_reminder).toBe(5);
    expect(report.recommendation).toMatchObject({
      action: 'scale_up',
      targetReplicas: 3,
      scaleUpBy: 1,
    });
    expect(report.recommendation.cost).toMatchObject({
      projectedHourlyCost: 0.75,
      withinHourlyBudget: true,
    });
    expect(database.execute).toHaveBeenCalledTimes(3);
    expect(capacityRegistryReader).toHaveBeenCalledWith({
      now: new Date('2035-03-18T13:30:00.000Z'),
    });
    expect(Object.keys(report.demand)).toEqual(['total', 'byLane', 'byStatus', 'unknownLane']);
    expect(JSON.stringify(report)).not.toMatch(/PHI_SENTINEL|555555|Jane/i);
  });

  it('fails the budget check when target replicas exceed the Phase 0 hourly budget input', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([{ priority_lane: 'manual', status: 'queued', count: 150 }]))
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([{ count: 0 }])),
    };

    const report = await buildPhase8CapacityPlan({
      database,
      capacityRegistryReader: vi.fn().mockResolvedValue({
        configured: true,
        backend: 'redis',
        instances: [readyReplica(), readyReplica()],
      }),
      now: new Date('2035-03-18T13:30:00.000Z'),
      windowStart: new Date('2035-03-18T14:00:00.000Z'),
      currentReplicas: 2,
      maxCallsPerReplica: 50,
      costPerReplicaHour: 0.5,
      hourlyBudget: 1,
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.name === 'hourly_cost_budget')).toMatchObject({
      status: 'failed',
    });
  });

  it('includes current ready backlog in scale recommendations and scale-down guards', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([]))
        .mockResolvedValueOnce(result([
          { priority_lane: 'manual', status: 'queued', count: 10 },
        ]))
        .mockResolvedValueOnce(result([{ count: 0 }])),
    };

    const report = await buildPhase8CapacityPlan({
      database,
      capacityRegistryReader: vi.fn().mockResolvedValue({
        configured: true,
        backend: 'redis',
        instances: [readyReplica(), readyReplica()],
      }),
      now: new Date('2035-03-18T13:30:00.000Z'),
      windowStart: new Date('2035-03-18T14:00:00.000Z'),
      currentReplicas: 4,
      minReplicas: 2,
      maxCallsPerReplica: 50,
    });

    expect(report.demand.total).toBe(10);
    expect(report.demandBreakdown.currentBacklog.total).toBe(10);
    expect(report.recommendation.action).toBe('hold');
    expect(report.recommendation.scaleDownSafe).toBe(false);
  });

  it('parses operator CLI options without exposing env values', () => {
    expect(parseArgs([
      '--window-start=2035-03-18T14:00:00.000Z',
      '--current-replicas=3',
      '--max-calls-per-replica=60',
      '--cost-per-replica-hour=0.12',
      '--hourly-budget=1.00',
    ])).toMatchObject({
      windowStart: '2035-03-18T14:00:00.000Z',
      currentReplicas: 3,
      maxCallsPerReplica: 60,
      costPerReplicaHour: 0.12,
      hourlyBudget: 1,
    });
  });
});
