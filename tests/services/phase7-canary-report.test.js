import { describe, expect, it, vi } from 'vitest';

const {
  buildPhase7CanaryReport,
  evaluateDailyCanarySlo,
  evaluatePhase7Canary,
  parseArgs,
} = await import('../../scripts/phase7-canary-report.js');

function result(rows) {
  return { rows };
}

function passingPhase5Report(overrides = {}) {
  return {
    ok: true,
    summary: { attempts: 70, failedChecks: 0 },
    metrics: {},
    checks: [
      { name: 'duplicate_outbound_calls', status: 'passed' },
      { name: 'duplicate_conversations', status: 'passed' },
      { name: 'duplicate_reminder_deliveries', status: 'passed' },
      { name: 'media_start_rate', status: 'passed' },
      { name: 'caller_id_answer_rate', status: 'passed' },
      { name: 'rollback_within_target', status: 'passed', elapsedSeconds: 150, targetSeconds: 300 },
      { name: 'cohort_no_drift', status: 'passed' },
    ],
    ...overrides,
  };
}

function sevenPassingDays() {
  return Array.from({ length: 7 }, (_, index) => ({
    day: `2035-03-${String(11 + index).padStart(2, '0')}`,
    architecture: 'queue',
    cohort: 'canary_queue',
    attempts: 10,
    answered: 9,
    mediaStarted: 9,
  }));
}

describe('phase 7 canary report', () => {
  it('passes the seven-day treatment SLO streak from aggregate daily cohort rows', () => {
    const daily = evaluateDailyCanarySlo({
      dailyCohortRows: sevenPassingDays(),
      answerRateBaseline: 0.7,
      requiredContinuousDays: 7,
      minDailyCanaryAttempts: 1,
    });

    expect(daily).toMatchObject({
      passed: true,
      requiredContinuousDays: 7,
      longestPassingStreak: 7,
    });
    expect(daily.dailyTreatment).toHaveLength(7);
  });

  it('fails when the canary has an SLO gap inside the required continuous window', () => {
    const rows = sevenPassingDays();
    rows[3] = { ...rows[3], mediaStarted: 7 };

    const daily = evaluateDailyCanarySlo({
      dailyCohortRows: rows,
      answerRateBaseline: 0.7,
      requiredContinuousDays: 7,
      minDailyCanaryAttempts: 1,
    });

    expect(daily.passed).toBe(false);
    expect(daily.longestPassingStreak).toBe(3);
  });

  it('requires Phase 5 gates, canary size, PHI sentinel, incident, and rollback evidence to be clean', () => {
    const evaluation = evaluatePhase7Canary({
      phase5Report: passingPhase5Report({
        ok: false,
        checks: [{ name: 'rollback_within_target', status: 'skipped' }],
      }),
      canarySeniors: 26,
      dailyCohortRows: sevenPassingDays(),
      answerRateBaseline: 0.7,
      requiredContinuousDays: 7,
      minCanarySeniors: 5,
      maxCanarySeniors: 25,
      phiSentinelFindings: 1,
      p0p1Incidents: 1,
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.checks.filter(check => check.status === 'failed').map(check => check.name)).toEqual([
      'phase5_rollout_checks',
      'canary_allowlist_size',
      'phi_sentinel_clear',
      'no_p0_p1_incidents',
      'rollback_within_target',
    ]);
  });

  it('builds a PHI-free Phase 7 report while reusing Phase 5 aggregate gates', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([{
          totalAttempts: 70,
          answeredAttempts: 63,
          mediaStartedAttempts: 63,
          endedAttempts: 63,
          failedAttempts: 0,
        }]))
        .mockResolvedValueOnce(result([
          { architecture: 'legacy', cohort: 'control', attempts: 20, answered: 16, mediaStarted: 16 },
          { architecture: 'queue', cohort: 'canary_queue', attempts: 50, answered: 47, mediaStarted: 47 },
        ]))
        .mockResolvedValueOnce(result([{ duplicateQueueAttemptKeys: 0, duplicateQueueAttemptRows: 0 }]))
        .mockResolvedValueOnce(result([{ duplicateCallControlKeys: 0, duplicateCallControlRows: 0 }]))
        .mockResolvedValueOnce(result([{ conversations: 63, completedConversations: 63, duplicateConversationRows: 0 }]))
        .mockResolvedValueOnce(result([{ reminderDeliveries: 0, duplicateReminderDeliveryRows: 0 }]))
        .mockResolvedValueOnce(result([{ activeQueueRows: 0 }]))
        .mockResolvedValueOnce(result([{ activeAttempts: 0 }]))
        .mockResolvedValueOnce(result([{ driftingSeniors: 0, seniorsObserved: 5 }]))
        .mockResolvedValueOnce(result([{ canarySeniors: 5, senior_id: 'PHI_SENTINEL_SHOULD_NOT_APPEAR' }]))
        .mockResolvedValueOnce(result([
          ...sevenPassingDays(),
          {
            day: '2035-03-11',
            architecture: 'legacy',
            cohort: 'control',
            attempts: 5,
            answered: 4,
            mediaStarted: 4,
            name: 'Jane Example',
            phone: '+15555550123',
          },
        ])),
    };

    const report = await buildPhase7CanaryReport({
      database,
      testRunId: 'phase7-canary-001',
      answerRateBaseline: 0.7,
      rollbackStartedAt: '2035-03-18T14:00:00.000Z',
      rollbackCompletedAt: '2035-03-18T14:02:30.000Z',
      rollbackTargetSeconds: 300,
      now: new Date('2035-03-18T14:05:00.000Z'),
    });

    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      canarySeniors: 5,
      longestPassingStreak: 7,
      failedChecks: 0,
    });
    expect(report.phase7.dailyTreatment).toHaveLength(7);
    expect(database.execute).toHaveBeenCalledTimes(11);
    expect(JSON.stringify({
      phase5: report.phase5,
      phase7: report.phase7,
      checks: report.checks,
      summary: report.summary,
    })).not.toMatch(/PHI_SENTINEL_SHOULD_NOT_APPEAR|Jane Example|\+15555550123/i);
  });

  it('parses operator inputs for canary gates', () => {
    expect(parseArgs([
      '--test-run-id=phase7-canary-001',
      '--answer-rate-baseline=0.72',
      '--required-continuous-days=7',
      '--min-canary-seniors=5',
      '--max-canary-seniors=25',
      '--phi-sentinel-findings=0',
      '--p0p1-incidents=0',
    ])).toMatchObject({
      testRunId: 'phase7-canary-001',
      answerRateBaseline: 0.72,
      requiredContinuousDays: 7,
      minCanarySeniors: 5,
      maxCanarySeniors: 25,
      phiSentinelFindings: 0,
      p0p1Incidents: 0,
    });
  });
});
