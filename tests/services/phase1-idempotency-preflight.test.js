import { describe, expect, it, vi } from 'vitest';

const { runPhase1IdempotencyPreflight } = await import('../../scripts/phase1-idempotency-preflight.js');

function exists(value = true) {
  return { rows: [{ exists: value }] };
}

function duplicates({ duplicateKeys = 0, duplicateRows = 0 } = {}) {
  return { rows: [{ duplicateKeys, duplicateRows }] };
}

function reminderCollisionSummary(overrides = {}) {
  return {
    rows: [{
      candidateRows: 0,
      candidateKeys: 0,
      duplicateCandidateRows: 0,
      collisionRows: 0,
      collisionKeys: 0,
      existingKeyConflicts: 0,
      ...overrides,
    }],
  };
}

describe('phase 1 idempotency preflight', () => {
  it('blocks unique index rollout when an existing hot-table key has duplicates', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(duplicates({ duplicateKeys: 1, duplicateRows: 2 }))
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(duplicates())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(reminderCollisionSummary())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(duplicates()),
    };

    const result = await runPhase1IdempotencyPreflight({ database });

    expect(result).toMatchObject({
      ok: false,
      blocked: true,
      summary: {
        blockedChecks: 1,
        duplicateRows: 2,
        collisionRows: 0,
      },
    });
    expect(result.checks[0]).toMatchObject({
      name: 'conversations_call_sid_unique_ready',
      blocked: true,
      duplicateKeys: 1,
      duplicateRows: 2,
    });
  });

  it('blocks when the reminder delivery key backfill still has collisions', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(duplicates())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(duplicates())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(reminderCollisionSummary({
          candidateRows: 3,
          candidateKeys: 2,
          duplicateCandidateRows: 2,
          collisionRows: 2,
          collisionKeys: 1,
        }))
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(duplicates()),
    };

    const result = await runPhase1IdempotencyPreflight({ database });

    expect(result).toMatchObject({
      ok: false,
      blocked: true,
      summary: {
        blockedChecks: 1,
        duplicateRows: 0,
        collisionRows: 2,
      },
    });
    expect(result.checks[2]).toMatchObject({
      name: 'reminder_deliveries_delivery_key_backfill_collisions',
      blocked: true,
      candidateRows: 3,
      collisionRows: 2,
      collisionKeys: 1,
    });
  });
});
