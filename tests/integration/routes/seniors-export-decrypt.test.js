/**
 * Category B (PHI shape) integration test — Node senior export route.
 *
 * Exercises `GET /api/seniors/:id/export` end-to-end with a fixture senior
 * whose Phase 1 ops tables (call_queue, call_attempts, post_call_jobs,
 * outbound_call_guards, scheduler_shadow_comparisons) carry rows with
 * encrypted payload columns. The test asserts:
 *
 *   (a) `payload_encrypted` on `post_call_jobs` rows is decrypted into a
 *       plaintext `payload` field via `decryptExportPostCallJob`.
 *   (b) `payload_encrypted` ciphertext is NOT in the response.
 *   (c) `context_notes_encrypted` on `senior_call_schedules` rows is
 *       decrypted into `contextNotes` and the ciphertext is stripped.
 *   (d) An unauthorized caregiver gets 403 BEFORE any data is read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestJson } from '../../helpers/http.js';

const harness = vi.hoisted(() => {
  const state = {
    auth: {
      isAdmin: false,
      isCofounder: false,
      userId: 'caregiver-test',
      provider: 'test',
    },
  };

  const makeSelectBuilder = () => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => Promise.resolve(harness.selectAwaitResults.shift() ?? [])),
      then: (resolve, reject) => Promise
        .resolve(harness.selectAwaitResults.shift() ?? [])
        .then(resolve, reject),
    };
    return builder;
  };

  return {
    state,
    selectAwaitResults: [],
    executeResults: [],
    requireAuth: vi.fn((req, _res, next) => {
      req.auth = state.auth;
      next();
    }),
    requireAdmin: vi.fn((req, res, next) => {
      req.auth = state.auth;
      if (!state.auth?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      return next();
    }),
    idempotencyMiddleware: vi.fn((_req, _res, next) => next()),
    writeLimiter: vi.fn((_req, _res, next) => next()),
    authLimiter: vi.fn((_req, _res, next) => next()),
    canAccessSenior: vi.fn(),
    getAccessibleSeniorIds: vi.fn(),
    routeError: vi.fn((res, error) => {
      const status = error?.status || error?.statusCode || 500;
      return res.status(status).json({ error: error?.message || 'error' });
    }),
    logAudit: vi.fn(),
    writeAudit: vi.fn(),
    authToRole: vi.fn(() => 'caregiver'),
    seniorService: {
      create: vi.fn(),
      list: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      findByPhone: vi.fn(),
    },
    caregiverService: {
      linkUserToSenior: vi.fn(),
    },
    db: {
      select: vi.fn(() => makeSelectBuilder()),
      execute: vi.fn(),
      transaction: vi.fn(),
    },
    decrypt: vi.fn(),
    decryptJson: vi.fn(),
    decryptReminderPhi: vi.fn((v) => v),
    decryptDailyContextPhi: vi.fn((v) => v),
    normalizeCallAnalysis: vi.fn((v) => v),
  };
});

vi.mock('../../../middleware/auth.js', () => ({
  requireAuth: harness.requireAuth,
  requireAdmin: harness.requireAdmin,
}));
vi.mock('../../../middleware/idempotency.js', () => ({
  idempotencyMiddleware: harness.idempotencyMiddleware,
}));
vi.mock('../../../middleware/rate-limit.js', () => ({
  writeLimiter: harness.writeLimiter,
  authLimiter: harness.authLimiter,
}));
vi.mock('../../../routes/helpers.js', () => ({
  canAccessSenior: harness.canAccessSenior,
  getAccessibleSeniorIds: harness.getAccessibleSeniorIds,
  routeError: harness.routeError,
}));
vi.mock('../../../services/audit.js', () => ({
  logAudit: harness.logAudit,
  writeAudit: harness.writeAudit,
  authToRole: harness.authToRole,
}));
vi.mock('../../../services/seniors.js', () => ({
  seniorService: harness.seniorService,
}));
vi.mock('../../../services/caregivers.js', () => ({
  caregiverService: harness.caregiverService,
}));
vi.mock('../../../db/client.js', () => ({
  db: harness.db,
}));
vi.mock('../../../lib/phi.js', () => ({
  encryptReminderPhi: vi.fn((v) => v),
  decryptReminderPhi: harness.decryptReminderPhi,
  encryptSeniorPhi: vi.fn((v) => v),
  decryptSeniorPhi: vi.fn((v) => v),
  decryptDailyContextPhi: harness.decryptDailyContextPhi,
}));
vi.mock('../../../lib/encryption.js', () => ({
  decrypt: harness.decrypt,
  decryptJson: harness.decryptJson,
}));
vi.mock('../../../services/call-analyses.js', () => ({
  normalizeCallAnalysis: harness.normalizeCallAnalysis,
}));

import seniorsRouter from '../../../routes/seniors.js';

const SENIOR_ID = '11111111-1111-4111-8111-111111111111';
const POST_CALL_JOB_ID = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  harness.selectAwaitResults.length = 0;
  harness.state.auth = {
    isAdmin: false,
    isCofounder: false,
    userId: 'caregiver-test',
    provider: 'test',
  };
  harness.canAccessSenior.mockResolvedValue(true);
  harness.seniorService.getById.mockResolvedValue({ id: SENIOR_ID, name: 'Test Senior' });
  // The decryption stubs return clear payloads.
  harness.decrypt.mockImplementation((v) => {
    if (typeof v !== 'string') return v;
    if (v.startsWith('enc:')) return `DECRYPTED:${v.slice(4)}`;
    return v;
  });
  harness.decryptJson.mockImplementation((v) => {
    if (typeof v !== 'string') return v;
    if (v.startsWith('enc:')) {
      // Deterministic but does NOT echo the source ciphertext, so the
      // "ciphertext is stripped from response" assertion is meaningful.
      return { decryptedMarker: `plain-payload-for-${v.length}` };
    }
    return v;
  });
  harness.db.execute.mockReset();
});

function seedExportFixtures({
  postCallJobRows = [],
  callScheduleRows = [],
} = {}) {
  // Order matches the Promise.all in routes/seniors.js export handler:
  // 0: senior (seniorService.getById — already mocked above)
  // 1: conversations
  // 2: memories
  // 3: reminders
  // 4: call_analyses
  // 5: daily_context
  // 6: caregivers
  // 7: senior_call_schedules
  // 8: call_queue
  // 9: call_attempts
  // 10: post_call_jobs (uses db.execute, NOT db.select)
  // 11: outbound_call_guards
  // 12: scheduler_shadow_comparisons
  // IMPORTANT ordering: the `db.select(...).orderBy(...)` chains shift
  // from this array SYNCHRONOUSLY during Promise.all argument construction
  // (orderBy returns a resolved Promise eagerly). The `caregivers` chain
  // is the only `.where()`-terminated query in the export — it shifts
  // LAST, when Promise.all invokes its thenable. So the shift order is:
  //   conversations, memories, reminders, call_analyses, daily_context,
  //   senior_call_schedules, call_queue, call_attempts,
  //   outbound_call_guards, scheduler_shadow_comparisons, caregivers.
  harness.selectAwaitResults.push(
    [],                       // 1. conversations
    [],                       // 2. memories
    [],                       // 3. reminders
    [],                       // 4. call_analyses
    [],                       // 5. daily_context
    callScheduleRows,         // 6. senior_call_schedules
    [],                       // 7. call_queue
    [],                       // 8. call_attempts
    // (post_call_jobs uses db.execute, mocked separately below)
    [],                       // 9. outbound_call_guards
    [],                       // 10. scheduler_shadow_comparisons
    [],                       // 11. caregivers (thenable-resolved last)
  );

  harness.db.execute.mockResolvedValue({ rows: postCallJobRows });
}

describe('GET /api/seniors/:id/export — payload decryption + PHI strip', () => {
  it('decrypts post_call_jobs.payload_encrypted to plain `payload` and removes the ciphertext from the response', async () => {
    seedExportFixtures({
      postCallJobRows: [{
        id: POST_CALL_JOB_ID,
        conversation_id: 'conv-1',
        senior_id: SENIOR_ID,
        job_type: 'analysis',
        status: 'completed',
        payload_encrypted: 'enc:rawCiphertextForJobPayload',
        attempt_count: 1,
      }],
    });

    const response = await requestJson(seniorsRouter, {
      method: 'GET',
      path: `/api/seniors/${SENIOR_ID}/export`,
    });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.postCallJobs)).toBe(true);
    expect(response.body.postCallJobs).toHaveLength(1);

    const job = response.body.postCallJobs[0];

    // (a) decrypted payload appears as a plain field — decryptJson was
    //     called with the ciphertext exactly once.
    expect(job.payload).toBeDefined();
    expect(job.payload).toEqual({ decryptedMarker: `plain-payload-for-${'enc:rawCiphertextForJobPayload'.length}` });
    expect(harness.decryptJson).toHaveBeenCalledWith('enc:rawCiphertextForJobPayload');

    // (b) ciphertext column is gone — neither snake nor camel form survives.
    expect(job.payload_encrypted).toBeUndefined();
    expect(job.payloadEncrypted).toBeUndefined();
    // And not at the top level either:
    expect(JSON.stringify(response.body)).not.toContain('enc:rawCiphertextForJobPayload');
    expect(JSON.stringify(response.body)).not.toContain('payload_encrypted');
    expect(JSON.stringify(response.body)).not.toContain('payloadEncrypted');
  });

  it('decrypts schedule.context_notes_encrypted to contextNotes and removes ciphertext', async () => {
    seedExportFixtures({
      callScheduleRows: [{
        id: SCHEDULE_ID,
        seniorId: SENIOR_ID,
        callType: 'check-in',
        contextNotesEncrypted: 'enc:rawCiphertextForScheduleNotes',
        targetLocalTime: '09:00',
        isActive: true,
      }],
    });

    const response = await requestJson(seniorsRouter, {
      method: 'GET',
      path: `/api/seniors/${SENIOR_ID}/export`,
    });

    expect(response.status).toBe(200);
    expect(response.body.callSchedules).toHaveLength(1);

    const schedule = response.body.callSchedules[0];
    expect(schedule.contextNotes).toBe('DECRYPTED:rawCiphertextForScheduleNotes');
    expect(schedule.contextNotesEncrypted).toBeUndefined();
    expect(schedule.context_notes_encrypted).toBeUndefined();

    expect(JSON.stringify(response.body)).not.toContain('enc:rawCiphertextForScheduleNotes');
  });

  it('returns 403 to an unauthorized caregiver BEFORE any SELECT runs', async () => {
    harness.canAccessSenior.mockResolvedValue(false);

    const response = await requestJson(seniorsRouter, {
      method: 'GET',
      path: `/api/seniors/${SENIOR_ID}/export`,
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/Access denied/i);
    // Critical: no DB activity, no decryption, no audit write.
    expect(harness.db.select).not.toHaveBeenCalled();
    expect(harness.db.execute).not.toHaveBeenCalled();
    expect(harness.seniorService.getById).not.toHaveBeenCalled();
    expect(harness.writeAudit).not.toHaveBeenCalled();
    expect(harness.decrypt).not.toHaveBeenCalled();
    expect(harness.decryptJson).not.toHaveBeenCalled();
  });

  it('handles post_call_jobs rows without payload_encrypted (no fabricated payload field)', async () => {
    seedExportFixtures({
      postCallJobRows: [{
        id: POST_CALL_JOB_ID,
        conversation_id: 'conv-2',
        senior_id: SENIOR_ID,
        job_type: 'summary',
        status: 'pending',
        // No payload_encrypted set.
        attempt_count: 0,
      }],
    });

    const response = await requestJson(seniorsRouter, {
      method: 'GET',
      path: `/api/seniors/${SENIOR_ID}/export`,
    });

    expect(response.status).toBe(200);
    const job = response.body.postCallJobs[0];
    // No payload field added when there's no ciphertext to decrypt.
    expect(job.payload).toBeUndefined();
    expect(job.payload_encrypted).toBeUndefined();
    expect(job.payloadEncrypted).toBeUndefined();
    expect(harness.decryptJson).not.toHaveBeenCalled();
  });
});
