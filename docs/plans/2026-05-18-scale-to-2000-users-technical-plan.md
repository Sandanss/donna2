# Donna 2,000 User Burst Scaling Technical Plan

Date: May 18, 2026  
Status: Proposed implementation plan  
Primary surfaces: `services/scheduler.js`, `db/schema.js`, `pipecat/main.py`, `pipecat/api/routes/telnyx.py`, `pipecat/api/routes/call_context.py`, `pipecat/services/post_call.py`, Railway configuration

## Executive Summary

Donna can scale to 2,000 daily users, but the current architecture should not be scaled by simply raising `MAX_CONCURRENT_CALLS` and adding Pipecat replicas. The active scheduler is a single Node polling loop that discovers due work, deduplicates with in-memory sets, and fires calls with a fixed concurrency of 10. Pipecat admission control is per replica, Redis is optional, Telnyx webhook dedupe is local memory, post-call work runs inline after calls, and the database pools can multiply quickly as replicas are added.

The target architecture should change from "find due calls and fire them" to "materialize eligible calls into a durable queue, prioritize them, lease them, and dispatch only when global voice capacity is available." This plan introduces:

- A normalized schedule table and durable `call_queue`.
- A parallel migration path that runs beside the legacy scheduler until measured safe.
- A capacity-aware dispatcher with priority lanes and Postgres leasing.
- Redis-backed global Pipecat capacity heartbeats and slot reservations.
- Scheduled pre-scaling around 15-minute calling windows.
- Horizontal Pipecat replicas with Redis required, not optional.
- Multi-instance hardening for WebSocket tokens, Telnyx event dedupe, media-stream start, rate limits, and deploy draining.
- A queued post-call worker system so 600 calls ending near the same time do not stampede the database and AI vendors.
- Database constraints, indexes, pooling, and idempotency changes for concurrent writes.
- PHI-safe queue, Redis, logging, retention, and audit practices.

Several design decisions are made now to avoid expensive re-architecture later, when the system needs to grow past 2,000 users (see "Forward Path To 10,000 Users" at the end of this doc for context):

- Operational tables (`call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`) live under a dedicated `ops.*` schema so they can later be moved to a dedicated operational Postgres without rewriting application SQL or denormalizing joins.
- Queue, attempt, and job tables use `PARTITION BY HASH (senior_id)` from day one. Cheap to do now, painful to retrofit, and gives the dispatcher headroom past the initial 2,000-user target.
- `PIPECAT_REQUIRE_REDIS=true` is the supported production posture from Phase 0 (with a sequenced rollout), not a flag flipped on later.
- Capacity heartbeats and reservations are region-aware (region in Redis keys, `region` column on `call_attempts`) even though we deploy in one region today. Multi-region becomes a configuration change, not a schema change.
- Post-call work is structured to run on a durable workflow engine (Temporal Cloud or Inngest) using `post_call_jobs` as source-of-truth metadata, because retry/backoff/dead-letter semantics already exist in those engines and the post-call burst is the highest-value place to use them.

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

## Product Readiness Verification

This scaling plan assumes the core product flows are reliable enough to scale. It does not replace product readiness work, and this section is not a claim that these features are missing. Treat it as a verification checklist before ramping traffic through the new scheduler:

- Mobile login/signup and account recovery work consistently with Clerk.
- Mobile onboarding creates caregiver, senior, schedule, and reminder data through Node APIs.
- Reminder CRUD from mobile and web caregiver surfaces persists the right encrypted PHI fields.
- Reminder delivery and acknowledgement work during real Pipecat/Telnyx calls.
- Mobile schedule controls and manual call initiation route through Node, not directly to Pipecat.
- Inbound known-senior calls and inbound onboarding calls still work when Pipecat has multiple replicas.
- Post-call analysis, summary, memory, notification, and observability flows run reliably after live calls.
- Mobile caregiver workflows have no known crash/dead-end paths for scheduling, reminders, or call controls.
- Sensitive debug logs are cleaned up before broader PHI-bearing traffic.

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

## Parallel Migration Strategy

This is an additive migration. The legacy scheduler remains available until the queue-based architecture has passed shadow tests, live canaries, and rollback drills. The new architecture should never require deleting legacy scheduler code to test it.

### Migration Principles

- Add new tables and workers beside the existing scheduler.
- Keep one dial authority at a time for any senior/time window.
- Run the new materializer and dispatcher in dry-run modes before they can create Telnyx calls.
- Dual-write schedule data into normalized tables, but do not dual-dial calls.
- Use stable senior cohorts so A/B results are comparable across multiple calls.
- Keep rollback simple: flip the dial authority back to legacy and leave queue rows for analysis.
- Keep all PHI-bearing data encrypted or referenced by ID only.

### Runtime Modes

| Mode | Legacy scheduler | Queue materializer | Queue dispatcher | Telnyx dialing authority | Purpose |
| --- | --- | --- | --- | --- | --- |
| `legacy_only` | Active | Off | Off | Legacy | Current behavior. |
| `shadow_materialize` | Active | Writes queue rows | Off | Legacy | Prove queue generation matches legacy due-call decisions. |
| `shadow_dispatch` | Active | Writes queue rows | Dry-run leases only | Legacy | Prove priority/capacity decisions without dialing. |
| `canary_queue` | Active for control cohort | Active | Active for treatment cohort | Split by cohort | A/B live calls while preventing duplicate calls. |
| `queue_primary` | Fallback only | Active | Active | Queue | New architecture is primary. |
| `legacy_rollback` | Active | Optional shadow | Off | Legacy | Immediate rollback state. |

### Feature Flags

Suggested flags:

- `CALL_ARCHITECTURE_MODE=legacy_only|shadow_materialize|shadow_dispatch|canary_queue|queue_primary|legacy_rollback`
- `CALL_QUEUE_DUAL_WRITE_SCHEDULES=true|false`
- `CALL_QUEUE_SHADOW_MATERIALIZE=true|false`
- `CALL_QUEUE_SHADOW_DISPATCH=true|false`
- `CALL_QUEUE_CANARY_PERCENT=0`
- `CALL_QUEUE_COHORT_ALLOWLIST=senior_id,...`
- `CALL_QUEUE_COHORT_BLOCKLIST=senior_id,...`
- `CALL_QUEUE_ENABLED_CALL_TYPES=manual,reminder,schedule,welfare`
- `CALL_QUEUE_ALLOW_REAL_DIAL=false`
- `CALL_QUEUE_REQUIRE_DIAL_GUARD=true`
- `CALL_QUEUE_COMPARE_WITH_LEGACY=true`

Default all flags to legacy-safe values. `CALL_QUEUE_ALLOW_REAL_DIAL` should be false unless `CALL_ARCHITECTURE_MODE` is `canary_queue` or `queue_primary`.

### Dial Authority And Double-Call Guard

The biggest migration risk is accidentally calling the same senior twice. Add a durable guard before either scheduler can initiate a call.

Suggested `outbound_call_guards` table:

- `id uuid primary key`
- `senior_id uuid not null`
- `guard_key text not null`
- `call_type text not null`
- `architecture text not null`
- `queue_id uuid`
- `legacy_dedup_key text`
- `target_at timestamp not null`
- `expires_at timestamp not null`
- `call_control_id text`
- `status text not null`
- `created_at timestamp default now()`
- `updated_at timestamp default now()`

Constraints and indexes:

- Unique `guard_key` while active.
- `(senior_id, status, expires_at)`.
- `(expires_at)` for cleanup.

Guard key examples:

- schedule call: `schedule:{senior_id}:{local_date}:{schedule_item_id_or_time}`
- reminder call: `reminder:{reminder_id}:{normalized_scheduled_for}`
- welfare call: `welfare:{senior_id}:{local_date}`
- manual call: `manual:{senior_id}:{request_id}`

Rule:

- Legacy and queue paths must both acquire the same guard before dialing.
- If the guard already exists, the second path records `suppressed_duplicate` and does not call Telnyx.
- Guard acquisition should happen in Postgres for durability. Redis can mirror it for fast observability, but Redis alone is not enough.

### Shadow Comparison

During `shadow_materialize` and `shadow_dispatch`, collect comparison records without dialing from the queue path:

- seniors legacy would call
- seniors queue would call
- call type and priority lane
- target time and dispatch time
- skip reason
- paused/inactive/cooldown decisions
- pending reminders included
- capacity decision
- estimated queue lag

Add a lightweight `scheduler_shadow_comparisons` table or structured metrics. Do not store names, phone numbers, reminder titles, or reminder descriptions.

Pass criteria before live canary:

- At least 7 days of shadow windows.
- 99 percent or better agreement for due scheduled calls after expected intentional differences are excluded.
- 100 percent agreement on paused/inactive senior suppression.
- 100 percent duplicate-call suppression in synthetic race tests.
- Queue-generated reminder calls match legacy reminder eligibility for the same scheduled instances.

### Cohort Assignment

Use stable cohorts:

- Control: legacy scheduler.
- Treatment: queue scheduler.

Assignment options:

- Explicit allowlist for first test seniors.
- Stable hash of `senior_id` for percent rollout.
- Separate flags by call type, because manual calls, reminders, scheduled check-ins, and welfare calls have different risk.

Do not A/B the same senior across architectures during the same testing period. Senior-level assignment keeps post-call outcomes, reminder retries, and caregiver experience easier to compare.

## Data Model Changes

### Schema Layout And Partitioning

Operational tables live under a dedicated `ops.*` schema. Application-domain tables (`seniors`, `conversations`, `memories`, `reminders`, `caregivers`, etc.) stay under `public.*`. This forces a clean boundary in app code — no SQL joins from `ops.call_queue` to `public.seniors` — so senior hydration for queued work happens through service calls or denormalized fields on the queue row itself rather than database joins. Later, the entire `ops.*` schema can be moved to a dedicated operational Postgres (separate Neon project, Crunchy Bridge, RDS, or CloudSQL) without rewriting application SQL; only the connection string for the operational pool changes.

All queue/attempt/job tables are hash-partitioned on `senior_id` from day one:

```sql
CREATE TABLE ops.call_queue ( ... )
  PARTITION BY HASH (senior_id);

DO $$ BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format(
      'CREATE TABLE ops.call_queue_p%s PARTITION OF ops.call_queue
       FOR VALUES WITH (MODULUS 16, REMAINDER %s)', i, i
    );
  END LOOP;
END $$;
```

- 16 partitions sized for 10,000 seniors (~625 per partition). Power-of-two count so partitions can later be split without remodulus.
- Partition key must appear in the primary key and in every unique constraint:
  - Primary key on partitioned tables is `(senior_id, id)`, not `id`.
  - Unique constraints all include `senior_id` as the leading column (e.g., `UNIQUE (senior_id, dedupe_key)`). This is a free strengthening because dedupe keys are already senior-scoped (`schedule:{senior_id}:{date}:...`).
- Foreign keys between partitioned tables use compound references: `ops.call_attempts.(senior_id, queue_id)` references `ops.call_queue.(senior_id, id)`. Foreign keys from partitioned tables to non-partitioned tables (e.g., `ops.call_queue.senior_id references public.seniors(id)`) are simple FKs.
- `call_attempts` and `post_call_jobs` use the same partitioning scheme so cross-table operations for a single senior stay within a single partition heap file. The dispatcher's hot path benefits from this locality.
- `FOR UPDATE SKIP LOCKED` works correctly across partitioned tables and benefits from reduced lock manager contention (per-partition heap locks instead of one global heap).
- One Postgres limitation worth noting explicitly: `UNIQUE (call_control_id)` cannot be enforced on a partitioned table without including the partition key. We get global uniqueness from Telnyx itself (one `call_control_id` per call) and additionally maintain a small unpartitioned `ops.call_control_index` lookup that maps `call_control_id → (senior_id, queue_id, attempt_id)` for fast inbound webhook routing without scanning all partitions.
- Retrofitting partitioning after live queue rows exist requires a `pg_partman`-style table swap with downtime; doing it now is essentially free.

Region awareness is a day-one decision. `call_attempts.region`, heartbeat Redis keys (`pipecat:instance:{region}:{instance_id}`), and capacity reservation Redis keys all include a region dimension. Today there is only one value (`us-east-1`), so no behavior changes, but the schema is forward-compatible with multi-region Pipecat fleets without a migration. See "Pipecat Horizontal Scaling → Region Awareness" for the runtime implications.

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

- Unique `(senior_id, dedupe_key)` — `senior_id` required as the leading column to satisfy hash partitioning.
- `(status, priority_lane, earliest_at)`.
- `(status, latest_at)`.
- `(senior_id, status)`.
- `(lease_expires_at)` for lease recovery.
- Partitioned by `HASH (senior_id)` into 16 partitions; partition key is part of the primary key. See "Schema Layout And Partitioning" above.

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
- `region text not null default 'us-east-1'`
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

- Unique `(senior_id, queue_id, attempt_number)` — `senior_id` required as leading column for hash partitioning. Global uniqueness on `(queue_id, attempt_number)` follows from `queue_id` being unique per senior.
- `call_control_id` global uniqueness enforced via the unpartitioned `ops.call_control_index` lookup table (see "Schema Layout And Partitioning"), not via a direct unique constraint on this partitioned table.
- `(status, created_at)`.
- `(senior_id, created_at desc)`.
- Partitioned by `HASH (senior_id)` into 16 partitions; partition key is part of the primary key.

Add fields to support A/B migration analysis:

- `architecture text not null` such as `legacy` or `queue`.
- `cohort text` such as `control`, `treatment`, or `shadow`.
- `test_run_id text`.
- `dispatch_decision_id uuid`.

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

- Unique `(senior_id, dedupe_key)` — `senior_id` required as leading column for hash partitioning.
- `(status, priority, run_after)`.
- `(lease_expires_at)`.
- `(senior_id, created_at desc)`.
- Partitioned by `HASH (senior_id)` into 16 partitions; partition key is part of the primary key.

Implementation note: this schema describes the canonical metadata layout. The recommended production implementation is a durable workflow engine (Temporal Cloud or Inngest) with `post_call_jobs` retained as a metadata/audit table — not as the work queue itself. See "Post-Call Queue Plan → Recommended Implementation" below.

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

`PIPECAT_REQUIRE_REDIS=true` is the supported production posture from Phase 0, not a flag flipped on when we move to multiple replicas. Single-instance fallback paths are documented and tested, but flipping the flag in production is what removes the local-state branch from the active code path. Sequenced rollout:

1. Provision multi-AZ Redis (Upstash regional pro, Redis Cloud HA, or ElastiCache cluster mode with automatic failover). BAA required because encrypted PHI shared-state payloads transit Redis.
2. Audit every code path that today checks Redis and falls back to local memory. Plan inventory: WebSocket token claims, Telnyx event dedupe, media-stream start lock, call metadata reads, rate limits, prewarm/context cache. Each fallback must be replaced with a fail-closed error in production mode.
3. Add a test that runs Pipecat with Redis unreachable and confirms `/health` reports unhealthy and `/ws` rejects new admissions.
4. Flip `PIPECAT_REQUIRE_REDIS=true` in dev → staging → production, watching Sentry for surprise errors during the rollout.
5. Update the on-call runbook: Redis unavailable now means all voice unavailable. The tradeoff is intentional — at scale, Redis uptime SLA matches Telnyx uptime SLA in operational importance.

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

### Region Awareness

The first 2,000 users are served from a single region. Multi-region Pipecat fleets are not deployed in this plan, but the code and data are designed to be region-aware from day one so that adding a second region later is a configuration change rather than a refactor.

Day-one requirements:

- `PIPECAT_REGION` env var is required on every Pipecat replica, defaulting to `us-east-1`. Plumb it through instance startup so heartbeats, reservations, and attempt records always carry a region.
- Redis heartbeat key shape: `pipecat:instance:{region}:{instance_id}` (TTL 15s). Capacity reservation key shape: `pipecat:reservation:{region}:{reservation_id}` (TTL 2–5 minutes).
- `ops.call_attempts.region text not null default 'us-east-1'` from the first migration. Same for any future operational table whose rows correspond to a specific call instance.
- Dispatcher reads global capacity by summing across all regions today (no behavior change for one-region deploys). The same aggregation function naturally extends to "prefer the senior's region, spill to others" once `seniors.preferred_region` is populated.
- `seniors.preferred_region text` nullable, defaulting `NULL` (meaning "any region"). Backfill from area code or timezone is a future task; schema readiness today is what matters.

What we explicitly defer:

- Actually deploying a Pipecat fleet in a second region. Cross-region DB latency (50–100ms per query on the hot call-start path) and cross-region Redis writes are real engineering problems that do not pay off at one-region 2,000-user scale.
- Cross-region failover for the primary Postgres or Redis. Current single-region posture is acceptable until we measurably need geo-distribution for voice latency.

The point of this section is that we should not have to migrate `call_attempts` to add a `region` column, redesign Redis key shapes, or reroute capacity reservation queries the day we decide to add a West Coast or international Pipecat fleet.

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

### Recommended Implementation: Durable Workflow Engine

The post-call burst (hundreds of calls ending near each other, each kicking off analysis + memory extraction + notifications + snapshot rebuild) is the single highest-value place to use a durable workflow engine rather than a hand-rolled Postgres job table. Retry policy, backoff, dead-letter routing, per-job-type concurrency caps, observability, and idempotency are all first-class features of Temporal Cloud or Inngest — features we would otherwise spend weeks reimplementing on top of `post_call_jobs`.

Recommended target: Temporal Cloud or Inngest.

- Each job type (`analysis`, `memory_extraction`, `caregiver_notifications`, etc.) becomes a workflow definition.
- `ops.post_call_jobs` is retained as a metadata/audit table — the system of record for "what work was enqueued for this call SID" — but the workflow engine owns lease, retry, dead-letter, and execution.
- Per-workflow concurrency caps replace per-worker concurrency caps. Provider-specific concurrency (Anthropic, Gemini, ElevenLabs) is enforced at the workflow engine level.
- Idempotency key is the `(call_sid, job_type)` pair, identical to the dedupe key on `post_call_jobs`.

The Postgres-backed worker architecture described below remains a viable Plan B if the team prefers not to take on Temporal/Inngest as a dependency, but every operational concern in the lists below (lease/retry/dead-letter/per-job-type caps/observability/idempotency) has to be re-implemented in app code in that case.

### Critical-Path Minimization

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

### Schema And Cluster Isolation

Operational tables (`ops.call_queue`, `ops.call_attempts`, `ops.post_call_jobs`, `ops.outbound_call_guards`, `ops.scheduler_shadow_comparisons`, `ops.call_control_index`) live under a dedicated Postgres schema from day one. Application-domain tables stay under `public.*`. This forces a clean code-level boundary: app code never writes a SQL join from `ops.call_queue` to `public.seniors`. Senior hydration for queued work happens through service calls or denormalized fields on the queue row itself.

A static check (CI lint or runtime startup check) should fail if app code attempts a cross-schema join, so the boundary is enforced from Phase 1 rather than rediscovered during a future migration.

The forward path is to split `ops.*` onto a dedicated operational Postgres cluster once Neon's write-throughput characteristics start to bound dispatch latency. Today, all schemas live in the same Neon project; tomorrow, only the operational-pool connection string changes.

Suggested operational cluster characteristics when the split happens:

- Provisioned IOPS suited to a write-heavy queue workload (unlike Neon's serverless model, which optimizes for storage-compute separation and is shaped around read-mostly app workloads).
- BAA-covered managed Postgres: Crunchy Bridge, AWS RDS for Postgres, or Google Cloud SQL.
- Read replica for dispatcher introspection queries ("what's queued for this senior?").
- Connection pool tuned for the worker fleet, separate from the app/API pool.

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

### PHI Protection Test Gates

PHI protection has to be tested throughout the migration, not only before production rollout.

Use synthetic PHI sentinels in dev/staging tests:

- senior name: `Donna Phi Sentinel`
- phone: a controlled test number only
- reminder title: `PHI_SENTINEL_REMINDER_DO_NOT_LOG`
- caregiver note: `PHI_SENTINEL_NOTE_DO_NOT_LOG`
- medical note: `PHI_SENTINEL_MEDICAL_DO_NOT_LOG`
- transcript phrase: `PHI_SENTINEL_TRANSCRIPT_DO_NOT_LOG`

For every phase that introduces a new table, cache, queue, worker, log path, or dashboard, run tests that assert:

- Sentinel strings do not appear in application logs.
- Sentinel strings do not appear in Sentry/event payloads.
- Sentinel strings do not appear in Redis raw values except inside encrypted shared-state blobs.
- Sentinel strings do not appear in plaintext queue/job/test-run operational tables.
- PHI-bearing values are stored only in encrypted companion columns or encrypted payload fields.
- Authorized export paths can retrieve/decrypt new PHI-bearing data where required.
- Delete/retention paths cover new tables and encrypted payloads.
- Audit logs are created for PHI reads/hydration/export/delete paths and do not store raw PHI in metadata.

This should become a repeatable test command or CI job before queue canaries. The test should fail on any raw sentinel match outside explicitly allowed encrypted columns.

### PHI Data Classification For New Architecture

| Surface | PHI allowed? | Storage rule | Retention/export/delete requirement |
| --- | --- | --- | --- |
| `senior_call_schedules` | Only encrypted context notes | IDs/times/plain operational fields; context encrypted | Covered by senior export/delete and schedule retention |
| `call_queue` | No raw PHI | IDs, lane, status, timestamps only | Operational retention and senior delete cleanup |
| `call_attempts` | No raw PHI | IDs, provider IDs, outcomes only | Operational retention and senior delete cleanup |
| `outbound_call_guards` | No raw PHI | IDs, guard keys, status only | Short retention and senior delete cleanup |
| `scheduler_shadow_comparisons` | No raw PHI | IDs, decisions, skip reasons only | Short retention; no transcripts/reminder text |
| `post_call_jobs` | Yes, only if necessary | Prefer IDs; encrypt any payload body | Export/delete/retention/legal hold coverage |
| Redis call metadata | Yes | Encrypted shared-state payload, short TTL | TTL plus incident runbook |
| Redis locks/heartbeats | No raw PHI | IDs and counters only | TTL |
| Logs/metrics/dashboards | No raw PHI | IDs/counts/status only; hash where possible | Log retention and review |

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

## A/B And Multi-Call Test Plan

The migration needs two kinds of testing:

1. Exact shadow comparison, where legacy is the only dialer and the queue path predicts what it would have done.
2. Live A/B, where control seniors use legacy and treatment seniors use the queue architecture.

Shadow comparison proves scheduling equivalence. Live A/B proves real call setup, Telnyx events, Pipecat routing, post-call behavior, and caregiver outcomes.

### Test Data Rules

- Use synthetic seniors and controlled test phone numbers for early live calls.
- Do not use real senior PHI in fixtures, screenshots, logs, or synthetic transcripts.
- Use non-PHI reminder titles such as "test reminder A" for automated test calls.
- Keep test caregiver notes synthetic and minimal.
- Mark test accounts with `test_run_id` or an equivalent metadata field so retention and cleanup are explicit.
- Never record or publish raw call audio/transcripts from test calls in logs or CI output.

### A/B Assignment

Use stable senior-level assignment:

- Control cohort: legacy scheduler and legacy post-call path.
- Treatment cohort: queue materializer, queue dispatcher, Redis capacity, and new post-call queue where enabled.

Do not alternate architectures per call for the same senior during the same test. Per-call randomization makes reminder retry state, cooldowns, caregiver notifications, and post-call memories hard to interpret. Senior-level cohorts are cleaner and safer.

### Test Run Tracking

Add a test-run identifier to every migration run:

- `test_run_id`
- `architecture`
- `cohort`
- `call_type`
- `senior_id`
- `queue_id`
- `legacy_dedup_key`
- `call_control_id`
- `scheduled_for`
- `dial_started_at`
- `answered_at`
- `media_started_at`
- `ended_at`
- `outcome`
- `failure_class`

This can live in `call_attempts`, a dedicated `scheduler_test_runs` table, or both. Keep it operational and ID-based; do not store PHI-bearing call content in test-run tables.

### Stage 1: Shadow Materialization

Goal: prove the queue creates the same eligible work as the legacy scheduler without dialing any queue calls.

Setup:

- `CALL_ARCHITECTURE_MODE=shadow_materialize`
- `CALL_QUEUE_ALLOW_REAL_DIAL=false`
- Legacy remains the only dial authority.

Run:

- At least 7 calendar days.
- Include morning, afternoon, and evening windows.
- Include scheduled calls, reminders, recurring reminders, paused caregivers, inactive seniors, and welfare eligibility.

Compare:

- Legacy due calls versus queue rows.
- Legacy skip reasons versus queue skip reasons.
- Reminder instance normalization.
- Schedule timezone handling.
- Paused/inactive suppression.
- Cooldown behavior.

Pass criteria:

- 99 percent or better agreement on scheduled-call eligibility after known intentional differences are excluded.
- 100 percent agreement on paused caregiver suppression.
- 100 percent agreement on inactive senior suppression.
- 100 percent agreement on reminder instance dedupe.
- No PHI in scheduler comparison logs.

### Stage 2: Shadow Dispatch

Goal: prove leasing, priority lanes, and capacity math without dialing from the queue.

Setup:

- `CALL_ARCHITECTURE_MODE=shadow_dispatch`
- Queue dispatcher can lease dry-run rows.
- Legacy remains the only dial authority.

Run:

- Simulate Pipecat capacity levels: 0, 10, 50, 150, 600.
- Simulate lane pressure: manual, hard reminders, reminder retries, scheduled check-ins, welfare.
- Run at least one 667-call/15-minute synthetic window.

Compare:

- Which queue rows would dispatch.
- Dispatch order by lane.
- Estimated queue lag.
- Capacity reservations that would be made.
- Rows suppressed by cooldown, pause, inactive senior, or existing guard.

Pass criteria:

- Manual and hard-reminder lanes preserve protected capacity.
- Queue lag stays within lane SLOs under 600 mocked slots.
- Multiple dispatcher workers produce no duplicate leases.
- Expired leases are recovered by the reconciler.
- No real Telnyx calls are created by the queue path.

### Stage 3: Paired Synthetic Live Calls

Goal: compare real call behavior across architectures without involving real seniors.

Setup:

- Use controlled test phone numbers answered by the team or an automated test endpoint.
- Create matched synthetic seniors:
  - 10 control seniors on legacy.
  - 10 treatment seniors on queue.
- Use equivalent schedules, reminders, timezones, and call settings.
- Keep all test content synthetic and non-PHI.

Minimum live-call matrix:

| Scenario | Control calls | Treatment calls | Required checks |
| --- | ---: | ---: | --- |
| Manual call now | 5 | 5 | exactly one dial, conversation created, post-call complete |
| Scheduled check-in | 10 | 10 | window timing, no duplicate dial, context loaded |
| One-time reminder | 10 | 10 | delivery row created once, acknowledgement persists |
| Recurring reminder | 10 | 10 | normalized scheduled instance, no duplicate delivery |
| No answer/busy | 5 | 5 | reservation released, retry/defer state correct |
| Inbound known senior | 5 | 5 | metadata visible across replicas, ws token consumed once |
| Inbound onboarding | 5 | 5 | prospect path unaffected |
| Post-call burst | 20 | 20 | job backlog drains inside SLO |

Pass criteria:

- 0 duplicate outbound calls.
- 0 duplicate `reminder_deliveries` for the same reminder instance.
- 0 duplicate conversation rows for one `call_control_id`.
- 0 WebSocket token replays accepted.
- 0 duplicate Telnyx stream starts.
- 95 percent or better successful media start for answered test calls.
- Post-call critical jobs meet SLOs.
- No PHI-bearing logs.

### Stage 4: Small Live Canary

Goal: test with real operational conditions while limiting blast radius.

Setup:

- Start with allowlisted internal/test seniors or consenting pilot users.
- `CALL_ARCHITECTURE_MODE=canary_queue`
- `CALL_QUEUE_CANARY_PERCENT=0`
- Use `CALL_QUEUE_COHORT_ALLOWLIST`.

Run:

- 5 treatment seniors for 2 days.
- 10 treatment seniors for 2 days.
- 25 treatment seniors for 3 days.
- Include at least one morning, afternoon, and evening window.

Compare to control:

- call setup success rate
- answer-to-media-start latency
- queue lag
- duplicate suppression count
- reminder acknowledgement rate
- post-call summary latency
- caregiver notification success
- subjective call quality from internal review where available

Pass criteria:

- No duplicate calls.
- Treatment call setup success is not worse than control by more than 1 percentage point.
- Treatment reminder delivery correctness is not worse than control.
- p95 queue lag stays below:
  - hard reminders: 3 minutes
  - scheduled check-ins: 10 minutes
  - welfare: 60 minutes
- No unresolved P0/P1 incidents.

### Stage 5: Window Load Canary

Goal: prove burst behavior under realistic window load.

Run:

- 50 treatment seniors in one 15-minute window.
- 100 treatment seniors in one 15-minute window.
- 250 treatment seniors in one 15-minute window.
- 600 treatment seniors only after provider contracts and mocked-load tests pass.

For each window:

- Pre-materialize queue rows.
- Prewarm context.
- Scale Pipecat to target replicas.
- Verify Redis heartbeats before dispatch.
- Run legacy control cohort in the same broad time period, but not on the same seniors.
- Review queue, provider, DB, and post-call dashboards immediately after the window.

Pass criteria:

- Capacity estimator predicts required replicas within 10 percent.
- No scale-down while calls are active.
- DB pool idle stays above 10 percent.
- Redis remains available and below command/memory thresholds.
- Provider rate-limit errors stay below alert thresholds.
- Post-call backlog returns to normal within 30 minutes for non-critical jobs.

### Rollback Gates

Immediately disable queue dialing and return to legacy if any of these occur:

- Any duplicate call to the same senior for the same schedule/reminder guard key.
- Any accepted WebSocket token replay.
- Any duplicate Telnyx media stream start for one call.
- Redis unavailable while scaled mode is enabled.
- Queue dispatcher creates real calls while not in `canary_queue` or `queue_primary`.
- Treatment call setup success drops more than 2 percentage points below control.
- Hard-reminder queue lag exceeds 5 minutes for more than 2 percent of reminders.
- DB connection exhaustion or sustained pool idle below 5 percent.
- PHI appears in logs, metrics, fixtures, screenshots, or CI output.

Rollback action:

1. Set `CALL_ARCHITECTURE_MODE=legacy_rollback`.
2. Set `CALL_QUEUE_ALLOW_REAL_DIAL=false`.
3. Stop queue dispatcher workers.
4. Keep materializer in shadow mode only if it is not contributing to the incident.
5. Preserve queue rows, attempts, and guards for analysis.
6. Run duplicate-call and reminder-delivery reconciliation before re-enabling queue canaries.

## Continuous Concurrency Test Cadence

Do not wait until the full architecture exists to test concurrency. Each piece should ship with targeted concurrency tests before the next piece builds on it.

### Concurrency Ladder

Run each relevant component at these levels as soon as it exists:

| Level | Purpose | Example target |
| --- | --- | --- |
| 1 | correctness | one senior, one schedule, one call |
| 10 | basic parallelism | 10 seniors due in same minute |
| 50 | first realistic burst | 50 due calls, 4 dispatcher workers |
| 100 | small window canary | 100 due calls, 4-8 workers |
| 250 | meaningful stress | 250 due calls, Redis locks, DB pool monitoring |
| 600 | first 2,000-user target | 667 queued calls in 15 minutes, 600 active capacity |
| 900 | headroom target | heavier single-window scenario |

Every level should record:

- duplicate queue rows
- duplicate guards
- duplicate call attempts
- duplicate Telnyx stream starts
- queue lease conflicts
- Redis lock failures
- DB pool usage
- slow query count
- queue lag by lane
- post-call backlog age
- PHI sentinel scan results

### Component-Level Concurrency Tests

Build these tests incrementally:

- Schedule normalization:
  - Run concurrent schedule writes for the same senior.
  - Assert one normalized active schedule per source schedule item.
  - Assert encrypted context notes do not leak to plaintext columns or logs.
- Queue materializer:
  - Run multiple materializer workers for the same window.
  - Assert unique `dedupe_key` prevents duplicate queue rows.
  - Assert paused/inactive seniors never get queued.
- Guard acquisition:
  - Race legacy and queue dialers against the same guard key.
  - Assert only one path receives the right to dial.
  - Assert losing path records `suppressed_duplicate`.
- Dispatcher leasing:
  - Run 4, 8, and 16 dispatcher workers with `FOR UPDATE SKIP LOCKED`.
  - Assert every queue row is leased at most once per lease period.
  - Assert expired leases are recovered.
- Redis coordination:
  - Race duplicate Telnyx event IDs across simulated replicas.
  - Race duplicate stream-start attempts for one `call_control_id`.
  - Race duplicate WebSocket token consumption.
  - Assert fail-closed behavior when Redis is unavailable in scaled mode.
- Capacity reservation:
  - Dispatch against changing fake Pipecat heartbeat capacity.
  - Assert reservations never exceed available lane capacity.
  - Assert stale reservations expire and are reconciled.
- Pipecat multi-instance:
  - Run at least two Pipecat processes against shared Redis in dev/staging.
  - Route webhook and WebSocket steps to different replicas.
  - Assert call metadata and token consumption still work.
- Post-call jobs:
  - Enqueue 50, 100, 250, and 600 call completions with provider stubs.
  - Assert worker concurrency caps hold.
  - Assert critical jobs complete before non-critical jobs.
  - Assert encrypted payloads and retention coverage.
- End-to-end windows:
  - Run 50, 100, 250, and 600 queued test calls through mocked providers.
  - Run smaller live Telnyx windows with controlled test numbers.
  - Assert no PHI sentinels in logs after each run.

### Required Test Types Per Pull Request

Every implementation PR in this migration should include at least one focused test from each relevant category:

- Unit test for pure scheduling/capacity/priority logic.
- Database integration test for idempotency, leasing, or guard constraints.
- Concurrency test for the shared state being introduced.
- PHI sentinel test for any new table/cache/log/dashboard path.
- Rollback or failure-mode test if the PR changes dial authority, Redis dependency, or post-call processing.

Small PRs can use small test sizes, but the test category should appear immediately. Larger synthetic load runs can remain nightly/manual until they are stable enough for CI.

## Implementation Phases

### Phase 0: Baseline And Guardrails

Goal: measure current system and prevent unsafe horizontal scaling.

Tasks:

- Add a documented scale target of 600 active calls for the first 2,000-user milestone.
- Set public environments to `LOG_LEVEL=INFO`.
- Verify Neon pooled URL usage.
- Provision multi-AZ Redis (Upstash regional pro, Redis Cloud HA, or ElastiCache cluster mode) with BAA. Prerequisite for the `PIPECAT_REQUIRE_REDIS=true` rollout in Phase 4.
- Audit existing Pipecat code paths that fall back to local memory when Redis is unavailable. Document the fallback inventory (WebSocket tokens, Telnyx event dedupe, stream-start lock, call metadata, rate limits, prewarm) and which paths must become fail-closed in scaled mode.
- Add a config guard: if Pipecat replicas > 1 or `PIPECAT_REQUIRE_REDIS=true`, Redis failures fail readiness.
- Add metrics for current scheduler cycle duration, plan size, success/fail counts, and Pipecat active calls.
- Add migration flags with safe defaults.
- Add PHI sentinel scan script for logs/tables touched by the migration.
- Decide initial provider concurrency numbers for Deepgram, Anthropic/Gemini, ElevenLabs, and Telnyx.
- Pick the workflow engine target for Phase 6 (Temporal Cloud, Inngest, or Postgres-backed Plan B) so Phase 6 implementation is unblocked.

Acceptance:

- We can see current call demand, active calls, and scheduler cycle duration in dev/staging.
- Scaled mode cannot accidentally run without Redis.
- Queue dialing cannot be enabled accidentally.
- PHI sentinel scan passes against current legacy test calls.

### Phase 1: Database Schema

Goal: create durable scheduling and idempotency primitives.

Tasks:

- Create the `ops` schema and place all new operational tables under it.
- Add `public.senior_call_schedules` (stays in `public.*` because it shares a senior-profile concern with `public.seniors`).
- Add `ops.call_queue` with `PARTITION BY HASH (senior_id)` into 16 partitions, primary key `(senior_id, id)`, unique constraint `(senior_id, dedupe_key)`.
- Add `ops.call_attempts` with the same partitioning scheme, plus `region text not null default 'us-east-1'` column. Compound FK `(senior_id, queue_id)` to `ops.call_queue.(senior_id, id)`.
- Add `ops.post_call_jobs` with the same partitioning scheme. If a workflow engine is chosen in Phase 0 (Temporal/Inngest), this becomes the metadata/audit table only.
- Add `ops.outbound_call_guards`.
- Add `ops.call_control_index` (unpartitioned) lookup mapping `call_control_id → (senior_id, queue_id, attempt_id)` for inbound webhook routing.
- Add optional `ops.scheduler_shadow_comparisons` and test-run tables.
- Add unique/index changes for conversations, reminder deliveries, queue, attempts, and jobs. Unique constraints on partitioned tables include `senior_id` as the leading column.
- Add retention coverage for new tables.
- Add migrations in root DB path and Pipecat migration path if both runtime paths need visibility.
- Add a CI lint or runtime startup check that fails if app code attempts a SQL join between `ops.*` and `public.*`, so the schema boundary is enforced from this phase rather than discovered later.

Acceptance:

- Migrations apply without table locks on production-sized data.
- Existing scheduler still runs while new tables are dark.
- Tests cover unique dedupe behavior.
- PHI sentinel tests prove queue/attempt/guard/test-run tables do not store raw PHI.
- Retention/delete/export coverage is defined for each new PHI-bearing or senior-linked table.

### Phase 2: Schedule Normalization And Materialization

Goal: stop scanning schedule JSON at dispatch time.

Tasks:

- Backfill `senior_call_schedules` from encrypted/decrypted senior schedule data.
- Update senior schedule write paths to maintain normalized schedules.
- Build materializer worker.
- Materialize 15-minute windows with deterministic jitter.
- Materialize reminders into hard-reminder and retry lanes.
- Run `shadow_materialize` with legacy as the only dialer.
- Keep old scheduler as fallback behind feature flag.

Acceptance:

- 2,000 seniors can be materialized for a day quickly and idempotently.
- Re-running materializer creates no duplicate queue entries.
- Paused/inactive seniors are excluded or cancelled.
- Shadow comparison meets Stage 1 pass criteria.
- Concurrent materializer tests pass at 10, 50, and 100 due calls before live canary work starts.
- PHI sentinel schedule context remains encrypted.

### Phase 3: Capacity-Aware Dispatcher

Goal: dispatch from queue only when capacity exists.

Tasks:

- Implement Postgres lease with `FOR UPDATE SKIP LOCKED`.
- Implement lane policy and protected capacity.
- Implement capacity reservation in Redis.
- Pass `queue_id` and `reservation_id` through Node -> Pipecat outbound request.
- Persist `call_attempts`.
- Add reconciler for expired leases/reservations.
- Implement guard acquisition shared by legacy and queue dialers.
- Run `shadow_dispatch` with no queue Telnyx calls.
- Feature flag dispatcher by environment.

Acceptance:

- Multiple dispatcher instances can run without duplicate calls.
- Manual lane can bypass lower-priority backlog.
- Queue lag remains bounded in mocked 667-call/15-minute test.
- Shadow dispatch meets Stage 2 pass criteria.
- Guard race tests pass with legacy and queue dialers contending for the same call.
- Dispatcher concurrency tests pass at 50, 100, and 250 queue rows before treatment live calls.
- PHI sentinel scan passes after dry-run dispatch logs.

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
- Redis outage tests prove fail-closed behavior in scaled mode.
- Two-replica dev/staging tests route webhook and WebSocket paths to different instances successfully.
- PHI sentinel metadata remains encrypted in Redis and absent from logs.

### Phase 5: Paired Synthetic Live A/B

Goal: prove the new architecture with real Telnyx/Pipecat calls before pilot traffic.

Tasks:

- Create matched synthetic control/treatment seniors.
- Run the Stage 3 live-call matrix.
- Verify reminder delivery, post-call, Redis, and DB behavior.
- Run duplicate-call reconciliation after each batch.
- Review logs for PHI leakage.

Acceptance:

- Stage 3 pass criteria met.
- Rollback path tested at least once.
- PHI sentinel scan passes across Node logs, Pipecat logs, Redis, queue tables, and post-call tables.

### Phase 6: Post-Call Queue

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
- Post-call concurrency tests pass at 50, 100, 250, and 600 completions with provider stubs.
- Encrypted job payload, export/delete, retention, and audit tests pass.

### Phase 7: Small Live Canary

Goal: run queue dialing for a small real cohort while legacy continues for the control cohort.

Tasks:

- Enable `canary_queue` for allowlisted seniors only.
- Run 5, 10, then 25 treatment seniors.
- Compare treatment metrics against legacy control.
- Keep queue dispatcher rollback-ready during every window.

Acceptance:

- Stage 4 pass criteria met.
- No duplicate-call guard violations.
- No PHI log findings.
- Treatment metrics are reviewed against control after every ramp step before expanding the cohort.

### Phase 8: Scheduled Auto Capacity

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
- Capacity/reservation concurrency tests pass at 250, 600, and 900 simulated slots.
- PHI sentinel scan confirms autoscaler logs contain no senior names, phone numbers, reminder text, or medical context.

### Phase 9: Load Testing And Rollout

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
- Live window canaries at 50, 100, 250, then 600 treatment seniors.

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
- Which durable workflow engine handles post-call jobs in production: Temporal Cloud, Inngest, or stay with the Postgres-backed worker pattern as Plan B. Decision drives Phase 6 implementation.
- When to split `ops.*` onto a dedicated operational Postgres cluster, and which provider/tier (Crunchy Bridge, RDS, CloudSQL). Default: stay in the same Neon project until write throughput becomes a measurable bottleneck.

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

## Forward Path To 10,000 Users

This plan delivers durable, multi-instance voice infrastructure capable of 600 concurrent active calls and 2,000 daily users. Scaling further — to roughly 10,000 daily users and 3,000 concurrent at peak — is past the design point of the architecture described above. It is not a "more replicas" exercise. Each of the assumptions below breaks before 10,000 users, and each requires its own design pass when the time comes.

The current plan has been written to *avoid the worst kinds of rework* when 10,000 becomes the target, not to deliver 10,000 today. The intent is to make the eventual transition mechanical rather than a re-architecture.

### What we've already done to make 10k cheaper

Several decisions earlier in this plan were chosen specifically with the 10k transition in mind:

- **`ops.*` schema isolation.** Moving operational tables to a dedicated Postgres later is a connection-string change, not a code refactor.
- **Hash partitioning by `senior_id`.** 16 partitions hold ~625 seniors each at 10k. The partition key is also the natural shard key if we ever need to move from "one partitioned table" to "many physical tables across shards."
- **`PIPECAT_REQUIRE_REDIS=true` from day one.** Removes the single-instance code path. Multi-region Redis later requires Redis Cluster, but application code already assumes Redis as the source of truth.
- **Region-aware capacity heartbeats and reservations.** Adding a second Pipecat region later is a deploy and config change. The schema and Redis key shapes do not change.
- **Workflow engine for post-call jobs.** Per-job-type concurrency caps, retry/backoff, and dead-letter are first-class features of Temporal/Inngest. Scaling job concurrency by 10x is a configuration knob, not new code.

### What breaks first

In order of how soon the wall hits as daily users grow past 2,000:

1. **Outbound caller ID reputation.** Long before any code-level metric moves, a single Donna caller ID placing ~3,000 outbound calls in a 15-minute window triggers carrier spam analytics. Answer rate collapses silently. Resolving this is a vendor problem: Telnyx-managed number pool, STIR/SHAKEN attestation, branded calling, regional caller IDs, reputation monitoring. Coordinate with Telnyx before this becomes the bottleneck.
2. **Provider concurrency quotas.** 3,000 concurrent calls means 3,000 concurrent Deepgram streams, 3,000 active Claude contexts, ~6,000 Director LLM RPS at the splits described in the architecture. Each provider's per-org quota becomes a hard ceiling. Plan: committed-tier contracts with Anthropic, Deepgram, ElevenLabs, Gemini, and OpenAI; multi-provider sharding with AI Gateway routing for STT and LLM; provider failover paths exercised in chaos tests.
3. **Single Postgres write throughput.** Even with `FOR UPDATE SKIP LOCKED` and partitioning, one Postgres primary handles a fixed write rate. `ops.call_attempts`, `ops.post_call_jobs`, `audit_logs`, and `conversations` all spike simultaneously during burst windows. Plan: dedicated operational Postgres with provisioned IOPS for the `ops.*` schema; read replicas for context hydration; consider moving the `audit_logs` append path to S3/Parquet rather than a Postgres table at 10k volume.
4. **Redis as a single point of failure.** Single-region Redis is acceptable for one Pipecat region. Multi-region voice requires Redis Cluster with cross-AZ failover, and capacity coherence becomes a consensus problem. Plan: Redis Cluster mode, capacity reservations consider Redis quorum, fallback path that leases through Postgres at higher latency if Redis is degraded.
5. **Single-region voice latency.** US coast-to-coast users on a single Pipecat region accept ~80–100ms additional one-way audio latency. Tolerable but noticeable. International expansion (Spanish-language users on the West Coast, or non-US markets) makes this worse. Plan: deploy Pipecat in multiple regions, route on `seniors.preferred_region`, accept cross-region writes for shared state (Postgres + Redis primaries stay in one region; reads are local).
6. **Caregiver notification throughput.** 10,000 daily notifications, bursty by call-end window. Resend (or any single email provider) starts throttling. Plan: notification service tier with batching, provider failover, and per-provider concurrency caps.
7. **Cost.** Roughly 1.7M call-minutes per day at 10k. STT + TTS + LLM costs dominate infrastructure costs and start determining margin. Plan: committed-tier contracts on every minute-billed vendor; evaluate self-hosted STT (Whisper, or self-hosted Deepgram) or cheaper TTS for low-stakes utterances.

### Architecture transitions between 2,000 and 10,000

Roughly in the order they become necessary:

| Transition | Driver | Approximate trigger |
| --- | --- | --- |
| Split `ops.*` to dedicated Postgres | Burst write throughput; pool exhaustion on Neon | ~3,000 daily users or first sustained alert on DB pool idle |
| Pipecat second region | Audio latency complaints from West Coast or international users | Product signal, not capacity signal |
| Telnyx managed number pool | Answer rate decline correlated with outbound volume | First measurable answer-rate drop |
| Multi-provider sharding (STT/LLM) | Provider rate-limit alerts | First sustained provider 429s at peak |
| Redis Cluster | Pipecat multi-region rollout or single-AZ Redis incident | Either trigger first |
| Workflow engine concurrency cap increase | Post-call job backlog growing | 10x current per-job-type cap with no DB stress |
| `audit_logs` archival to S3/Parquet | `audit_logs` write rate or storage cost | Storage-cost trigger before throughput trigger |

### Product transitions

Code and infrastructure are necessary but not sufficient at 10,000 users. Two product-level changes become structurally important:

- **Schedule distribution.** Stop letting all users pick "9:00 AM." Offer scheduling bands ("morning: 8–9 AM, we'll pick a quiet minute"), use historical answer-rate data to suggest off-peak slots, and use deterministic jitter within the band to spread load. This is a product change that buys massive capacity headroom — possibly more than any single infrastructure change.
- **Tiered call types.** Hard reminders (medication, appointments) remain time-sensitive. Companion check-ins become flexible within a multi-hour window. The lane reservation policy from the 2k plan extends naturally; the product change is exposing the flexibility to caregivers in the mobile app.

### When to start the 10,000-user plan

Not now. The 2,000-user architecture should run in production for at least 90 days with documented SLOs, real burst-window data, and a known cost profile before the 10,000-user plan starts. Most of the assumptions above (answer rate, p95 call duration, per-provider concurrency utilization) need measured production data to design against. Designing for 10,000 today, before 2,000 has shipped, repeats the same mistake as scaling `MAX_CONCURRENT_CALLS` instead of building the queue.

The forward-compatible decisions in this plan (`ops.*` schema, partitioning, Redis-required, region-aware, workflow engine) are the parts that *would have been expensive to retrofit*. Everything else in the 10,000-user transition can wait for real production data.
