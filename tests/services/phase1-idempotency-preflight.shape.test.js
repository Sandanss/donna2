/**
 * Category B (PHI shape) test — Phase 1 idempotency preflight.
 *
 * The preflight runs duplicate-key scans on hot tables (conversations,
 * reminder_deliveries, call_metrics) and a backfill-collision scan on
 * reminder_deliveries. By design it MUST return only aggregate counts and
 * boolean / string-array flags — never raw call SIDs, reminder IDs,
 * delivery keys, names, phones, or response bodies.
 *
 * The audit noted existing tests only assert numeric matchObject claims
 * (duplicateRows, collisionRows). This test feeds the preflight mocked DB
 * rows that include synthetic PHI-shaped fields in addition to the
 * aggregate columns, then traverses the entire returned summary to assert
 * no PHI-shaped key (besides the explicit aggregate-name allowlist) and
 * no sentinel value made it through.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PHI_SENTINELS,
  PHI_KEY_REGEX,
  assertNoPhiShape,
} from '../integration-harness/phi-shape.js';

const { runPhase1IdempotencyPreflight } = await import(
  '../../scripts/phase1-idempotency-preflight.js'
);

function existsResult(value = true) {
  return { rows: [{ exists: value }] };
}

// duplicate-key counter row that ALSO carries PHI-shaped columns. If the
// preflight ever switched from `count(*)::int AS duplicateKeys` to
// `SELECT * FROM duplicate_groups`, these extra fields would surface in
// the returned summary and the traversal would catch it.
function duplicatesWithPhiBleed({ duplicateKeys = 0, duplicateRows = 0 } = {}) {
  return {
    rows: [{
      duplicateKeys,
      duplicateRows,
      // PHI-shape decoys — must not be forwarded by the preflight:
      call_sid: 'CA-PHI-SENTINEL-1234',
      reminder_id: '11111111-2222-3333-4444-555555555555',
      delivery_key: `reminder_delivery:${PHI_SENTINELS.reminderTitle}:2026-05-23T09:00`,
      name: PHI_SENTINELS.name,
      phone: PHI_SENTINELS.phone,
      transcript: PHI_SENTINELS.transcript,
      reminder_title: PHI_SENTINELS.reminderTitle,
      caregiver_note: PHI_SENTINELS.caregiverNote,
      response_body: '{"phone":"+1-555-867-5309","summary":"PHI_SENTINEL_TRANSCRIPT_DO_NOT_LOG"}',
    }],
  };
}

function reminderCollisionWithPhiBleed(overrides = {}) {
  return {
    rows: [{
      candidateRows: 0,
      candidateKeys: 0,
      duplicateCandidateRows: 0,
      collisionRows: 0,
      collisionKeys: 0,
      existingKeyConflicts: 0,
      // PHI-shape decoys:
      reminder_id: '11111111-2222-3333-4444-555555555555',
      delivery_key: `reminder_delivery:PHI_SENTINEL_REMINDER_DO_NOT_LOG:2026-05-23T09:00`,
      name: PHI_SENTINELS.name,
      reminder_title: PHI_SENTINELS.reminderTitle,
      ...overrides,
    }],
  };
}

// The preflight issues, per duplicate-keys check (3 of them):
//   tableExists, columnExists, duplicate-count
// Plus the reminder-delivery-collision check (4th):
//   tableExists, columnExists x 4 (id, reminder_id, scheduled_for, delivery_key), collision-scan
// Order of checks per source: conversations.call_sid, reminder_deliveries.delivery_key,
// reminder-collision, call_metrics.call_sid
function buildSqlSequence({ collisionOverrides = {} } = {}) {
  return [
    // conversations.call_sid duplicate scan
    existsResult(true),                                  // table exists
    existsResult(true),                                  // column exists
    duplicatesWithPhiBleed(),                            // duplicate counter
    // reminder_deliveries.delivery_key duplicate scan
    existsResult(true),
    existsResult(true),
    duplicatesWithPhiBleed(),
    // reminder-delivery-collision check: 4 columns checked
    existsResult(true),                                  // table exists
    existsResult(true), existsResult(true), existsResult(true), existsResult(true), // 4 column checks
    reminderCollisionWithPhiBleed(collisionOverrides),
    // call_metrics.call_sid duplicate scan
    existsResult(true),
    existsResult(true),
    duplicatesWithPhiBleed(),
  ];
}

// Allow only the keys we know are aggregate/structural — anything else
// matching PHI_KEY_REGEX is a leak.
const ALLOWED_AGGREGATE_KEYS = new Set([
  'name',            // each check's `name` is a label like "conversations_call_sid_unique_ready"
  'summary',         // top-level summary aggregate object
  // Note: NO `migration`, `blocked`, `ok`, `duplicateRows`, `duplicateKeys`,
  // `missing`, `candidateRows`, etc. — those don't match PHI_KEY_REGEX so
  // no allowlist needed for them.
]);

describe('phase 1 idempotency preflight PHI shape', () => {
  it('returns only aggregate counts and labels — no PHI-shaped keys or sentinel values', async () => {
    const database = {
      execute: vi.fn(),
    };
    const sequence = buildSqlSequence();
    for (const result of sequence) {
      database.execute.mockResolvedValueOnce(result);
    }

    const result = await runPhase1IdempotencyPreflight({ database });

    // Sanity: the preflight actually ran every check.
    expect(result.checks.length).toBe(4);
    expect(result.summary.totalChecks).toBe(4);

    // The structural assertion: no PHI sentinel values, no PHI-shaped keys.
    assertNoPhiShape(result, {
      allowedKeys: ALLOWED_AGGREGATE_KEYS,
    });

    // And each check has only the documented shape.
    for (const check of result.checks) {
      expect(typeof check.name).toBe('string');
      expect(typeof check.migration).toBe('string');
      expect(typeof check.ok).toBe('boolean');
      expect(typeof check.blocked).toBe('boolean');
      expect(Array.isArray(check.missing)).toBe(true);
      // No PHI keys on any check object (the `name` key is the check's label).
      for (const key of Object.keys(check)) {
        if (key === 'name') continue;
        expect(
          PHI_KEY_REGEX.test(key),
          `check.${key} should not be a PHI-shaped key`,
        ).toBe(false);
      }
    }
  });

  it('still has clean shape when a blocked check carries collision counts', async () => {
    const database = { execute: vi.fn() };
    const sequence = buildSqlSequence({
      collisionOverrides: {
        candidateRows: 4,
        candidateKeys: 2,
        duplicateCandidateRows: 2,
        collisionRows: 2,
        collisionKeys: 1,
      },
    });
    for (const r of sequence) database.execute.mockResolvedValueOnce(r);

    const result = await runPhase1IdempotencyPreflight({ database });

    expect(result.blocked).toBe(true);
    expect(result.summary.collisionRows).toBe(2);
    // Even on the blocked path the shape must stay PHI-free.
    assertNoPhiShape(result, { allowedKeys: ALLOWED_AGGREGATE_KEYS });
  });

  it('rejects regressions that would forward `call_sid` or `delivery_key` in summary metadata', () => {
    // Sanity check the traversal isn't vacuous against a hand-built leak.
    const polluted = {
      ok: true,
      blocked: false,
      summary: {
        totalChecks: 4,
        // imagine a regression added these for "debugging":
        sample_call_sid: 'CA-PHI-SENTINEL-1234',
        sample_delivery_key: `reminder_delivery:${PHI_SENTINELS.reminderTitle}:2026-05-23T09:00`,
      },
      checks: [],
    };

    // call_sid and delivery_key don't match PHI_KEY_REGEX, but their
    // VALUES carry sentinels — so the value check catches it.
    expect(() => assertNoPhiShape(polluted, { allowedKeys: ALLOWED_AGGREGATE_KEYS }))
      .toThrow(/PHI/);
  });
});
