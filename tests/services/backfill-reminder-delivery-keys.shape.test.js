/**
 * Category B (PHI shape) test — reminder delivery key backfill.
 *
 * The script returns a summary object with counts (scanned, eligible,
 * updated, etc.). It MUST NOT carry the reminderId, the delivery_key
 * itself, the senior name, or the phone number through to its output —
 * those are internal scratch values used to build the deterministic
 * delivery key.
 *
 * Existing tests assert numeric counters via `toMatchObject`. This test
 * feeds the script PHI-bearing mocked rows and walks the entire summary
 * recursively to assert no PHI-shaped key (besides aggregates) and no
 * sentinel value leaks.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PHI_SENTINELS,
  assertNoPhiShape,
} from '../integration-harness/phi-shape.js';

const { backfillReminderDeliveryKeys } = await import(
  '../../scripts/backfill-reminder-delivery-keys.js'
);

function preflightClean() {
  return {
    rows: [{
      candidateRows: 2,
      candidateKeys: 2,
      duplicateCandidateRows: 0,
      collisionRows: 0,
      collisionKeys: 0,
      existingKeyConflicts: 0,
      // PHI-shape decoys — must not be forwarded:
      reminder_id: '22222222-2222-4222-8222-222222222222',
      delivery_key: `reminder_delivery:${PHI_SENTINELS.reminderTitle}:2026-05-23T09:30`,
      reminder_title: PHI_SENTINELS.reminderTitle,
      name: PHI_SENTINELS.name,
      phone: PHI_SENTINELS.phone,
    }],
  };
}

function candidateRowsWithPhi() {
  return {
    rows: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        reminderId: '22222222-2222-4222-8222-222222222222',
        scheduledMinute: '2026-05-23T09:30',
        // PHI-shape extras that the next-stage UPDATE must not echo back:
        reminder_title: PHI_SENTINELS.reminderTitle,
        reminder_description: PHI_SENTINELS.reminderDescription,
        senior_name: PHI_SENTINELS.name,
        senior_phone: PHI_SENTINELS.phone,
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        reminderId: '44444444-4444-4444-8444-444444444444',
        scheduledMinute: '2026-05-23T10:00',
        reminder_title: PHI_SENTINELS.reminderTitle,
        senior_name: PHI_SENTINELS.name,
      },
    ],
  };
}

function preflightBlocked() {
  return {
    rows: [{
      candidateRows: 3,
      candidateKeys: 2,
      duplicateCandidateRows: 2,
      collisionRows: 2,
      collisionKeys: 1,
      existingKeyConflicts: 0,
      // PHI-shape decoys:
      delivery_key: `reminder_delivery:${PHI_SENTINELS.reminderTitle}:2026-05-23T09:30`,
      reminder_title: PHI_SENTINELS.reminderTitle,
      name: PHI_SENTINELS.name,
    }],
  };
}

// Top-level summary keys that don't match PHI_KEY_REGEX so don't need
// allowlisting. None of `dryRun/scanned/candidateRows/eligible/...` collide.
const ALLOWED_KEYS = new Set([]);

describe('backfill-reminder-delivery-keys PHI shape', () => {
  it('returns only aggregate counts when the backfill is blocked by collisions', async () => {
    const database = {
      execute: vi.fn().mockResolvedValueOnce(preflightBlocked()),
    };

    const result = await backfillReminderDeliveryKeys({
      database,
      dryRun: false,
      limit: 100,
    });

    expect(result.blocked).toBe(true);
    expect(result.collisionRows).toBe(2);

    // Walk the whole summary — no PHI-shaped keys, no PHI sentinels.
    assertNoPhiShape(result, { allowedKeys: ALLOWED_KEYS });

    // Belt-and-suspenders: explicit field-name allowlist.
    const allowedSummaryKeys = new Set([
      'dryRun', 'scanned', 'candidateRows', 'candidateKeys', 'eligible',
      'collisionRows', 'collisionKeys', 'duplicateCandidateRows',
      'existingKeyConflicts', 'wouldUpdate', 'updated', 'failed', 'blocked',
    ]);
    for (const key of Object.keys(result)) {
      expect(
        allowedSummaryKeys.has(key),
        `unexpected summary key "${key}" — did the backfill grow a PHI-bearing field?`,
      ).toBe(true);
    }
  });

  it('returns only aggregate counts on the dry-run write path with PHI-bearing rows', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(preflightClean())
        .mockResolvedValueOnce(candidateRowsWithPhi()),
    };

    const result = await backfillReminderDeliveryKeys({
      database,
      dryRun: true,
      limit: 10,
    });

    expect(result.blocked).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.eligible).toBe(2);
    expect(result.wouldUpdate).toBe(2);
    expect(result.updated).toBe(0);

    assertNoPhiShape(result, { allowedKeys: ALLOWED_KEYS });
  });

  it('returns only aggregate counts on the real-write path', async () => {
    const updateOk = { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(preflightClean())
        .mockResolvedValueOnce(candidateRowsWithPhi())
        .mockResolvedValueOnce(updateOk)
        .mockResolvedValueOnce(updateOk),
    };

    const result = await backfillReminderDeliveryKeys({
      database,
      dryRun: false,
      limit: 10,
    });

    expect(result.blocked).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.updated).toBe(2);
    expect(result.scanned).toBe(2);

    assertNoPhiShape(result, { allowedKeys: ALLOWED_KEYS });
  });

  it('proves the traversal would catch a regression that adds reminderId to the summary', () => {
    // Hand-built bad shape to prove the assertion isn't vacuous.
    const polluted = {
      dryRun: false,
      blocked: false,
      updated: 1,
      // a regression adds the per-row identifier:
      sample_reminder_id: '22222222-2222-4222-8222-222222222222',
      sample_delivery_key: `reminder_delivery:${PHI_SENTINELS.reminderTitle}:2026-05-23T09:30`,
    };

    expect(() => assertNoPhiShape(polluted, { allowedKeys: ALLOWED_KEYS }))
      .toThrow(/PHI/);
  });
});
