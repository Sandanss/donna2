import { buildPhase8CapacityPlan } from './phase8-capacity-plan.js';
import { writeAudit } from './audit.js';
import { applyRailwayScale } from './railway-scaling.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Phase8Autoscaler');

const DEFAULT_AUTOSCALER_TICK_MS = 60_000;

function integerValue(value, defaultValue = 0, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeReasonCode(value, fallback = 'operator_override') {
  const sanitized = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, '_')
    .slice(0, 120);
  return sanitized || fallback;
}

function checkStatus(plan, name) {
  return (plan?.checks || []).find(check => check.name === name)?.status || null;
}

export function shouldApplyPhase8ScaleRecommendation(plan) {
  const recommendation = plan?.recommendation || {};
  const action = recommendation.action;

  if (action === 'scale_up') {
    const budgetStatus = checkStatus(plan, 'hourly_cost_budget');
    if (budgetStatus === 'failed') {
      return {
        apply: false,
        reason: 'hourly_cost_budget_failed',
      };
    }
    return {
      apply: recommendation.scaleUpBy > 0,
      reason: recommendation.scaleUpBy > 0 ? 'scale_up_recommended' : 'target_already_reached',
    };
  }

  if (action === 'scale_down') {
    return {
      apply: recommendation.scaleDownBy > 0 && recommendation.scaleDownSafe === true,
      reason: recommendation.scaleDownSafe === true
        ? 'scale_down_recommended'
        : 'scale_down_guard_blocked',
    };
  }

  return {
    apply: false,
    reason: action || 'no_recommendation',
  };
}

export async function runPhase8AutoscalerOnce({
  planOptions = {},
  confirmScale = false,
  dryRun = true,
  scaleExecutor = applyRailwayScale,
  scaleOptions = {},
  now = new Date(),
} = {}) {
  const plan = await buildPhase8CapacityPlan({
    ...planOptions,
    now,
  });
  const decision = shouldApplyPhase8ScaleRecommendation(plan);
  const resolvedDryRun = !confirmScale || dryRun;

  if (!decision.apply) {
    return {
      ok: plan.ok,
      applied: false,
      dryRun: resolvedDryRun,
      decision,
      plan,
      scaleOperation: null,
      phiPolicy: {
        outputContainsRawPhi: false,
      },
    };
  }

  const scaleOperation = await scaleExecutor({
    ...scaleOptions,
    targetReplicas: plan.recommendation.targetReplicas,
    reason: `phase8_autoscaler:${plan.recommendation.reason}`,
    dryRun: resolvedDryRun,
    now,
  });

  return {
    ok: plan.ok && scaleOperation.ok,
    applied: scaleOperation.applied,
    dryRun: scaleOperation.dryRun,
    decision,
    plan,
    scaleOperation,
    phiPolicy: {
      outputContainsRawPhi: false,
    },
  };
}

export async function applyOperatorScaleOverride({
  planOptions = {},
  targetReplicas,
  confirmScale = false,
  dryRun = true,
  reason = 'operator_override',
  actor = 'unknown',
  actorRole = 'admin',
  ipAddress = null,
  userAgent = null,
  auditWriter = writeAudit,
  scaleExecutor = applyRailwayScale,
  scaleOptions = {},
  now = new Date(),
} = {}) {
  const plan = await buildPhase8CapacityPlan({
    ...planOptions,
    now,
  });
  const safeTarget = integerValue(targetReplicas, -1, { min: 0, max: 50 });
  if (safeTarget < 0) {
    const error = new Error('targetReplicas must be a non-negative integer');
    error.status = 400;
    throw error;
  }

  const currentReplicas = integerValue(plan.capacity?.currentReplicas, 0, { min: 0, max: 50 });
  const direction = safeTarget > currentReplicas
    ? 'scale_up'
    : safeTarget < currentReplicas
      ? 'scale_down'
      : 'hold';

  if (direction === 'scale_down' && plan.recommendation?.scaleDownSafe !== true) {
    const error = new Error('Scale-down is blocked while demand, active calls, reservations, or critical post-call backlog remain');
    error.status = 409;
    error.plan = plan;
    throw error;
  }

  const scaleOperation = direction === 'hold'
    ? {
      ok: true,
      applied: false,
      dryRun: true,
      reason: 'target_matches_current_replicas',
      targetReplicas: safeTarget,
    }
    : await scaleExecutor({
      ...scaleOptions,
      targetReplicas: safeTarget,
      reason: `operator_override:${safeReasonCode(reason)}`,
      dryRun: !confirmScale || dryRun,
      now,
    });

  if (auditWriter) {
    // Wrap audit in try/catch so a failed audit doesn't mask the actual
    // scale result the operator needs to see. Railway already scaled by
    // the time we get here; logging the audit failure beats throwing a
    // 500 that hides what happened.
    try {
      await auditWriter({
        userId: actor,
        userRole: actorRole,
        action: 'update',
        resourceType: 'scale_operation',
        resourceId: null,
        ipAddress,
        userAgent,
        metadata: {
          operation: 'phase8_operator_override',
          direction,
          targetReplicas: safeTarget,
          currentReplicas,
          dryRun: Boolean(scaleOperation.dryRun),
          applied: Boolean(scaleOperation.applied),
          reason: safeReasonCode(reason),
        },
      });
    } catch (error) {
      log.warn('Phase 8 operator override audit failed', { error: error.message });
    }
  }

  return {
    ok: scaleOperation.ok,
    direction,
    targetReplicas: safeTarget,
    currentReplicas,
    plan,
    scaleOperation,
    phiPolicy: {
      outputContainsRawPhi: false,
    },
  };
}

export function startPhase8AutoscalerWorker({
  enabled = process.env.PHASE8_AUTOSCALER_ENABLED === 'true',
  tickMs = integerValue(process.env.PHASE8_AUTOSCALER_TICK_MS, DEFAULT_AUTOSCALER_TICK_MS, { min: 10_000, max: 3_600_000 }),
  confirmScale = process.env.PHASE8_AUTOSCALER_CONFIRM_SCALE === 'true',
  dryRun = process.env.PHASE8_AUTOSCALER_DRY_RUN !== 'false',
  planOptions = {},
  scaleOptions = {},
  runOnce = runPhase8AutoscalerOnce,
} = {}) {
  if (!enabled) {
    return {
      enabled: false,
      stop: () => {},
    };
  }

  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runOnce({
        planOptions,
        confirmScale,
        dryRun,
        scaleOptions,
      });
      const action = result.plan?.recommendation?.action;
      if (result.applied || action === 'scale_up' || action === 'scale_down' || !result.ok) {
        log.info('Phase 8 autoscaler tick', {
          ok: result.ok,
          action,
          applied: result.applied,
          dryRun: result.dryRun,
          targetReplicas: result.plan?.recommendation?.targetReplicas,
        });
      }
    } catch (error) {
      log.error('Phase 8 autoscaler tick failed', {
        error: error.message,
      });
    } finally {
      running = false;
    }
  }

  void tick();
  const interval = setInterval(() => void tick(), tickMs);
  interval.unref?.();

  return {
    enabled: true,
    tickMs,
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export function phase8PlanOptionsFromEnv(env = process.env) {
  return {
    windowMinutes: integerValue(env.PHASE8_WINDOW_MINUTES, 15, { min: 1, max: 240 }),
    currentReplicas: env.PHASE8_CURRENT_REPLICAS == null
      ? null
      : integerValue(env.PHASE8_CURRENT_REPLICAS, null, { min: 0, max: 50 }),
    minReplicas: integerValue(env.PHASE8_MIN_REPLICAS, 2, { min: 0, max: 50 }),
    maxCallsPerReplica: integerValue(env.PHASE8_MAX_CALLS_PER_REPLICA, 50, { min: 1, max: 10000 }),
    overbookFactor: optionalNumber(env.PHASE8_OVERBOOK_FACTOR) ?? 1,
    warmupMinutes: integerValue(env.PHASE8_WARMUP_MINUTES, 20, { min: 1, max: 120 }),
    readyMinutesBeforeWindow: integerValue(env.PHASE8_READY_MINUTES_BEFORE_WINDOW, 10, { min: 1, max: 120 }),
    criticalBacklogThreshold: integerValue(env.PHASE8_CRITICAL_BACKLOG_THRESHOLD, 0, { min: 0, max: 100000 }),
    costPerReplicaHour: optionalNumber(env.PHASE8_COST_PER_REPLICA_HOUR),
    hourlyBudget: optionalNumber(env.PHASE8_HOURLY_BUDGET),
  };
}
