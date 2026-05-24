import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { sendError } from '../lib/http-response.js';
import { routeError } from './helpers.js';
import { authToRole } from '../services/audit.js';
import { buildPhase8CapacityPlan } from '../scripts/phase8-capacity-plan.js';
import {
  applyOperatorScaleOverride,
  phase8PlanOptionsFromEnv,
  runPhase8AutoscalerOnce,
} from '../services/phase8-autoscaler.js';

const router = Router();

function integerValue(value, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function numberValue(value, defaultValue, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return defaultValue;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function planOptionsFromRequest(source = {}) {
  const requested = stripUndefined({
    windowStart: source.windowStart || source.window_start || null,
    windowMinutes: integerValue(source.windowMinutes ?? source.window_minutes, undefined, { min: 1, max: 240 }),
    currentReplicas: (source.currentReplicas ?? source.current_replicas) == null
      ? undefined
      : integerValue(source.currentReplicas ?? source.current_replicas, null, { min: 0, max: 50 }),
    minReplicas: integerValue(source.minReplicas ?? source.min_replicas, undefined, { min: 0, max: 50 }),
    maxCallsPerReplica: integerValue(source.maxCallsPerReplica ?? source.max_calls_per_replica, undefined, { min: 1, max: 10000 }),
    overbookFactor: numberValue(source.overbookFactor ?? source.overbook_factor, undefined, { min: 0.1, max: 2 }),
    warmupMinutes: integerValue(source.warmupMinutes ?? source.warmup_minutes, undefined, { min: 1, max: 120 }),
    readyMinutesBeforeWindow: integerValue(source.readyMinutesBeforeWindow ?? source.ready_minutes_before_window, undefined, { min: 1, max: 120 }),
    criticalBacklogThreshold: integerValue(source.criticalBacklogThreshold ?? source.critical_backlog_threshold, undefined, { min: 0, max: 100000 }),
    costPerReplicaHour: optionalNumber(source.costPerReplicaHour ?? source.cost_per_replica_hour),
    hourlyBudget: optionalNumber(source.hourlyBudget ?? source.hourly_budget),
  });
  return {
    ...phase8PlanOptionsFromEnv(),
    ...requested,
  };
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined));
}

function scaleOptionsFromRequest(source = {}) {
  return stripUndefined({
    service: source.service || undefined,
    environment: source.environment || undefined,
    region: source.region || undefined,
  });
}

router.get('/api/scale-operations/phase8/plan', requireAdmin, async (req, res) => {
  try {
    const plan = await buildPhase8CapacityPlan(stripUndefined(planOptionsFromRequest(req.query)));
    res.json({ plan });
  } catch (error) {
    routeError(res, error, 'GET /api/scale-operations/phase8/plan');
  }
});

router.post('/api/scale-operations/phase8/autoscale-once', requireAdmin, async (req, res) => {
  try {
    const result = await runPhase8AutoscalerOnce({
      planOptions: stripUndefined(planOptionsFromRequest(req.body || {})),
      confirmScale: booleanValue(req.body?.confirmScale, false),
      dryRun: !booleanValue(req.body?.confirmScale, false) || booleanValue(req.body?.dryRun, true),
      scaleOptions: scaleOptionsFromRequest(req.body || {}),
    });
    res.json(result);
  } catch (error) {
    routeError(res, error, 'POST /api/scale-operations/phase8/autoscale-once');
  }
});

router.post('/api/scale-operations/phase8/override', requireAdmin, async (req, res) => {
  try {
    const targetReplicas = req.body?.targetReplicas ?? req.body?.target_replicas;
    if (targetReplicas == null) {
      return sendError(res, 400, { error: 'targetReplicas is required' });
    }

    const result = await applyOperatorScaleOverride({
      planOptions: stripUndefined(planOptionsFromRequest(req.body || {})),
      targetReplicas,
      confirmScale: booleanValue(req.body?.confirmScale, false),
      dryRun: !booleanValue(req.body?.confirmScale, false) || booleanValue(req.body?.dryRun, true),
      reason: req.body?.reason || 'admin_operator_override',
      actor: req.auth.userId,
      actorRole: authToRole(req.auth),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      scaleOptions: scaleOptionsFromRequest(req.body || {}),
    });

    res.json(result);
  } catch (error) {
    if (error?.status === 409 && error.plan) {
      return sendError(res, 409, {
        error: error.message,
        plan: error.plan,
      });
    }
    routeError(res, error, 'POST /api/scale-operations/phase8/override');
  }
});

export default router;
