/**
 * Category B (PHI shape) test — Phase 0 scaling baseline collector.
 *
 * The audit found `scripts/collect-phase0-scaling-baseline.js` self-declares
 * `phiPolicy.outputContainsRawPhi: false`, but existing tests only assert
 * the literal claim, not whether the SQL actually only selects aggregate
 * columns, nor whether the output structure could carry PHI-shaped fields.
 *
 * The collector's `rowsFrom()` forwards every key the DB returns verbatim,
 * so PHI safety is a function of (a) the SQL only selecting aggregate
 * columns and (b) the surrounding scaffolding not embedding PHI keys.
 *
 * This test therefore does two things:
 *   1. Captures every SQL string the script issues, parses out the literal
 *      query text from drizzle's `queryChunks`, and asserts none reference
 *      PHI-shaped column names like `name`, `phone`, `transcript`, etc.
 *   2. Feeds realistic aggregate-only rows into the script, then traverses
 *      the full baseline output structurally to assert no PHI-shaped keys
 *      or values escape via the scaffolding.
 *
 * Plus a sanity test that proves the traversal helper isn't vacuous.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PHI_KEY_REGEX,
  PHI_SENTINELS,
  assertNoPhiShape,
} from '../integration-harness/phi-shape.js';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: mocks.execute,
  },
}));

const { collectBaseline } = await import('../../scripts/collect-phase0-scaling-baseline.js');

function existsRow(value) {
  return { rows: [{ exists: value }] };
}

// Realistic aggregate-only rows for each metric in the script. Numbers,
// labels, and category strings only — what the SELECTed columns produce.
const AGGREGATE_SENIOR_COUNT = { total_seniors: 1500, active_seniors: 1450, inactive_seniors: 50 };
const AGGREGATE_DURATION = {
  completed_calls: 100,
  avg_seconds: '90.00',
  p50_seconds: '60.00',
  p95_seconds: '180.00',
  max_seconds: 600,
};
const AGGREGATE_ANSWER_RATE = [
  { local_window: 'morning', attempted_calls: 100, answered_calls: 70, answer_rate_pct: '70.00' },
  { local_window: 'afternoon', attempted_calls: 80, answered_calls: 60, answer_rate_pct: '75.00' },
];
const AGGREGATE_PEAK = { estimated_peak_active_calls: 12 };
const AGGREGATE_COVERAGE = {
  conversations_in_window: 100,
  conversations_with_call_metrics: 95,
  conversations_with_cache_metric_hint: 80,
  conversations_with_token_metric_hint: 85,
};
const AGGREGATE_ATTEMPTS = [
  { provider: 'telnyx', status: 'completed', attempts: 100, provider_errors: 2 },
];
const AGGREGATE_QUEUE = [
  { priority_lane: 'scheduled_checkin', status: 'queued', rows: 5, oldest_age_seconds: 30 },
];
const AGGREGATE_JOBS = [
  { job_type: 'analysis', status: 'completed', rows: 50, oldest_age_seconds: 120 },
];

// Extract the literal SQL chunks (no params) from a drizzle sql tagged template.
function literalSqlOf(query) {
  if (!query || !Array.isArray(query.queryChunks)) return '';
  return query.queryChunks
    .map((chunk) => {
      if (chunk && typeof chunk === 'object' && Array.isArray(chunk.value)) {
        return chunk.value.join(' ');
      }
      // Nested SQL (e.g. embedded sql.identifier or another tagged template)
      if (chunk && typeof chunk === 'object' && Array.isArray(chunk.queryChunks)) {
        return literalSqlOf(chunk);
      }
      return '';
    })
    .join(' ');
}

// PHI-shaped column names that should never appear in an aggregate baseline
// query. These are stricter than the broad PHI_KEY_REGEX because we're
// matching against real SQL identifiers, not output keys.
const FORBIDDEN_PHI_COLUMN_REGEX =
  /\b(name|phone|transcript|reminder_title|reminder_description|caregiver_note|profile_notes|content|prompt|summary_text)\b/i;

beforeEach(() => {
  mocks.execute.mockReset();
});

describe('collect-phase0-scaling-baseline PHI shape', () => {
  it('issues only aggregate SQL — no SELECT names, phones, transcripts, reminder text, notes, or content', async () => {
    // Stub all SQL calls in order: 4 availability probes, then 8 metric
    // queries (5 always-on + 3 optional, since we say tables exist).
    mocks.execute
      .mockResolvedValueOnce(existsRow(true))   // tableExists('call_attempts')
      .mockResolvedValueOnce(existsRow(true))   // tableExists('call_queue')
      .mockResolvedValueOnce(existsRow(true))   // tableExists('post_call_jobs')
      .mockResolvedValueOnce(existsRow(true))   // columnExists('conversations', 'direction')
      .mockResolvedValueOnce({ rows: [AGGREGATE_SENIOR_COUNT] })
      .mockResolvedValueOnce({ rows: [AGGREGATE_DURATION] })
      .mockResolvedValueOnce({ rows: AGGREGATE_ANSWER_RATE })
      .mockResolvedValueOnce({ rows: [AGGREGATE_PEAK] })
      .mockResolvedValueOnce({ rows: [AGGREGATE_COVERAGE] })
      .mockResolvedValueOnce({ rows: AGGREGATE_ATTEMPTS })
      .mockResolvedValueOnce({ rows: AGGREGATE_QUEUE })
      .mockResolvedValueOnce({ rows: AGGREGATE_JOBS });

    const baseline = await collectBaseline({ days: 30 });

    // Every issued SQL captured by the mock — strip the availability probes
    // (those legitimately query `information_schema.columns.column_name` and
    // would otherwise self-match the broad regex).
    const allQueries = mocks.execute.mock.calls.map(([query]) => literalSqlOf(query));
    // First 4 calls are the existence probes — skip them.
    const metricQueries = allQueries.slice(4);
    expect(metricQueries.length).toBeGreaterThanOrEqual(5);

    for (const queryText of metricQueries) {
      if (FORBIDDEN_PHI_COLUMN_REGEX.test(queryText)) {
        throw new Error(
          `baseline metric SQL selects a PHI-shaped column: \n${queryText.slice(0, 400)}`,
        );
      }
    }

    // And the output has no PHI fields/values escaping via scaffolding.
    // Allowlist keys that are aggregate labels / structural metadata, so
    // the helper doesn't false-flag e.g. `metric.name = "active_senior_counts"`.
    const allowedKeys = new Set([
      'name',                       // metric.name and phiPolicy field
      'notes',                      // phiPolicy.notes — literal docstring
      'phiPolicy',
      'instrumentationGaps',
    ]);
    assertNoPhiShape(baseline, { allowedKeys });
    expect(baseline.phiPolicy.outputContainsRawPhi).toBe(false);
  });

  it('also passes the shape check when optional tables are unavailable', async () => {
    mocks.execute
      .mockResolvedValueOnce(existsRow(false))
      .mockResolvedValueOnce(existsRow(false))
      .mockResolvedValueOnce(existsRow(false))
      .mockResolvedValueOnce(existsRow(false))
      .mockResolvedValueOnce({ rows: [AGGREGATE_SENIOR_COUNT] })
      .mockResolvedValueOnce({ rows: [AGGREGATE_DURATION] })
      .mockResolvedValueOnce({ rows: AGGREGATE_ANSWER_RATE })
      .mockResolvedValueOnce({ rows: [AGGREGATE_PEAK] })
      .mockResolvedValueOnce({ rows: [AGGREGATE_COVERAGE] });

    const baseline = await collectBaseline({ days: 7 });

    expect(baseline.optionalTables.callAttemptsAvailable).toBe(false);
    expect(baseline.optionalColumns.conversationDirectionAvailable).toBe(false);

    const allowedKeys = new Set(['name', 'notes', 'phiPolicy', 'instrumentationGaps']);
    assertNoPhiShape(baseline, { allowedKeys });
  });

  it('catches a regression that forwards raw row fields with PHI-shaped names', () => {
    // The collector forwards `rowsFrom(result)` verbatim — so a regression
    // that selected `name` or `phone` would surface here. Prove the
    // traversal isn't vacuous by feeding a hand-built baseline shaped as
    // the script would emit it if the SQL changed under us.
    const polluted = {
      generatedAt: '2026-05-23T00:00:00Z',
      phiPolicy: { outputContainsRawPhi: false, notes: 'aggregate only' },
      metrics: [
        {
          name: 'active_senior_counts',
          ok: true,
          rows: [{ name: PHI_SENTINELS.name, phone: PHI_SENTINELS.phone }],
        },
      ],
      instrumentationGaps: [],
    };

    expect(() => assertNoPhiShape(polluted, {
      allowedKeys: new Set(['name', 'notes', 'phiPolicy', 'instrumentationGaps']),
    })).toThrow(/PHI/);

    // And the broad-column regex catches it standalone:
    expect(FORBIDDEN_PHI_COLUMN_REGEX.test('SELECT name, phone FROM seniors')).toBe(true);
    expect(PHI_KEY_REGEX.test('phone')).toBe(true);
  });
});
