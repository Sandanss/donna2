import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { sendError } from '../lib/http-response.js';
import { routeError } from './helpers.js';
import { authToRole } from '../services/audit.js';
import {
  listDeadLetterPostCallJobs,
  requeueDeadLetterPostCallJob,
} from '../services/post-call-jobs.js';

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

router.get('/api/post-call-jobs/dead-letter', requireAdmin, async (req, res) => {
  try {
    const jobs = await listDeadLetterPostCallJobs({ limit: parseLimit(req.query.limit) });
    res.json({ jobs });
  } catch (error) {
    routeError(res, error, 'GET /api/post-call-jobs/dead-letter');
  }
});

router.post('/api/post-call-jobs/:id/replay', requireAdmin, async (req, res) => {
  try {
    const jobId = String(req.params.id || '');
    if (!UUID_PATTERN.test(jobId)) {
      return sendError(res, 400, { error: 'Valid job id is required' });
    }

    const job = await requeueDeadLetterPostCallJob({
      jobId,
      replayedBy: req.auth.userId,
      replayedByRole: authToRole(req.auth),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (!job) {
      return sendError(res, 404, { error: 'Dead-letter job not found' });
    }

    res.json({ job });
  } catch (error) {
    routeError(res, error, 'POST /api/post-call-jobs/:id/replay');
  }
});

export default router;
