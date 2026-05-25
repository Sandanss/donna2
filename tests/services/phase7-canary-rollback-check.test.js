import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: { execute: vi.fn() } }));
vi.mock('../../services/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { summarizeRollbackCheck } = await import('../../scripts/phase7-canary-rollback-check.js');

describe('summarizeRollbackCheck', () => {
  it('reports ok=true with zero breaches for a clean report', () => {
    const report = {
      windowStart: '2026-05-23T18:00:00.000Z',
      windowEnd: '2026-05-24T18:00:00.000Z',
      canaryCohortSize: 5,
      canaryRampPhases: ['5'],
      evaluation: { ok: true, breaches: [] },
    };

    const summary = summarizeRollbackCheck(report);
    expect(summary.ok).toBe(true);
    expect(summary.breachCount).toBe(0);
    expect(summary.breaches).toEqual([]);
    expect(summary.canaryCohortSize).toBe(5);
    expect(summary.canaryRampPhases).toEqual(['5']);
  });

  it('reports ok=false and lists every breach when SLOs fail', () => {
    const breaches = [
      { name: 'treatment_setup_p95_ms', cohort: 'treatment', setupP95Ms: 2400, target: 1500 },
      { name: 'treatment_setup_success_rate', cohort: 'treatment', setupSuccessRate: 0.7, floor: 0.95 },
    ];
    const report = {
      windowStart: '2026-05-23T18:00:00.000Z',
      windowEnd: '2026-05-24T18:00:00.000Z',
      canaryCohortSize: 10,
      canaryRampPhases: ['10'],
      evaluation: { ok: false, breaches },
    };

    const summary = summarizeRollbackCheck(report);
    expect(summary.ok).toBe(false);
    expect(summary.breachCount).toBe(2);
    expect(summary.breaches).toEqual(breaches);
  });

  it('handles missing evaluation gracefully (treats as not-ok with 0 breaches)', () => {
    const summary = summarizeRollbackCheck({});
    expect(summary.ok).toBe(false);
    expect(summary.breachCount).toBe(0);
    expect(summary.breaches).toEqual([]);
  });

  it('output is JSON-serializable and PHI-free', () => {
    const report = {
      windowStart: '2026-05-23T18:00:00.000Z',
      windowEnd: '2026-05-24T18:00:00.000Z',
      canaryCohortSize: 5,
      canaryRampPhases: ['5'],
      evaluation: {
        ok: false,
        breaches: [{ name: 'treatment_setup_p95_ms', cohort: 'treatment', setupP95Ms: 2400 }],
      },
    };

    const summary = summarizeRollbackCheck(report);
    const serialized = JSON.stringify(summary);

    // PHI-shape guards: rollback summary must not contain per-turn data
    // or transcripts (the input report doesn't, but defense-in-depth).
    expect(serialized.toLowerCase()).not.toContain('transcript');
    expect(serialized.toLowerCase()).not.toContain('caller_text');
    expect(serialized.toLowerCase()).not.toContain('senior_name');
    expect(serialized.toLowerCase()).not.toContain('phone_number');
  });
});
