import { Router } from 'express';
import { conversationService } from '../services/conversations.js';
import { requireAuth } from '../middleware/auth.js';
import { validateParams } from '../middleware/validate.js';
import { seniorIdParamSchema } from '../validators/schemas.js';
import { getAccessibleSeniorIds, canAccessSenior, routeError } from './helpers.js';
import { logAudit, authToRole } from '../services/audit.js';
import { sendError } from '../lib/http-response.js';

const router = Router();

// Get summary-only calls for a senior (caregiver-facing)
router.get('/api/seniors/:id/calls', requireAuth, validateParams(seniorIdParamSchema), async (req, res) => {
  try {
    if (!await canAccessSenior(req.auth, req.params.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'conversation',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { seniorId: req.params.id, view: 'call_summaries' },
    });
    const calls = await conversationService.getCallSummariesForSenior(req.params.id, 20);
    res.json(calls);
  } catch (error) {
    routeError(res, error, 'GET /api/seniors/:id/calls');
  }
});

// Get conversations for a senior
router.get('/api/seniors/:id/conversations', requireAuth, validateParams(seniorIdParamSchema), async (req, res) => {
  try {
    if (!await canAccessSenior(req.auth, req.params.id)) {
      return sendError(res, 403, { error: 'Access denied to this senior' });
    }
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'conversation',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata: { seniorId: req.params.id },
    });
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const convos = req.auth.isAdmin
      ? await conversationService.getForSenior(req.params.id, limit)
      : await conversationService.getCallSummariesForSenior(req.params.id, limit, offset);
    res.json(convos);
  } catch (error) {
    routeError(res, error, 'GET /api/seniors/:id/conversations');
  }
});

// Get all recent conversations (admins see all, caregivers see their seniors')
router.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    logAudit({
      userId: req.auth.userId,
      userRole: authToRole(req.auth),
      action: 'read',
      resourceType: 'conversation',
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    if (req.auth.isAdmin) {
      const convos = await conversationService.getRecent(50);
      return res.json(convos);
    }
    // Filter to accessible seniors
    const accessibleIds = await getAccessibleSeniorIds(req.auth);
    if (!accessibleIds?.length) {
      return res.json([]);
    }
    const convos = await conversationService.getRecentCallSummariesForSeniors(accessibleIds, 50);
    res.json(convos);
  } catch (error) {
    routeError(res, error, 'GET /api/conversations');
  }
});

export default router;
