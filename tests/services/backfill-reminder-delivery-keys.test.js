import { describe, expect, it, vi } from 'vitest';

const {
  backfillReminderDeliveryKeys,
  buildReminderDeliveryKey,
} = await import('../../scripts/backfill-reminder-delivery-keys.js');

describe('reminder delivery key backfill', () => {
  it('builds deterministic minute-level delivery keys', () => {
    expect(buildReminderDeliveryKey({
      reminderId: 'reminder-1',
      scheduledMinute: '2035-03-11T09:30',
    })).toBe('reminder_delivery:reminder-1:2035-03-11T09:30');
  });

  it('blocks writes when full-table preflight finds collisions', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            candidateRows: 3,
            candidateKeys: 2,
            duplicateCandidateRows: 2,
            collisionRows: 2,
            collisionKeys: 1,
            existingKeyConflicts: 0,
          }],
        }),
    };

    const result = await backfillReminderDeliveryKeys({
      database,
      dryRun: false,
      limit: 1,
    });

    expect(result).toMatchObject({
      blocked: true,
      candidateRows: 3,
      collisionRows: 2,
      collisionKeys: 1,
      duplicateCandidateRows: 2,
      updated: 0,
    });
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it('updates only after a clean full-table preflight', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce({
          rows: [{
            candidateRows: 2,
            candidateKeys: 2,
            duplicateCandidateRows: 0,
            collisionRows: 0,
            collisionKeys: 0,
            existingKeyConflicts: 0,
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            reminderId: '22222222-2222-4222-8222-222222222222',
            scheduledMinute: '2035-03-11T09:30',
          }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: '11111111-1111-4111-8111-111111111111' }],
        }),
    };

    const result = await backfillReminderDeliveryKeys({
      database,
      dryRun: false,
      limit: 1,
    });

    expect(result).toMatchObject({
      blocked: false,
      scanned: 1,
      candidateRows: 2,
      candidateKeys: 2,
      eligible: 1,
      collisionRows: 0,
      updated: 1,
    });
    expect(database.execute).toHaveBeenCalledTimes(3);
  });
});
