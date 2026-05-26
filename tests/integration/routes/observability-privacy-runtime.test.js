import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestJson } from '../../helpers/http.js';

const harness = vi.hoisted(() => {
  const state = {
    auth: {
      isAdmin: true,
      isCofounder: false,
      userId: 'admin-test',
      provider: 'test',
    },
  };

  const makeSelectBuilder = () => {
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => Promise.resolve(harness.selectWhereResults.shift() ?? [])),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(harness.selectLimitResults.shift() ?? [])),
    };
    return builder;
  };

  return {
    state,
    selectWhereResults: [],
    selectLimitResults: [],
    execute: vi.fn(),
    cleanupWhere: vi.fn(() => Promise.resolve({ rowCount: 0 })),
    decrypt: vi.fn((value) => `decrypted:${value}`),
    decryptJson: vi.fn((value) => value),
    logAudit: vi.fn(),
    authToRole: vi.fn(() => 'admin'),
    requireAdmin: vi.fn((req, res, next) => {
      req.auth = state.auth;
      if (!state.auth?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      return next();
    }),
    callAnalysisService: {
      getLatestByConversationIds: vi.fn(),
    },
    getDatabaseScalingSnapshot: vi.fn(),
    db: {
      select: vi.fn(() => makeSelectBuilder()),
      execute: vi.fn((...args) => harness.execute(...args)),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: harness.cleanupWhere,
        })),
      })),
    },
  };
});

vi.mock('../../../db/client.js', () => ({
  db: harness.db,
}));

vi.mock('../../../middleware/auth.js', () => ({
  requireAdmin: harness.requireAdmin,
}));

vi.mock('../../../lib/encryption.js', () => ({
  decrypt: harness.decrypt,
  decryptJson: harness.decryptJson,
}));

vi.mock('../../../services/call-analyses.js', () => ({
  callAnalysisService: harness.callAnalysisService,
}));

vi.mock('../../../services/db-observability.js', () => ({
  getDatabaseScalingSnapshot: harness.getDatabaseScalingSnapshot,
}));

vi.mock('../../../services/audit.js', () => ({
  logAudit: harness.logAudit,
  authToRole: harness.authToRole,
}));

import observabilityRouter from '../../../routes/observability.js';

function makeCallRow(overrides = {}) {
  return {
    id: 'call-1',
    callSid: 'CA1234567890',
    seniorId: 'senior-1',
    seniorName: 'Test Senior',
    seniorPhone: '+15558675309',
    startedAt: '2035-01-01T15:00:00.000Z',
    endedAt: '2035-01-01T15:10:00.000Z',
    durationSeconds: 600,
    status: 'completed',
    sentiment: 'neutral',
    concerns: [],
    ...overrides,
  };
}

function makeLatencyMetric(overrides = {}) {
  return {
    call_sid: 'CA1234567890',
    duration_seconds: 600,
    latency: JSON.stringify({
      turn_avg_ms: 1200,
      stage_breakdown: {
        'call.answer_to_ws': {
          count: 1,
          avg_ms: 900,
          p95_ms: 900,
          max_ms: 900,
          last_ms: 900,
        },
      },
    }),
    tools_used: [],
    token_usage: {},
    context_trace_encrypted: null,
    ...overrides,
  };
}

describe('observability route privacy behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.auth = {
      isAdmin: true,
      isCofounder: false,
      userId: 'admin-test',
      provider: 'test',
    };
    harness.selectWhereResults.length = 0;
    harness.selectLimitResults.length = 0;
    harness.execute.mockResolvedValue({ rows: [] });
    harness.cleanupWhere.mockResolvedValue({ rowCount: 0 });
    harness.decrypt.mockImplementation((value) => {
      if (value === 'enc:summary') return 'decrypted summary';
      return `decrypted:${value}`;
    });
    harness.decryptJson.mockImplementation((value) => value);
    harness.callAnalysisService.getLatestByConversationIds.mockResolvedValue(new Map());
    harness.getDatabaseScalingSnapshot.mockResolvedValue({
      capturedAt: '2035-01-01T00:00:00.000Z',
      pool: { max: 20, total: 8, idle: 4, waiting: 0 },
      activity: { available: true, active_backends: 1, byState: [] },
      locks: { available: true, waiting_locks: 0, waiting_backends: 0, blocked_backends: 0 },
      hotTables: { available: true, tables: [{ table_name: 'memories', estimated_live_rows: 10 }] },
      slowQueries: { available: true, queries: [{ query_id: '123', mean_exec_time_ms: 42 }] },
      phiPolicy: { outputContainsRawPhi: false },
    });
  });

  it('enforces admin auth before querying observability data', async () => {
    harness.state.auth = {
      isAdmin: false,
      isCofounder: false,
      userId: 'caregiver-test',
      provider: 'test',
    };

    const response = await requestJson(observabilityRouter, {
      method: 'GET',
      path: '/api/observability/calls',
    });

    expect(response.status).toBe(403);
    expect(harness.db.select).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('decrypts call details at the response boundary without exposing ciphertext fields', async () => {
    harness.selectWhereResults.push([
      makeCallRow({
        summary: 'legacy summary',
        summaryEncrypted: 'enc:summary',
        transcript: [{ role: 'user', content: 'legacy transcript' }],
        transcriptEncrypted: 'enc:transcript',
      }),
    ]);
    harness.decryptJson.mockImplementation((value) => {
      if (value === 'enc:transcript') {
        return [{ role: 'user', content: 'decrypted transcript' }];
      }
      return value;
    });

    const response = await requestJson(observabilityRouter, {
      method: 'GET',
      path: '/api/observability/calls/call-1',
    });

    expect(response.status).toBe(200);
    expect(response.body.summary).toBe('decrypted summary');
    expect(response.body.transcript).toEqual([{ role: 'user', content: 'decrypted transcript' }]);
    expect(JSON.stringify(response.body)).not.toContain('enc:summary');
    expect(JSON.stringify(response.body)).not.toContain('enc:transcript');
    expect(response.body).not.toHaveProperty('summaryEncrypted');
    expect(response.body).not.toHaveProperty('transcriptEncrypted');
  });

  it('omits encrypted context trace ciphertext from metrics responses', async () => {
    harness.selectWhereResults.push([
      makeCallRow({
        transcript: [],
        callMetrics: null,
      }),
    ]);
    harness.execute.mockResolvedValue({
      rows: [
        makeLatencyMetric({
          context_trace_encrypted: 'enc:context-trace',
          token_usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
      ],
    });

    const response = await requestJson(observabilityRouter, {
      method: 'GET',
      path: '/api/observability/calls/call-1/metrics',
    });

    expect(response.status).toBe(200);
    expect(response.body.infraMetric).not.toHaveProperty('context_trace_encrypted');
    expect(JSON.stringify(response.body)).not.toContain('enc:context-trace');
    expect(response.body.callMetrics.totalTokens).toBe(14);
  });

  it('falls back to latency-only context when encrypted context trace cannot decrypt', async () => {
    harness.selectWhereResults.push([
      makeCallRow({
        id: 'call-1',
        callSid: 'CA1234567890',
      }),
    ]);
    harness.execute.mockResolvedValue({
      rows: [
        makeLatencyMetric({
          context_trace_encrypted: 'enc:bad-context-trace',
        }),
      ],
    });
    harness.decryptJson.mockImplementation((value) => {
      if (value === 'enc:bad-context-trace') {
        throw new Error('decrypt failed');
      }
      return value;
    });

    const response = await requestJson(observabilityRouter, {
      method: 'GET',
      path: '/api/observability/calls/call-1/context',
    });

    expect(response.status).toBe(200);
    expect(response.body.contextTrace.events).toEqual([]);
    expect(response.body.contextTrace.latency_breakdown['call.answer_to_ws'].avg_ms).toBe(900);
    expect(response.body.captured).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('enc:bad-context-trace');
  });

  it('returns database scaling stats without query text or PHI-bearing fields', async () => {
    const response = await requestJson(observabilityRouter, {
      method: 'GET',
      path: '/api/observability/db',
    });

    expect(response.status).toBe(200);
    expect(response.body.pool.total).toBe(8);
    expect(response.body.slowQueries.queries[0]).toEqual({
      query_id: '123',
      mean_exec_time_ms: 42,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/query_text|transcript|summary|phone|senior_name/i);
    expect(harness.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      resourceType: 'database',
      metadata: expect.objectContaining({ endpoint: 'db_scaling' }),
    }));
  });
});
