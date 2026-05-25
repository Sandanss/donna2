import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initiateTelnyxOutboundCall: vi.fn(),
  prewarmTelnyxOutboundContext: vi.fn(),
  dbSelect: vi.fn(),
  dbExecute: vi.fn(),
  dbUpdate: vi.fn(),
  runDailyPrefetch: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../services/telnyx.js', () => ({
  initiateTelnyxOutboundCall: mocks.initiateTelnyxOutboundCall,
  prewarmTelnyxOutboundContext: mocks.prewarmTelnyxOutboundContext,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: mocks.dbSelect,
    execute: mocks.dbExecute,
    update: mocks.dbUpdate,
  },
}));

vi.mock('../../services/context-cache.js', () => ({
  contextCacheService: {
    runDailyPrefetch: mocks.runDailyPrefetch,
  },
}));

vi.mock('../../services/data-retention.js', () => ({
  runDailyPurgeIfNeeded: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('../../lib/growthbook.js', () => ({
  resolveFlags: vi.fn(async () => ({})),
  getValue: vi.fn(),
}));

const {
  filterLegacyExecutableCallPlan,
  schedulerService,
} = await import('../../services/scheduler.js');

function buildScheduleSpec() {
  return {
    type: 'schedule',
    senior: {
      id: 'senior-1',
      timezone: 'America/New_York',
    },
    scheduleItem: {
      id: 'sched-1',
      title: 'Morning call',
      time: '9:00 AM',
      frequency: 'daily',
    },
    dedupKey: 'senior-1:sched-1',
    pendingReminders: [
      { id: 'rem-1', title: 'Take medication', description: 'Blood pressure pills', type: 'medication' },
    ],
  };
}

function buildWelfareSpec() {
  return {
    type: 'welfare',
    senior: {
      id: 'senior-2',
      timezone: 'America/New_York',
    },
  };
}

function buildReminderSpec() {
  return {
    type: 'reminder',
    senior: {
      id: 'senior-3',
      timezone: 'America/New_York',
    },
    reminder: {
      id: 'rem-3',
      title: 'Take medication',
      type: 'medication',
    },
    scheduledFor: new Date('2035-03-11T13:30:00.000Z'),
  };
}

describe('schedulerService schedule-driven calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CALL_ARCHITECTURE_MODE;
    delete process.env.CALL_QUEUE_ALLOW_REAL_DIAL;
    mocks.initiateTelnyxOutboundCall.mockResolvedValue({
      callSid: 'v3:test-call',
      callControlId: 'v3:test-call',
    });
    vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('10');
  });

  afterEach(() => {
    delete process.env.CALL_ARCHITECTURE_MODE;
    delete process.env.CALL_QUEUE_ALLOW_REAL_DIAL;
    vi.restoreAllMocks();
  });

  it('triggers a scheduled call with reminderIds and contextNotes', async () => {
    const spec = buildScheduleSpec();
    spec.scheduleItem.contextNotes = 'Ask about doctor visit';

    await schedulerService.triggerOutboundCall(spec, 'https://pipecat.example.test');

    expect(mocks.initiateTelnyxOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({
        seniorId: 'senior-1',
        callType: 'schedule',
        reminderIds: ['rem-1'],
        contextNotes: 'Ask about doctor visit',
        baseUrl: 'https://pipecat.example.test',
      }),
    );
  });

  it('triggers a welfare call for seniors without scheduled calls', async () => {
    const spec = buildWelfareSpec();

    await schedulerService.triggerOutboundCall(spec, 'https://pipecat.example.test');

    expect(mocks.initiateTelnyxOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({
        seniorId: 'senior-2',
        callType: 'check-in',
        baseUrl: 'https://pipecat.example.test',
      }),
    );
  });

  it('triggers a reminder call with reminder delivery context', async () => {
    const spec = buildReminderSpec();
    spec.existingDelivery = { id: 'delivery-1' };

    await schedulerService.triggerOutboundCall(spec, 'https://pipecat.example.test');

    expect(mocks.initiateTelnyxOutboundCall).toHaveBeenCalledWith(
      expect.objectContaining({
        seniorId: 'senior-3',
        callType: 'reminder',
        reminderId: 'rem-3',
        scheduledFor: '2035-03-11T13:30:00.000Z',
        existingDeliveryId: 'delivery-1',
        baseUrl: 'https://pipecat.example.test',
      }),
    );
  });

  it('acquires a durable outbound guard in shadow mode before legacy dialing', async () => {
    process.env.CALL_ARCHITECTURE_MODE = 'shadow_dispatch';
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [{ id: 'guard-1', guard_key: 'schedule:senior-1:2035-03-11:sched-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'guard-1', status: 'initiated' }] });
    const spec = buildScheduleSpec();

    const result = await schedulerService.triggerOutboundCall(spec, 'https://pipecat.example.test');

    expect(result).toEqual(expect.objectContaining({
      callSid: 'v3:test-call',
      callControlId: 'v3:test-call',
    }));
    expect(mocks.dbExecute).toHaveBeenCalledTimes(2);
    expect(mocks.initiateTelnyxOutboundCall).toHaveBeenCalledTimes(1);
  });

  it('suppresses legacy dialing when the durable guard is already held', async () => {
    process.env.CALL_ARCHITECTURE_MODE = 'shadow_dispatch';
    mocks.dbExecute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'guard-1', guard_key: 'schedule:senior-1:2035-03-11:sched-1' }] });
    const spec = buildScheduleSpec();

    const result = await schedulerService.triggerOutboundCall(spec, 'https://pipecat.example.test');

    expect(result).toBeNull();
    expect(mocks.initiateTelnyxOutboundCall).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Outbound call suppressed by durable guard',
      expect.objectContaining({ type: 'schedule', seniorId: 'senior-1' }),
    );
  });

  it('buildCallPlan deduplicates — scheduled calls prevent welfare for same senior', () => {
    const schedCalls = [{
      senior: { id: 'senior-1' },
      scheduleItem: { id: 's1', time: '9:00 AM', frequency: 'daily' },
      dedupKey: 'senior-1:s1',
      pendingReminders: [],
    }];
    const welfareSeniors = [{ id: 'senior-1' }, { id: 'senior-2' }];

    const plan = schedulerService.buildCallPlan(schedCalls, welfareSeniors);

    expect(plan).toHaveLength(2);
    expect(plan[0].type).toBe('schedule');
    expect(plan[0].senior.id).toBe('senior-1');
    expect(plan[1].type).toBe('welfare');
    expect(plan[1].senior.id).toBe('senior-2');
  });

  it('buildCallPlan adds due reminder calls between scheduled and welfare work', () => {
    const schedCalls = [{
      senior: { id: 'senior-1' },
      scheduleItem: { id: 's1', time: '9:00 AM', frequency: 'daily' },
      dedupKey: 'senior-1:s1',
      pendingReminders: [],
    }];
    const dueReminders = [
      { senior: { id: 'senior-1' }, reminder: { id: 'rem-skipped' }, scheduledFor: new Date() },
      { senior: { id: 'senior-3' }, reminder: { id: 'rem-3' }, scheduledFor: new Date() },
    ];
    const welfareSeniors = [{ id: 'senior-2' }, { id: 'senior-3' }];

    const plan = schedulerService.buildCallPlan(schedCalls, welfareSeniors, dueReminders);

    expect(plan.map(spec => spec.type)).toEqual(['schedule', 'reminder', 'welfare']);
    expect(plan.map(spec => spec.senior.id)).toEqual(['senior-1', 'senior-3', 'senior-2']);
  });

  it('filters canary-owned seniors out of legacy execution when queue canary dialing is live', () => {
    const callPlan = [
      { type: 'schedule', senior: { id: 'senior-1' } },
      { type: 'schedule', senior: { id: 'senior-2' } },
    ];

    const legacyPlan = filterLegacyExecutableCallPlan(callPlan, {
      mode: 'canary_queue',
      allowRealDial: true,
      canaryPercent: 0,
      canarySeniorIds: ['senior-1'],
    });

    expect(legacyPlan).toEqual([
      { type: 'schedule', senior: { id: 'senior-2' } },
    ]);
  });
});

describe('schedulerService reliability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CALL_ARCHITECTURE_MODE;
    delete process.env.CALL_QUEUE_ALLOW_REAL_DIAL;
    mocks.initiateTelnyxOutboundCall.mockResolvedValue({
      callSid: 'v3:test-call',
      callControlId: 'v3:test-call',
    });
    vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('10');
  });

  afterEach(() => {
    delete process.env.CALL_ARCHITECTURE_MODE;
    delete process.env.CALL_QUEUE_ALLOW_REAL_DIAL;
    vi.restoreAllMocks();
  });

  it('retries transient Telnyx failures before reporting a call as initiated', async () => {
    const spec = buildScheduleSpec();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
      callback();
      return 0;
    });
    mocks.initiateTelnyxOutboundCall
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce({
        callSid: 'v3:retry-success',
        callControlId: 'v3:retry-success',
      });

    const result = await schedulerService.triggerOutboundCall(spec, 'https://pipecat.example.test');

    expect(result).toEqual({
      sid: 'v3:retry-success',
      callSid: 'v3:retry-success',
      callControlId: 'v3:retry-success',
    });
    expect(mocks.initiateTelnyxOutboundCall).toHaveBeenCalledTimes(3);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Telnyx call retry',
      expect.objectContaining({ attempt: 1, delay_ms: 1000 }),
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Telnyx call retry',
      expect.objectContaining({ attempt: 2, delay_ms: 2000 }),
    );
    setTimeoutSpy.mockRestore();
  });

  it('keeps recurring reminders pinned to senior wall-clock time across DST', () => {
    const reminder = {
      scheduledTime: '2035-03-11T14:30:00.000Z',
      isRecurring: true,
      cronExpression: '30 9 * * *',
    };
    const senior = {
      id: 'senior-1',
      timezone: 'America/New_York',
    };

    expect(
      schedulerService
        .getScheduledForTime(reminder, senior, new Date('2035-03-11T12:00:00.000Z'))
        .toISOString(),
    ).toBe('2035-03-11T13:30:00.000Z');
  });
});
