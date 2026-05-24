import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { sendError } from '../lib/http-response.js';
import { routeError } from './helpers.js';
import {
  addToCanary,
  listActiveCanaryMembers,
  removeFromCanary,
} from '../services/canary-cohort.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RAMP_PHASE_PATTERN = /^[A-Za-z0-9_-]{1,50}$/;

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 500;
  return Math.min(parsed, 2000);
}

router.get('/api/canary/members', requireAdmin, async (req, res) => {
  try {
    const members = await listActiveCanaryMembers({ limit: parseLimit(req.query.limit) });
    res.json({ members });
  } catch (error) {
    routeError(res, error, 'GET /api/canary/members');
  }
});

router.post('/api/canary/members', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const rawIds = Array.isArray(body.senior_ids)
      ? body.senior_ids
      : (body.senior_id ? [body.senior_id] : []);

    if (rawIds.length === 0) {
      return sendError(res, 400, { error: 'senior_ids array (or senior_id) is required' });
    }

    const seniorIds = rawIds.map((value) => String(value || '').trim());
    const invalid = seniorIds.filter((id) => !UUID_PATTERN.test(id));
    if (invalid.length > 0) {
      return sendError(res, 400, {
        error: 'All senior_ids must be valid UUIDs',
        invalidCount: invalid.length,
      });
    }

    const rampPhase = String(body.ramp_phase || '').trim();
    if (!RAMP_PHASE_PATTERN.test(rampPhase)) {
      return sendError(res, 400, { error: 'ramp_phase must be 1-50 chars of [A-Za-z0-9_-]' });
    }

    const notes = body.notes ? String(body.notes).slice(0, 500) : null;

    const added = [];
    const errors = [];
    for (const seniorId of seniorIds) {
      try {
        const row = await addToCanary({
          seniorId,
          rampPhase,
          addedBy: req.auth?.userId || null,
          notes,
        });
        added.push(row);
      } catch (error) {
        errors.push({ seniorId, error: error.code || 'add_failed' });
      }
    }

    if (added.length === 0) {
      return sendError(res, 400, { error: 'No seniors added', errors });
    }

    res.status(errors.length > 0 ? 207 : 200).json({ added, errors });
  } catch (error) {
    routeError(res, error, 'POST /api/canary/members');
  }
});

router.delete('/api/canary/members/:seniorId', requireAdmin, async (req, res) => {
  try {
    const seniorId = String(req.params.seniorId || '').trim();
    if (!UUID_PATTERN.test(seniorId)) {
      return sendError(res, 400, { error: 'senior_id must be a valid UUID' });
    }

    const reason = (req.body && req.body.reason) || req.query.reason || 'manual_admin';
    const removed = await removeFromCanary({
      seniorId,
      removedBy: req.auth?.userId || null,
      reason,
    });

    if (!removed) {
      return sendError(res, 404, { error: 'Senior not in active canary cohort' });
    }

    res.json({ removed });
  } catch (error) {
    if (error?.code === 'invalid_removed_reason') {
      return sendError(res, 400, { error: error.message });
    }
    routeError(res, error, 'DELETE /api/canary/members/:seniorId');
  }
});

export default router;
