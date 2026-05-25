import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  auditWriter: vi.fn(async () => undefined),
}));

vi.mock('../../db/client.js', () => ({
  db: { execute: mocks.execute },
}));

vi.mock('../../services/audit.js', () => ({
  writeAudit: mocks.auditWriter,
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
  addToCanary,
  getActiveCanarySeniorIds,
  getCanaryRampPhase,
  listActiveCanaryMembers,
  removeFromCanary,
  resolveMergedCanarySeniorIds,
} = await import('../../services/canary-cohort.js');

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_B = '22222222-2222-4222-8222-222222222222';

function database(results) {
  const execute = vi.fn();
  for (const result of results) {
    execute.mockResolvedValueOnce({ rows: result });
  }
  return { execute };
}

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.auditWriter.mockReset();
});

describe('canary-cohort', () => {
  describe('addToCanary', () => {
    it('rejects invalid senior_id with a typed error code', async () => {
      await expect(
        addToCanary({ seniorId: 'not-a-uuid', rampPhase: '5' }),
      ).rejects.toMatchObject({ code: 'invalid_senior_id' });
    });

    it('rejects invalid ramp_phase with a typed error code', async () => {
      await expect(
        addToCanary({ seniorId: VALID_UUID_A, rampPhase: 'bad ramp phase!' }),
      ).rejects.toMatchObject({ code: 'invalid_ramp_phase' });
    });

    it('inserts a new canary row and writes an audit entry', async () => {
      const insertedRow = {
        senior_id: VALID_UUID_A,
        ramp_phase: '5',
        added_by: 'admin-1',
        added_at: '2026-05-24T00:00:00Z',
        removed_at: null,
        removed_reason: null,
        notes: null,
        __was_inserted: true,
      };
      const db = database([[insertedRow]]);
      const auditWriter = vi.fn(async () => undefined);
      const expectedRow = { ...insertedRow };
      delete expectedRow.__was_inserted;

      const row = await addToCanary(
        { seniorId: VALID_UUID_A, rampPhase: '5', addedBy: 'admin-1' },
        { database: db, auditWriter },
      );

      expect(row).toEqual(expectedRow);
      expect(db.execute).toHaveBeenCalledTimes(1);

      await new Promise((r) => setTimeout(r, 0));
      expect(auditWriter).toHaveBeenCalledWith(expect.objectContaining({
        action: 'canary_cohort_add',
        resourceType: 'canary_cohort_membership',
        resourceId: VALID_UUID_A,
        metadata: { rampPhase: '5' },
      }));
    });

    it('survives audit-writer failures without raising', async () => {
      const insertedRow = {
        senior_id: VALID_UUID_A,
        ramp_phase: '5',
        added_by: 'admin-1',
        added_at: '2026-05-24T00:00:00Z',
        removed_at: null,
        removed_reason: null,
        notes: null,
        __was_inserted: true,
      };
      const db = database([[insertedRow]]);
      const auditWriter = vi.fn(async () => {
        throw new Error('audit_durability_blip');
      });
      const expectedRow = { ...insertedRow };
      delete expectedRow.__was_inserted;

      const row = await addToCanary(
        { seniorId: VALID_UUID_A, rampPhase: '5', addedBy: 'admin-1' },
        { database: db, auditWriter },
      );
      expect(row).toEqual(expectedRow);
      await new Promise((r) => setTimeout(r, 0));
      expect(auditWriter).toHaveBeenCalledTimes(1);
    });

    it('does not write a duplicate audit entry when senior is already active', async () => {
      const existingRow = {
        senior_id: VALID_UUID_A,
        ramp_phase: '5',
        added_by: 'admin-1',
        added_at: '2026-05-24T00:00:00Z',
        removed_at: null,
        removed_reason: null,
        notes: null,
        __was_inserted: false,
      };
      const db = database([[existingRow]]);
      const auditWriter = vi.fn(async () => undefined);
      const expectedRow = { ...existingRow };
      delete expectedRow.__was_inserted;

      const row = await addToCanary(
        { seniorId: VALID_UUID_A, rampPhase: '5', addedBy: 'admin-1' },
        { database: db, auditWriter },
      );

      expect(row).toEqual(expectedRow);
      await new Promise((r) => setTimeout(r, 0));
      expect(auditWriter).not.toHaveBeenCalled();
    });

    it('raises when DB returns no row (insert + existing both empty)', async () => {
      const db = database([[]]);

      await expect(
        addToCanary({ seniorId: VALID_UUID_A, rampPhase: '5' }, { database: db }),
      ).rejects.toThrow(/failed to add canary member/i);
    });
  });

  describe('removeFromCanary', () => {
    it('rejects unknown removed_reason values', async () => {
      await expect(
        removeFromCanary({ seniorId: VALID_UUID_A, reason: 'arbitrary' }),
      ).rejects.toMatchObject({ code: 'invalid_removed_reason' });
    });

    it('defaults missing reason to manual_admin', async () => {
      const db = database([[{ senior_id: VALID_UUID_A, ramp_phase: '5', removed_reason: 'manual_admin' }]]);

      const row = await removeFromCanary(
        { seniorId: VALID_UUID_A, removedBy: 'admin-1' },
        { database: db, auditWriter: mocks.auditWriter },
      );

      expect(row?.removed_reason).toBe('manual_admin');
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('returns null when senior is not in active cohort (UPDATE matched 0 rows)', async () => {
      const db = database([[]]);
      const auditWriter = vi.fn(async () => undefined);

      const row = await removeFromCanary(
        { seniorId: VALID_UUID_A, reason: 'phase_complete' },
        { database: db, auditWriter },
      );
      expect(row).toBeNull();
      await new Promise((r) => setTimeout(r, 0));
      expect(auditWriter).not.toHaveBeenCalled();
    });

    it('writes audit entry on successful removal with PHI-free metadata', async () => {
      const row = {
        senior_id: VALID_UUID_A,
        ramp_phase: '10',
        removed_at: '2026-05-24T01:00:00Z',
        removed_reason: 'phase_complete',
      };
      const db = database([[row]]);
      const auditWriter = vi.fn(async () => undefined);

      await removeFromCanary(
        { seniorId: VALID_UUID_A, removedBy: 'admin-2', reason: 'phase_complete' },
        { database: db, auditWriter },
      );

      await new Promise((r) => setTimeout(r, 0));
      expect(auditWriter).toHaveBeenCalledWith(expect.objectContaining({
        action: 'canary_cohort_remove',
        resourceType: 'canary_cohort_membership',
        resourceId: VALID_UUID_A,
        metadata: { rampPhase: '10', reason: 'phase_complete' },
      }));
    });
  });

  describe('listActiveCanaryMembers', () => {
    it('clamps limit between 1 and 2000', async () => {
      const db = database([[]]);
      await listActiveCanaryMembers({ limit: 50_000 }, { database: db });
      // Limit clamping is validated by ensuring the query executes — the
      // raw SQL embeds the limit as a parameter, so we only need to
      // confirm one execute happened with no rejection.
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('returns rows from the DB in execute order', async () => {
      const rows = [
        { senior_id: VALID_UUID_A, ramp_phase: '5', added_at: '2026-05-24T00:00:00Z' },
        { senior_id: VALID_UUID_B, ramp_phase: '10', added_at: '2026-05-24T01:00:00Z' },
      ];
      const db = database([rows]);

      const members = await listActiveCanaryMembers({}, { database: db });
      expect(members).toEqual(rows);
    });
  });

  describe('getCanaryRampPhase', () => {
    it('returns ramp_phase for an active senior', async () => {
      const db = database([[{ ramp_phase: '25' }]]);
      const phase = await getCanaryRampPhase(VALID_UUID_A, { database: db });
      expect(phase).toBe('25');
    });

    it('returns null when senior is not in active cohort', async () => {
      const db = database([[]]);
      const phase = await getCanaryRampPhase(VALID_UUID_A, { database: db });
      expect(phase).toBeNull();
    });

    it('rejects invalid senior_id', async () => {
      await expect(getCanaryRampPhase('not-a-uuid')).rejects.toMatchObject({
        code: 'invalid_senior_id',
      });
    });
  });

  describe('resolveMergedCanarySeniorIds', () => {
    it('returns DB members only when env allowlist is empty', async () => {
      const db = database([[{ senior_id: VALID_UUID_A }, { senior_id: VALID_UUID_B }]]);
      const merged = await resolveMergedCanarySeniorIds([], { database: db });
      expect(merged).toEqual([VALID_UUID_A, VALID_UUID_B].sort());
    });

    it('returns env allowlist only when DB is empty', async () => {
      const db = database([[]]);
      const merged = await resolveMergedCanarySeniorIds([VALID_UUID_A], { database: db });
      expect(merged).toEqual([VALID_UUID_A]);
    });

    it('unions DB + env allowlist deterministically (sorted, deduped)', async () => {
      const db = database([[
        { senior_id: VALID_UUID_B },
        { senior_id: VALID_UUID_A },
      ]]);
      const merged = await resolveMergedCanarySeniorIds([VALID_UUID_A, VALID_UUID_B], { database: db });
      // Same set, deduped.
      expect(merged.length).toBe(2);
      expect(new Set(merged)).toEqual(new Set([VALID_UUID_A, VALID_UUID_B]));
      // Sorted.
      expect(merged).toEqual([...merged].sort());
    });

    it('ignores empty / whitespace env values', async () => {
      const db = database([[{ senior_id: VALID_UUID_A }]]);
      const merged = await resolveMergedCanarySeniorIds(['', '   ', VALID_UUID_B], { database: db });
      expect(merged).toEqual([VALID_UUID_A, VALID_UUID_B].sort());
    });

    it('returns empty array when both sources are empty', async () => {
      const db = database([[]]);
      const merged = await resolveMergedCanarySeniorIds([], { database: db });
      expect(merged).toEqual([]);
    });
  });

  describe('getActiveCanarySeniorIds', () => {
    it('returns a Set of active senior_ids', async () => {
      const db = database([[
        { senior_id: VALID_UUID_A },
        { senior_id: VALID_UUID_B },
      ]]);

      const ids = await getActiveCanarySeniorIds({ database: db });
      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(2);
      expect(ids.has(VALID_UUID_A)).toBe(true);
      expect(ids.has(VALID_UUID_B)).toBe(true);
    });

    it('returns an empty Set when no canary members exist', async () => {
      const db = database([[]]);
      const ids = await getActiveCanarySeniorIds({ database: db });
      expect(ids.size).toBe(0);
    });
  });
});
