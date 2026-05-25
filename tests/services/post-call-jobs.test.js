import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  encryptJson: vi.fn(value => `enc:${JSON.stringify(value)}`),
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock('../../lib/encryption.js', () => ({
  encryptJson: mocks.encryptJson,
}));

vi.mock('../../services/audit.js', () => ({
  writeAudit: mocks.writeAudit,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

const {
  POST_CALL_JOB_STATUSES,
  POST_CALL_JOB_TYPES,
  POST_CALL_PROVIDER_KEYS,
  PostCallProviderSemaphores,
  assertPostCallPayloadHasNoPlainPhi,
  buildPostCallJobSpecs,
  createPostCallShadowVerificationHandlers,
  createPostCallWorkflowHandlers,
  executePostCallJob,
  enqueuePostCallJobGraph,
  leaseReadyPostCallJobs,
  recoverExpiredPostCallJobLeases,
  reconcilePostCallJobLeases,
  requeueDeadLetterPostCallJob,
  resolvePostCallFailureTransition,
  resolvePostCallProviderCaps,
  runPostCallStampedeSimulation,
  runPostCallWorkerOnce,
} = await import('../../services/post-call-jobs.js');

function result(rows) {
  return { rows };
}

function jobRow(overrides = {}) {
  return {
    id: overrides.id || '11111111-1111-4111-8111-111111111111',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    call_sid: 'CA_test',
    senior_id: '33333333-3333-4333-8333-333333333333',
    job_type: overrides.job_type || POST_CALL_JOB_TYPES.ANALYSIS,
    status: overrides.status || POST_CALL_JOB_STATUSES.QUEUED,
    priority: overrides.priority ?? 60,
    dedupe_key: `post-call:CA_test:${overrides.job_type || POST_CALL_JOB_TYPES.ANALYSIS}`,
    depends_on: overrides.depends_on || [],
    attempt_count: overrides.attempt_count ?? 0,
    max_attempts: overrides.max_attempts ?? 5,
    lease_owner: overrides.lease_owner || null,
    lease_expires_at: overrides.lease_expires_at || null,
    run_after: overrides.run_after || '2035-03-11T14:00:00.000Z',
    last_error_code: overrides.last_error_code || null,
    last_error_at: overrides.last_error_at || null,
    started_at: overrides.started_at || null,
    completed_at: overrides.completed_at || null,
    dead_lettered_at: overrides.dead_lettered_at || null,
    dead_letter_reason: overrides.dead_letter_reason || null,
    created_at: overrides.created_at || '2035-03-11T13:00:00.000Z',
    updated_at: overrides.updated_at || '2035-03-11T13:00:00.000Z',
  };
}

describe('post-call jobs Phase 6 queue foundation', () => {
  it('builds the dependency graph with encrypted payloads and no raw PHI fields', () => {
    const specs = buildPostCallJobSpecs({
      conversationId: '22222222-2222-4222-8222-222222222222',
      callSid: 'CA_test',
      seniorId: '33333333-3333-4333-8333-333333333333',
      payloadByType: {
        [POST_CALL_JOB_TYPES.METRICS_FINALIZE]: { callSid: 'CA_test' },
      },
    });

    const byType = new Map(specs.map(spec => [spec.jobType, spec]));

    expect(byType.get(POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS).dependsOnTypes).toEqual([
      POST_CALL_JOB_TYPES.ANALYSIS,
    ]);
    expect(byType.get(POST_CALL_JOB_TYPES.INTEREST_DISCOVERY).dependsOnTypes).toEqual([
      POST_CALL_JOB_TYPES.MEMORY_EXTRACTION,
    ]);
    expect(byType.get(POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD).dependsOnTypes).toEqual([
      POST_CALL_JOB_TYPES.MEMORY_EXTRACTION,
      POST_CALL_JOB_TYPES.DAILY_CONTEXT,
    ]);
    expect(byType.get(POST_CALL_JOB_TYPES.METRICS_FINALIZE).payloadEncrypted).toMatch(/^enc:/);
    expect(mocks.encryptJson).toHaveBeenCalledWith({ callSid: 'CA_test' });
  });

  it('rejects raw PHI-shaped payload fields and sentinel text before encryption', () => {
    expect(() => assertPostCallPayloadHasNoPlainPhi({
      transcript: 'hello',
    })).toThrow(/PHI-bearing/);

    expect(() => assertPostCallPayloadHasNoPlainPhi({
      context: 'Donna Phi Sentinel should never be stored raw',
    })).toThrow(/raw PHI sentinel/);
  });

  it('applies Phase 6 retry policies and dead-letters at max attempts', () => {
    const now = new Date('2035-03-11T14:00:00.000Z');

    const retry = resolvePostCallFailureTransition({
      jobType: POST_CALL_JOB_TYPES.REMINDER_RECOVERY,
      attemptCount: 1,
      now,
      errorCode: 'provider timeout',
    });

    expect(retry).toMatchObject({
      status: POST_CALL_JOB_STATUSES.FAILED,
      delaySeconds: 10,
      lastErrorCode: 'provider_timeout',
    });
    expect(retry.runAfter.toISOString()).toBe('2035-03-11T14:00:10.000Z');

    const terminal = resolvePostCallFailureTransition({
      jobType: POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS,
      attemptCount: 3,
      now,
      errorCode: 'resend_429',
    });

    expect(terminal).toMatchObject({
      status: POST_CALL_JOB_STATUSES.DEAD_LETTER,
      deadLetterReason: 'resend_429',
    });
  });

  it('computes provider caps from Phase 0 measurements with conservative factors', () => {
    expect(resolvePostCallProviderCaps({
      anthropicHaikuPeakTpm: 100000,
      geminiFlashConcurrent: 40,
      openAiEmbeddingsRpm: 3000,
      resendSendRate: 200,
    })).toEqual({
      anthropicHaikuTpm: 60000,
      geminiFlashConcurrent: 24,
      openAiEmbeddingsRpm: 1500,
      resendSendRate: 100,
    });
  });

  it('enqueues jobs in topological order when a custom order is provided', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([jobRow({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          job_type: POST_CALL_JOB_TYPES.MEMORY_EXTRACTION,
        })]))
        .mockResolvedValueOnce(result([jobRow({
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          job_type: POST_CALL_JOB_TYPES.DAILY_CONTEXT,
        })]))
        .mockResolvedValueOnce(result([jobRow({
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          job_type: POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD,
          depends_on: [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ],
        })])),
    };

    const jobs = await enqueuePostCallJobGraph({
      database,
      conversationId: '22222222-2222-4222-8222-222222222222',
      callSid: 'CA_test',
      jobTypes: [
        POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD,
        POST_CALL_JOB_TYPES.DAILY_CONTEXT,
        POST_CALL_JOB_TYPES.MEMORY_EXTRACTION,
      ],
      now: new Date('2035-03-11T14:00:00.000Z'),
    });

    expect(jobs.map(job => job.jobType)).toEqual([
      POST_CALL_JOB_TYPES.MEMORY_EXTRACTION,
      POST_CALL_JOB_TYPES.DAILY_CONTEXT,
      POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD,
    ]);
    expect(database.execute).toHaveBeenCalledTimes(3);
  });

  it('leases ready jobs and normalizes database rows without payloads', async () => {
    const database = {
      execute: vi.fn().mockResolvedValueOnce(result([jobRow({
        id: '44444444-4444-4444-8444-444444444444',
        status: POST_CALL_JOB_STATUSES.LEASED,
        lease_owner: 'worker-1',
        attempt_count: 2,
      })])),
    };

    const jobs = await leaseReadyPostCallJobs({
      database,
      workerId: 'worker-1',
      now: new Date('2035-03-11T14:00:00.000Z'),
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: '44444444-4444-4444-8444-444444444444',
      status: POST_CALL_JOB_STATUSES.LEASED,
      leaseOwner: 'worker-1',
      attemptCount: 2,
    });
    expect(jobs[0]).not.toHaveProperty('payloadEncrypted');
  });

  it('requeues dead-letter jobs and writes a PHI-free audit record', async () => {
    const auditWriter = vi.fn(async () => undefined);
    const database = {
      execute: vi.fn().mockResolvedValueOnce(result([jobRow({
        id: '55555555-5555-4555-8555-555555555555',
        status: POST_CALL_JOB_STATUSES.QUEUED,
        job_type: POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS,
        attempt_count: 0,
      })])),
    };

    const job = await requeueDeadLetterPostCallJob({
      database,
      jobId: '55555555-5555-4555-8555-555555555555',
      auditWriter,
      replayedBy: 'admin-1',
      replayedByRole: 'admin',
      now: new Date('2035-03-11T14:00:00.000Z'),
    });

    expect(job).toMatchObject({
      id: '55555555-5555-4555-8555-555555555555',
      status: POST_CALL_JOB_STATUSES.QUEUED,
      attemptCount: 0,
    });
    expect(auditWriter).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update',
      resourceType: 'post_call_job',
      resourceId: '55555555-5555-4555-8555-555555555555',
      metadata: {
        operation: 'dead_letter_replay',
        jobType: POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS,
      },
    }));
  });

  it('enforces provider semaphore caps and records max observed concurrency', async () => {
    const semaphores = new PostCallProviderSemaphores({
      [POST_CALL_PROVIDER_KEYS.RESEND]: 2,
    });
    let active = 0;
    let maxActive = 0;

    await Promise.all(Array.from({ length: 5 }, () => semaphores.run(
      POST_CALL_PROVIDER_KEYS.RESEND,
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
      },
    )));

    expect(maxActive).toBe(2);
    expect(semaphores.snapshot().maxObserved[POST_CALL_PROVIDER_KEYS.RESEND]).toBe(2);
  });

  it('executes one worker tick through lease, running, handler, and completion', async () => {
    const handler = vi.fn(async () => undefined);
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([])) // recoverExpiredPostCallJobLeases — nothing to recover
        .mockResolvedValueOnce(result([])) // deadLetterBlockedPostCallDependents — nothing blocked
        .mockResolvedValueOnce(result([jobRow({
          id: '66666666-6666-4666-8666-666666666666',
          status: POST_CALL_JOB_STATUSES.LEASED,
          job_type: POST_CALL_JOB_TYPES.METRICS_FINALIZE,
          lease_owner: 'post-call-worker-1',
          attempt_count: 1,
        })]))
        .mockResolvedValueOnce(result([jobRow({
          id: '66666666-6666-4666-8666-666666666666',
          status: POST_CALL_JOB_STATUSES.RUNNING,
          job_type: POST_CALL_JOB_TYPES.METRICS_FINALIZE,
          lease_owner: 'post-call-worker-1',
          attempt_count: 1,
        })]))
        .mockResolvedValueOnce(result([jobRow({
          id: '66666666-6666-4666-8666-666666666666',
          status: POST_CALL_JOB_STATUSES.COMPLETED,
          job_type: POST_CALL_JOB_TYPES.METRICS_FINALIZE,
          attempt_count: 1,
        })])),
    };

    const tick = await runPostCallWorkerOnce({
      database,
      workerId: 'post-call-worker-1',
      handlers: {
        [POST_CALL_JOB_TYPES.METRICS_FINALIZE]: handler,
      },
      limit: 1,
      now: new Date('2035-03-11T14:00:00.000Z'),
    });

    expect(tick).toMatchObject({
      leased: 1,
      blockedDeadLettered: 0,
      counts: {
        [POST_CALL_JOB_STATUSES.COMPLETED]: 1,
      },
    });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      id: '66666666-6666-4666-8666-666666666666',
      jobType: POST_CALL_JOB_TYPES.METRICS_FINALIZE,
    }), expect.objectContaining({
      provider: POST_CALL_PROVIDER_KEYS.DB,
      workerId: 'post-call-worker-1',
    }));
  });

  it('fails a job through the worker executor when a handler throws', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([jobRow({
          id: '77777777-7777-4777-8777-777777777777',
          status: POST_CALL_JOB_STATUSES.RUNNING,
          lease_owner: 'post-call-worker-1',
          attempt_count: 1,
        })]))
        .mockResolvedValueOnce(result([{
          id: '77777777-7777-4777-8777-777777777777',
          job_type: POST_CALL_JOB_TYPES.ANALYSIS,
          attempt_count: 1,
          max_attempts: 5,
        }]))
        .mockResolvedValueOnce(result([jobRow({
          id: '77777777-7777-4777-8777-777777777777',
          status: POST_CALL_JOB_STATUSES.FAILED,
          last_error_code: 'stub_failed',
          attempt_count: 1,
        })])),
    };

    const resultRow = await executePostCallJob({
      database,
      job: {
        id: '77777777-7777-4777-8777-777777777777',
        jobType: POST_CALL_JOB_TYPES.ANALYSIS,
      },
      workerId: 'post-call-worker-1',
      handlers: {
        [POST_CALL_JOB_TYPES.ANALYSIS]: async () => {
          const error = new Error('stub failed');
          error.code = 'stub_failed';
          throw error;
        },
      },
      now: new Date('2035-03-11T14:00:00.000Z'),
    });

    expect(resultRow).toMatchObject({
      status: POST_CALL_JOB_STATUSES.FAILED,
      errorCode: 'stub_failed',
      provider: POST_CALL_PROVIDER_KEYS.GEMINI_FLASH,
    });
  });

  it('does not mark a leased job running until its provider semaphore starts the handler', async () => {
    const database = { execute: vi.fn() };
    const providerSemaphores = {
      run: vi.fn(async () => ({
        status: 'waiting_for_provider_slot',
      })),
    };

    const resultRow = await executePostCallJob({
      database,
      job: {
        id: '88888888-8888-4888-8888-888888888888',
        jobType: POST_CALL_JOB_TYPES.ANALYSIS,
      },
      workerId: 'post-call-worker-1',
      handlers: {
        [POST_CALL_JOB_TYPES.ANALYSIS]: async () => undefined,
      },
      providerSemaphores,
      now: new Date('2035-03-11T14:00:00.000Z'),
    });

    expect(resultRow).toEqual({ status: 'waiting_for_provider_slot' });
    expect(providerSemaphores.run).toHaveBeenCalledWith(
      POST_CALL_PROVIDER_KEYS.GEMINI_FLASH,
      expect.any(Function),
    );
    expect(database.execute).not.toHaveBeenCalled();
  });

  it('builds PHI-free shadow handlers that verify completed post-call artifacts', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([{ count: 1 }]))
        .mockResolvedValueOnce(result([{ count: 1 }]))
        .mockResolvedValueOnce(result([{ count: 1 }]))
        .mockResolvedValueOnce(result([{ count: 0 }])),
    };
    const handlers = createPostCallShadowVerificationHandlers({ database });
    const job = {
      callSid: 'CA_test',
      seniorId: '33333333-3333-4333-8333-333333333333',
    };

    await expect(handlers[POST_CALL_JOB_TYPES.METRICS_FINALIZE](job)).resolves.toBeUndefined();
    await expect(handlers[POST_CALL_JOB_TYPES.REMINDER_RECOVERY](job)).resolves.toBeUndefined();
    expect(database.execute).toHaveBeenCalledTimes(4);
  });

  it('returns retryable codes from shadow handlers while inline artifacts are pending', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([{ count: 1 }]))
        .mockResolvedValueOnce(result([{ count: 0 }])),
    };
    const handlers = createPostCallShadowVerificationHandlers({ database });

    await expect(handlers[POST_CALL_JOB_TYPES.ANALYSIS]({
      callSid: 'CA_test',
    })).rejects.toMatchObject({
      code: 'analysis_artifact_pending',
    });
  });

  it('builds workflow handlers through the production adapter seam', async () => {
    const adapter = {
      handle: vi.fn(async () => undefined),
    };
    const handlers = createPostCallWorkflowHandlers({ adapter });
    const job = {
      id: '11111111-1111-4111-8111-111111111111',
      jobType: POST_CALL_JOB_TYPES.ANALYSIS,
    };

    await handlers[POST_CALL_JOB_TYPES.ANALYSIS](job, { workerId: 'worker-1' });

    expect(adapter.handle).toHaveBeenCalledWith(
      POST_CALL_JOB_TYPES.ANALYSIS,
      expect.objectContaining({ jobType: POST_CALL_JOB_TYPES.ANALYSIS }),
      { workerId: 'worker-1' },
    );
  });

  it('uses artifact verification as the default workflow handler mode', async () => {
    const database = {
      execute: vi.fn()
        .mockResolvedValueOnce(result([{ count: 1 }]))
        .mockResolvedValueOnce(result([{ count: 1 }])),
    };
    const handlers = createPostCallWorkflowHandlers({ database });

    await expect(handlers[POST_CALL_JOB_TYPES.METRICS_FINALIZE]({
      callSid: 'CA_test',
    })).resolves.toBeUndefined();
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it('runs a provider-stub stampede simulation with cap and SLO checks', async () => {
    const report = await runPostCallStampedeSimulation({
      completions: 20,
      providerLimits: {
        [POST_CALL_PROVIDER_KEYS.DB]: 8,
        [POST_CALL_PROVIDER_KEYS.GEMINI_FLASH]: 3,
        [POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS]: 2,
        [POST_CALL_PROVIDER_KEYS.RESEND]: 2,
      },
      handlerDurationsMs: {
        [POST_CALL_JOB_TYPES.ANALYSIS]: 2,
        [POST_CALL_JOB_TYPES.MEMORY_EXTRACTION]: 2,
      },
      dbPoolStatsProvider: async () => ({ idle: 4, max: 20 }),
    });

    expect(report.ok).toBe(true);
    expect(report.totalJobs).toBe(20 * 8);
    expect(report.providerMaxObserved[POST_CALL_PROVIDER_KEYS.GEMINI_FLASH]).toBeLessThanOrEqual(3);
    expect(report.providerMaxObserved[POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS]).toBeLessThanOrEqual(2);
    expect(report.checks.map(check => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
  });
});

describe('post-call jobs lease recovery (C1 review fix)', () => {
  it('recoverExpiredPostCallJobLeases flips expired LEASED rows back to QUEUED', async () => {
    const database = {
      execute: vi.fn().mockResolvedValueOnce(result([
        { id: 'job-1', job_type: POST_CALL_JOB_TYPES.ANALYSIS, attempt_count: 2, max_attempts: 5 },
        { id: 'job-2', job_type: POST_CALL_JOB_TYPES.MEMORY_EXTRACTION, attempt_count: 1, max_attempts: 5 },
      ])),
    };

    const recovered = await recoverExpiredPostCallJobLeases(
      { now: new Date('2026-05-25T01:00:00Z'), limit: 50 },
      { database },
    );

    expect(recovered).toHaveLength(2);
    expect(recovered[0].id).toBe('job-1');
    expect(database.execute).toHaveBeenCalledTimes(1);

    const sqlObj = JSON.stringify(database.execute.mock.calls[0][0]);
    // Reverts to QUEUED, clears lease_owner + lease_expires_at, preserves attempt_count.
    expect(sqlObj).toContain('queued');
    expect(sqlObj).toContain('lease_owner = NULL');
    expect(sqlObj).toContain('lease_expires_at = NULL');
    expect(sqlObj).not.toContain('attempt_count = 0');
    // CRITICAL: only LEASED rows are touched. A worker that crashed during
    // RUNNING is NOT auto-recovered (could re-fire external side effects).
    expect(sqlObj).toContain('leased');
    expect(sqlObj).not.toMatch(/status\s*IN\s*\([^)]*running/i);
  });

  it('reconcilePostCallJobLeases returns recovered count', async () => {
    const database = {
      execute: vi.fn().mockResolvedValueOnce(result([
        { id: 'job-1', job_type: POST_CALL_JOB_TYPES.ANALYSIS, attempt_count: 1, max_attempts: 5 },
      ])),
    };

    const summary = await reconcilePostCallJobLeases({}, { database });
    expect(summary).toEqual({ recovered: 1 });
  });

  it('recoverExpiredPostCallJobLeases returns empty list when nothing expired', async () => {
    const database = { execute: vi.fn().mockResolvedValueOnce(result([])) };
    const recovered = await recoverExpiredPostCallJobLeases({}, { database });
    expect(recovered).toEqual([]);
  });
});
