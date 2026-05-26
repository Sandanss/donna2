# Scalability Architecture

> Current scale posture for `zuludev`: legacy outbound runtime, queue/capacity rollout to 2,000 users, and the forward path to 10,000 users.

---

## Status Summary

Donna has **two outbound-call architectures right now**.

| Architecture | Status | Use |
|---|---|---|
| **Legacy scheduler/dialer** | Still present and kept as current/rollback authority | Good for today's smaller production load. It should not be scaled to 2,000 users by only raising `MAX_CONCURRENT_CALLS` or adding replicas. |
| **Queue + capacity architecture** | Implemented on `zuludev`, gated by rollout flags | The path to 2,000 active seniors with daily calls and bursty windows. |

The queue architecture is not "fully active" until production is running:

- `CALL_ARCHITECTURE_MODE=queue_primary`
- `CALL_QUEUE_ALLOW_REAL_DIAL=true`
- `CALL_QUEUE_DISPATCHER_ENABLED=true`
- `CALL_QUEUE_REQUIRE_DIAL_GUARD=true`
- `CALL_QUEUE_USE_CAPACITY_REGISTRY=true`
- `CALL_QUEUE_REQUIRE_CAPACITY_REGISTRY=true`
- Redis/shared state required for scaled Pipecat
- Phase 7/8 rollout evidence saved

Until then, the legacy and queue paths intentionally coexist.

---

## Target Milestones

| Milestone | Status | Design point |
|---|---|---|
| Today's runtime | Legacy scheduler + Pipecat, with queue code available behind flags | Lower-volume production and rollback |
| 2,000 active seniors | Active rollout target | Durable queue, capacity-aware dispatch, canary rollout, pre-window scaling |
| 10,000 active seniors | Forward path, not completed runtime | Partitioned/ops data plane, HA or multi-region Redis, caller-ID pool, provider sharding/failover, workflow-engine post-call execution |

The 2,000-user plan is [the scale plan](../plans/2026-05-18-scale-to-2000-users-technical-plan.md). The 10,000-user path is [scale plan §8](../plans/2026-05-18-scale-to-2000-users-technical-plan.md#8-forward-path-to-10000-users).

---

## Legacy Architecture

**Primary files:**

- `services/scheduler.js`
- `routes/calls.js`
- `services/telnyx.js`
- `pipecat/api/routes/telnyx.py`
- `pipecat/main.py`
- `pipecat/services/post_call.py`

**Flow:**

```
Node scheduler tick
    |
    v
Build due scheduled/reminder/welfare plan
    |
    v
Legacy in-process dedupe maps + local calling-window checks
    |
    v
POST Pipecat /telnyx/outbound
    |
    v
Telnyx call -> /telnyx/events -> /ws
    |
    v
Pipecat call pipeline
    |
    v
Inline post-call work, or queued heavy work when POST_CALL_QUEUE_ENABLED=true
```

**Known limits:**

- One Node scheduler leader performs planning and dialing.
- Several dedupe/cooldown decisions are in process memory.
- Legacy execution uses a fixed dial concurrency limit.
- Pipecat `MAX_CONCURRENT_CALLS` is per replica unless the queue dispatcher consumes the capacity registry.
- Post-call work normally runs inline after disconnect unless the queued post-call flag is enabled.
- Raising replica count multiplies DB pools and provider concurrency unless capped elsewhere.

The legacy path remains valuable as a rollback path, but it is not the target architecture for the 2,000-user burst.

---

## 2,000-User Architecture

The new architecture changes outbound calling from "find due calls and fire them" to "materialize eligible calls, lease them by priority, and dial only when global voice capacity is available."

```
Caregiver schedules / reminders
    |
    v
senior_call_schedules + reminder schedules
    |
    v
services/call-schedules.js materializer
    |
    v
call_queue
    |
    v
services/call-queue.js dispatcher
    |
    v
Redis capacity reservation + outbound_call_guards row
    |
    v
Pipecat /telnyx/outbound -> Telnyx -> /ws
    |
    v
call_attempts + post_call_jobs
```

### Queue Tables

| Table | Purpose |
|---|---|
| `senior_call_schedules` | Normalized recurring/one-time schedules derived from caregiver config |
| `call_queue` | Durable outbound dispatch queue with status, priority lane, lease, and dedupe key |
| `call_attempts` | Per-dispatch audit trail with `architecture`, `cohort`, and provider IDs |
| `outbound_call_guards` | Shared legacy/queue dial-authority guard |
| `scheduler_shadow_comparisons` | Side-by-side legacy/queue decision records during rollout |
| `post_call_jobs` | Gated post-call job DAG and dead-letter state |
| `canary_cohort_membership` | Phase 7 queue canary cohort source of truth |

Current migrations use flat default-schema tables. The `ops.*` schema and partitioning ideas in the scale plan are forward-compatible targets, not implemented on the current branch.

### Rollout Modes

`CALL_ARCHITECTURE_MODE` drives the migration:

| Mode | Legacy dials | Queue materializes | Queue dispatches | Queue places real calls |
|---|---|---|---|---|
| `legacy_only` | yes | no | no | no |
| `shadow_materialize` | yes | yes | no | no |
| `shadow_dispatch` | yes | yes | dry-run only | no |
| `canary_queue` | non-canary only | yes | canary cohort | yes, if allowed |
| `queue_primary` | no | yes | all eligible rows | yes |
| `legacy_rollback` | yes | no by default; existing queue rows retained for analysis | no | no |

`CALL_QUEUE_ALLOW_REAL_DIAL=true` is valid only in `canary_queue` or `queue_primary`.

### Dial Authority

`outbound_call_guards.guard_key` is the duplicate-call safety primitive. Legacy and queue paths build the same key for a call instance; only the process that wins the guard may dial. Current `call_attempts` writes are queue-dispatch owned; Pipecat lifecycle events update an attempt only when the outbound metadata includes a `queue_id`. The legacy scheduler does not currently persist `architecture='legacy'` attempt rows.

### Capacity Coordination

**Files:**

- `pipecat/services/capacity.py`
- `services/pipecat-capacity.js`
- `services/call-queue.js`
- `services/phase8-capacity-plan.js`

Pipecat publishes PHI-free heartbeats to Redis:

```
pipecat:instance:{instance_id}
```

Heartbeat fields include:

- `active_calls`
- `inbound_active_calls`
- `max_calls`
- `pending_start_count`
- `draining`
- `ready`
- `warmup_gate_green`
- `db_pool_idle`
- `circuit_breakers_open`

The dispatcher reads fresh heartbeats, excludes unready/draining replicas, subtracts active calls and pending reservations, applies lane policy, then acquires a short-lived reservation before dialing.

`services/pipecat-capacity.js` supports Redis, Upstash REST, or no shared registry. There is no local heartbeat-registry fallback. If the registry is absent and not required, the queue dispatcher falls back to configured batch-size capacity; if `CALL_QUEUE_REQUIRE_CAPACITY_REGISTRY=true`, missing shared state blocks queue dispatch.

Current queue lane reserves are code-defined in `services/call-queue.js` for:

- `manual`
- `hard_reminder`
- `reminder_retry`
- `scheduled_checkin`
- `welfare`
- `low_priority_retry`

Inbound calls are not leased through `call_queue`. They are accounted for through `inbound_active_calls` and total active-capacity subtraction.

### Redis Shared State

Redis is optional for single-instance development, but required for scaled Pipecat. Shared-state responsibilities:

- capacity heartbeats
- pending-start capacity reservations
- encrypted call metadata
- single-use WebSocket token state
- Telnyx stream-start dedupe
- rate-limit counters in scaled mode
- encrypted short-lived reminder/call context

When `PIPECAT_REQUIRE_REDIS=true`, Pipecat must fail closed if Redis/shared state is missing for operations that require shared state.

### Readiness And Autoscaling

**Files:**

- `pipecat/services/readiness.py`
- `pipecat/services/capacity.py`
- `services/phase8-capacity-plan.js`
- `services/phase8-autoscaler.js`
- `routes/scale-operations.js`

New Pipecat replicas should not count as available capacity until the warm-up gate is green. Phase 8 planning reads future `call_queue` demand plus live heartbeats and emits:

- `scale_up`
- `wait_for_readiness`
- `hold`
- `scale_down`

Autoscaling is dry-run by default. Railway actuation requires explicit confirmation and must remain inside the Phase 0 cost budget unless an operator override is approved and audited.

### Post-Call Scale Path

**Files:**

- `pipecat/services/post_call.py`
- `pipecat/services/post_call_jobs.py`
- `pipecat/services/post_call_job_worker.py`
- `services/post-call-jobs.js`
- `pipecat/scripts/run_post_call_worker_once.py`
- `scripts/run-post-call-worker-once.js`
- `routes/post-call-jobs.js`

The active runtime uses inline post-call work unless `POST_CALL_QUEUE_ENABLED=true`. The queued path writes a `post_call_jobs` DAG and the Pipecat worker executes the heavy jobs:

- `metrics_finalize`
- `reminder_recovery`
- `analysis`
- `memory_extraction`
- `daily_context`
- `caregiver_notifications`
- `interest_discovery`
- `snapshot_rebuild`

The Pipecat worker leases jobs with `FOR UPDATE SKIP LOCKED`, honors dependencies, retries with backoff, and moves exhausted jobs to `dead_letter`. The Node worker remains the PHI-free artifact-verification/shadow path. Provider/work limits are per worker process until a distributed limiter or worker-count cap is added.

### Canary Membership

**Files:**

- `services/canary-cohort.js`
- `routes/canary.js`
- `db/migrations/013_canary_cohort_membership.sql`

`canary_cohort_membership` is the steady-state source of truth for Phase 7 canary members in the integrated scheduler runtime, which merges DB membership with the env allowlist. `CALL_QUEUE_COHORT_ALLOWLIST` remains an emergency/env fallback, and a non-empty env allowlist or nonzero percent is still needed until the standalone dispatcher/config validator becomes DB-aware. Admin routes expose membership by senior ID and ramp phase only; they do not join names, phone numbers, reminder text, transcripts, or notes.

---

## 2,000-User Gates

The new architecture should not be declared ready for 2,000 users until all of these are true:

- Phase 0 evidence exists: 7-day baseline, vendor limits, cost model, caller-ID decision, migration timing.
- Phase 1 queue/idempotency migrations have been applied safely or explicitly accepted as flat-table rollout.
- Phase 3 scaled Pipecat primitives are verified under actual multi-replica Railway behavior.
- Phase 5 live A/B and rollback drill have saved timings.
- Phase 6 post-call stampede evidence exists with real provider caps and DB pool observations.
- Phase 7 live canary has 7 clean days and saved daily reports.
- Phase 8 capacity planning has dry-run and confirmed operator-reviewed evidence.
- PHI sentinel scans are clear for logs, queue rows, Redis payloads, scripts, and reports.

---

## Path To 10,000 Users

The 10,000-user path is incremental from the queue architecture. It is **not** complete runtime support today.

| Transition | Trigger | Action |
|---|---|---|
| Operational table partitioning or `ops.*` schema | DB pool/write-pressure SLO breaches during burst, or roughly 3,000 daily users | Move hot queue/job/attempt tables to a dedicated operational schema or partitioned layout with an online migration plan. |
| Redis Cluster / HA shared state | Redis incident, multi-region Pipecat, or shared-state latency/reliability pressure | Move from single-region key assumptions to HA or multi-region Redis and add region-aware key/schema routing. |
| Caller-ID pool and reputation management | Answer rate falls below the Phase 0 baseline target as outbound volume grows | Add managed number pool, STIR/SHAKEN/reputation monitoring, and cohort-aware caller-ID assignment. |
| Provider sharding/failover | Sustained STT/LLM/TTS/embedding 429s despite concurrency caps | Add provider routing/failover across STT, TTS, LLM, and embedding providers. |
| Workflow-engine post-call execution | Post-call backlog, retries, or dead-letter operations outgrow the Postgres worker | Promote the Phase 6 DAG to Temporal, Inngest, or equivalent while keeping DB metadata/audit. |
| Archive and retention tiering | Audit/log/storage cost grows faster than budget | Add archive lifecycle for old audit/log/job data while preserving HIPAA retention and export/delete semantics. |
| Multi-region Pipecat | Latency/product signal requires it, not just capacity | Add region-aware queue routing, shared-state keys, Telnyx routing, and data-residency review. |

The main discipline for 10k is the same as for 2k: do not count a future design as complete until runtime code, migration plan, operational runbook, and evidence exist.

---

## Key Files

| File | Purpose |
|---|---|
| `services/scheduler.js` | Legacy scheduler/dialer plus dual-path materialization/dispatch orchestration |
| `services/call-schedules.js` | Schedule normalization/materialization |
| `services/call-queue.js` | Queue enqueue, lease, lane policy, guard, dispatcher, reconciler |
| `services/pipecat-capacity.js` | Node reader/writer for Pipecat heartbeats and reservations |
| `pipecat/services/capacity.py` | Pipecat heartbeat publisher and reservation cleanup |
| `pipecat/services/readiness.py` | Replica warm-up/readiness gate |
| `services/post-call-jobs.js` | Post-call job DAG, leases, retries, dead-letter handling |
| `services/canary-cohort.js` | Phase 7 canary cohort source of truth |
| `services/phase8-autoscaler.js` | Capacity planner actuator and Railway scale wrapper |
| `routes/scale-operations.js` | Admin capacity planning and override API |
| `routes/canary.js` | Admin canary membership API |
| `services/phase8-capacity-plan.js` | PHI-free pre-window capacity plan |
| `docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md` | Full 2,000-user plan and 10k path |

---

## Historical Notes

Older scalability docs and load tests refer to 8,000 users, 500 concurrent calls, Twilio media streams, and mock Twilio load tests. Treat those as historical unless a current architecture document or runtime file marks them active. The current scale milestone is 2,000 active seniors, with a documented forward path to 10,000.
