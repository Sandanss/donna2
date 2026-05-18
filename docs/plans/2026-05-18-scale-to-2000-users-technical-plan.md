# Donna 2,000 User Burst Scaling Technical Plan

Date: May 18, 2026  
Status: Proposed implementation plan  
Primary surfaces: `services/scheduler.js`, `db/schema.js`, `pipecat/main.py`, `pipecat/api/routes/telnyx.py`, `pipecat/api/routes/call_context.py`, `pipecat/services/post_call.py`, Railway configuration

## Executive Summary

Donna can scale to 2,000 daily users, but the current architecture should not be scaled by simply raising `MAX_CONCURRENT_CALLS` and adding Pipecat replicas. The active scheduler is a single Node polling loop that discovers due work, deduplicates with in-memory sets, and fires calls with a fixed concurrency of 10. Pipecat admission control is per replica, Redis is optional, Telnyx webhook dedupe is local memory, post-call work runs inline after calls, and the database pools can multiply quickly as replicas are added.

The target architecture should change from "find due calls and fire them" to "materialize eligible calls into a durable queue, prioritize them, lease them, and dispatch only when global voice capacity is available." This plan introduces:

- A normalized schedule table and durable `call_queue`.
- A capacity-aware dispatcher with priority lanes and Postgres leasing.
- Redis-backed global Pipecat capacity heartbeats and slot reservations.
- Scheduled pre-scaling around 15-minute calling windows.
- Horizontal Pipecat replicas with Redis required, not optional.
- Multi-instance hardening for WebSocket tokens, Telnyx event dedupe, media-stream start, rate limits, and deploy draining.
- A queued post-call worker system so 600 calls ending near the same time do not stampede the database and AI vendors.
- Database constraints, indexes, pooling, and idempotency changes for concurrent writes.
- PHI-safe queue, Redis, logging, retention, and audit practices.

Contracts with Telnyx and ElevenLabs are necessary but not sufficient. We also need provider capacity and BAAs for Deepgram, Anthropic, Google/Gemini, OpenAI/Tavily if used during calls or post-call work, Resend for notifications, Neon, Railway, Sentry, and any cache/queue vendor that can hold PHI.

## Capacity Model

The user pattern we are planning for is not evenly distributed traffic. Most calls happen in common morning, afternoon, and evening windows, with high concurrency during those windows and empty capacity outside them.

Assumptions for the first scale target:

- 2,000 active seniors.
- One scheduled call per senior per day.
- Three common calling windows per day.
- Each window is 15 minutes.
- Average connected call duration is 10 minutes.
- We need 30 percent operational headroom.
- We need enough capacity for active AI calls and for outbound dial attempts that have not answered yet.

Capacity math:

| Scenario | Calls in 15-minute window | Average active call concurrency at 10 min calls | With 30 percent headroom |
| --- | ---: | ---: | ---: |
| Evenly split across 3 windows | 667 | 445 | 579 |
| Heavier single window | 1,000 | 667 | 867 |
| All 2,000 in one window | 2,000 | 1,333 | 1,733 |

Recommended initial target:

- Design the system for 600 concurrent active AI calls.
- Keep the design extensible to 900 without re-architecture.
- Treat 1,800 concurrent as a later enterprise-tier design point requiring higher provider contracts, more replicas, stronger database partitioning, and stricter call distribution policy.

Important nuance: active call concurrency and dial attempt concurrency are different. A call consumes Telnyx outbound capacity when Donna dials. It consumes Pipecat, STT, LLM, and TTS capacity only after a human answers and Telnyx starts the media stream. The first version should be conservative and reserve AI capacity before dialing. After measuring answer rate and answer latency, we can introduce a controlled overbooking factor.

## Current Architecture Snapshot

Runtime source of truth:

- Node/Express is the active frontend API and scheduler.
- Pipecat owns Telnyx WebSocket media, voice pipeline, call metadata, and post-call processing.
- Frontends never call Pipecat directly.
- Shared persistence is Neon PostgreSQL.
- Redis exists as optional shared state in Pipecat; single-instance fallback is in-memory.

Current scheduler behavior:

- `services/scheduler.js` runs one 60-second polling loop.
- A Postgres advisory lock elects one scheduler leader.
- The scheduler fetches due scheduled calls, due reminders, and welfare calls.
- It uses local memory for:
  - `welfareCalledToday`
  - `scheduleCalledToday`
  - `seniorLastCallTime`
  - reminder prewarm cache
- It executes the call plan with fixed concurrency `10`.
- Scheduled call definitions live in `seniors.preferred_call_times`, a JSON/JSON-encrypted field.
- Reminder and schedule discovery currently performs broad scans plus per-candidate lookups.

Current Pipecat capacity behavior:

- `pipecat/main.py` uses a local `asyncio.Semaphore(MAX_CALLS)`.
- `/health` and `/live` expose only local active calls and local max calls.
- WebSocket token validation is backed by local memory plus Redis if configured.
- `PIPECAT_REQUIRE_REDIS=true` exists, but Redis failures in some call-state paths still degrade toward local behavior rather than fail closed.

Current Telnyx multi-instance behavior:

- Telnyx webhook signature validation exists.
- Outbound metadata is keyed by Telnyx `call_control_id`.
- A single-use `ws_token` gates media WebSocket startup.
- Telnyx event dedupe currently uses `_recent_telnyx_event_ids`, a local in-memory dictionary.
- Media stream start uses a local lock and local `telnyx_stream_started` flag.

Current database behavior:

- Node uses Neon serverless `Pool` with default max 20.
- Pipecat uses asyncpg with default `DB_POOL_MIN=5`, `DB_POOL_MAX=50`.
- Existing indexes cover common conversation, memory, reminder, delivery, daily context, and analysis reads.
- `reminder_deliveries` has no visible unique idempotency key for one scheduled reminder instance.
- `conversations.call_sid` has an index, but it is not defined as unique in the shared schema.

Current post-call behavior:

- `pipecat/services/post_call.py` completes the conversation, runs analysis, extracts memories, updates reminders, clears caches, sends caregiver notifications, discovers interests, saves daily context, rebuilds snapshots, and persists metrics.
- Some independent steps run in parallel, but the whole orchestration still happens as part of call teardown.
- A burst of hundreds of calls ending close together will create a burst of database writes and AI/vendor calls.

Current deployment behavior:

- Root Railway config has `numReplicas = 1`.
- Pipecat Railway config does not set multiple replicas.
- Pipecat shutdown waits about 7 seconds for calls, but typical calls are minutes long.
- Scaling down or deploying during active calls can interrupt seniors unless we add an explicit drain workflow.

## Product Readiness Dependencies

This scaling plan assumes the core product flows are reliable enough to scale. It does not replace the pilot feature backlog. Before or alongside scale work, the remaining product-critical features are:

- Mobile login/signup and account recovery that work consistently with Clerk.
- Mobile onboarding that creates caregiver, senior, schedule, and reminder data through Node APIs.
- Reminder CRUD from mobile and web caregiver surfaces.
- Reminder delivery and acknowledgement during real Pipecat/Telnyx calls.
- Mobile schedule controls and manual call initiation.
- Inbound known-senior calls and inbound onboarding calls.
- Post-call analysis, summary, memory, notification, and observability flows that run reliably after live calls.
- Mobile no-crash/no-dead-end pass for caregiver workflows.
- Sensitive debug log cleanup before broader PHI-bearing traffic.

Scaling work should start with durable scheduling, capacity, and multi-instance safety because those are structural. Product work and scale work can run in parallel as long as the queue schema and call initiation contracts are stabilized early.

## Bottlenecks And Risks

### 1. Scheduler Discovery Is Not Built For Burst Windows

The current scheduler discovers due work each minute and tries to initiate it immediately. That approach breaks down when 667 calls become due in a 15-minute window.

Main issues:

- Fixed initiation concurrency of 10 cannot reliably fill a 600-call active pool during peak.
- Due work is not durable. If the leader restarts mid-cycle, in-memory dedupe and cooldown state are lost.
- The scheduler scans all active seniors to parse schedules from JSON.
- It performs per-senior and per-reminder queries inside loops.
- It has no concept of "queue lag", "deadline", "lease", or "capacity reservation".
- It cannot fairly choose between manual calls, medication reminders, scheduled check-ins, welfare calls, and retries under constrained capacity.

### 2. In-Memory Dedupe Is Unsafe At Scale

`welfareCalledToday`, `scheduleCalledToday`, `seniorLastCallTime`, reminder prewarm cache, Telnyx event dedupe, and media-stream start protection are all local to one process today.

This is safe only when there is one scheduler and one Pipecat instance. It is not safe when:

- Node restarts during a dispatch window.
- More than one Node instance is deployed.
- More than one Pipecat replica receives Telnyx webhooks.
- Telnyx retries webhooks and a different replica handles the retry.
- A media stream start condition is satisfied by two webhook events on two replicas.

### 3. Pipecat Capacity Is Local, Not Global

The current semaphore correctly protects one Pipecat process, but the scheduler cannot know total capacity across replicas by querying a load-balanced `/health`. It needs per-instance capacity, drain state, and freshness.

Without global capacity:

- The scheduler can over-dial and cause capacity rejections after seniors answer.
- One hot replica can reject calls while other replicas are idle.
- Scale-down can happen while calls are active.
- We cannot reserve capacity before dispatch.

### 4. Redis Is Optional, But Horizontal Voice Requires It

Pipecat has Redis support for call metadata and WebSocket token claims, but it also has local fallback behavior. For a single replica, this is useful. For multiple replicas, it is dangerous.

At horizontal scale, Redis must be a required dependency for:

- call metadata
- WebSocket token consumption
- Telnyx event dedupe
- media-stream start locks
- capacity heartbeats
- pending start reservations
- distributed rate limits
- shared prewarm/context cache

If Redis is required and unavailable, Pipecat should fail readiness and stop admitting calls rather than proceed in a split-brain mode.

### 5. Post-Call Work Can Stampede The Database And Vendors

If 600 calls end within a short period, the current inline post-call orchestration can create a synchronized burst of:

- conversation completion writes
- transcript encryption writes
- Gemini analysis requests
- memory extraction requests
- embedding writes
- reminder delivery updates
- notification creation
- daily context inserts
- snapshot rebuilds
- call metrics inserts

The voice pipeline should finish the call cleanly, persist the minimum critical state, and enqueue heavier work for controlled workers.

### 6. Database Connection Multiplication Can Exhaust Neon

At the current defaults:

- 10 Pipecat replicas * `DB_POOL_MAX=50` = up to 500 Pipecat database connections.
- Node instances and post-call workers add more.
- Load tests already documented direct Neon connection limits around high concurrency.

The database plan must use Neon pooled connections, lower per-replica pools, worker-level concurrency caps, and query/index changes that reduce both connection count and write amplification.

### 7. Hot Tables Need Idempotency And Indexes

High-concurrency windows will stress:

- `conversations`
- `reminder_deliveries`
- `call_analyses`
- `memories`
- `daily_call_context`
- `call_metrics`
- `notifications`
- `audit_logs`
- new queue and job tables

The highest-risk concurrent write cases are duplicate conversations for the same call, duplicate reminder delivery rows for the same reminder instance, duplicate call attempts, duplicate post-call jobs, and webhook/event replay.

### 8. Deploy And Scale-Down Safety Is Too Short For Live Calls

Current Pipecat shutdown waits seconds. Senior calls last minutes. Horizontal scaling needs a drain protocol:

- stop admitting new calls
- wait for active calls to finish or reach a max age
- only then terminate the instance

### 9. Observability Is Missing Scheduler And Capacity SLOs

Today we can see local active calls and some call metrics. At 2,000 users we need operational dashboards and alerts for:

- queue depth by lane
- queue age and deadline risk
- global active calls
- per-instance capacity and drain status
- pending start reservations
- Telnyx errors and answer rates
- provider concurrency and rate limits
- database pool usage and slow queries
- post-call job backlog
- duplicate suppression events

## Target Architecture

The target design has four planes:

1. Schedule materialization: turn caregiver schedules and reminder schedules into durable queue entries.
2. Dispatch: lease eligible queue entries by priority and capacity, then ask Pipecat to dial.
3. Voice runtime: Pipecat replicas handle admitted media streams with Redis-backed global state.
4. Post-call processing: queue expensive work and process it under explicit concurrency limits.

```
Caregiver schedules / reminders
          |
          v
senior_call_schedules + reminder schedules
          |
          v
Schedule materializer  --->  call_queue
                                  |
                                  v
Capacity-aware dispatcher  --->  Redis capacity reservations
                                  |
                                  v
Node -> Pipecat /telnyx/outbound -> Telnyx -> /telnyx/events -> /ws
                                  |
                                  v
                         minimal completion writes
                                  |
                                  v
                           post_call_jobs
                                  |
                                  v
                     throttled post-call workers
```

## Data Model Changes

### `senior_call_schedules`

Move scheduled calls out of `seniors.preferred_call_times.schedule` for runtime dispatch. Keep the JSON field only as legacy/profile input during migration.

Suggested columns:

- `id uuid primary key`
- `senior_id uuid not null references seniors(id)`
- `source_profile_hash text`
- `title text`
- `call_type text not null default 'schedule'`
- `timezone text not null`
- `target_local_time time not null`
- `window_minutes integer not null default 15`
- `frequency text not null`
- `days_of_week integer[]`
- `one_time_date date`
- `priority_lane text not null default 'scheduled_checkin'`
- `reminder_ids uuid[]`
- `context_notes_encrypted text`
- `next_run_at timestamp not null`
- `last_materialized_for timestamp`
- `is_active boolean not null default true`
- `created_at timestamp default now()`
- `updated_at timestamp default now()`

Indexes:

- `(is_active, next_run_at)`
- `(senior_id, is_active)`
- `(priority_lane, next_run_at)`

Notes:

- `context_notes` can be PHI and should not be stored in plaintext.
- The materializer should update `next_run_at` after it successfully creates queue entries.
- Schedule computation must use the senior timezone, not server timezone.

### `call_queue`

This is the durable source of truth for eligible outbound work.

Suggested columns:

- `id uuid primary key`
- `senior_id uuid not null references seniors(id)`
- `schedule_id uuid references senior_call_schedules(id)`
- `reminder_id uuid references reminders(id)`
- `call_type text not null`
- `priority_lane text not null`
- `priority_score integer not null default 0`
- `target_at timestamp not null`
- `earliest_at timestamp not null`
- `latest_at timestamp not null`
- `status text not null`
- `dedupe_key text not null`
- `lease_owner text`
- `lease_expires_at timestamp`
- `attempt_count integer not null default 0`
- `last_attempt_id uuid`
- `last_error_code text`
- `last_error_at timestamp`
- `cancel_reason text`
- `created_at timestamp default now()`
- `updated_at timestamp default now()`

Statuses:

- `queued`
- `leased`
- `initiating`
- `started`
- `completed`
- `deferred`
- `failed`
- `cancelled`
- `expired`

Indexes and constraints:

- Unique `dedupe_key`.
- `(status, priority_lane, earliest_at)`.
- `(status, latest_at)`.
- `(senior_id, status)`.
- `(lease_expires_at)` for lease recovery.

PHI rule:

- Do not store reminder title, medical notes, transcript snippets, caregiver notes, or raw schedule context in this table.
- Store IDs, timestamps, lane, and operational status only.
- If operator-facing explanation is needed, derive it after authorization from source tables.

### `call_attempts`

Every attempt to dial a queue entry gets its own record.

Suggested columns:

- `id uuid primary key`
- `queue_id uuid not null references call_queue(id)`
- `senior_id uuid not null references seniors(id)`
- `attempt_number integer not null`
- `provider text not null default 'telnyx'`
- `call_control_id text`
- `status text not null`
- `reservation_id text`
- `reserved_capacity integer not null default 1`
- `dial_started_at timestamp`
- `answered_at timestamp`
- `media_started_at timestamp`
- `ended_at timestamp`
- `provider_error_code text`
- `provider_error_class text`
- `created_at timestamp default now()`
- `updated_at timestamp default now()`

Indexes and constraints:

- Unique `(queue_id, attempt_number)`.
- Unique `call_control_id` where not null.
- `(status, created_at)`.
- `(senior_id, created_at desc)`.

### `post_call_jobs`

Move heavy post-call work out of call teardown.

Suggested columns:

- `id uuid primary key`
- `conversation_id uuid`
- `call_sid text not null`
- `senior_id uuid`
- `job_type text not null`
- `status text not null`
- `priority integer not null default 0`
- `dedupe_key text not null`
- `payload_encrypted text`
- `attempt_count integer not null default 0`
- `lease_owner text`
- `lease_expires_at timestamp`
- `last_error_code text`
- `last_error_at timestamp`
- `run_after timestamp not null default now()`
- `created_at timestamp default now()`
- `updated_at timestamp default now()`

Indexes and constraints:

- Unique `dedupe_key`.
- `(status, priority, run_after)`.
- `(lease_expires_at)`.
- `(senior_id, created_at desc)`.

Job types:

- `analysis`
- `memory_extraction`
- `reminder_recovery`
- `daily_context`
- `snapshot_rebuild`
- `caregiver_notifications`
- `interest_discovery`
- `metrics_finalize`

Critical-path exception:

- Conversation completion and final transcript persistence should still happen immediately at call end.
- Reminder acknowledgement already made during the call should remain immediate.
- Reminder recovery from transcript can be a high-priority post-call job if the immediate path cannot complete quickly.

### Idempotency Constraints For Existing Tables

Add or verify:

- Unique `conversations.call_sid` where `call_sid is not null`.
- Unique reminder delivery key for one reminder instance. The safest option is a new `delivery_key` generated from `reminder_id` plus normalized `scheduled_for`, because the current scheduler uses a tolerance window.
- Unique `call_metrics.call_sid` if one metrics row per call is intended.
- Index `audit_logs(created_at)` already exists in Pipecat migrations; for high write volume consider time partitioning or a BRIN index.

## Scheduler Redesign

### Components

Split the current scheduler into four workers. They can initially run inside the Node service, but the code should make it easy to move them to a dedicated worker service later.

The materializer and reconciler can remain singleton workers behind an advisory lock. The dispatcher should not require a singleton leader once `FOR UPDATE SKIP LOCKED` leasing is in place; multiple dispatcher workers are how we fill peak capacity quickly without duplicate calls.

1. Schedule materializer
   - Runs ahead of each dispatch window.
   - Creates queue rows for scheduled calls and reminder calls.
   - Uses unique `dedupe_key` so restarts are safe.
   - Does not call Telnyx.

2. Context prewarmer
   - Runs after queue materialization and before dispatch.
   - Preloads context for soon-to-dispatch queue entries.
   - Stores PHI-bearing context only in encrypted Redis/shared-state payloads with short TTL, or references existing encrypted DB rows.

3. Capacity-aware dispatcher
   - Leases queue rows using `FOR UPDATE SKIP LOCKED`.
   - Reads global Pipecat capacity from Redis.
   - Reserves capacity before dialing.
   - Calls Pipecat `/telnyx/outbound`.
   - Writes `call_attempts`.
   - Updates queue status.

4. Reconciler
   - Recovers expired leases.
   - Releases stale capacity reservations.
   - Marks queue rows expired after `latest_at`.
   - Requeues retryable provider failures with backoff.
   - Cancels queued calls for inactive seniors or paused caregivers.

### Queue Leasing

Use Postgres row locking for durable concurrency:

```sql
WITH candidates AS (
  SELECT id
  FROM call_queue
  WHERE status = 'queued'
    AND earliest_at <= now()
    AND latest_at > now()
  ORDER BY
    CASE priority_lane
      WHEN 'manual' THEN 1
      WHEN 'hard_reminder' THEN 2
      WHEN 'reminder_retry' THEN 3
      WHEN 'scheduled_checkin' THEN 4
      WHEN 'welfare' THEN 5
      ELSE 6
    END,
    priority_score DESC,
    target_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE call_queue q
SET status = 'leased',
    lease_owner = $2,
    lease_expires_at = now() + interval '60 seconds',
    updated_at = now()
FROM candidates
WHERE q.id = candidates.id
RETURNING q.*;
```

This lets multiple dispatcher workers run safely without duplicate calls.

### Priority Lanes

Recommended lanes:

| Lane | Purpose | Deadline behavior |
| --- | --- | --- |
| `manual` | Caregiver/admin "call now" | Dispatch immediately if any reserved manual capacity exists. |
| `hard_reminder` | Medication/appointment reminders with hard times | Dispatch closest to target and protect capacity. |
| `reminder_retry` | Retry after missed/no-ack reminder | Dispatch before retry deadline. |
| `scheduled_checkin` | Normal scheduled companion calls | Smooth within 15-minute window. |
| `welfare` | Seniors without recent completed calls | Best effort within safe calling hours. |
| `low_priority_retry` | Catch-up and non-urgent retries | Only use spare capacity. |

Initial reserved capacity policy at 600 total active slots:

- Manual/inbound reserve: 10 percent.
- Hard reminders: 35 percent.
- Reminder retries: 15 percent.
- Scheduled check-ins: 35 percent.
- Welfare and low-priority catch-up: 5 percent.

Unused higher-priority capacity can spill downward. Lower-priority lanes should not consume protected manual or hard-reminder reserve unless an explicit emergency override is enabled.

### Dispatch Window Rules

For a 15-minute scheduled window:

- Materialize calls at least 45 minutes ahead.
- Set `earliest_at = target_at - 7.5 minutes`.
- Set `latest_at = target_at + 7.5 minutes` for normal check-ins.
- Hard reminders can use tighter windows, for example `target_at - 2 minutes` to `target_at + 5 minutes`.
- Welfare calls can use a broad window and should be deprioritized under load.

Do not push all 667 calls exactly at the displayed time. Spread dispatch using a deterministic jitter derived from senior ID and schedule ID, bounded by the window.

### Capacity Reservation

Dispatcher algorithm:

1. Read Redis instance heartbeats.
2. Compute global capacity:
   - `healthy && !draining`
   - `sum(max_calls - active_calls - pending_start_reservations)`
3. Apply lane reservation policy.
4. Lease only as many queue rows as capacity allows.
5. Create Redis capacity reservation with TTL before dialing.
6. Ask Pipecat to create the Telnyx call and pass `queue_id` and `reservation_id`.
7. If Pipecat/Telnyx initiation fails, release reservation and mark retry/defer/fail.
8. If media starts, Pipecat converts reservation into active call.
9. If no answer, busy, failed, or terminal webhook arrives before media starts, release reservation.

Redis keys:

- `pipecat:instance:{instance_id}` hash, TTL 15 seconds.
- `pipecat:reservation:{reservation_id}` string/hash, TTL 2 to 5 minutes.
- `pipecat:queue-reservations:{queue_id}` for dedupe.

Conservative first version:

- One pending reservation consumes one AI slot.
- No overbooking.

Later optimization:

- Add `OUTBOUND_OVERBOOK_FACTOR`, for example `1.15`, based on measured answer rate and answer latency.
- Never overbook hard-reminder lane until we have production data.

## Pipecat Horizontal Scaling

### Instance Heartbeats

Each Pipecat replica should publish:

- `instance_id`
- `service_version`
- `active_calls`
- `max_calls`
- `pending_start_count`
- `draining`
- `healthy`
- `started_at`
- `updated_at`
- `db_pool_size`
- `db_pool_idle`
- `circuit_breakers_open`

Heartbeat interval:

- every 3 to 5 seconds
- Redis TTL 15 seconds

If heartbeat is stale, the dispatcher treats the instance as unavailable.

### Required Env

For scaled Pipecat:

- `PIPECAT_REQUIRE_REDIS=true`
- `REDIS_URL=...`
- `MAX_CONCURRENT_CALLS=75` initially per replica
- `DB_POOL_MIN=2`
- `DB_POOL_MAX=10` to `15`
- `LOG_LEVEL=INFO`
- `PIPECAT_DRAINING=false`
- `INSTANCE_ID` or generated stable process ID

Initial replica counts:

| Phase | Replicas | Max calls per replica | Total nominal capacity |
| --- | ---: | ---: | ---: |
| Off-peak | 2 | 75 | 150 |
| Normal peak | 8 | 75 | 600 |
| Headroom peak | 10 | 75 | 750 |
| Later heavy window | 12 | 75 | 900 |

The right per-replica limit must be validated by CPU, memory, audio latency, provider latency, and DB pool behavior. Do not assume 75 is safe without load testing.

### Multi-Instance Hardening

Required before multiple Pipecat replicas:

- Startup/readiness fails if `PIPECAT_REQUIRE_REDIS=true` and Redis is unavailable.
- WebSocket token consume must fail closed if Redis claim fails in scaled mode.
- Telnyx event dedupe moves from local memory to Redis:
  - key: `telnyx:event:{event_id}`
  - TTL: 10 minutes
  - operation: `SET NX EX`
- Media stream start uses Redis lock:
  - key: `telnyx:start_stream:{call_control_id}`
  - TTL: 2 minutes
  - operation: `SET NX EX`
- Call metadata reads should not silently use stale local-only state in scaled mode.
- Rate limits use Redis-backed stores on Node and Pipecat.
- Prewarm/context cache is shared or explicitly per-instance with safe fallback.
- `/health` should expose whether shared state is Redis and whether scaled mode is fail-closed.

### Deployment Draining

Add an operational drain workflow:

1. Mark instance `draining=true`.
2. `/live` can remain live, but `/health` should indicate no new admissions.
3. Dispatcher stops routing reservations to the instance.
4. Existing calls continue.
5. Wait until `active_calls=0` or a max drain timeout such as 15 minutes.
6. Terminate the instance.

Current 7-second shutdown is not enough for production voice calls. For Railway deploys, we should avoid deploying/scaling down during peak windows until drain orchestration is implemented and verified.

## Scheduled Auto Capacity

Recommended schedule for common windows:

| Time relative to window | Action |
| --- | --- |
| T-60 min | Confirm provider quota, Redis, DB, and Railway health. |
| T-45 min | Materialize `call_queue` for the window. |
| T-35 min | Compute expected capacity and required Pipecat replicas. |
| T-30 min | Begin context prewarm for high-priority and early-window calls. |
| T-20 min | Scale Pipecat replicas up. |
| T-10 min | Verify heartbeats show enough global capacity; page if short. |
| T-7.5 min | Begin dispatch for jittered calls whose `earliest_at` has arrived. |
| T to T+7.5 min | Continue priority/capacity-aware dispatch. |
| T+15 min | Stop dispatching newly expired normal check-ins; keep hard reminders/retries according to policy. |
| T+35 min | Start scale-down only if active calls and post-call backlog are low. |
| T+60 min | Return to off-peak baseline if healthy. |

Implementation options:

- First version: scheduled Railway scale changes through an operator script or cron-controlled worker.
- Better version: an autoscaler service reads future queue demand and calls the Railway API to set Pipecat replicas.
- Do not scale down based only on queue depth. Scale down only when active calls, pending reservations, and post-call critical backlog are low.

## Post-Call Queue Plan

The voice call teardown path should do only the minimum required work:

- complete the conversation record
- persist encrypted transcript/final status
- persist immediate reminder acknowledgement if available
- enqueue post-call jobs with idempotency keys
- release capacity reservation

Move these to workers:

- call analysis
- memory extraction
- embeddings
- daily context
- interest discovery
- snapshot rebuild
- caregiver notifications
- non-critical metrics enrichment

Worker controls:

- Separate worker concurrency per job type.
- Separate provider concurrency caps.
- Retry with exponential backoff and dead-letter state.
- Idempotent job dedupe by call SID plus job type.
- PHI payloads encrypted if stored in `post_call_jobs`.
- Prefer passing IDs and loading encrypted source data at execution time.

Initial concurrency caps:

| Job type | Initial concurrency | Reason |
| --- | ---: | --- |
| `reminder_recovery` | 50 | User-facing correctness; cheap DB work. |
| `metrics_finalize` | 50 | Operational visibility. |
| `caregiver_notifications` | 20 | Avoid notification provider spikes. |
| `analysis` | provider quota dependent | AI call; expensive. |
| `memory_extraction` | provider quota dependent | AI/embedding heavy. |
| `daily_context` | 25 | DB writes, moderate. |
| `snapshot_rebuild` | 10 | DB read/write heavy. |
| `interest_discovery` | 10 | Lower urgency. |

SLOs:

- Conversation completion: within 5 seconds of call end.
- Reminder recovery: within 2 minutes.
- Caregiver high-severity concern notifications: within 5 minutes after analysis.
- Normal call summary: within 15 minutes.
- Memory/snapshot freshness: within 30 minutes.

## Database Scaling Plan

### Connection Pooling

Use Neon pooled connection strings for runtime services.

Initial pool settings:

- Pipecat: `DB_POOL_MIN=2`, `DB_POOL_MAX=10` to `15` per replica.
- Node API/scheduler: `DB_POOL_MAX=20` initially; reduce if scheduler moves to worker.
- Post-call workers: separate pool max per worker service, likely 10 to 20.

Rules:

- Do not let total theoretical connections exceed Neon pooler guidance.
- Track actual `pool.size`, `pool.idle`, query latency, and timeout errors.
- Prefer short transactions and batched operations.
- Do not hold DB connections while calling Telnyx, LLMs, STT, TTS, or notification vendors.

### Query Changes

Replace broad scans and N+1 loops:

- Use `senior_call_schedules.next_run_at` instead of scanning all `seniors.preferred_call_times`.
- Generate queue rows in bulk.
- Query pending reminders in batches by senior ID and time window.
- Replace per-candidate delivery checks with set-based joins.
- Keep encrypted PHI reads out of scheduler dispatch where possible.
- Move PHI context hydration to prewarm or Pipecat, not queue planning.

### Write Hotspot Controls

Use idempotent writes:

- `call_queue.dedupe_key`
- `call_attempts(queue_id, attempt_number)`
- `call_attempts.call_control_id`
- `post_call_jobs.dedupe_key`
- reminder delivery unique key
- conversation unique `call_sid`

Use write shaping:

- Batch queue materialization.
- Cap post-call workers.
- Prefer append-only attempt/job rows over repeatedly updating hot rows when possible.
- Update aggregate counters asynchronously, not during call admission.

### Retention

Extend retention and deletion jobs to cover new tables:

- `call_queue`
- `call_attempts`
- `post_call_jobs`
- any scheduler event table
- Redis keys by TTL

Suggested retention:

- Operational queue rows: 90 days.
- Attempts: 180 days.
- Post-call jobs: 180 days, or same as related conversation metadata if payload can contain PHI.
- Dead-letter rows with PHI encrypted and covered by legal hold/delete flows.

## Provider And Vendor Capacity Beyond Telnyx And ElevenLabs

Contracts with Telnyx and ElevenLabs are necessary for channels and TTS concurrency. Other architecture dependencies:

- Deepgram STT concurrency for active calls.
- Anthropic LLM concurrency and token-per-minute limits for conversation turns.
- Gemini/Google concurrency for Quick Observer and post-call analysis if enabled.
- OpenAI embeddings/news/search capacity if used in memory and context.
- Tavily search limits if in-call web search can be triggered under scale.
- Resend email throughput for caregiver notifications.
- Neon database tier, pooled connections, storage I/O, and write throughput.
- Railway CPU/memory/network quotas and replica limits.
- Redis/Upstash command throughput and memory.
- Sentry event quotas and PII controls.

HIPAA/compliance dependency:

- Any vendor that receives, stores, processes, or can observe PHI needs a BAA or must be removed/minimized from PHI paths before healthcare/enterprise launch.

## Multiple People Calling The Same Donna Number

A single Donna phone number is not a single physical line. With enough Telnyx inbound channel capacity, many people can call the same number at the same time.

How it works operationally:

- Telnyx creates a separate call object for each call.
- Each call has a unique `call_control_id`.
- Telnyx sends separate webhooks per call.
- Donna stores call metadata by `call_control_id`.
- Donna starts a separate media WebSocket per call.
- Pipecat authenticates each media stream with `call_control_id` plus a one-time `ws_token`.

What needs to scale:

- Telnyx inbound concurrent channels.
- Pipecat active WebSocket capacity.
- Redis call metadata lookup.
- STT/TTS/LLM concurrency.
- Database writes for each conversation.

Outbound nuance:

- Donna can place many outbound calls using the same caller ID if Telnyx allows the outbound concurrent channels.
- At high volume, using one caller ID for all calls may hurt answer rate or trigger carrier spam analytics.
- We should discuss branded calling, STIR/SHAKEN, call reputation monitoring, and possibly a managed number pool with Telnyx before large-scale outbound windows.

## Privacy And Security Requirements

Scaling must not weaken PHI controls.

Queue and scheduler:

- Store IDs, timestamps, status, and lane only in `call_queue`.
- Store PHI-bearing context notes only encrypted.
- Do not log senior names, phone numbers, reminder titles, medical notes, transcripts, caregiver notes, or prompt context from scheduler workers.
- Logs should use senior IDs only when needed, and preferably truncated or hashed in external observability.

Redis:

- Continue using encrypted shared-state payloads for call metadata and reminder context.
- TTL all PHI-bearing keys.
- Never store raw request bodies, raw transcripts, or raw provider payloads in Redis.
- Include new Redis keys in incident response and operational runbooks.

Audit:

- Context hydration for calls reads PHI and should continue to audit at system level.
- Exports/deletes must include any new PHI-bearing job/cache tables.
- High-risk export and deletion paths should fail closed if audit persistence fails.

Rate limits:

- Move Node and Pipecat rate limits from in-memory stores to Redis-backed stores before multiple public replicas.
- Service-to-service scheduler/Pipecat traffic should be authenticated with labeled `DONNA_API_KEYS`.

Logging:

- `LOG_LEVEL=INFO` in all public Railway environments.
- Load tests and staging smoke tests should include a log review for PHI leakage.

## Observability And Alerts

Add metrics:

- `call_queue_depth{lane,status}`
- `call_queue_oldest_age_seconds{lane}`
- `call_queue_deadline_risk_count{lane}`
- `call_dispatch_leased_total{lane}`
- `call_dispatch_started_total{lane}`
- `call_dispatch_failed_total{lane,error_class}`
- `call_capacity_global_available`
- `call_capacity_global_active`
- `call_capacity_pending_reservations`
- `pipecat_instance_active_calls{instance_id}`
- `pipecat_instance_draining{instance_id}`
- `telnyx_webhook_duplicate_total`
- `telnyx_stream_start_duplicate_suppressed_total`
- `post_call_job_depth{job_type,status}`
- `post_call_job_latency_seconds{job_type}`
- `db_pool_idle{service}`
- `db_slow_query_total{service}`
- `provider_rate_limited_total{provider}`

Alerts:

- Queue oldest age exceeds 3 minutes for hard reminders.
- Queue oldest age exceeds 10 minutes for scheduled calls.
- Global capacity below required capacity at T-10 minutes.
- Redis unavailable in scaled mode.
- DB pool idle below 10 percent for 5 minutes.
- Post-call critical backlog older than 5 minutes.
- Telnyx or TTS provider rate-limit errors exceed threshold.
- Any Pipecat instance still active during planned scale-down deadline.

Dashboard views:

- Current window demand versus capacity.
- Lane-level queue health.
- Per-instance Pipecat calls.
- Provider health.
- Post-call backlog.
- Database health.

## Implementation Phases

### Phase 0: Baseline And Guardrails

Goal: measure current system and prevent unsafe horizontal scaling.

Tasks:

- Add a documented scale target of 600 active calls for the first 2,000-user milestone.
- Set public environments to `LOG_LEVEL=INFO`.
- Verify Neon pooled URL usage.
- Add a config guard: if Pipecat replicas > 1 or `PIPECAT_REQUIRE_REDIS=true`, Redis failures fail readiness.
- Add metrics for current scheduler cycle duration, plan size, success/fail counts, and Pipecat active calls.
- Decide initial provider concurrency numbers for Deepgram, Anthropic/Gemini, ElevenLabs, and Telnyx.

Acceptance:

- We can see current call demand, active calls, and scheduler cycle duration in dev/staging.
- Scaled mode cannot accidentally run without Redis.

### Phase 1: Database Schema

Goal: create durable scheduling and idempotency primitives.

Tasks:

- Add `senior_call_schedules`.
- Add `call_queue`.
- Add `call_attempts`.
- Add `post_call_jobs`.
- Add unique/index changes for conversations, reminder deliveries, queue, attempts, and jobs.
- Add retention coverage for new tables.
- Add migrations in root DB path and Pipecat migration path if both runtime paths need visibility.

Acceptance:

- Migrations apply without table locks on production-sized data.
- Existing scheduler still runs while new tables are dark.
- Tests cover unique dedupe behavior.

### Phase 2: Schedule Normalization And Materialization

Goal: stop scanning schedule JSON at dispatch time.

Tasks:

- Backfill `senior_call_schedules` from encrypted/decrypted senior schedule data.
- Update senior schedule write paths to maintain normalized schedules.
- Build materializer worker.
- Materialize 15-minute windows with deterministic jitter.
- Materialize reminders into hard-reminder and retry lanes.
- Keep old scheduler as fallback behind feature flag.

Acceptance:

- 2,000 seniors can be materialized for a day quickly and idempotently.
- Re-running materializer creates no duplicate queue entries.
- Paused/inactive seniors are excluded or cancelled.

### Phase 3: Capacity-Aware Dispatcher

Goal: dispatch from queue only when capacity exists.

Tasks:

- Implement Postgres lease with `FOR UPDATE SKIP LOCKED`.
- Implement lane policy and protected capacity.
- Implement capacity reservation in Redis.
- Pass `queue_id` and `reservation_id` through Node -> Pipecat outbound request.
- Persist `call_attempts`.
- Add reconciler for expired leases/reservations.
- Feature flag dispatcher by environment.

Acceptance:

- Multiple dispatcher instances can run without duplicate calls.
- Manual lane can bypass lower-priority backlog.
- Queue lag remains bounded in mocked 667-call/15-minute test.

### Phase 4: Pipecat Multi-Instance Hardening

Goal: make Pipecat safe behind multiple replicas.

Tasks:

- Add Redis heartbeat and capacity registry.
- Require Redis in scaled mode and fail closed on Redis state failures.
- Move Telnyx event dedupe to Redis.
- Move stream-start lock to Redis.
- Make WebSocket token consume fail closed if Redis claim fails in scaled mode.
- Add drain flag and admission behavior.
- Add Redis-backed rate limiting.
- Update health/readiness payloads.

Acceptance:

- Duplicate webhook events routed to different replicas are deduped.
- Duplicate WebSocket token use is rejected across replicas.
- Stream start happens once per call.
- Draining replica gets no new reservations.

### Phase 5: Post-Call Queue

Goal: prevent post-call stampedes after burst windows.

Tasks:

- Persist minimal call completion immediately.
- Enqueue post-call jobs with idempotency keys.
- Implement worker leasing and retries.
- Add provider-specific concurrency caps.
- Prioritize reminder recovery and high-severity notifications.
- Add job metrics and dead-letter inspection.

Acceptance:

- 600 mocked call completions do not exhaust DB pools.
- Critical completion/reminder jobs meet SLOs.
- Analysis/memory backlog drains under configured limits.

### Phase 6: Scheduled Auto Capacity

Goal: provision capacity before known windows and safely scale down after.

Tasks:

- Build demand estimator from future `call_queue`.
- Implement scheduled scale-up for Pipecat replicas.
- Verify heartbeats before window.
- Implement scale-down guard using active calls, reservations, and backlog.
- Add runbook for manual override.

Acceptance:

- Pipecat is at target capacity 10 minutes before a test window.
- No scale-down happens while calls are active.
- Operators can see and override capacity state.

### Phase 7: Load Testing And Rollout

Goal: prove the architecture before real seniors depend on it.

Tests:

- 2,000 daily schedules, 667 in a 15-minute window.
- 600 active mocked Pipecat calls.
- Parallel dispatcher race with at least 4 dispatcher workers.
- Duplicate Telnyx webhooks across replicas.
- WebSocket token replay across replicas.
- Redis outage in scaled mode.
- DB pool saturation.
- 600 post-call completions in 5 minutes.
- Provider rate-limit simulations.
- Deploy/drain during active calls.
- PHI log review after load test.

Rollout:

- Dev mocked-provider test.
- Staging live provider small-window test.
- Production canary: 50 users.
- Production canary: 100 users.
- Production canary: 250 users.
- Production canary: 600 users in a planned window.
- 2,000 users after meeting queue, DB, provider, and post-call SLOs.

## Feature Flags And Configuration

Suggested flags:

- `CALL_SCHEDULER_MODE=legacy|queue`
- `CALL_QUEUE_MATERIALIZER_ENABLED=true|false`
- `CALL_QUEUE_DISPATCHER_ENABLED=true|false`
- `CALL_QUEUE_RECONCILER_ENABLED=true|false`
- `CALL_QUEUE_WINDOW_MINUTES=15`
- `CALL_DISPATCH_LEASE_SECONDS=60`
- `CALL_SLOT_RESERVATION_SECONDS=180`
- `CALL_DISPATCH_MAX_BATCH_SIZE=100`
- `CALL_DISPATCH_OVERBOOK_FACTOR=1.0`
- `CALL_LANE_POLICY_VERSION=v1`
- `POST_CALL_QUEUE_ENABLED=true|false`
- `POST_CALL_WORKER_ENABLED=true|false`
- `PIPECAT_REQUIRE_REDIS=true`
- `PIPECAT_DRAINING=true|false`
- `MAX_CONCURRENT_CALLS=75`
- `DB_POOL_MAX=10`
- `REDIS_RATE_LIMITS_ENABLED=true`

## Open Decisions

These do not block starting the implementation, but they should be decided before production rollout:

- Exact average call duration and p95 call duration to use for capacity.
- Expected answer rate by window and whether to allow dispatch overbooking.
- Whether 600 active calls is enough for launch or whether we want 900 from day one.
- Initial protected capacity percentages by lane.
- Whether post-call workers run inside Node/Pipecat or as a separate Railway worker service.
- Which vendor handles TTS at scale if ElevenLabs contract is not ready.
- Whether one outbound caller ID is acceptable or whether Telnyx should provide branded calling/number pool guidance.
- Whether Redis is Railway Redis or Upstash for production scale.
- Whether queue operational rows can be retained 90/180 days or need a shorter PHI-minimized retention policy.

## Initial Engineering Checklist

Recommended build order:

1. Add queue schema, attempt schema, job schema, indexes, and retention coverage.
2. Add schedule normalization/backfill from current senior schedules.
3. Build materializer behind a flag, with no call dispatch.
4. Build dispatcher against mocked Pipecat capacity.
5. Add Pipecat Redis heartbeats and scaled-mode fail-closed behavior.
6. Wire dispatcher to real Pipecat `/telnyx/outbound`.
7. Add Redis Telnyx event dedupe and stream-start lock.
8. Add post-call job queue and workers.
9. Add scheduled capacity estimator and manual scale runbook.
10. Run load tests and PHI log review.
11. Canary rollout.

## Definition Of Done For 2,000 Users

The architecture is ready for 2,000 users when:

- 667 calls can be scheduled inside a 15-minute window without duplicate queue rows.
- The dispatcher can run with multiple workers without duplicate call attempts.
- Pipecat can run multiple replicas with Redis required and no local-only split brain.
- The system can sustain 600 active mocked calls with acceptable latency and DB pool headroom.
- Queue lag stays inside lane-specific SLOs.
- 600 call endings do not overload post-call workers, AI providers, or Postgres.
- Scale-up happens before scheduled windows and scale-down drains live calls.
- Duplicate Telnyx webhooks and WebSocket token replays are suppressed across replicas.
- Logs and metrics remain PHI-safe under load.
- Retention/export/delete/audit behavior covers new PHI-bearing tables and caches.
- Provider contracts/quotas and BAAs are confirmed for every PHI path used in production.
