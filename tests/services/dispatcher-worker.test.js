import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchQueuedCalls: vi.fn(),
  dryRunDispatchQueuedCalls: vi.fn(),
  reconcileQueueLeases: vi.fn(),
  reconcileOutboundCallGuards: vi.fn(),
  readPipecatCapacityRegistry: vi.fn(),
  resolveCallArchitectureConfig: vi.fn(),
  resolveMergedCanarySeniorIds: vi.fn(async ids => ids),
}));

vi.mock('../../services/call-queue.js', async () => {
  const actual = await vi.importActual('../../services/call-queue.js');
  return {
    ...actual,
    dispatchQueuedCalls: mocks.dispatchQueuedCalls,
    dryRunDispatchQueuedCalls: mocks.dryRunDispatchQueuedCalls,
    reconcileQueueLeases: mocks.reconcileQueueLeases,
    reconcileOutboundCallGuards: mocks.reconcileOutboundCallGuards,
    resolveCallArchitectureConfig: mocks.resolveCallArchitectureConfig,
  };
});

vi.mock('../../services/pipecat-capacity.js', async () => {
  const actual = await vi.importActual('../../services/pipecat-capacity.js');
  return {
    ...actual,
    readPipecatCapacityRegistry: mocks.readPipecatCapacityRegistry,
  };
});

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../lib/growthbook.js', () => ({
  initGrowthBook: vi.fn(),
  closeGrowthBook: vi.fn(),
}));

vi.mock('../../lib/security-config.js', () => ({
  getPipecatPublicUrl: () => 'https://pipecat.test',
}));

vi.mock('../../services/canary-cohort.js', () => ({
  resolveMergedCanarySeniorIds: mocks.resolveMergedCanarySeniorIds,
}));

const { dispatchOnce, reconcileOnce, loadCapacityInputs } = await import('../../scripts/run-dispatcher-worker.js');

function configFor(overrides = {}) {
  return {
    mode: 'shadow_dispatch',
    shadowMaterialize: true,
    shadowDispatch: true,
    allowRealDial: false,
    requireDialGuard: true,
    compareWithLegacy: false,
    canaryPercent: 0,
    canarySeniorIds: [],
    testRunId: null,
    materializerLimit: 1000,
    dispatcherEnabled: true,
    reconcilerEnabled: true,
    dispatcherBatchSize: 50,
    dispatchLeaseSeconds: 60,
    dispatchOverbookFactor: 1,
    useCapacityRegistry: true,
    requireCapacityRegistry: false,
    lanePolicyVersion: 'v1',
    shadowCapacitySlots: null,
    enabledCallTypes: ['manual', 'reminder', 'schedule', 'welfare'],
    ...overrides,
  };
}

describe('dispatcher worker', () => {
  beforeEach(() => {
    mocks.dispatchQueuedCalls.mockReset();
    mocks.dryRunDispatchQueuedCalls.mockReset();
    mocks.reconcileQueueLeases.mockReset();
    mocks.reconcileOutboundCallGuards.mockReset();
    mocks.readPipecatCapacityRegistry.mockReset();
    mocks.resolveCallArchitectureConfig.mockReset();
    mocks.resolveMergedCanarySeniorIds.mockReset();
    mocks.resolveMergedCanarySeniorIds.mockImplementation(async ids => ids);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs dry-run dispatch in shadow_dispatch and feeds capacity registry data through', async () => {
    mocks.resolveCallArchitectureConfig.mockReturnValue(configFor());
    mocks.readPipecatCapacityRegistry.mockResolvedValue({
      configured: true,
      backend: 'redis',
      instances: [
        { instanceId: 'replica-a', healthy: true, ready: true, maxCalls: 50, activeCalls: 5 },
      ],
      scanned: 1,
    });
    mocks.dryRunDispatchQueuedCalls.mockResolvedValue({ requested: 50, leased: 3 });

    const result = await dispatchOnce({ baseUrl: 'https://pipecat.test' });

    expect(result.mode).toBe('shadow_dispatch');
    expect(result.live).toBe(false);
    expect(mocks.dispatchQueuedCalls).not.toHaveBeenCalled();
    expect(mocks.dryRunDispatchQueuedCalls).toHaveBeenCalledTimes(1);
    const call = mocks.dryRunDispatchQueuedCalls.mock.calls[0][0];
    expect(call.respectLanePolicy).toBe(true);
    expect(call.instances).toEqual([
      { instanceId: 'replica-a', healthy: true, ready: true, maxCalls: 50, activeCalls: 5 },
    ]);
  });

  it('runs live dispatch in canary_queue with allowRealDial and forwards canary cohort filter', async () => {
    mocks.resolveCallArchitectureConfig.mockReturnValue(configFor({
      mode: 'canary_queue',
      allowRealDial: true,
      canaryPercent: 5,
      canarySeniorIds: ['s1'],
    }));
    mocks.readPipecatCapacityRegistry.mockResolvedValue({
      configured: true,
      backend: 'redis',
      instances: [{ instanceId: 'replica-a', healthy: true, ready: true, maxCalls: 50, activeCalls: 0 }],
      scanned: 1,
    });
    mocks.dispatchQueuedCalls.mockResolvedValue({ requested: 50, leased: 4, dialed: 2 });

    const result = await dispatchOnce({ baseUrl: 'https://pipecat.test' });

    expect(result.mode).toBe('canary_queue');
    expect(result.live).toBe(true);
    expect(mocks.dispatchQueuedCalls).toHaveBeenCalledTimes(1);
    const call = mocks.dispatchQueuedCalls.mock.calls[0][0];
    expect(call.canaryPercent).toBe(5);
    expect(call.canarySeniorIds).toEqual(['s1']);
    expect(call.cohort).toBe('canary_queue');
    expect(call.architecture).toBe('queue');
  });

  it('merges DB canary cohort members before live canary dispatch', async () => {
    mocks.resolveCallArchitectureConfig.mockReturnValue(configFor({
      mode: 'canary_queue',
      allowRealDial: true,
      canaryPercent: 0,
      canarySeniorIds: ['env-senior'],
    }));
    mocks.resolveMergedCanarySeniorIds.mockResolvedValue(['db-senior', 'env-senior']);
    mocks.readPipecatCapacityRegistry.mockResolvedValue({
      configured: true,
      backend: 'redis',
      instances: [{ instanceId: 'replica-a', healthy: true, ready: true, maxCalls: 50, activeCalls: 0 }],
      scanned: 1,
    });
    mocks.dispatchQueuedCalls.mockResolvedValue({ requested: 50, leased: 1, dialed: 1 });

    await dispatchOnce({ baseUrl: 'https://pipecat.test' });

    expect(mocks.resolveMergedCanarySeniorIds).toHaveBeenCalledWith(['env-senior']);
    expect(mocks.dispatchQueuedCalls.mock.calls[0][0].canarySeniorIds).toEqual(['db-senior', 'env-senior']);
  });

  it('skips dispatch when dispatcher is disabled in legacy modes', async () => {
    mocks.resolveCallArchitectureConfig.mockReturnValue(configFor({ dispatcherEnabled: false, mode: 'legacy_only' }));
    const result = await dispatchOnce({ baseUrl: 'https://pipecat.test' });
    expect(result).toEqual({ skipped: 'dispatcher_disabled', mode: 'legacy_only' });
    expect(mocks.dispatchQueuedCalls).not.toHaveBeenCalled();
    expect(mocks.dryRunDispatchQueuedCalls).not.toHaveBeenCalled();
  });

  it('reconcileOnce honors the reconciler-enabled flag', async () => {
    mocks.resolveCallArchitectureConfig.mockReturnValueOnce(configFor({ reconcilerEnabled: false }));
    expect(await reconcileOnce()).toEqual({ skipped: 'reconciler_disabled' });
    mocks.resolveCallArchitectureConfig.mockReturnValueOnce(configFor({ reconcilerEnabled: true }));
    mocks.reconcileQueueLeases.mockResolvedValueOnce({ recovered: 2, expired: 1 });
    mocks.reconcileOutboundCallGuards.mockResolvedValueOnce({ released: 3 });
    expect(await reconcileOnce()).toEqual({ recovered: 2, expired: 1, guardsReleased: 3 });
    expect(mocks.reconcileOutboundCallGuards).toHaveBeenCalledTimes(1);
  });

  it('reconcileOnce reports guardsReleased=0 and still returns lease stats when guard reconciler throws', async () => {
    mocks.resolveCallArchitectureConfig.mockReturnValueOnce(configFor({ reconcilerEnabled: true }));
    mocks.reconcileQueueLeases.mockResolvedValueOnce({ recovered: 0, expired: 4 });
    mocks.reconcileOutboundCallGuards.mockRejectedValueOnce(new Error('db_blip'));

    expect(await reconcileOnce()).toEqual({ recovered: 0, expired: 4, guardsReleased: 0 });
  });

  it('falls back to the batch-size capacity slot when the registry is missing and not required', async () => {
    mocks.readPipecatCapacityRegistry.mockResolvedValue({
      configured: false,
      backend: 'none',
      instances: [],
      scanned: 0,
      error: 'capacity_registry_unavailable',
    });
    const inputs = await loadCapacityInputs(configFor({ requireCapacityRegistry: false }));
    expect(inputs).toEqual({ capacitySlots: 50 });
  });

  it('throws when the capacity registry is required but unavailable', async () => {
    mocks.readPipecatCapacityRegistry.mockResolvedValue({
      configured: false,
      backend: 'none',
      instances: [],
      scanned: 0,
      error: 'capacity_registry_unavailable',
    });
    await expect(loadCapacityInputs(configFor({ requireCapacityRegistry: true }))).rejects.toThrow(
      /Capacity registry unavailable/,
    );
  });
});
