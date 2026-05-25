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
    rejectAuth: false,
  };

  const requireAuth = vi.fn((req, res, next) => {
    if (state.rejectAuth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.auth = state.auth;
    return next();
  });

  const requireAdmin = vi.fn((req, res, next) => {
    req.auth = state.auth;
    if (!state.auth?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    return next();
  });

  const routeError = vi.fn((res, error) => {
    const status = error?.status || error?.statusCode || 500;
    const message = status < 500 ? error.message : 'An internal error occurred';
    return res.status(status).json({ error: message });
  });

  return {
    state,
    requireAuth,
    requireAdmin,
    routeError,
    seniorService: {
      getById: vi.fn(),
    },
    canAccessSenior: vi.fn(),
    logAudit: vi.fn(),
    authToRole: vi.fn(() => 'caregiver'),
    initiateTelnyxOutboundCall: vi.fn(),
    endTelnyxCall: vi.fn(),
    enqueueCall: vi.fn(),
    resolveCallArchitectureConfig: vi.fn(() => ({ mode: 'legacy_only' })),
    idempotencyMiddleware: vi.fn((_req, _res, next) => next()),
    callLimiter: vi.fn((_req, _res, next) => next()),
  };
});

vi.mock('../../../services/seniors.js', () => ({
  seniorService: harness.seniorService,
}));

vi.mock('../../../middleware/auth.js', () => ({
  requireAuth: harness.requireAuth,
  requireAdmin: harness.requireAdmin,
}));

vi.mock('../../../middleware/idempotency.js', () => ({
  idempotencyMiddleware: harness.idempotencyMiddleware,
}));

vi.mock('../../../middleware/rate-limit.js', () => ({
  callLimiter: harness.callLimiter,
}));

vi.mock('../../../routes/helpers.js', () => ({
  canAccessSenior: harness.canAccessSenior,
  routeError: harness.routeError,
}));

vi.mock('../../../services/audit.js', () => ({
  logAudit: harness.logAudit,
  authToRole: harness.authToRole,
}));

vi.mock('../../../services/telnyx.js', () => ({
  initiateTelnyxOutboundCall: harness.initiateTelnyxOutboundCall,
  endTelnyxCall: harness.endTelnyxCall,
}));

vi.mock('../../../services/call-queue.js', async () => {
  const actual = await vi.importActual('../../../services/call-queue.js');
  return {
    ...actual,
    enqueueCall: harness.enqueueCall,
    resolveCallArchitectureConfig: harness.resolveCallArchitectureConfig,
  };
});

import callsRouter from '../../../routes/calls.js';

const SENIOR_ID = '11111111-1111-4111-8111-111111111111';
const BASE_URL = 'https://pipecat.test';

function configureApp(app) {
  app.set('baseUrl', BASE_URL);
}

function makeActiveSenior(overrides = {}) {
  return {
    id: SENIOR_ID,
    isActive: true,
    phone: '(555) 867-5309',
    ...overrides,
  };
}

describe('calls route runtime behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.auth = {
      isAdmin: false,
      isCofounder: false,
      userId: 'caregiver-test',
      provider: 'test',
    };
    harness.state.rejectAuth = false;
    harness.seniorService.getById.mockResolvedValue(makeActiveSenior());
    harness.canAccessSenior.mockResolvedValue(true);
    harness.initiateTelnyxOutboundCall.mockResolvedValue({
      callSid: 'call-test-1',
      callControlId: 'control-test-1',
    });
    harness.endTelnyxCall.mockResolvedValue({});
    harness.enqueueCall.mockResolvedValue({ row: { id: 'queue-1' } });
    harness.resolveCallArchitectureConfig.mockReturnValue({ mode: 'legacy_only' });
  });

  it('validates call initiation input before touching senior data', async () => {
    const response = await requestJson(callsRouter, {
      method: 'POST',
      path: '/api/call',
      body: { seniorId: 'not-a-uuid' },
      configureApp,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(harness.seniorService.getById).not.toHaveBeenCalled();
    expect(harness.initiateTelnyxOutboundCall).not.toHaveBeenCalled();
  });

  it('denies inaccessible seniors before initiating a Telnyx call', async () => {
    harness.canAccessSenior.mockResolvedValue(false);

    const response = await requestJson(callsRouter, {
      method: 'POST',
      path: '/api/call',
      body: { seniorId: SENIOR_ID },
      configureApp,
    });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Access denied to this senior');
    expect(harness.canAccessSenior).toHaveBeenCalledWith(harness.state.auth, SENIOR_ID);
    expect(harness.initiateTelnyxOutboundCall).not.toHaveBeenCalled();
  });

  it('initiates a check-in call through Pipecat for an active accessible senior', async () => {
    const response = await requestJson(callsRouter, {
      method: 'POST',
      path: '/api/call',
      body: { seniorId: SENIOR_ID },
      configureApp,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      provider: 'telnyx',
      callSid: 'call-test-1',
      callControlId: 'control-test-1',
      seniorId: SENIOR_ID,
    });
    expect(harness.initiateTelnyxOutboundCall).toHaveBeenCalledWith({
      seniorId: SENIOR_ID,
      callType: 'check-in',
      baseUrl: BASE_URL,
    });
    expect(harness.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'caregiver-test',
      action: 'create',
      resourceType: 'call',
      metadata: { seniorId: SENIOR_ID },
    }));
  });

  it('enqueues manual calls behind queue primary instead of bypassing capacity', async () => {
    harness.resolveCallArchitectureConfig.mockReturnValue({ mode: 'queue_primary' });

    const response = await requestJson(callsRouter, {
      method: 'POST',
      path: '/api/call',
      headers: { 'idempotency-key': 'manual-call-key-12345' },
      body: { seniorId: SENIOR_ID },
      configureApp,
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      queued: true,
      queueId: 'queue-1',
      seniorId: SENIOR_ID,
    });
    expect(harness.enqueueCall).toHaveBeenCalledWith(expect.objectContaining({
      seniorId: SENIOR_ID,
      callType: 'manual',
      priorityLane: 'manual',
      priorityScore: 100,
      requestId: 'manual-call-key-12345',
    }));
    expect(harness.initiateTelnyxOutboundCall).not.toHaveBeenCalled();
  });

  it('does not initiate calls for inactive seniors', async () => {
    harness.seniorService.getById.mockResolvedValue(makeActiveSenior({ isActive: false }));

    const response = await requestJson(callsRouter, {
      method: 'POST',
      path: '/api/call',
      body: { seniorId: SENIOR_ID },
      configureApp,
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Senior is not active');
    expect(harness.canAccessSenior).not.toHaveBeenCalled();
    expect(harness.initiateTelnyxOutboundCall).not.toHaveBeenCalled();
  });

  it('requires admin access when ending a call', async () => {
    const denied = await requestJson(callsRouter, {
      method: 'POST',
      path: '/api/calls/call-test-1/end',
      configureApp,
    });

    expect(denied.status).toBe(403);
    expect(harness.endTelnyxCall).not.toHaveBeenCalled();

    harness.state.auth = {
      isAdmin: true,
      isCofounder: false,
      userId: 'admin-test',
      provider: 'test',
    };

    const allowed = await requestJson(callsRouter, {
      method: 'POST',
      path: '/api/calls/call-test-1/end',
      configureApp,
    });

    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ success: true, provider: 'telnyx' });
    expect(harness.endTelnyxCall).toHaveBeenCalledWith('call-test-1', {
      baseUrl: BASE_URL,
    });
  });
});
