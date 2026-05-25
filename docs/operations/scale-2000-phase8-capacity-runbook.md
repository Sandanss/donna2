# Scale 2000 Phase 8 Capacity Runbook

Purpose: plan scheduled Pipecat capacity before known call windows, using only aggregate operational counters.

This runbook is for Phase 8 after the Phase 7 canary exit gates are met. It does not dial calls. Capacity planning is always PHI-free; Railway scaling is dry-run by default and requires explicit confirmation.

## Inputs

- Future `call_queue` rows for the target window.
- Pipecat capacity heartbeats from Redis or Upstash.
- Critical post-call backlog count for `metrics_finalize` and `reminder_recovery`.
- Phase 0 hourly cost budget and current Railway replica count.

The report must remain PHI-free. It reads and emits counts only: lane counts, status counts, replica capacity, readiness, backlog, and budget math.

## Pre-Window Plan

Run at least 30 minutes before a known call window:

```bash
npm run phase8:capacity-plan -- \
  --window-start=2035-03-18T14:00:00.000Z \
  --window-minutes=15 \
  --current-replicas=2 \
  --max-calls-per-replica=50 \
  --warmup-minutes=20 \
  --ready-minutes-before-window=10 \
  --cost-per-replica-hour=0.12 \
  --hourly-budget=1.00
```

Read `recommendation.action`:

- `scale_up`: scale Pipecat to `recommendation.targetReplicas`.
- `wait_for_readiness`: do not count the current replicas as usable yet. Investigate replicas whose warm-up gate is not green.
- `hold`: keep the current replica count.
- `scale_down`: scale to `recommendation.targetReplicas` only if the runbook operator confirms the output checks are passing.

## Autoscaler Tick

Run the same plan through the autoscaler actuator in dry-run mode:

```bash
npm run phase8:autoscaler-once -- \
  --window-start=2035-03-18T14:00:00.000Z \
  --current-replicas=2 \
  --max-calls-per-replica=50 \
  --cost-per-replica-hour=0.12 \
  --hourly-budget=1.00
```

To apply the recommendation to Railway, pass `--confirm-scale` and identify the Pipecat service/environment/region:

```bash
npm run phase8:autoscaler-once -- \
  --confirm-scale \
  --service=donna-pipecat \
  --environment=production \
  --region=us-west \
  --window-start=2035-03-18T14:00:00.000Z \
  --current-replicas=2
```

The actuator uses `railway scale REGION=REPLICAS --service <service> --environment <environment> --json`. The command updates replica configuration without a redeploy.

The long-running Node autoscaler loop is disabled by default. Enable it only after Phase 7 exits cleanly:

```bash
PHASE8_AUTOSCALER_ENABLED=true
PHASE8_AUTOSCALER_CONFIRM_SCALE=true
PHASE8_AUTOSCALER_DRY_RUN=false
PHASE8_RAILWAY_SERVICE=donna-pipecat
PHASE8_RAILWAY_ENVIRONMENT=production
PHASE8_RAILWAY_REGION=us-west
PHASE8_COST_PER_REPLICA_HOUR=0.12
PHASE8_HOURLY_BUDGET=1.00
```

Do not enable confirmed long-running actuation unless both budget env vars are set. If the budget inputs are missing, the code marks the budget check as skipped; only a `failed` budget check blocks scale-up.

## Scale-Up Gate

Scale-up should happen by `recommendation.scaleUpAt`. The target capacity must be ready by `recommendation.targetReadyAt`, which is 10 minutes before the call window by default.

The autoscaler or operator must not treat a Pipecat replica as available capacity unless the Phase 3 readiness gate reports green. The planner enforces this by excluding `warmupGateGreen=false` replicas from `capacity.availableSlots`.

## Scale-Down Gate

Scale down only when all of these are true in the report:

- `demand.total` is `0`.
- `capacity.activeCalls` is `0`.
- `capacity.pendingReservations` is `0`.
- `postCall.criticalBacklog` is at or below `postCall.criticalBacklogThreshold`.
- `recommendation.scaleDownSafe` is `true`.
- `hourly_cost_budget` is not `failed`.

If any active call, reservation, or critical post-call backlog exists, hold current capacity.

## Admin Override

The admin dashboard exposes **Scale Ops** for emergency operator actions. It calls:

- `GET /api/scale-operations/phase8/plan`
- `POST /api/scale-operations/phase8/autoscale-once`
- `POST /api/scale-operations/phase8/override`

Overrides are dry-run unless the operator checks "Apply to Railway". Scale-down is rejected while demand, active calls, reservations, or critical post-call backlog remain unless a future code change explicitly adds a reviewed force path.

Example plan request:

```bash
curl -G https://donna-api-production-2450.up.railway.app/api/scale-operations/phase8/plan \
  -H 'Authorization: Bearer <admin-jwt>' \
  --data-urlencode 'windowStart=2035-03-18T14:00:00.000Z' \
  --data-urlencode 'windowMinutes=15' \
  --data-urlencode 'currentReplicas=2' \
  --data-urlencode 'maxCallsPerReplica=50' \
  --data-urlencode 'costPerReplicaHour=0.12' \
  --data-urlencode 'hourlyBudget=1.00'
```

Example one-shot autoscaler body:

```bash
curl -X POST https://donna-api-production-2450.up.railway.app/api/scale-operations/phase8/autoscale-once \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d '{
    "windowStart": "2035-03-18T14:00:00.000Z",
    "currentReplicas": 2,
    "maxCallsPerReplica": 50,
    "costPerReplicaHour": 0.12,
    "hourlyBudget": 1.00,
    "service": "donna-pipecat",
    "environment": "production",
    "region": "us-west",
    "confirmScale": false,
    "dryRun": true
  }'
```

Example operator override body:

```bash
curl -X POST https://donna-api-production-2450.up.railway.app/api/scale-operations/phase8/override \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d '{
    "targetReplicas": 4,
    "reason": "known_window_manual_override",
    "windowStart": "2035-03-18T14:00:00.000Z",
    "currentReplicas": 2,
    "costPerReplicaHour": 0.12,
    "hourlyBudget": 1.00,
    "service": "donna-pipecat",
    "environment": "production",
    "region": "us-west",
    "confirmScale": false,
    "dryRun": true
  }'
```

## Failure Response

- If `scale_up_schedule` fails, scale manually immediately and mark the window as late in the rollout notes.
- If `hourly_cost_budget` fails, do not increase replicas without founder approval for the revised Phase 0 budget.
- If `wait_for_readiness` persists past `recommendation.targetReadyAt`, pause the window or reduce the canary cohort before dispatch.
- If Redis or Upstash is unavailable, do not rely on capacity estimates. Keep minimum capacity and investigate shared-state health before moving queued traffic.
- If the Railway CLI is unavailable or unauthenticated, leave the autoscaler in dry-run and use the Railway dashboard manually.

## Evidence To Save

Save the JSON output under the rollout evidence folder for the test window. It must not contain senior IDs, phone numbers, transcripts, summaries, reminder text, notes, prompts, or payload bodies.
