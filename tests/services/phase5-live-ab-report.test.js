import { describe, expect, it, vi } from 'vitest';

const {
  buildPhase5LiveAbReport,
  evaluatePhase5Report,
} = await import('../../scripts/phase5-live-ab-report.js');

function result(rows) {
  return { rows };
}

describe('phase 5 live A/B report', () => {
  it('passes when aggregate drill metrics meet gates without exposing raw PHI identifiers', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([{
          totalAttempts: 260,
          answeredAttempts: 210,
          mediaStartedAttempts: 205,
          endedAttempts: 205,
          failedAttempts: 5,
        }]))
        .mockResolvedValueOnce(result([
          { architecture: 'legacy', cohort: 'control', attempts: 100, answered: 80, mediaStarted: 78 },
          { architecture: 'queue', cohort: 'canary_queue', attempts: 160, answered: 130, mediaStarted: 127 },
        ]))
        .mockResolvedValueOnce(result([{ duplicateQueueAttemptKeys: 0, duplicateQueueAttemptRows: 0 }]))
        .mockResolvedValueOnce(result([{ duplicateCallControlKeys: 0, duplicateCallControlRows: 0 }]))
        .mockResolvedValueOnce(result([{ conversations: 205, completedConversations: 205, duplicateConversationRows: 0 }]))
        .mockResolvedValueOnce(result([{ reminderDeliveries: 20, duplicateReminderDeliveryRows: 0 }]))
        .mockResolvedValueOnce(result([{ activeQueueRows: 0 }]))
        .mockResolvedValueOnce(result([{ activeAttempts: 0 }]))
        .mockResolvedValueOnce(result([{ driftingSeniors: 0, seniorsObserved: 260 }])),
    };

    const report = await buildPhase5LiveAbReport({
      database,
      testRunId: 'phase5-run-001',
      answerRateBaseline: 0.7,
      rollbackStartedAt: '2035-03-11T14:00:00.000Z',
      rollbackCompletedAt: '2035-03-11T14:02:30.000Z',
      rollbackTargetSeconds: 300,
      now: new Date('2035-03-11T14:03:00.000Z'),
    });

    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      attempts: 260,
      answerRate: 0.8077,
      mediaStartRate: 0.9762,
      failedChecks: 0,
    });
    expect(report.metrics.rollback.elapsedSeconds).toBe(150);
    expect(report.metrics.cohortDrift.driftingSeniors).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/111-222|Jane|Dad's medication|PHI_SENTINEL/i);
    expect(database.execute).toHaveBeenCalledTimes(9);
  });

  it('fails duplicate and media gates from aggregate counters', () => {
    const evaluated = evaluatePhase5Report({
      attemptSummary: {
        totalAttempts: 10,
        answeredAttempts: 5,
        mediaStartedAttempts: 4,
      },
      duplicateSummary: {
        duplicateQueueAttemptRows: 1,
        duplicateCallControlRows: 0,
      },
      conversationSummary: {
        duplicateConversationRows: 1,
      },
      reminderDeliverySummary: {
        duplicateReminderDeliveryRows: 0,
      },
      answerRateBaseline: 0.8,
      minAnswerCanaryAttempts: 10,
    });

    expect(evaluated.ok).toBe(false);
    expect(evaluated.checks.filter(check => check.status === 'failed').map(check => check.name)).toEqual([
      'duplicate_outbound_calls',
      'duplicate_conversations',
      'media_start_rate',
      'caller_id_answer_rate',
    ]);
  });

  it('cohortBreakdown rows expose only operational counters, never PHI fields', async () => {
    // Category G: ensure the cohort breakdown in the live A/B report contains
    // ONLY {architecture, cohort, attempts, answered, mediaStarted}. Any
    // additional field that leaks senior_id, phone, name, or transcript would
    // turn the report into a PHI surface.
    const cohortRows = [
      { architecture: 'legacy', cohort: 'control', attempts: 100, answered: 80, mediaStarted: 78 },
      { architecture: 'queue', cohort: 'canary_queue', attempts: 160, answered: 130, mediaStarted: 127 },
    ];

    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([{
          totalAttempts: 260,
          answeredAttempts: 210,
          mediaStartedAttempts: 205,
          endedAttempts: 205,
          failedAttempts: 5,
        }]))
        .mockResolvedValueOnce(result(cohortRows))
        .mockResolvedValueOnce(result([{ duplicateQueueAttemptKeys: 0, duplicateQueueAttemptRows: 0 }]))
        .mockResolvedValueOnce(result([{ duplicateCallControlKeys: 0, duplicateCallControlRows: 0 }]))
        .mockResolvedValueOnce(result([{ conversations: 205, completedConversations: 205, duplicateConversationRows: 0 }]))
        .mockResolvedValueOnce(result([{ reminderDeliveries: 0, duplicateReminderDeliveryRows: 0 }])),
    };

    const report = await buildPhase5LiveAbReport({
      database,
      testRunId: 'phase5-cohort-shape',
      now: new Date('2035-03-11T14:00:00.000Z'),
    });

    expect(Array.isArray(report.metrics.cohortBreakdown)).toBe(true);
    expect(report.metrics.cohortBreakdown).toHaveLength(2);

    const allowedKeys = new Set(['architecture', 'cohort', 'attempts', 'answered', 'mediaStarted']);
    for (const row of report.metrics.cohortBreakdown) {
      const rowKeys = Object.keys(row);
      for (const key of rowKeys) {
        expect(allowedKeys.has(key), `cohortBreakdown row has unexpected key ${key}`).toBe(true);
      }
      // Explicit negative assertions for the high-value PHI signals.
      expect(row).not.toHaveProperty('seniorId');
      expect(row).not.toHaveProperty('senior_id');
      expect(row).not.toHaveProperty('phone');
      expect(row).not.toHaveProperty('phone_number');
      expect(row).not.toHaveProperty('name');
    }
  });

  // ----------------------------------------------------------------------
  // Test 17: cohort-drift detection
  //
  // The report fails when a senior_id appears in both architecture cohorts
  // within the same test_run_id — a senior dual-classified into both
  // `legacy` and `queue` cohorts corrupts the A/B counter math. Flipped
  // from xfail to passing in Phase 4 cleanup once the cohort_no_drift check
  // landed in evaluatePhase5Report.
  // ----------------------------------------------------------------------
  it('fails when a senior_id appears in both architecture cohorts within test_run_id', () => {
    // Drift fixture: 1 senior somehow counted in both cohorts.
    const evaluated = evaluatePhase5Report({
      attemptSummary: {
        totalAttempts: 4,
        answeredAttempts: 4,
        mediaStartedAttempts: 4,
      },
      duplicateSummary: {
        duplicateQueueAttemptRows: 0,
        duplicateCallControlRows: 0,
      },
      conversationSummary: { duplicateConversationRows: 0 },
      reminderDeliverySummary: { duplicateReminderDeliveryRows: 0 },
      cohortDriftSummary: {
        driftingSeniors: 1,
        seniorsObserved: 4,
      },
    });

    expect(evaluated.ok).toBe(false);
    const failedNames = evaluated.checks
      .filter(check => check.status === 'failed')
      .map(check => check.name);
    expect(failedNames).toContain('cohort_no_drift');
  });

  it('passes cohort_no_drift when every senior stays in a single (architecture, cohort) tuple', () => {
    const evaluated = evaluatePhase5Report({
      attemptSummary: {
        totalAttempts: 4,
        answeredAttempts: 4,
        mediaStartedAttempts: 4,
      },
      duplicateSummary: {
        duplicateQueueAttemptRows: 0,
        duplicateCallControlRows: 0,
      },
      conversationSummary: { duplicateConversationRows: 0 },
      reminderDeliverySummary: { duplicateReminderDeliveryRows: 0 },
      cohortDriftSummary: {
        driftingSeniors: 0,
        seniorsObserved: 4,
      },
    });

    const driftCheck = evaluated.checks.find(c => c.name === 'cohort_no_drift');
    expect(driftCheck?.status).toBe('passed');
  });

  it('marks rollback drain failed when queue-owned rows remain active', () => {
    const evaluated = evaluatePhase5Report({
      attemptSummary: {
        totalAttempts: 1,
        answeredAttempts: 1,
        mediaStartedAttempts: 1,
      },
      duplicateSummary: {
        duplicateQueueAttemptRows: 0,
        duplicateCallControlRows: 0,
      },
      conversationSummary: {
        duplicateConversationRows: 0,
      },
      reminderDeliverySummary: {
        duplicateReminderDeliveryRows: 0,
      },
      rollbackSummary: {
        activeQueueRows: 1,
        activeAttempts: 0,
        elapsedSeconds: 30,
        targetSeconds: 300,
      },
    });

    expect(evaluated.ok).toBe(false);
    expect(evaluated.checks.find(check => check.name === 'rollback_drain')).toMatchObject({
      status: 'failed',
      activeQueueRows: 1,
    });
  });

  it('fails rollback report when elapsed time exceeds the target SLO', () => {
    const evaluated = evaluatePhase5Report({
      attemptSummary: {
        totalAttempts: 1,
        answeredAttempts: 1,
        mediaStartedAttempts: 1,
      },
      duplicateSummary: {
        duplicateQueueAttemptRows: 0,
        duplicateCallControlRows: 0,
      },
      conversationSummary: {
        duplicateConversationRows: 0,
      },
      reminderDeliverySummary: {
        duplicateReminderDeliveryRows: 0,
      },
      rollbackSummary: {
        activeQueueRows: 0,
        activeAttempts: 0,
        elapsedSeconds: 301,
        targetSeconds: 300,
      },
    });

    expect(evaluated.ok).toBe(false);
    expect(evaluated.checks.find(check => check.name === 'rollback_within_target')).toMatchObject({
      status: 'failed',
      elapsedSeconds: 301,
      targetSeconds: 300,
    });
  });

  it('fails rollback report when timestamps are present but no target SLO is declared', () => {
    const evaluated = evaluatePhase5Report({
      attemptSummary: {
        totalAttempts: 1,
        answeredAttempts: 1,
        mediaStartedAttempts: 1,
      },
      duplicateSummary: {
        duplicateQueueAttemptRows: 0,
        duplicateCallControlRows: 0,
      },
      conversationSummary: {
        duplicateConversationRows: 0,
      },
      reminderDeliverySummary: {
        duplicateReminderDeliveryRows: 0,
      },
      rollbackSummary: {
        activeQueueRows: 0,
        activeAttempts: 0,
        elapsedSeconds: 30,
      },
    });

    expect(evaluated.ok).toBe(false);
    expect(evaluated.checks.find(check => check.name === 'rollback_within_target')).toMatchObject({
      status: 'failed',
      reason: 'no --rollback-target-seconds SLO declared',
      elapsedSeconds: 30,
    });
  });
});
