import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: { execute: vi.fn() } }));
vi.mock('../../services/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { buildCanaryDailyReport, evaluateCanaryReport } = await import(
  '../../scripts/phase7-canary-daily-report.js'
);

describe('evaluateCanaryReport', () => {
  it('passes when both cohorts hit every SLO and have no duplicates', () => {
    const cohorts = [
      { cohort: 'control', total_attempts: 1000, failed_attempts: 20, setup_p95_ms: 1200, answered_attempts: 800, media_started_attempts: 780 },
      { cohort: 'treatment', total_attempts: 50, failed_attempts: 1, setup_p95_ms: 1300, answered_attempts: 42, media_started_attempts: 41 },
    ];
    const duplicates = [
      { cohort: 'control', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
      { cohort: 'treatment', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
    ];
    const postCall = [
      { cohort: 'control', total_calls_with_critical_jobs: 800, calls_critical_complete: 790, critical_p95_seconds: 120 },
      { cohort: 'treatment', total_calls_with_critical_jobs: 42, calls_critical_complete: 41, critical_p95_seconds: 90 },
    ];

    const evaluation = evaluateCanaryReport({ cohorts, duplicates, postCall });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.failedCount).toBe(0);
    expect(evaluation.breaches).toEqual([]);
  });

  it('flags setup latency p95 breach in the treatment cohort', () => {
    const cohorts = [
      { cohort: 'control', total_attempts: 1000, failed_attempts: 20, setup_p95_ms: 1200 },
      { cohort: 'treatment', total_attempts: 50, failed_attempts: 1, setup_p95_ms: 2400 },
    ];
    const duplicates = [
      { cohort: 'control', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
      { cohort: 'treatment', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
    ];
    const postCall = [
      { cohort: 'control', total_calls_with_critical_jobs: 800, calls_critical_complete: 790 },
      { cohort: 'treatment', total_calls_with_critical_jobs: 42, calls_critical_complete: 41 },
    ];

    const evaluation = evaluateCanaryReport({ cohorts, duplicates, postCall });

    expect(evaluation.ok).toBe(false);
    const setupBreach = evaluation.breaches.find((b) => b.name === 'treatment_setup_p95_ms');
    expect(setupBreach).toBeDefined();
    expect(setupBreach.cohort).toBe('treatment');
    expect(setupBreach.target).toBe(1500);
    expect(setupBreach.setupP95Ms).toBe(2400);
  });

  it('flags setup_success_rate breach below the 0.95 floor', () => {
    const cohorts = [
      { cohort: 'control', total_attempts: 1000, failed_attempts: 20, setup_p95_ms: 1200 },
      // 50 attempts, 10 failed -> 0.8 success rate, below 0.95 floor.
      { cohort: 'treatment', total_attempts: 50, failed_attempts: 10, setup_p95_ms: 1300 },
    ];
    const duplicates = [
      { cohort: 'control', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
      { cohort: 'treatment', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
    ];
    const postCall = [
      { cohort: 'control', total_calls_with_critical_jobs: 0, calls_critical_complete: 0 },
      { cohort: 'treatment', total_calls_with_critical_jobs: 0, calls_critical_complete: 0 },
    ];

    const evaluation = evaluateCanaryReport({ cohorts, duplicates, postCall });

    expect(evaluation.ok).toBe(false);
    const successBreach = evaluation.breaches.find((b) => b.name === 'treatment_setup_success_rate');
    expect(successBreach).toBeDefined();
    expect(successBreach.setupSuccessRate).toBe(0.8);
    expect(successBreach.floor).toBe(0.95);
  });

  it('flags any duplicate outbound row in either cohort', () => {
    const cohorts = [
      { cohort: 'control', total_attempts: 1000, failed_attempts: 20, setup_p95_ms: 1200 },
      { cohort: 'treatment', total_attempts: 50, failed_attempts: 1, setup_p95_ms: 1300 },
    ];
    const duplicates = [
      { cohort: 'control', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
      { cohort: 'treatment', duplicate_queue_attempt_rows: 1, duplicate_call_control_rows: 0 },
    ];
    const postCall = [
      { cohort: 'control', total_calls_with_critical_jobs: 0, calls_critical_complete: 0 },
      { cohort: 'treatment', total_calls_with_critical_jobs: 0, calls_critical_complete: 0 },
    ];

    const evaluation = evaluateCanaryReport({ cohorts, duplicates, postCall });

    expect(evaluation.ok).toBe(false);
    const dupBreach = evaluation.breaches.find((b) => b.name === 'treatment_duplicate_outbound');
    expect(dupBreach).toBeDefined();
    expect(dupBreach.duplicateQueueAttemptRows).toBe(1);
  });

  it('flags post-call completion rate breach', () => {
    const cohorts = [
      { cohort: 'control', total_attempts: 1000, failed_attempts: 20, setup_p95_ms: 1200 },
      { cohort: 'treatment', total_attempts: 50, failed_attempts: 1, setup_p95_ms: 1300 },
    ];
    const duplicates = [
      { cohort: 'control', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
      { cohort: 'treatment', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
    ];
    const postCall = [
      { cohort: 'control', total_calls_with_critical_jobs: 800, calls_critical_complete: 790 },
      // 42 with critical jobs, 30 complete -> 0.714, below 0.95.
      { cohort: 'treatment', total_calls_with_critical_jobs: 42, calls_critical_complete: 30 },
    ];

    const evaluation = evaluateCanaryReport({ cohorts, duplicates, postCall });

    expect(evaluation.ok).toBe(false);
    const pcBreach = evaluation.breaches.find((b) => b.name === 'treatment_post_call_completion_rate');
    expect(pcBreach).toBeDefined();
    expect(pcBreach.floor).toBe(0.95);
  });

  it('skips checks when a cohort has no attempts in the window', () => {
    const cohorts = [
      { cohort: 'control', total_attempts: 1000, failed_attempts: 20, setup_p95_ms: 1200 },
      // Treatment empty (ramp not started).
    ];
    const duplicates = [
      { cohort: 'control', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
      { cohort: 'treatment', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
    ];
    const postCall = [
      { cohort: 'control', total_calls_with_critical_jobs: 800, calls_critical_complete: 790 },
    ];

    const evaluation = evaluateCanaryReport({ cohorts, duplicates, postCall });

    expect(evaluation.ok).toBe(true);
    const skipped = evaluation.checks.filter((c) => c.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((c) => c.cohort === 'treatment')).toBe(true);
  });

  it('threshold overrides relax SLO floors for a non-prod environment', () => {
    const cohorts = [
      { cohort: 'control', total_attempts: 1000, failed_attempts: 20, setup_p95_ms: 1200 },
      { cohort: 'treatment', total_attempts: 50, failed_attempts: 1, setup_p95_ms: 3000 },
    ];
    const duplicates = [
      { cohort: 'control', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
      { cohort: 'treatment', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
    ];
    const postCall = [
      { cohort: 'control', total_calls_with_critical_jobs: 800, calls_critical_complete: 790 },
      { cohort: 'treatment', total_calls_with_critical_jobs: 42, calls_critical_complete: 41 },
    ];

    const evaluation = evaluateCanaryReport({
      cohorts,
      duplicates,
      postCall,
      thresholds: { setupP95TargetMs: 5000 },
    });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.breaches.find((b) => b.name === 'treatment_setup_p95_ms')).toBeUndefined();
  });
});

describe('buildCanaryDailyReport', () => {
  it('queries 24h window, splits cohorts, and emits PHI-free output', async () => {
    const now = new Date('2026-05-24T18:00:00.000Z');
    const member = { senior_id: '11111111-1111-4111-8111-111111111111', ramp_phase: '5', added_at: '2026-05-24T00:00:00Z' };

    // Stub DB with: cohorts query, duplicates query, post-call query.
    const execute = vi.fn();
    execute.mockResolvedValueOnce({ rows: [
      { cohort: 'control', total_attempts: 100, failed_attempts: 2, setup_p95_ms: 1200, distinct_seniors: 80 },
      { cohort: 'treatment', total_attempts: 5, failed_attempts: 0, setup_p95_ms: 1100, distinct_seniors: 1 },
    ] });
    execute.mockResolvedValueOnce({ rows: [
      { cohort: 'control', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
      { cohort: 'treatment', duplicate_queue_attempt_rows: 0, duplicate_call_control_rows: 0 },
    ] });
    execute.mockResolvedValueOnce({ rows: [
      { cohort: 'control', total_calls_with_critical_jobs: 80, calls_critical_complete: 80 },
      { cohort: 'treatment', total_calls_with_critical_jobs: 4, calls_critical_complete: 4 },
    ] });

    const report = await buildCanaryDailyReport({
      windowHours: 24,
      now,
      database: { execute },
      members: [member],
    });

    expect(report.generatedAt).toBe(now.toISOString());
    expect(report.windowStart).toBe(new Date(now.getTime() - 24 * 3600 * 1000).toISOString());
    expect(report.windowEnd).toBe(now.toISOString());
    expect(report.canaryCohortSize).toBe(1);
    expect(report.canaryRampPhases).toEqual(['5']);
    expect(report.evaluation.ok).toBe(true);

    // PHI-shape check: serialized report must not contain transcript-shaped
    // keys or fields. (avg_turns / avg_response_latencies aren't in this
    // report's shape — this script returns counts + percentiles only.)
    const serialized = JSON.stringify(report);
    expect(serialized.toLowerCase()).not.toContain('transcript');
    expect(serialized.toLowerCase()).not.toContain('caller_text');
    expect(serialized.toLowerCase()).not.toContain('senior_name');
    expect(serialized.toLowerCase()).not.toContain('phone_number');
  });
});
