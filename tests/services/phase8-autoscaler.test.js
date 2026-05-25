import { describe, expect, it, vi } from 'vitest';

const {
  applyRailwayScale,
  buildRailwayScaleCommand,
} = await import('../../services/railway-scaling.js');
const {
  applyOperatorScaleOverride,
  runPhase8AutoscalerOnce,
  shouldApplyPhase8ScaleRecommendation,
} = await import('../../services/phase8-autoscaler.js');

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

function databaseForDemand({ queued = 0, criticalBacklog = 0 } = {}) {
  return {
    execute: vi.fn()
      .mockResolvedValueOnce(result(queued > 0
        ? [{ priority_lane: 'scheduled_checkin', status: 'queued', count: queued }]
        : []))
      .mockResolvedValueOnce(result([{ count: criticalBacklog }])),
  };
}

describe('phase 8 autoscaler and Railway scaling', () => {
  it('builds a non-interactive Railway scale command with service, environment, region, and JSON output', () => {
    expect(buildRailwayScaleCommand({
      targetReplicas: 4,
      service: 'donna-pipecat',
      environment: 'staging',
      region: 'us-west',
    })).toMatchObject({
      bin: 'railway',
      args: ['scale', 'us-west=4', '--service', 'donna-pipecat', '--environment', 'staging', '--json'],
      targetReplicas: 4,
      region: 'us-west',
    });
  });

  it('keeps Railway scale changes dry-run by default', async () => {
    const execFileAsync = vi.fn();
    const result = await applyRailwayScale({
      targetReplicas: 3,
      reason: 'test',
      dryRun: true,
      service: 'donna-pipecat',
      environment: 'staging',
      execFileAsync,
    });

    expect(result).toMatchObject({
      ok: true,
      applied: false,
      dryRun: true,
      targetReplicas: 3,
    });
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('executes Railway CLI only when dryRun is false and required config is present', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({
      stdout: '{"ok":true}',
      stderr: '',
    });

    const result = await applyRailwayScale({
      targetReplicas: 3,
      reason: 'test',
      dryRun: false,
      service: 'donna-pipecat',
      environment: 'staging',
      region: 'us-east',
      execFileAsync,
    });

    expect(execFileAsync).toHaveBeenCalledWith('railway', [
      'scale',
      'us-east=3',
      '--service',
      'donna-pipecat',
      '--environment',
      'staging',
      '--json',
    ], expect.objectContaining({ timeout: 60000 }));
    expect(result).toMatchObject({
      ok: true,
      applied: true,
      dryRun: false,
      railway: { ok: true },
    });
  });

  it('recommends applying scale-up but blocks failed budget recommendations', () => {
    expect(shouldApplyPhase8ScaleRecommendation({
      recommendation: { action: 'scale_up', scaleUpBy: 2 },
      checks: [{ name: 'hourly_cost_budget', status: 'passed' }],
    })).toEqual({ apply: true, reason: 'scale_up_recommended' });

    expect(shouldApplyPhase8ScaleRecommendation({
      recommendation: { action: 'scale_up', scaleUpBy: 2 },
      checks: [{ name: 'hourly_cost_budget', status: 'failed' }],
    })).toEqual({ apply: false, reason: 'hourly_cost_budget_failed' });
  });

  it('runs autoscaler once and performs a dry-run scale-up from aggregate plan data', async () => {
    const scaleExecutor = vi.fn().mockResolvedValue({
      ok: true,
      applied: false,
      dryRun: true,
      targetReplicas: 3,
    });

    const output = await runPhase8AutoscalerOnce({
      planOptions: {
        database: databaseForDemand({ queued: 125 }),
        capacityRegistryReader: vi.fn().mockResolvedValue({
          configured: true,
          backend: 'redis',
          instances: [readyReplica(), readyReplica()],
        }),
        windowStart: new Date('2035-03-18T14:00:00.000Z'),
        currentReplicas: 2,
        maxCallsPerReplica: 50,
        costPerReplicaHour: 0.1,
        hourlyBudget: 1,
      },
      now: new Date('2035-03-18T13:30:00.000Z'),
      confirmScale: false,
      dryRun: true,
      scaleExecutor,
    });

    expect(output.applied).toBe(false);
    expect(output.dryRun).toBe(true);
    expect(scaleExecutor).toHaveBeenCalledWith(expect.objectContaining({
      targetReplicas: 3,
      dryRun: true,
    }));
  });

  it('blocks operator scale-down when active calls make the plan unsafe', async () => {
    await expect(applyOperatorScaleOverride({
      planOptions: {
        database: databaseForDemand({ queued: 0 }),
        capacityRegistryReader: vi.fn().mockResolvedValue({
          configured: true,
          backend: 'redis',
          instances: [readyReplica({ activeCalls: 1 }), readyReplica(), readyReplica()],
        }),
        windowStart: new Date('2035-03-18T14:00:00.000Z'),
        currentReplicas: 3,
      },
      targetReplicas: 2,
      auditWriter: vi.fn(),
      scaleExecutor: vi.fn(),
      now: new Date('2035-03-18T13:30:00.000Z'),
    })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('audits operator overrides with aggregate operational metadata only', async () => {
    const auditWriter = vi.fn();
    const scaleExecutor = vi.fn().mockResolvedValue({
      ok: true,
      applied: false,
      dryRun: true,
      targetReplicas: 4,
    });

    const output = await applyOperatorScaleOverride({
      planOptions: {
        database: databaseForDemand({ queued: 0 }),
        capacityRegistryReader: vi.fn().mockResolvedValue({
          configured: true,
          backend: 'redis',
          instances: [readyReplica(), readyReplica()],
        }),
        windowStart: new Date('2035-03-18T14:00:00.000Z'),
        currentReplicas: 2,
      },
      targetReplicas: 4,
      reason: 'admin_scale_up_override',
      actor: 'admin-1',
      auditWriter,
      scaleExecutor,
      now: new Date('2035-03-18T13:30:00.000Z'),
    });

    expect(output).toMatchObject({
      ok: true,
      direction: 'scale_up',
      targetReplicas: 4,
      currentReplicas: 2,
    });
    expect(auditWriter).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1',
      action: 'update',
      resourceType: 'scale_operation',
      metadata: expect.objectContaining({
        direction: 'scale_up',
        targetReplicas: 4,
        currentReplicas: 2,
      }),
    }));
    expect(JSON.stringify(auditWriter.mock.calls[0][0])).not.toMatch(/senior|phone|transcript|summary|reminder/i);
  });
});
