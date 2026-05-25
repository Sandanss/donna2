/**
 * Category G: edge cases for the scale-2000 backfill.
 *
 * These tests cover DST + timezone arithmetic, cohort bucket parity, dedupe
 * key locality, audit-on-failure, and orphaned schedule cleanup. They are
 * unit tests with mocked db/audit — no real Postgres.
 *
 * Production code is NOT modified by this file. Tests that document a
 * missing safeguard (resolveAffinityTtlSeconds clamping) are marked
 * `it.fails` so they surface as expected-fail and don't block CI.
 */

import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  writeAudit: vi.fn(async () => undefined),
  encrypt: vi.fn((value) => `enc:test:${value}`),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: mocks.execute,
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  },
}));

vi.mock('../../lib/encryption.js', () => ({
  encrypt: mocks.encrypt,
}));

vi.mock('../../services/audit.js', () => ({
  writeAudit: mocks.writeAudit,
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
  buildCallDedupeKey,
  canaryBucketForSeniorId,
  isSeniorInQueueCanaryCohort,
  materializeLegacyCallPlan,
  recordSchedulerShadowComparison,
} = await import('../../services/call-queue.js');

const {
  computeNextScheduleRunAt,
  syncSeniorCallSchedulesFromPreferredCallTimes,
} = await import('../../services/call-schedules.js');

const {
  resolveAffinityTtlSeconds,
} = await import('../../services/dispatcher-affinity.js');

function mockDatabase(results) {
  const execute = vi.fn();
  for (const result of results) {
    execute.mockResolvedValueOnce({ rows: result });
  }
  return { execute };
}

/**
 * Render a drizzle-orm SQL object into a flat string for substring/regex
 * matching. Drizzle splits the template into StringChunk objects interleaved
 * with parameter values; we only need the static fragments for assertions.
 */
function renderSql(sqlObj) {
  if (!sqlObj || !Array.isArray(sqlObj.queryChunks)) return String(sqlObj || '');
  return sqlObj.queryChunks
    .map(chunk => {
      if (chunk && Array.isArray(chunk.value)) return chunk.value.join('');
      return '';
    })
    .join(' ');
}

beforeEach(() => {
  mocks.execute.mockReset();
  mocks.writeAudit.mockReset();
  mocks.writeAudit.mockResolvedValue(undefined);
  delete process.env.DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS;
});

// ---------------------------------------------------------------------------
// 8. Materializer: senior tz change mid-day does NOT rewrite target_at
// ---------------------------------------------------------------------------

describe('materializer idempotency under senior tz change', () => {
  it('does NOT rewrite target_at on already-materialized queue rows', async () => {
    // The materializer enqueues via INSERT ... ON CONFLICT (dedupe_key) DO NOTHING.
    // A second run for the SAME schedule_id + localDate (even with a different
    // senior timezone) must produce the same dedupe_key and reuse the existing
    // row — target_at on disk is never updated.

    const scheduleId = 'schedule-tz-mid-day';
    const seniorId = 'senior-tz-mid-day';
    const targetAt = new Date('2035-03-11T13:30:00.000Z');

    // First materialization — senior is in America/New_York at the moment.
    const firstKey = buildCallDedupeKey({
      callType: 'schedule',
      seniorId,
      scheduleId,
      targetAt,
      localDate: '2035-03-11', // resolved against NY mid-day
    });

    // Mid-day the senior's tz flips to America/Los_Angeles. The materializer
    // recomputes localDate against the new tz, but the LOCAL date is still
    // 2035-03-11 (06:30 LA) — the dedupe key must remain stable.
    const secondKey = buildCallDedupeKey({
      callType: 'schedule',
      seniorId,
      scheduleId,
      targetAt,
      localDate: '2035-03-11',
    });

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toBe('schedule:senior-tz-mid-day:2035-03-11:schedule-tz-mid-day');

    // Simulate the materializer hitting the existing row on retry.
    // INSERT returns no rows (ON CONFLICT DO NOTHING); SELECT returns the
    // pre-existing queue row whose target_at must NOT have moved.
    const existingRow = {
      id: 'queue-1',
      senior_id: seniorId,
      schedule_id: scheduleId,
      dedupe_key: firstKey,
      target_at: targetAt,
    };

    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // INSERT, no rows back
        .mockResolvedValueOnce({ rows: [existingRow] }), // SELECT existing
    };

    const { enqueueCall } = await import('../../services/call-queue.js');
    const result = await enqueueCall({
      seniorId,
      scheduleId,
      callType: 'schedule',
      priorityLane: 'scheduled_checkin',
      priorityScore: 0,
      targetAt,
      dedupeKey: firstKey,
    }, { database });

    expect(result.inserted).toBe(false);
    expect(result.row.target_at).toEqual(targetAt);

    // Critically: only one INSERT statement was issued; there is no UPDATE
    // path on the materialization side that could touch target_at.
    const insertSql = renderSql(database.execute.mock.calls[0][0]);
    expect(insertSql).toMatch(/INSERT INTO call_queue/i);
    expect(insertSql).not.toMatch(/UPDATE\s+call_queue/i);
  });
});

// ---------------------------------------------------------------------------
// 9. Materializer: fall-back DST one-time schedule fires once
// ---------------------------------------------------------------------------

describe('materializer DST fall-back behavior', () => {
  it('fires a one-time 1:30 AM schedule exactly once on the fall-back day', () => {
    // America/New_York fall-back 2035: 02:00 EDT → 01:00 EST.
    // The local hour 01:30 occurs TWICE in wall-clock time, but a one-time
    // schedule must fire exactly once at the first occurrence.
    const schedule = {
      frequency: 'one-time',
      date: '2035-11-04',
      time: '1:30 AM',
      timezone: 'America/New_York',
    };

    // Before the schedule should fire.
    const firstRun = computeNextScheduleRunAt(
      schedule,
      new Date('2035-11-04T00:00:00.000Z'),
    );
    expect(firstRun).not.toBeNull();
    expect(firstRun.toISOString()).toBe('2035-11-04T05:30:00.000Z');

    // After the first occurrence has elapsed (a few minutes past 1:30 AM EDT),
    // the one-time schedule must NOT re-fire at the duplicated 1:30 AM EST hour.
    const secondRun = computeNextScheduleRunAt(
      schedule,
      new Date(firstRun.getTime() + 60 * 1000),
    );
    expect(secondRun).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. Materializer: Pacific/Honolulu (no DST) and PST→PDT crossings
// ---------------------------------------------------------------------------

describe('computeNextScheduleRunAt across timezone crossings', () => {
  it('treats Pacific/Honolulu as a fixed UTC-10 offset year-round', () => {
    // Honolulu does NOT observe DST. 9:30 AM HST = 19:30 UTC, always.
    const summer = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'Pacific/Honolulu',
    }, new Date('2035-07-15T12:00:00.000Z'));
    expect(summer.toISOString()).toBe('2035-07-15T19:30:00.000Z');

    const winter = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'Pacific/Honolulu',
    }, new Date('2035-01-15T12:00:00.000Z'));
    expect(winter.toISOString()).toBe('2035-01-15T19:30:00.000Z');
  });

  it('shifts the UTC anchor as America/Los_Angeles crosses PST → PDT', () => {
    // PST is UTC-8; PDT is UTC-7. Spring-forward 2035 is Mar 11.
    const beforeSpringForward = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'America/Los_Angeles',
    }, new Date('2035-03-10T12:00:00.000Z'));
    expect(beforeSpringForward.toISOString()).toBe('2035-03-10T17:30:00.000Z');

    const afterSpringForward = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'America/Los_Angeles',
    }, new Date('2035-03-12T12:00:00.000Z'));
    expect(afterSpringForward.toISOString()).toBe('2035-03-12T16:30:00.000Z');
  });

  it('shifts the UTC anchor as America/Los_Angeles crosses PDT → PST', () => {
    // Fall-back 2035 is Nov 4. PDT (-7) before, PST (-8) after.
    const beforeFallBack = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'America/Los_Angeles',
    }, new Date('2035-11-03T12:00:00.000Z'));
    expect(beforeFallBack.toISOString()).toBe('2035-11-03T16:30:00.000Z');

    const afterFallBack = computeNextScheduleRunAt({
      frequency: 'daily',
      time: '9:30 AM',
      timezone: 'America/Los_Angeles',
    }, new Date('2035-11-05T12:00:00.000Z'));
    expect(afterFallBack.toISOString()).toBe('2035-11-05T17:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// 11. canaryCohortFilterSql buckets agree with isSeniorInQueueCanaryCohort
// ---------------------------------------------------------------------------

describe('canary bucket math: SQL and JS predicate parity', () => {
  // Reimplement the bucket formula from canaryCohortFilterSql in JS, then
  // verify it agrees with canaryBucketForSeniorId for the same input.
  //
  // SQL fragment (from services/call-queue.js):
  //   (('x' || substr(md5(senior_id::text), 1, 4))::bit(16)::int) % 100
  //   < canaryPercent
  function bucketFromSqlFormula(seniorId) {
    const digest = createHash('md5').update(seniorId).digest('hex');
    // bit(16)::int yields 0..65535 (zero-padded, always non-negative).
    return Number.parseInt(digest.slice(0, 4), 16) % 100;
  }

  it('SQL bucket math matches canaryBucketForSeniorId for 100 random UUIDs', () => {
    // Deterministic UUIDs: a mix of typical Postgres UUIDs.
    const seniorIds = [];
    for (let i = 0; i < 100; i += 1) {
      const hex = createHash('sha256').update(`senior-${i}`).digest('hex');
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      seniorIds.push(uuid);
    }

    for (const id of seniorIds) {
      const sqlBucket = bucketFromSqlFormula(id);
      const jsBucket = canaryBucketForSeniorId(id);
      expect(sqlBucket, `mismatch for ${id}`).toBe(jsBucket);
    }
  });

  it('JS predicate isSeniorInQueueCanaryCohort agrees with the SQL bucket for various canaryPercent', () => {
    const seniorIds = [];
    for (let i = 0; i < 100; i += 1) {
      const hex = createHash('sha256').update(`predicate-${i}`).digest('hex');
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      seniorIds.push(uuid);
    }

    for (const canaryPercent of [0, 1, 17, 50, 83, 99, 100]) {
      for (const id of seniorIds) {
        const sqlSaysIn = bucketFromSqlFormula(id) < canaryPercent || canaryPercent >= 100;
        const jsSaysIn = isSeniorInQueueCanaryCohort(id, { canaryPercent });
        expect(jsSaysIn, `mismatch ${id} @ ${canaryPercent}%`).toBe(sqlSaysIn);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 12. materializeLegacyCallPlan writes shadow_decision audit row on failure
// ---------------------------------------------------------------------------

describe('shadow materialization audit-on-failure', () => {
  it('records a shadow_decision audit row with queueDecision=failed', async () => {
    // A spec that lacks senior.id will throw in buildQueueInputFromLegacyCallSpec
    // (requireString('seniorId')). The materializer must still record a
    // shadow_decision audit for the failure path.
    const failingSpec = {
      type: 'schedule',
      // no senior + no seniorId → enqueue path throws → failed branch
      scheduleItem: { id: 'sched-failed-1' },
      dedupKey: 'legacy:failed:1',
    };

    // For the failed branch, recordSchedulerShadowComparison is called once.
    // It in turn calls database.execute (for the INSERT) and writeAudit.
    const database = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 'shadow-1' }] }),
    };

    const result = await materializeLegacyCallPlan([failingSpec], {
      database,
      now: new Date('2035-03-11T13:00:00.000Z'),
      architecture: 'legacy_shadow',
      recordComparisons: true,
      testRunId: 'phase4-failed',
      capacityDecision: 'allowed',
    });

    // The plan recorded one failure.
    expect(result.planned).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.comparisonInserted).toBe(1);

    // The audit writer (writeAudit) was invoked with action='shadow_decision'.
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    const auditPayload = mocks.writeAudit.mock.calls[0][0];
    expect(auditPayload.action).toBe('shadow_decision');
    expect(auditPayload.resourceType).toBe('senior');
    // The shadow comparison row's queue_decision must mark the failure.
    expect(auditPayload.metadata.queueDecision).toBe('failed');
  });

  it('writes shadow_decision audit with queueDecision=failed via recordSchedulerShadowComparison directly', async () => {
    // Defense-in-depth: verify the audit writer receives queueDecision='failed'
    // when recordSchedulerShadowComparison is called directly with a failure.
    const database = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 'shadow-2' }] }),
    };

    await recordSchedulerShadowComparison({
      testRunId: 'phase4-direct',
      seniorId: 'senior-failed',
      callType: 'schedule',
      priorityLane: 'scheduled_checkin',
      legacyDedupKey: 'legacy:direct:1',
      legacyDecision: 'planned',
      queueDecision: 'failed',
      skipReason: 'unknown',
      capacityDecision: 'allowed',
    }, { database });

    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit.mock.calls[0][0].metadata.queueDecision).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 13. syncSeniorCallSchedulesFromPreferredCallTimes removes orphaned schedule rows
// ---------------------------------------------------------------------------

describe('syncSeniorCallSchedulesFromPreferredCallTimes orphan cleanup', () => {
  it('deactivates all existing rows and only re-activates schedules still in preferredCallTimes', async () => {
    // The sync function issues an UPDATE that sets is_active=false on ALL
    // existing rows for the senior, then upserts (with is_active=true) the
    // currently-preferred schedules. Orphans stay is_active=false.
    const database = mockDatabase([
      [],
      [],
    ]);

    const senior = {
      id: 'senior-orphan',
      timezone: 'America/New_York',
      preferredCallTimes: {
        schedule: [
          { id: 'schedule-keep', frequency: 'daily', time: '9:30 AM' },
          // schedule-removed is intentionally absent → should remain is_active=false
        ],
      },
    };

    const result = await syncSeniorCallSchedulesFromPreferredCallTimes(senior, {
      database,
      now: new Date('2035-03-11T12:00:00.000Z'),
    });

    expect(result).toEqual({
      seniorId: 'senior-orphan',
      total: 1,
      upserted: 1,
    });

    // First execute: bulk deactivation. Second: upsert for the kept schedule.
    expect(database.execute).toHaveBeenCalledTimes(2);

    const deactivateSql = renderSql(database.execute.mock.calls[0][0]);
    expect(deactivateSql).toMatch(/UPDATE\s+senior_call_schedules/i);
    expect(deactivateSql).toMatch(/is_active\s*=\s*false/i);

    const upsertSql = renderSql(database.execute.mock.calls[1][0]);
    expect(upsertSql).toMatch(/INSERT INTO senior_call_schedules/i);
    expect(upsertSql).toMatch(/ON CONFLICT/i);
    expect(upsertSql).toMatch(/is_active\s*=\s*true/i);
  });
});

// ---------------------------------------------------------------------------
// 14. buildCallDedupeKey uses senior-local date across UTC day boundary
// ---------------------------------------------------------------------------

describe('buildCallDedupeKey honors senior-local date', () => {
  it('uses Honolulu-local 2035-11-03 when targetAt is 2035-11-04 UTC', async () => {
    // Pacific/Honolulu is UTC-10 with no DST. A call scheduled at 05:30 UTC
    // on 2035-11-04 is 19:30 HST on 2035-11-03. The dedupe key must reflect
    // the SENIOR's local date, not UTC.
    const { getLocalDateKey } = await import('../../services/call-queue.js');

    const targetAt = new Date('2035-11-04T05:30:00.000Z');
    const localDate = getLocalDateKey(targetAt, 'Pacific/Honolulu');
    expect(localDate).toBe('2035-11-03');

    const key = buildCallDedupeKey({
      callType: 'schedule',
      seniorId: 'senior-honolulu',
      scheduleId: 'schedule-honolulu-evening',
      targetAt,
      localDate,
    });

    expect(key).toBe('schedule:senior-honolulu:2035-11-03:schedule-honolulu-evening');
    // It must NOT use the UTC date.
    expect(key).not.toContain('2035-11-04');
  });

  it('welfare dedupe key also uses senior-local date', async () => {
    const { getLocalDateKey } = await import('../../services/call-queue.js');

    const targetAt = new Date('2035-11-04T05:30:00.000Z');
    const localDate = getLocalDateKey(targetAt, 'Pacific/Honolulu');

    const key = buildCallDedupeKey({
      callType: 'welfare',
      seniorId: 'senior-honolulu',
      targetAt,
      localDate,
    });

    expect(key).toBe('welfare:senior-honolulu:2035-11-03');
  });
});

// ---------------------------------------------------------------------------
// 15. resolveAffinityTtlSeconds env clamping
// ---------------------------------------------------------------------------

describe('resolveAffinityTtlSeconds env clamping', () => {
  // Anthropic's prompt-cache TTL is 5 minutes, so any affinity TTL > 300 is
  // operationally meaningless. Production now clamps via Math.min so a
  // misconfig can't silently route to a stale replica past the cache window.
  // Flipped from xfail to passing in Phase 4 cleanup.
  it('clamps DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS=900 down to 300', () => {
    process.env.DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS = '900';
    const ttl = resolveAffinityTtlSeconds(process.env);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('keeps env values at or below 300 unchanged', () => {
    process.env.DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS = '120';
    expect(resolveAffinityTtlSeconds(process.env)).toBe(120);
  });

  it('default (no env) returns the 5-minute prompt-cache window', () => {
    delete process.env.DISPATCHER_PROMPT_CACHE_AFFINITY_TTL_SECONDS;
    expect(resolveAffinityTtlSeconds(process.env)).toBe(300);
  });
});
