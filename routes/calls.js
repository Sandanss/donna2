import { Router } from 'express';
import { seniorService } from '../services/seniors.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { callLimiter } from '../middleware/rate-limit.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { validateBody } from '../middleware/validate.js';
import { initiateCallSchema } from '../validators/schemas.js';
import { canAccessSenior, routeError } from './helpers.js';
import { logAudit, authToRole } from '../services/audit.js';
import { sendError } from '../lib/http-response.js';
import { endTelnyxCall, initiateTelnyxOutboundCall } from '../services/telnyx.js';
import { isSchedulerConsentGateEnabled } from '../lib/scheduler-config.js';
import {
  CALL_ARCHITECTURE_MODES,
  PRIORITY_LANES,
  enqueueCall,
  resolveCallArchitectureConfig,
} from '../services/call-queue.js';

const router = Router();

function formatPhoneForCall(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return String(phone || '').startsWith('+') ? String(phone) : `+${digits}`;
}

function manualCallRequestId(req, seniorId) {
  const key = req.get('idempotency-key') || req.get('x-idempotency-key');
  if (key) return key;
  return `manual:${req.auth?.userId || 'unknown'}:${seniorId}:${Date.now()}`;
}

// API: Initiate outbound call (strict rate limit: 5/min)
router.post('/api/call', requireAuth, validateBody(initiateCallSchema), idempotencyMiddleware, callLimiter, async (req, res) => {
  const { seniorId, contextNotes, callType: requestedCallType } = req.body;
  const PIPECAT_URL = req.app.get('baseUrl');

  // Caregiver-initiated consent / discovery calls flow through the same
  // manual-call API but route to dedicated Pipecat flows. Default is the
  // legacy manual check-in behavior so existing callers keep working.
  const isConsentCall = requestedCallType === 'consent';
  const isDiscoveryCall = requestedCallType === 'discovery';

  logAudit({
    userId: req.auth.userId,
    userRole: authToRole(req.auth),
    action: 'create',
    resourceType: 'call',
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
    metadata: { seniorId },
  });

  try {
    const senior = await seniorService.getById(seniorId);
    if (!senior) {
      return sendError(res, 404, { error: 'Senior not found' });
    }
    if (!senior.isActive) {
      return sendError(res, 400, { error: 'Senior is not active' });
    }

    // Consent / discovery calls are exempt from the consent_status gate
    // (consent calls are how the senior moves from pending → granted; discovery
    // is a caregiver-initiated follow-up that may also run during pending).
    // For all other callTypes, fail closed only when SCHEDULER_REQUIRE_CONSENT
    // is on — same flag the scheduler uses, so the manual call path can't be
    // stricter than the auto-dispatcher. Default OFF preserves existing
    // behavior; flip to true once prod is verified.
    if (!isConsentCall && !isDiscoveryCall && isSchedulerConsentGateEnabled()) {
      if (senior.consentStatus !== 'granted' || senior.callable === false) {
        return sendError(res, 409, {
          error: 'Senior has not granted consent for calls',
          consentStatus: senior.consentStatus,
        });
      }
    }

    // Check if user can access this senior before resolving/calling the phone number.
    if (!await canAccessSenior(req.auth, senior.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }

    const callPhone = formatPhoneForCall(senior.phone);
    if (!callPhone) {
      return sendError(res, 400, { error: 'Senior phone is not callable' });
    }

    // Pipecat callType: 'check-in' is the legacy default; explicit consent /
    // discovery flow values route to the dedicated nodes/tools.
    const pipecatCallType = isConsentCall
      ? 'consent'
      : isDiscoveryCall
        ? 'discovery'
        : 'check-in';
    // Queue lane: consent / discovery share the manual lane (caregiver-driven,
    // bypasses cohort selection).
    const queueCallType = isConsentCall
      ? 'consent'
      : isDiscoveryCall
        ? 'discovery'
        : 'manual';

    const architectureConfig = resolveCallArchitectureConfig();
    if (architectureConfig.mode === CALL_ARCHITECTURE_MODES.QUEUE_PRIMARY) {
      const queued = await enqueueCall({
        seniorId: senior.id,
        callType: queueCallType,
        priorityLane: PRIORITY_LANES.MANUAL,
        priorityScore: 100,
        targetAt: new Date(),
        windowMinutes: 15,
        requestId: manualCallRequestId(req, senior.id),
      });
      return res.status(202).json({
        success: true,
        queued: true,
        queueId: queued.row?.id || null,
        seniorId: senior.id,
        callType: pipecatCallType,
      });
    }

    const call = await initiateTelnyxOutboundCall({
      seniorId: senior.id,
      callType: pipecatCallType,
      contextNotes: contextNotes || undefined,
      baseUrl: PIPECAT_URL,
    });
    res.json({
      success: true,
      provider: 'telnyx',
      callSid: call.callSid,
      callControlId: call.callControlId,
      seniorId: senior.id,
    });

  } catch (error) {
    routeError(res, error, 'POST /api/call');
  }
});

// API: List active calls (admin only)
// Active calls are tracked by Pipecat — query its /health endpoint
router.get('/api/calls', requireAdmin, (req, res) => {
  res.json({
    activeCalls: 0,
    callSids: [],
  });
});

// API: End a call (admin only)
router.post('/api/calls/:callSid/end', requireAdmin, async (req, res) => {
  try {
    await endTelnyxCall(req.params.callSid, { baseUrl: req.app.get('baseUrl') });
    res.json({ success: true, provider: 'telnyx' });
  } catch (error) {
    routeError(res, error, 'POST /api/calls/:callSid/end');
  }
});

export default router;
