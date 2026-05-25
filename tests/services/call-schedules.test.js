import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  encrypt: vi.fn((value) => `enc:test:${value}`),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: mocks.execute,
  },
}));

vi.mock('../../lib/encryption.js', () => ({
  encrypt: mocks.encrypt,
}));

const {
  buildQueueInputFromNormalizedSchedule,
  computeNextScheduleRunAt,
  materializeDueNormalizedSchedules,
  normalizeSeniorCallScheduleRows,
  syncSeniorCallSchedulesFromPreferredCallTimes,
} = await import('../../services/call-schedules.js');

function mockDatabase(results) {
  const execute = vi.fn();
  for (const result of results) {
    execute.mockResolvedValueOnce({ rows: result });
  }
  return { execute };
}

describe('call schedule normalization', () => {
  it('computes the next daily run in the senior timezone', () => {
    const next = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'America/New_York',
    }, new Date('2035-03-11T12:00:00.000Z'));

    expect(next.toISOString()).toBe('2035-03-11T13:30:00.000Z');
  });

  it('runs once across the fall-back duplicated local hour', () => {
    const schedule = {
      frequency: 'daily',
      time: '1:30 AM',
      timezone: 'America/New_York',
    };
    const first = computeNextScheduleRunAt(schedule, new Date('2035-11-04T04:00:00.000Z'));

    expect(first.toISOString()).toBe('2035-11-04T05:30:00.000Z');
    expect(computeNextScheduleRunAt(schedule, new Date(first.getTime() + 60 * 1000)).toISOString())
      .toBe('2035-11-05T06:30:00.000Z');
  });

  it('moves spring-forward skipped local times to the next valid wall-clock time', () => {
    const next = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '2:30 AM',
      timezone: 'America/New_York',
    }, new Date('2035-03-11T04:00:00.000Z'));

    expect(next.toISOString()).toBe('2035-03-11T07:30:00.000Z');
  });

  it('handles one-time schedules on a DST boundary day', () => {
    const next = computeNextScheduleRunAt({
      frequency: 'one-time',
      date: '2035-03-11',
      time: '2:30 AM',
      timezone: 'America/New_York',
    }, new Date('2035-03-11T04:00:00.000Z'));

    expect(next.toISOString()).toBe('2035-03-11T07:30:00.000Z');
  });

  it('recomputes next run when the senior timezone changes', () => {
    const now = new Date('2035-03-11T12:00:00.000Z');
    const newYork = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'America/New_York',
    }, now);
    const chicago = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'America/Chicago',
    }, now);

    expect(newYork.toISOString()).toBe('2035-03-11T13:30:00.000Z');
    expect(chicago.toISOString()).toBe('2035-03-11T14:30:00.000Z');
  });

  it('skips past one-time schedules', () => {
    const next = computeNextScheduleRunAt({
      frequency: 'one-time',
      date: '2035-03-10',
      time: '9:30 AM',
      timezone: 'America/New_York',
    }, new Date('2035-03-11T12:00:00.000Z'));

    expect(next).toBeNull();
  });

  it('normalizes schedule JSON into ID-only runtime rows with encrypted notes', () => {
    const rows = normalizeSeniorCallScheduleRows({
      id: 'senior-1',
      timezone: 'America/New_York',
      preferredCallTimes: {
        schedule: [
          {
            id: 'schedule-1',
            title: 'Not copied',
            frequency: 'recurring',
            recurringDays: [1, 3, 5],
            time: '9:30 AM',
            reminderIds: ['11111111-1111-4111-8111-111111111111'],
            contextNotes: 'test context note',
          },
        ],
      },
    }, new Date('2035-03-10T12:00:00.000Z'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      seniorId: 'senior-1',
      frequency: 'recurring',
      daysOfWeek: [1, 3, 5],
      targetLocalTime: '09:30:00',
      contextNotesEncrypted: 'enc:test:test context note',
    }));
    expect(JSON.stringify(rows[0])).not.toContain('Not copied');
  });

  it('dual-writes normalized schedules idempotently', async () => {
    const database = mockDatabase([
      [],
      [],
    ]);

    const result = await syncSeniorCallSchedulesFromPreferredCallTimes({
      id: 'senior-1',
      timezone: 'America/New_York',
      preferredCallTimes: {
        schedule: [
          {
            frequency: 'daily',
            time: '9:30 AM',
          },
        ],
      },
    }, {
      database,
      now: new Date('2035-03-11T12:00:00.000Z'),
    });

    expect(result).toEqual({
      seniorId: 'senior-1',
      total: 1,
      upserted: 1,
    });
    expect(database.execute).toHaveBeenCalledTimes(2);
  });
});

describe('normalized schedule materialization', () => {
  it('builds a queue input inside the 15 minute window with stable dedupe', () => {
    const input = buildQueueInputFromNormalizedSchedule({
      id: 'schedule-1',
      seniorId: 'senior-1',
      callType: 'schedule',
      timezone: 'America/New_York',
      windowMinutes: 15,
      priorityLane: 'scheduled_checkin',
      nextRunAt: new Date('2035-03-11T13:30:00.000Z'),
    });

    expect(input.dedupeKey).toBe('schedule:senior-1:2035-03-11:schedule-1');
    expect(input.earliestAt.toISOString()).toBe('2035-03-11T13:22:30.000Z');
    expect(input.latestAt.toISOString()).toBe('2035-03-11T13:37:30.000Z');
    expect(input.targetAt.getTime()).toBeGreaterThanOrEqual(input.earliestAt.getTime());
    expect(input.targetAt.getTime()).toBeLessThanOrEqual(input.latestAt.getTime());
  });

  it('materializes due schedules and advances the next run', async () => {
    const database = mockDatabase([
      [{
        id: 'schedule-1',
        seniorId: 'senior-1',
        callType: 'schedule',
        timezone: 'America/New_York',
        targetLocalTime: '09:30:00',
        windowMinutes: 15,
        frequency: 'daily',
        daysOfWeek: null,
        oneTimeDate: null,
        priorityLane: 'scheduled_checkin',
        nextRunAt: new Date('2035-03-11T13:30:00.000Z'),
      }],
      [{ id: 'queue-1' }],
      [],
    ]);

    const result = await materializeDueNormalizedSchedules({
      database,
      now: new Date('2035-03-11T13:00:00.000Z'),
      horizonMinutes: 45,
    });

    expect(result).toEqual({
      scanned: 1,
      inserted: 1,
      existing: 0,
      failed: 0,
    });
    expect(database.execute).toHaveBeenCalledTimes(3);
  });

  it('uses a transaction-level advisory lock when the database supports transactions', async () => {
    const tx = mockDatabase([
      [{ acquired: true }],
      [{
        id: 'schedule-1',
        seniorId: 'senior-1',
        callType: 'schedule',
        timezone: 'America/New_York',
        targetLocalTime: '09:30:00',
        windowMinutes: 15,
        frequency: 'daily',
        daysOfWeek: null,
        oneTimeDate: null,
        priorityLane: 'scheduled_checkin',
        nextRunAt: new Date('2035-03-11T13:30:00.000Z'),
      }],
      [{ id: 'queue-1' }],
      [],
    ]);
    const database = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };

    const result = await materializeDueNormalizedSchedules({
      database,
      now: new Date('2035-03-11T13:00:00.000Z'),
      horizonMinutes: 45,
    });

    expect(result).toEqual({
      scanned: 1,
      inserted: 1,
      existing: 0,
      failed: 0,
    });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });

  it('skips materialization when another worker owns the advisory lock', async () => {
    const tx = mockDatabase([
      [{ acquired: false }],
    ]);
    const database = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };

    const result = await materializeDueNormalizedSchedules({
      database,
      now: new Date('2035-03-11T13:00:00.000Z'),
    });

    expect(result).toEqual({
      scanned: 0,
      inserted: 0,
      existing: 0,
      failed: 0,
    });
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('materializes a 667-call 15-minute window without duplicate queue keys', async () => {
    const dueSchedules = Array.from({ length: 667 }, (_, index) => ({
      id: `schedule-${index + 1}`,
      seniorId: `senior-${index + 1}`,
      callType: 'schedule',
      timezone: 'America/New_York',
      targetLocalTime: '09:30:00',
      windowMinutes: 15,
      frequency: 'daily',
      daysOfWeek: null,
      oneTimeDate: null,
      priorityLane: 'scheduled_checkin',
      nextRunAt: new Date('2035-03-11T13:30:00.000Z'),
    }));

    let callIndex = 0;
    const queueIds = new Set();
    const database = {
      execute: vi.fn(async () => {
        callIndex += 1;
        if (callIndex === 1) {
          return { rows: dueSchedules };
        }
        if (callIndex % 2 === 0) {
          const schedule = dueSchedules[(callIndex - 2) / 2];
          queueIds.add(`schedule:${schedule.seniorId}:2035-03-11:${schedule.id}`);
          return { rows: [{ id: `queue-${schedule.id}` }] };
        }
        return { rows: [] };
      }),
    };

    const result = await materializeDueNormalizedSchedules({
      database,
      now: new Date('2035-03-11T13:00:00.000Z'),
      horizonMinutes: 45,
      limit: 667,
    });

    expect(result).toEqual({
      scanned: 667,
      inserted: 667,
      existing: 0,
      failed: 0,
    });
    expect(queueIds.size).toBe(667);
    expect(database.execute).toHaveBeenCalledTimes(1 + 667 * 2);
  });
});
