# Donna 2,000 User Burst Scaling Technical Plan

Date: May 18, 2026
Revision: 3
Status: Active rollout plan with current scaling-branch implementation status
Primary surfaces: `services/scheduler.js`, `db/schema.js`, `pipecat/main.py`, `pipecat/api/routes/telnyx.py`, `pipecat/api/routes/call_context.py`, `pipecat/services/post_call.py`, Railway configuration

## Revision Notes

Rev 3 changes from rev 2:

- **Memory scaling work is now proactive, not deferred.** `memories` is split from `prospect_memories` and rebuilt as 64 Postgres hash partitions by `senior_id`; memory read/write paths include the owner key so Postgres can prune to the relevant partition.
- **Post-call queue activation now releases Pipecat capacity.** With `POST_CALL_QUEUE_ENABLED=true`, Pipecat enqueues the heavy jobs and skips inline analysis, memory extraction, daily-context, interest, and snapshot work while keeping immediate completion, reminder, notification, and cleanup behavior inline.
- **PHI-safe DB observability is implemented.** The Node observability API and dashboard now expose pool pressure, aggregate activity, lock waits, hot table stats, and queryid-only slow-query aggregates without raw SQL text or PHI.
- **The 10k section now separates completed proactive work from future operational-table partitioning.** Call queue/job/attempt tables remain flat default-schema tables for the 2,000-user rollout unless measurements force an online ops-table migration.

Rev 2 changes from rev 1:

- **Phase 0 reshaped from "guardrails" to "measure, decide, contract."** It now produces measured production baselines, closes all Open Decisions, completes the vendor concurrency inventory, kicks off the BAA chase, and publishes a cost model — all before any code change downstream.
- **New gaps closed.** Cost model, vendor concurrency inventory, outbound caller-ID / answer-rate risk, inbound capacity lane, Pipecat replica cold-start, Anthropic prompt-cache behavior at scale, DST and timezone edge cases, senior-delete vs. in-flight dispatch race, Node multi-instance topology, service-to-service rate-limit carve-out, shadow-mode audit trail, dead-letter and dependency graph for post-call jobs.
- **Definition of Done is numeric.** Every acceptance criterion has a measurable target. Qualitative "queue lag stays inside SLO" replaced with "p95 hard-reminder queue lag ≤ 180s."
- **Document reshaped to four sections.** Goals & constraints, Architecture, Phased implementation with explicit prerequisite gates, Operations. The single source of truth for SLOs, flags, and vendor capacity is a table at the top, not scattered across phases.
- **Phase 4 (Pipecat hardening) is a HARD prerequisite for Phase 7 (live canary).** Sequence isn't enough; it's a checkbox.
- **Rollback drills are acceptance criteria, not just triggers.** Each canary phase includes an executed rollback drill with elapsed time recorded.
- **CONCURRENTLY migration bug fixed in current code.** The queue foundation and concurrent index work are now split between `db/migrations/010_call_queue_foundation.sql` and `db/migrations/011_call_queue_concurrent_indexes.sql` (mirrored by Pipecat `023`/`024`). Live apply must still run concurrent-index migrations outside a transaction.

## Executive Summary

Donna can scale to 2,000 daily users, but the current architecture should not be scaled by raising `MAX_CONCURRENT_CALLS` and adding Pipecat replicas. The active scheduler is a single Node polling loop that discovers due work, deduplicates with in-memory sets, and fires calls with a fixed concurrency of 10. Pipecat admission control is per replica. Redis is optional. Telnyx webhook dedupe is local memory. Post-call work defaults to inline when the queue flag is off; with `POST_CALL_QUEUE_ENABLED=true`, Pipecat now enqueues heavy post-call jobs and skips those heavy inline steps so call capacity is released sooner. Database pools multiply quickly as replicas are added.

The target is to change from "find due calls and fire them" to "materialize eligible calls into a durable queue, prioritize them, lease them, and dispatch only when global voice capacity is available." This plan introduces:

- A normalized schedule table and durable `call_queue`.
- A parallel migration path that runs beside the legacy scheduler until measured safe.
- A capacity-aware dispatcher with priority lanes (including an explicit inbound lane) and Postgres leasing.
- Redis-backed global Pipecat capacity heartbeats and slot reservations.
- Scheduled pre-scaling around 15-minute calling windows with a replica readiness gate.
- Horizontal Pipecat replicas with Redis required.
- Multi-instance hardening for WebSocket tokens, Telnyx event dedupe, media-stream start, rate limits, and deploy draining.
- A queued post-call worker system with a dependency graph and dead-letter handling.
- Database constraints, indexes, pooling, and idempotency changes for concurrent writes.
- PHI-safe queue, Redis, logging, retention, and audit practices.

Several schema-level decisions were evaluated for forward compatibility. The current scaling branch implementation is more conservative than the original rev-2 target for operational tables, while already landing memory partitioning (full status in §2.7 Schema Layout And Partitioning):

- Current migrations create `senior_call_schedules`, `call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`, Node-owned `canary_cohort_membership`, 64 hash-partitioned `memories`, and unpartitioned `prospect_memories` in the default application schema, matching the active services and tests.
- Current queue, attempt, and job tables are not hash-partitioned. They rely on senior/status/lease/dedupe indexes and `FOR UPDATE SKIP LOCKED`; `senior_id` hash partitioning remains a forward-compatible migration decision for operational tables before higher-volume rollout. Memory partitioning has already landed because memory search/write growth is the higher-risk user-data hot path.
- Post-call work currently uses `post_call_jobs` as the Postgres metadata/work table behind an opt-in worker. A Pipecat-side worker can execute heavy post-call jobs today; a durable workflow engine (Temporal Cloud or Inngest) remains the recommended production runtime once Phase 0 closes that decision.
- DB scaling observability is available through the admin observability API/dashboard with PHI-free pool, lock, hot-table, and queryid-only slow-query aggregate views.
- Current Redis key shapes are single-region: `pipecat:instance:{instance_id}`, `pipecat:reservation:{reservation_id}`, and `pipecat:queue-reservations:{queue_id}`. Region-aware schema and Redis keys remain future multi-region work.

Provider capacity and BAAs are required for Telnyx, ElevenLabs, Deepgram, Anthropic, Google/Gemini, OpenAI/Tavily (if used during calls or post-call work), Resend, Neon, Railway, Sentry, Upstash/Redis vendor.

---

# 1. Goals and Constraints

## 1.1 Goal

Scale Donna's call infrastructure to 2,000 active seniors with a daily call each, sustaining bursts of up to 667 calls in a 15-minute window, with no duplicate dialing, no PHI leaks, and no capacity stampedes.

## 1.2 Capacity Target

- Design the system for **600 concurrent active AI calls**.
- Keep the design extensible to **900** without re-architecture.
- Treat **1,800 concurrent** as a later enterprise-tier design point.

## 1.3 SLO Table (single source of truth)

All numeric targets live here. Phases reference this table; they do not redefine targets.

| Metric | Target | Notes |
| --- | --- | --- |
| Outbound call setup p95 | ≤ 1.5s at 600 active | dispatcher decision → media start |
| Inbound answer-to-media p95 | ≤ 1.5s during peak | telnyx event → media start |
| Hard-reminder queue lag p95 | ≤ 180s | queue `earliest_at` → lease |
| Reminder-retry queue lag p95 | ≤ 300s | same |
| Scheduled-checkin queue lag p95 | ≤ 360s | same |
| Welfare queue lag p95 | ≤ 1800s | same |
| Manual queue lag p95 | ≤ 30s | same |
| DB pool idle | ≥ 15% sustained at peak | per service |
| Post-call critical job p95 | ≤ 5 min | conversation completion, reminder recovery |
| Post-call high-severity notification p95 | ≤ 5 min | from end-of-call |
| Post-call normal summary p95 | ≤ 15 min | from end-of-call |
| Post-call memory/snapshot p95 | ≤ 30 min | from end-of-call |
| Duplicate-call rate | 0 / 10,000 load-test dispatches | guard + reconciler |
| Outbound answer rate at peak | ≥ 80% of single-call baseline | from caller-ID strategy canary |
| PHI sentinel scan hits | 0 | logs, Sentry, Redis raw, queue tables |
| Cost per senior per month | within Phase 0 budget | see §1.5 |

## 1.4 Capacity Assumptions

All assumptions in this section are **placeholders to be replaced by Phase 0 baseline metrics.** The capacity table is recomputed once baselines exist; the values below are illustrative.

- 2,000 active seniors.
- One scheduled call per senior per day.
- Three common calling windows per day.
- Each window is 15 minutes.
- Average connected call duration: **TBD by Phase 0** (rev 1 assumed 10 min).
- 30% operational headroom.

| Scenario | Calls in 15-min window | Avg active concurrency | + 30% headroom |
| --- | ---: | ---: | ---: |
| Evenly split across 3 windows | 667 | (Phase 0) | (Phase 0) |
| Heavier single window | 1,000 | (Phase 0) | (Phase 0) |
| All-in-one window | 2,000 | (Phase 0) | (Phase 0) |

**Nuance:** active call concurrency and dial-attempt concurrency are different. A call consumes Telnyx outbound capacity when Donna dials; it consumes Pipecat / STT / LLM / TTS capacity only after a human answers and media starts. First version reserves AI capacity before dialing; an overbooking factor is added only after measured answer rate and answer latency exist.

## 1.5 Cost Model (Phase 0 deliverable)

Phase 0 produces a $/call and $/senior/month projection at 200, 500, 1,000, and 2,000 users covering:

- Pipecat replicas (Railway compute)
- Node API + dispatcher (Railway compute)
- Neon database (current tier vs. scaled tier and pooled-connection tier)
- Redis (Upstash production tier vs. Railway TCP Redis)
- Anthropic Haiku tokens (input + output, with realistic prompt-cache hit-rate assumption)
- Deepgram concurrent streams + minutes
- ElevenLabs TTS minutes (and Cartesia fallback)
- OpenAI embeddings + news search
- Tavily searches
- Telnyx outbound minutes + caller-ID pool fees
- Resend email volume
- Sentry events / month
- GrowthBook usage

Production canary (Phase 7) is **blocked until the cost projection at the target user count is approved** by founders.

## 1.6 Vendor Capacity Inventory (Phase 0 deliverable)

| Vendor | Today's measured peak | Contract cap | BAA status | Owner | Target close |
| --- | --- | --- | --- | --- | --- |
| Anthropic Haiku TPM (in / out) | TBD | TBD | TBD | TBD | TBD |
| Anthropic Haiku concurrent calls | TBD | TBD | — | TBD | TBD |
| Deepgram concurrent streams | TBD | TBD | TBD | TBD | TBD |
| ElevenLabs concurrent TTS | TBD | TBD | TBD | TBD | TBD |
| Cartesia concurrent TTS (fallback) | TBD | TBD | TBD | TBD | TBD |
| OpenAI embeddings RPM | TBD | TBD | TBD | TBD | TBD |
| OpenAI news / web search QPS | TBD | TBD | TBD | TBD | TBD |
| Tavily QPS | TBD | TBD | — | TBD | TBD |
| Telnyx outbound concurrent channels | TBD | TBD | done | TBD | done |
| Telnyx inbound concurrent channels | TBD | TBD | done | — | done |
| Telnyx caller-ID pool (if applicable) | — | TBD | done | TBD | TBD |
| Neon connections (pooled URL) | TBD | TBD | done | TBD | done |
| Redis vendor (Upstash or Railway) | TBD | TBD | TBD | TBD | TBD |
| Resend send rate | TBD | TBD | TBD | TBD | TBD |
| Sentry events / month | TBD | TBD | — | TBD | TBD |

**Phase 7 (live canary) is gated on completed BAAs for every vendor that touches PHI.**

## 1.7 Out of Scope (rev 2 addition)

The following are explicitly out of scope for the 2,000-user milestone:

- Multi-region call routing or data residency.
- Multi-database or multi-tenant sharding. For this milestone, scale reads/writes with durable queue tables, indexes, pooling, and worker concurrency caps first.
- More than one scheduled call per senior per day.
- B2B / facility tenancy with shared admins.
- Real-time co-listening, three-way calling, or multi-party calls.
- Caregiver self-serve dispatch overrides ("call my dad now" beyond existing manual call).
- Replacing Telnyx as the call provider during this milestone.
- Replacing Claude Haiku as the in-call LLM during this milestone.
- Geographic anti-affinity for Pipecat replicas.

If demand emerges for any of these, they become a separate plan after the 2,000-user milestone is verified.

**Database sharding note:** do not shard by last name. Last name is PHI-adjacent, skewed, mutable, and does not line up with Donna's access patterns. If Phase 0 database measurements show one table is still hot after indexes, pooling, and queue leasing, the next step is Postgres-native partitioning by operational key (`senior_id` hash or time window, depending on the table). Multi-database sharding would use opaque tenant/senior hash routing, not names, and stays out of scope for 2,000 users.

---

# 2. Architecture

## 2.1 Four Planes

1. **Schedule materialization** — turn caregiver schedules and reminder schedules into durable queue entries.
2. **Dispatch** — lease eligible queue entries by priority and capacity, then ask Pipecat to dial.
3. **Voice runtime** — Pipecat replicas handle admitted media streams with Redis-backed global state.
4. **Post-call processing** — heavy work runs in workers under explicit concurrency caps and dependency ordering.

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
                           post_call_jobs (with dependency graph)
                                  |
                                  v
                     throttled post-call workers
```

## 2.2 Consistency Model

1. **Postgres decides what should happen.** Durable, auditable, retryable state.
2. **Redis decides what can happen right now.** Short-lived runtime state with TTLs.
3. **In-memory state owns only the call this replica is actively processing.**

### Postgres responsibilities

- due work and dedupe: `senior_call_schedules`, `call_queue`, `dedupe_key`
- dispatch ownership: `lease_owner`, `lease_expires_at`, `FOR UPDATE SKIP LOCKED`
- dial idempotency: `outbound_call_guards.guard_key`
- provider attempt history: `call_attempts`
- post-call retry and dependency state: `post_call_jobs`
- export, hard-delete, legal-hold, audit, retention coverage

Multiple Node materializer/dispatcher workers are safe because they coordinate through Postgres unique constraints and row leases, not because only one process is running.

### Redis responsibilities

Required once Pipecat has more than one replica:

- Pipecat instance heartbeats and drain state
- global active capacity and pending start reservations
- WebSocket token atomic consume state
- Telnyx webhook event dedupe
- media stream start locks
- senior cooldown keys (if cooldown stays outside Postgres)
- distributed rate-limit counters
- encrypted/shared context payloads with short TTLs

Critical Redis operations must be atomic. Use `SET ... NX EX ...` or Lua/transactional helpers for token claims, stream-start locks, event dedupe, and reservation acquire/release.

Recommended key families:

- `pipecat:instance:{instance_id}` (heartbeat hash, TTL 15s)
- `pipecat:drain:{instance_id}`
- `call:metadata:{call_control_id}`
- `call:ws_token:{call_control_id}:{token_hash}`
- `call:ws_token_claimed:{call_control_id}`
- `telnyx:event:{event_id}` (TTL 10–30 min)
- `telnyx:stream_started:{call_control_id}` (TTL = max call duration + buffer)
- `pipecat:reservation:{reservation_id}` (reservation payload, TTL 2–5 min)
- `pipecat:queue-reservations:{queue_id}` (queue-to-reservation set)
- `pipecat:reservation-slot:{instance_id}:{reservation_id}` (slot-level guard)
- `call:pending_start:{call_control_id}`
- `senior:cooldown:{senior_id}` (TTL 10 min)
- `rate:{scope}:{key}`

### In-memory responsibilities

Allowed only when losing the state cannot create duplicate calls, over-admit capacity, bypass auth, or lose required audit/deletion state.

Move out of memory before horizontal scale:

- `scheduleCalledToday`, `welfareCalledToday`, `seniorLastCallTime`
- local Telnyx webhook dedupe
- local media-stream-start flags
- local-only WebSocket token consume state
- local active capacity as the only capacity signal
- local public rate-limit counters

Keep in memory:

- active pipeline objects for a call already assigned to that replica
- per-call audio buffers / processors
- best-effort local caches that are safe to miss or lose

## 2.3 Priority Lanes (revised — inbound added)

| Lane | Purpose | Initial reserve at 600 slots | Deadline behavior |
| --- | --- | ---: | --- |
| `manual` | Caregiver/admin "call now" | 8% | dispatch immediately if reserve available |
| `inbound` | Inbound caregiver / new customer / senior callback | 7% | not dispatched (Pipecat admits); reservation accounted for global capacity |
| `hard_reminder` | Medication/appointment reminders with hard times | 35% | dispatch close to target; protect capacity |
| `reminder_retry` | Retry after missed/no-ack reminder | 15% | dispatch before retry deadline |
| `scheduled_checkin` | Normal scheduled companion calls | 30% | smooth within 15-min window |
| `welfare` | Seniors without recent completed calls | 5% | best effort within safe calling hours |
| `low_priority_retry` | Catch-up and non-urgent retries | spare | only on spare capacity |

**Inbound is a new explicit lane (rev 2).** Pipecat admits inbound calls directly through `/telnyx/events`, not through the queue. The lane exists so that:

- the dispatcher subtracts inbound activity from global capacity when leasing outbound rows
- a sudden inbound surge cannot starve an in-flight outbound window
- the Stage 5 test matrix includes a 50-inbound + 200-outbound concurrency test

Unused higher-priority capacity can spill downward. Lower-priority lanes do not consume protected `manual`, `inbound`, or `hard_reminder` reserve unless an explicit emergency override is enabled.

## 2.4 Dial Authority and Double-Call Guard

`outbound_call_guards` is the durable safety primitive. Both legacy and queue dialers must acquire the same guard row before initiating a Telnyx call.

Suggested table:

- `id uuid primary key`
- `senior_id uuid not null`
- `guard_key text not null` (unique while active)
- `call_type text not null`
- `architecture text not null` (`legacy` | `queue`)
- `queue_id uuid`
- `legacy_dedup_key text`
- `target_at timestamp not null`
- `expires_at timestamp not null`
- `call_control_id text`
- `status text not null`
- `created_at timestamp default now()`
- `updated_at timestamp default now()`

Guard key examples:

- schedule: `schedule:{senior_id}:{local_date}:{schedule_item_id_or_time}`
- reminder: `reminder:{reminder_id}:{normalized_scheduled_for}`
- welfare: `welfare:{senior_id}:{local_date}`
- manual: `manual:{senior_id}:{request_id}`

**Senior-delete race (rev 2 addition):** before issuing the HTTP call to Pipecat `/telnyx/outbound`, the dispatcher MUST re-check, inside the same transaction that flips guard status from `acquired → initiating`:

- `senior.is_active = true`
- `senior.deleted_at IS NULL`
- caregiver-paused state for this senior is still false

If any check fails, the guard transitions to `cancelled`, the Redis reservation is released, and `call_attempts` records the suppression. This race is not covered by the materializer or reconciler alone — a lease can be held for 60 seconds while the senior is deleted.

## 2.5 PHI Data Classification

| Surface | PHI allowed? | Storage rule | Retention/export/delete |
| --- | --- | --- | --- |
| `senior_call_schedules` | Only encrypted context notes | IDs / times / plain operational fields; context encrypted | Covered by senior export/delete |
| `call_queue` | No raw PHI | IDs, lane, status, timestamps only | Operational retention + senior delete |
| `call_attempts` | No raw PHI | IDs, provider IDs, outcomes only | Operational retention + senior delete |
| `outbound_call_guards` | No raw PHI | IDs, guard keys, status only | Short retention + senior delete |
| `scheduler_shadow_comparisons` | No raw PHI | IDs, decisions, skip reasons only | Short retention; no transcripts/reminder text |
| `post_call_jobs` | Yes, only if necessary | Prefer IDs; encrypt payload body | Export/delete/retention/legal hold |
| `memories` | Yes | Senior-owned memories only; 64 hash partitions by `senior_id`; embeddings + encrypted/plain memory fields follow existing memory rules | Export/delete/retention/legal hold |
| `prospect_memories` | Yes | Prospect-owned onboarding memories split out of senior partition set | Export/delete/retention/legal hold |
| Redis call metadata | Yes | Encrypted shared-state payload, short TTL | TTL + incident runbook |
| Redis locks/heartbeats | No raw PHI | IDs and counters only | TTL |
| Logs/metrics/dashboards | No raw PHI | IDs/counts/status only; hash where possible | Log retention and review |
| `audit_logs` (incl. shadow decisions) | No raw PHI in metadata | resource IDs only | 2,190 days |

## 2.6 Configuration Matrix

Single source of truth for flags. Defaults by environment.

| Flag | Dev | Staging | Canary | Prod (target) |
| --- | --- | --- | --- | --- |
| `CALL_ARCHITECTURE_MODE` | `legacy_only` | `shadow_materialize` → `shadow_dispatch` | `canary_queue` | `queue_primary` |
| `CALL_QUEUE_DUAL_WRITE_SCHEDULES` | false | true | true | true |
| `CALL_QUEUE_SHADOW_MATERIALIZE` | false | true | true | (n/a) |
| `CALL_QUEUE_SHADOW_DISPATCH` | false | true | true | (n/a) |
| `CALL_QUEUE_CANARY_PERCENT` | 0 | 0 | per ramp step | 100 |
| `CALL_QUEUE_COHORT_ALLOWLIST` | empty | empty | pilot IDs | empty |
| `CALL_QUEUE_ALLOW_REAL_DIAL` | false | false | true | true |
| `CALL_QUEUE_REQUIRE_DIAL_GUARD` | true | true | true | true |
| `CALL_QUEUE_COMPARE_WITH_LEGACY` | true | true | true | false |
| `CALL_QUEUE_MATERIALIZER_LIMIT` | 100 | 1000 | 1000 | 1000 |
| `CALL_QUEUE_DISPATCHER_ENABLED` | false | true (dry-run) | true | true |
| `CALL_QUEUE_RECONCILER_ENABLED` | false | true | true | true |
| `CALL_QUEUE_USE_CAPACITY_REGISTRY` | false | true | true | true |
| `CALL_QUEUE_REQUIRE_CAPACITY_REGISTRY` | false | false | true | true |
| `CALL_DISPATCH_MAX_BATCH_SIZE` | 10 | 50 | 100 | 100 |
| `CALL_DISPATCH_LEASE_SECONDS` | 60 | 60 | 60 | 60 |
| `CALL_DISPATCH_OVERBOOK_FACTOR` | 1.0 | 1.0 | 1.0 | 1.0 (revise after Phase 7) |
| `POST_CALL_QUEUE_ENABLED` | false | true | true | true |
| `POST_CALL_WORKER_ENABLED` | false | true | true | true |
| `PIPECAT_REQUIRE_REDIS` | false | true | true | true |
| `PIPECAT_DRAINING` | false | false | false | toggled by autoscaler |
| `MAX_CONCURRENT_CALLS` | 5 | 25 | 75 | 75 |
| `DB_POOL_MAX` (Pipecat per replica) | 10 | 10 | 15 | 15 |
| `DB_POOL_MAX` (Node) | 10 | 20 | 20 | 20 |
| `REDIS_RATE_LIMITS_ENABLED` | false | true | true | true |
| `LOG_LEVEL` | DEBUG | INFO | INFO | INFO |

### 2.6.1 Initial Code Merge / Environment Flag Plan

Use this plan when promoting the `zuludev` code to `main` before changing dial-authority behavior. The goal is code parity first, then environment-scoped behavior changes.

**Code rollout:**

1. Merge `zuludev` into `main` once the branch is ready.
2. Deploy the same merged code to `main` / production, dev, and `zuludev`.
3. Treat the code deploy and the shadow-traffic flag flip as separate changes. A successful code deploy is not permission to start shadow materialization in every environment.

**Main / production flags stay inert:**

```bash
CALL_ARCHITECTURE_MODE=legacy_only
CALL_QUEUE_ALLOW_REAL_DIAL=false
CALL_QUEUE_DISPATCHER_ENABLED=false
CALL_QUEUE_SHADOW_MATERIALIZE=false
CALL_QUEUE_SHADOW_DISPATCH=false
POST_CALL_QUEUE_ENABLED=false
PHASE8_AUTOSCALER_ENABLED=false
```

**Dev flags stay inert for merge smoke testing:**

Dev receives the same new code first, but starts with the same inert flag set as main / production. Use dev to verify boot, config validation, migrations against a dev database, and that the legacy scheduler still behaves normally. Do not enable shadow traffic in dev unless the test objective explicitly requires it and the dev database is isolated.

**Only `zuludev` starts shadow materialization:**

After the `zuludev` database has the queue tables and the schedule backfill dry-run is clean, set only the `zuludev` environment to:

```bash
CALL_ARCHITECTURE_MODE=shadow_materialize
CALL_QUEUE_DUAL_WRITE_SCHEDULES=true
CALL_QUEUE_COMPARE_WITH_LEGACY=true
CALL_QUEUE_ALLOW_REAL_DIAL=false
CALL_QUEUE_DISPATCHER_ENABLED=false
CALL_QUEUE_SHADOW_DISPATCH=false
```

If `zuludev` is a non-production environment and the scheduler needs to run there, also set:

```bash
SCHEDULER_ALLOW_NON_PROD=true
```

**Preflight before flipping `zuludev` to shadow materialization:**

- Confirm the target database has `senior_call_schedules`, `call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`, and `canary_cohort_membership`.
- Run `npm run phase2:validate-rollout-config`.
- Run `npm run phase2:backfill-call-schedules -- --dry-run`; write the backfill only after the dry-run output is clean and PHI-free.
- Confirm `CALL_QUEUE_ALLOW_REAL_DIAL=false` and `CALL_QUEUE_DISPATCHER_ENABLED=false` immediately before and after the flag change.

**Expected result:**

Main / production and dev run the new code in `legacy_only` mode. `zuludev` runs shadow materialization only: legacy remains the only real dial authority, queue rows and shadow comparisons are created, and no queue-owned Telnyx calls are placed.

## 2.7 Schema Layout And Partitioning

This section separates the **current branch implementation** from the **forward-compatible schema target**. The distinction matters because the active code, tests, and runbooks currently use unqualified table names such as `call_queue`, not `ops.call_queue`.

### Current scaling-branch implementation

Verified against `db/migrations/010_call_queue_foundation.sql`, `db/migrations/011_call_queue_concurrent_indexes.sql`, `db/migrations/012_post_call_job_state_machine.sql`, `db/migrations/013_canary_cohort_membership.sql`, `db/migrations/021_memories_hash_partitioned.sql`, `pipecat/db/migrations/023_call_queue_foundation.sql`, `pipecat/db/migrations/024_call_queue_concurrent_indexes.sql`, `pipecat/db/migrations/025_post_call_job_state_machine.sql`, `pipecat/db/migrations/032_memories_hash_partitioned.sql`, `services/call-queue.js`, `services/post-call-jobs.js`, `services/memory.js`, `pipecat/services/memory.py`, and the integration tests:

- `senior_call_schedules`, `call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`, and Node-owned `canary_cohort_membership` are created in the default application schema.
- `memories` is a default-schema table partitioned into 64 hash partitions by `senior_id`. `senior_id` is non-null, senior memory writes/searches include `senior_id`, and prospect memory rows are stored separately in `prospect_memories`.
- There is no `ops` schema, `call_control_index` table, `call_attempts.region` column, or `PARTITION BY HASH` declaration for the current queue/job/attempt tables.
- The current uniqueness model is global `dedupe_key`, global `outbound_call_guards.guard_key`, `(queue_id, attempt_number)`, and partial unique `call_attempts.call_control_id` where not null.
- The current hot-path scaling primitives are indexes on status/lane/time/senior, `FOR UPDATE SKIP LOCKED` leasing, bounded worker batches, Redis capacity reservations, the durable guard reconciler, senior-scoped memory partition pruning, and PHI-safe DB observability for pool/lock/hot-table pressure.
- Current Redis capacity keys are `pipecat:instance:{instance_id}`, `pipecat:reservation:{reservation_id}`, and `pipecat:queue-reservations:{queue_id}`.

This current shape is the one reflected by `docs/architecture/ARCHITECTURE.md`, `docs/architecture/PERFORMANCE.md`, the Phase 1 migration runbook, and the test suite.

### Forward-compatible target

The original rev-2 operational-table target remains valid as a scaling direction, but it is **not implemented on the current branch**. Before applying Phase 1 to a live database, choose one of these paths in writing:

1. If no shared environment has applied the current migrations yet, rewrite the Phase 1 migrations and service SQL to use `ops.*`, hash-partitioned queue/job tables, `call_control_index`, and region columns before the first live apply.
2. If staging or production has already applied the current migrations, keep the current flat tables for the 2,000-user rollout unless Phase 0 clone timing or load tests show DB write pressure. Then add a separate online migration plan for `ops.*` and partitioning.

The forward target is:

- Operational tables (`call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`, `call_control_index`) move under a dedicated `ops.*` schema so they can later be placed on a dedicated operational Postgres.
- `call_queue`, `call_attempts`, and `post_call_jobs` become hash-partitioned by `senior_id` with 16 partitions.
- Primary keys on partitioned tables include the partition key, and unique constraints include `senior_id` where Postgres requires it.
- `ops.call_control_index` remains unpartitioned for global `call_control_id -> (senior_id, queue_id, attempt_id)` lookup if `call_attempts` becomes partitioned.
- Memory tables do not wait for this future operational-table move: senior-owned `memories` already uses 64 hash partitions by `senior_id`; the future memory decision is when to move vector search to a dedicated pgvector/vector store if measured memory-search or embedding-write pressure exceeds the primary database budget.

Example target DDL shape, not current branch DDL:

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

### Region column and key shape

Current code is single-region from an application-data perspective. Railway scaling scripts accept a Railway region argument for actuator commands, but call routing and queue schemas do not branch on region.

Multi-region call routing is explicitly out of scope per §1.7. When it becomes in scope, add `region` to the operational attempt/reservation model and reshape Redis keys deliberately; do not assume the current single-region key shape already encodes region.

### Table scaling risk snapshot

This is the scale-bearing table list for the 2,000 -> 10,000 path. Risk means "likely to become a bottleneck under burst/write/search pressure," not compliance sensitivity.

| Table / family | Main pressure | 2k risk | 10k risk | Current posture |
| --- | --- | --- | --- | --- |
| `memories` | Senior-scoped vector search + post-call writes | Medium | High | 64 hash partitions by `senior_id`; every senior read/write includes `senior_id` for partition pruning. Move to dedicated vector store only after measured memory pressure. |
| `prospect_memories` | Onboarding/prospect memory writes | Low | Medium | Split out so prospect rows do not dilute senior memory partitions. |
| `post_call_jobs` | End-of-window job burst, retries, dependencies | Medium | High | Flat table with indexes and `FOR UPDATE SKIP LOCKED`; heavy Pipecat worker drains jobs under concurrency caps. Candidate for `ops.*`/partitioning or workflow engine before 10k if backlog/DB pressure grows. |
| `call_queue` | Dispatcher lease contention | Low/Medium | Medium/High | Flat table is acceptable for 2k with status/lane/time indexes and bounded batches. Partition/worker-affinity only when DB observability shows lock or lease pressure. |
| `call_attempts` | Burst insert/update history | Medium | High | Flat indexed table; key candidate for `ops.*`/dedicated operational Postgres if burst writes hit DB pool SLOs. |
| `outbound_call_guards` | Dial-authority uniqueness | Low | Medium | Small, short-retention safety table; keep indexed and short-lived. |
| `scheduler_shadow_comparisons` | Shadow-mode write volume | Low | Low/Medium | Short retention; PHI-free. Can be archived/deleted aggressively after rollout. |
| `senior_call_schedules` | Materializer scans | Low | Medium | Normalized schedule table with predictable scan pattern; add region/time-window partitioning only if materializer p95 moves. |
| `reminder_deliveries` | Reminder dedupe/history writes | Medium | Medium/High | Idempotency key and indexes matter more than partitioning at 2k; watch write spikes around hard reminders. |
| `conversations` and transcript rows | Append-only call history | Medium | High | Keep hot-path writes idempotent; journal/archive split is likely before 100k and may be useful before 10k if storage/write pressure rises. |
| `call_analyses` / summaries | Post-call analysis writes/reads | Low/Medium | Medium/High | Queue heavy writes; consider journal split with conversations when analysis volume grows. |
| `call_metrics` | Per-call aggregate metrics | Low | Medium | Unique by call SID; useful for SLOs and cost. Keep small and indexed. |
| `audit_logs` | Append-only compliance events | Medium | High | Never queried in hot path. S3/Parquet or warehouse archival is a likely 10k+ move. |
| `seniors`, `caregivers`, `reminders`, `daily_call_context` | User-scoped OLTP reads/writes | Low/Medium | Medium | Stay in primary Postgres; add read replicas/caches for dashboard pressure before sharding. |
| `canary_cohort_membership` | Rollout membership lookup | Low | Low | Node-owned, small operational table; retain/delete with rollout policy. |

## 2.8 Dual-Path Rollout Contract

The durable queue tables in §2.7 give us the substrate; this section is the operational contract for **running legacy and queue in parallel** while we migrate. Both paths stay deployed and able to take traffic through every phase below — until we sit on `queue_primary` for the full clean window in §3 Phase 9, we never delete the legacy path.

The rollout is deliberately concurrent, but not double-authoritative. The legacy scheduler and queue path may both evaluate the same due work during migration; only one path may place a real Telnyx call for a given senior/call instance.

**Non-negotiable invariant:** at every phase, there is exactly one real dial authority per senior/time window. The other path may materialize rows, acquire dry-run leases, compare decisions, and emit audit/comparison records, but it must not call Telnyx.

| Mode | Legacy path | Queue path | Real dial authority | Required purpose |
| --- | --- | --- | --- | --- |
| `legacy_only` | evaluates + dials | disabled except guarded tests | legacy | current behavior / rollback |
| `shadow_materialize` | evaluates + dials | materializes queue rows + comparison records only | legacy | prove schedule normalization and queue dedupe |
| `shadow_dispatch` | evaluates + dials | materializes + dry-run leases + capacity simulation; no Telnyx calls | legacy | prove leasing, lane policy, capacity inputs, reconciler |
| `canary_queue` | evaluates + dials for non-canary cohorts | dials only allowlisted/canary cohort | split by cohort, never both | live treatment/control comparison |
| `queue_primary` | evaluates only if needed for rollback visibility; skips execution | dials all eligible queue rows | queue | production target |
| `legacy_rollback` | evaluates + dials | dispatcher stopped; existing queue rows retained for analysis; no new materialization by default | legacy | emergency rollback |

Operational rules:

- `CALL_QUEUE_ALLOW_REAL_DIAL=true` is only valid in `canary_queue` or `queue_primary`. In `shadow_materialize` and `shadow_dispatch`, queue work must remain non-dialing.
- `outbound_call_guards.guard_key` is shared by both paths and must be acquired before any Telnyx request. A duplicate guard acquisition is a rollback trigger.
- In `canary_queue`, cohort assignment must be deterministic and logged by ID/cohort only. Non-canary seniors remain on legacy so treatment/control can run concurrently. Queue leasing and legacy filtering must use the same ID-only allowlist/bucket logic from `CALL_QUEUE_COHORT_ALLOWLIST` and `CALL_QUEUE_CANARY_PERCENT`.
- Shadow and canary comparisons must write `scheduler_shadow_comparisons` and the `audit_logs` `shadow_decision` event without names, phone numbers, reminder text, transcripts, caregiver notes, or prompt context.
- Rollback is a mode flip to `legacy_rollback` or `legacy_only`, plus dispatcher stop/drain. Queue rows, attempts, reservations, and guards are preserved for reconciliation.
- Legacy scheduler code and flags remain deployable through the full 2,000-user rollout; removing them is a separate cleanup phase after 14 clean days on `queue_primary` (see §3 Phase 9).

---

# 3. Phased Implementation

Each phase has a **prerequisite gate** (must be true before phase starts), **work items**, and **numeric exit criteria** (must be true before phase ends). Phases run in number order unless explicitly marked parallel. Phase 7 has hard gates from both Phase 3 and Phase 6.

## Phase 0 — Measure, Decide, Contract (BLOCKING, ~2 weeks)

Phase 0 is no longer a thin guardrail. It produces measurements, closes decisions, and starts vendor contracts before any code change downstream. Codex's rev 1 jumped to building because rev 1's Phase 0 let it; rev 2 does not.

**Prerequisite gate:** none.

**Work items:**

1. **Production baseline metrics.** Instrumented and visible in dashboards for at least 7 continuous days before Phase 1 starts:
   - p50 / p95 connected call duration (last 30 days)
   - Answer rate by window (morning / afternoon / evening)
   - Current scheduler cycle p50 / p95
   - Peak concurrent calls observed (last 30 days)
   - Peak DB pool utilization per service (Node + Pipecat)
   - Peak Anthropic input TPM and output TPM
   - Peak Deepgram concurrent streams
   - Peak ElevenLabs concurrent TTS
   - Peak OpenAI embeddings RPM
   - Telnyx outbound concurrent channels observed
   - Pipecat per-replica CPU + memory at observed peak
   - **Anthropic prompt-cache hit rate** (within-call and across-call). Within-call hit rate confirms the 1024-token cacheable prefix is real; across-call hit rate determines whether cross-call cache reuse is feasible at 600 concurrent calls.
2. **Vendor concurrency + BAA inventory.** §1.6 table fully populated with measured peaks and contract caps. BAA chase started for every vendor that touches PHI; status logged with owner + target date.
3. **Cost model.** §1.5 projection published.
4. **Outbound caller-ID strategy.** Telnyx conversation closed. Decided: one of single ID, number pool, branded calling, STIR/SHAKEN attestation. Decision documented; owner named.
5. **All Open Decisions closed in writing** (see §6). No code in Phase 2+ relies on a still-open decision.
6. **Out-of-scope list published** (§1.7).
7. **Observability scaffolding deployed.** Metrics, dashboards, alerts for queue depth (placeholder), capacity (placeholder), post-call backlog (placeholder), DB pool, vendor rate-limit errors. PHI sentinel scan implemented as CI job. The placeholders matter — when Phase 2 lands, queue depth dashboards already exist.
8. **Incident runbook v1.** One-pager covering at minimum:
   - DB pool exhausted at T-2 min before window
   - Redis unavailable in scaled mode
   - Dispatcher stuck (queue growing, no leases)
   - Pipecat replica down at T-5 min
   - Telnyx outbound failure storm
   - Vendor rate-limit storm (Anthropic / Deepgram / ElevenLabs)
   - PHI sentinel hit in production
   - Duplicate-call detected post-hoc
   - Replica readiness gate stuck red
9. **Migration timing dry-run.** Run the Phase 1 migrations against a clone of production data; record elapsed time per statement. Establish max acceptable lock duration.

**Exit criteria:**

- 7+ days of baseline metrics visible in dashboards.
- BAA chase started for every PHI-touching vendor (status logged with owner + target date).
- Cost model approved by founders for the 2,000-user target.
- Caller-ID strategy decided and documented.
- All Open Decisions closed in writing.
- Runbook v1 reviewed by oncall + founders.
- Phase 1 migrations timed on prod-sized clone with acceptable lock duration.
- §1.4 capacity table refreshed with real numbers in place of placeholders.

**Phase 0 implementation artifacts on this branch:**

- Readiness/runbook checklist: `docs/operations/scale-2000-phase0-readiness.md`.
- Live staging drill runbook: `docs/operations/scale-2000-live-drills.md`.
- PHI-free aggregate baseline collector: `npm run phase0:baseline -- --days=30 --out=tmp/phase0-baseline.json`.
- Cost model generator: `npm run phase0:cost -- --baseline=tmp/phase0-baseline.json --assumptions=tmp/phase0-cost-assumptions.json`.
- Cost assumption template: `docs/operations/templates/phase0-cost-assumptions.example.json`.
- Business-plan cost assumptions file: `docs/operations/templates/phase0-cost-assumptions.business-plan-current.json`.
- Redis/shared-state drill: `npm run phase0:redis-drill -- --simulate-outage`.
- Guarded Telnyx call drill: `npm run phase0:live-call-drill -- --senior-id=<staging-senior-uuid> --confirm-live-call`.
- CI-safe PHI sentinel scan: `npm run phi:sentinel`.

These artifacts do not satisfy Phase 0 by themselves. They make the Phase 0 evidence repeatable; founders/oncall still need 7 days of dashboard data, vendor cap confirmation, BAA owners/target dates, caller-ID decision, runbook review, and migration timing on a production-sized clone before Phase 1 is considered unblocked.

## Phase 1 — Schema and Idempotency (~1 week)

**Prerequisite gate:** Phase 0 exit criteria met.

**Work items:**

1. **Schema and migrations.** See §2.7 for current branch status and the forward-compatible target.
   - Current branch migrations create `senior_call_schedules`, `call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`, and Node-owned `canary_cohort_membership` in the default application schema. Queue/job migrations are mirrored between Node and Pipecat; canary membership is Node-only today.
   - Current branch migrations also create 64 hash-partitioned senior `memories` plus unpartitioned `prospect_memories`, mirrored between Node and Pipecat. This is the proactive memory-scaling step; it is separate from operational queue/job partitioning.
   - Current branch migrations do **not** create `ops.*`, `call_control_index`, `call_attempts.region`, or hash partitions for queue/job/attempt tables. Do not mark those operational-table items complete until a separate migration/code rewrite lands.
   - Before live Phase 1 apply, record whether we are accepting the current flat-table implementation for the 2,000-user rollout or rewriting the migrations to the `ops.*` / partitioned target before any live data exists.
   - If the flat-table implementation is accepted, the trigger for `ops.*` / partitioning moves to the Phase 0 DB measurements and the §6 operational Postgres split decision.
2. **Keep `CREATE INDEX CONCURRENTLY` outside transactional migration files.** Current code has already split the concurrent indexes into `db/migrations/011_call_queue_concurrent_indexes.sql` and `pipecat/db/migrations/024_call_queue_concurrent_indexes.sql`. Live apply must run those files in autocommit/outside a transaction; do not run them through a migration runner that wraps files in `BEGIN/COMMIT`.
3. **`reminder_deliveries.delivery_key` backfill.** Existing rows have no delivery key. Backfill script that derives `delivery_key` from `reminder_id` + normalized `scheduled_for` (using the same tolerance window the current scheduler uses for dedupe). Run on a staging clone first; if any collisions are found, document the collision-resolution policy before applying the unique index in production.
4. **Migration timing measured on prod-sized clone**, not asserted. Each migration completes within the threshold set in Phase 0 dry-run. Before applying concurrent unique indexes, run an aggregate idempotency preflight that reports duplicate/collision counts only, never raw call SIDs, reminder IDs, delivery keys, names, phone numbers, transcripts, notes, or response bodies.
5. Idempotency constraints:
   - Unique `conversations.call_sid` where not null (CONCURRENTLY, separate step).
   - Unique `reminder_deliveries.delivery_key` where not null (CONCURRENTLY, separate step).
   - Unique `call_metrics.call_sid` in the Pipecat concurrent migration; `call_metrics` is one row per call and the post-call writer must tolerate duplicate retry attempts by updating the existing metrics row.
6. Retention coverage extended in both Node `services/data-retention.js` and Pipecat `services/data_retention.py` for all new tables (queue: 90d, attempts: 180d, jobs: 180d, guards: 30d, shadow comparisons: 30d). **Parity verified** between Node and Pipecat retention loops.
7. Hard-delete + legal-hold coverage extended to all new senior-linked tables.
8. Senior export endpoint extended to include new tables (encrypted fields decrypted only at the response boundary).

**Exit criteria:**

- Migrations applied on staging clone, timing recorded, no errors.
- Delivery-key backfill applied with 0 unresolved collisions on staging clone of prod.
- Idempotency preflight passes before concurrent indexes are applied.
- Unit + integration tests cover unique constraints and dedupe behavior.
- PHI sentinel scan passes against all new tables.
- Retention / hard-delete / export coverage tested end-to-end on staging clone.
- Node and Pipecat retention loops verified for mirrored queue/job tables, with Node-only coverage verified for canary cohort membership.

**Phase 1 implementation artifacts on this branch:**

- Migration runbook: `docs/operations/scale-2000-phase1-migration-runbook.md`.
- Aggregate idempotency preflight: `npm run phase1:preflight-idempotency`.
- Reminder delivery key backfill: `npm run phase1:backfill-delivery-keys -- --dry-run`, then `--write` only after zero collisions.
- Transaction-safe foundation migrations: `db/migrations/010_call_queue_foundation.sql` and `pipecat/db/migrations/023_call_queue_foundation.sql`.
- Non-transactional concurrent index migrations: `db/migrations/011_call_queue_concurrent_indexes.sql` and `pipecat/db/migrations/024_call_queue_concurrent_indexes.sql`.
- Post-call job state migrations: `db/migrations/012_post_call_job_state_machine.sql` and `pipecat/db/migrations/025_post_call_job_state_machine.sql`.
- Canary cohort membership migration: `db/migrations/013_canary_cohort_membership.sql` (Node-owned; no Pipecat mirror).
- Memory partition migrations: `db/migrations/021_memories_hash_partitioned.sql` and `pipecat/db/migrations/032_memories_hash_partitioned.sql`.
- Gap vs forward target: the current operational queue/job/attempt migrations are flat default-schema tables, not `ops.*` and not `PARTITION BY HASH`. That is a documented remaining schema decision, not a completed Phase 1 artifact. Senior memories are already hash-partitioned.

## Phase 2 — Schedule Normalization and Materializer (~1–2 weeks)

**Prerequisite gate:** Phase 1 exit criteria met.

**Work items:**

1. Backfill `senior_call_schedules` from existing `seniors.preferred_call_times` via a Node script (`scripts/backfill-call-schedules.js`). Idempotent; safe to re-run.
2. Update senior create/update write paths to maintain normalized schedules under `CALL_QUEUE_DUAL_WRITE_SCHEDULES`. **Read paths must remain side-effect-free** — no shadow-mode flag may cause `GET /seniors/:id` to write to `senior_call_schedules`. Audit, latency, and retry behavior depend on read idempotency.
3. Materializer worker creating queue rows ≥45 min ahead of `target_at`. Idempotent via unique `dedupe_key`. Singleton behind a Postgres advisory lock.
4. **DST + timezone edge-case test suite (rev 2 addition).** Required tests:
   - Spring-forward day in senior timezone — call scheduled at the skipped local hour must not double-fire or silently drop.
   - Fall-back day — call scheduled at the duplicated local hour fires once.
   - Senior timezone change mid-day — next materializer cycle uses the new timezone; in-flight queue rows are not retroactively shifted.
   - Server in UTC vs. senior in PST/PDT vs. senior in HST.
   - One-time-date schedules on the DST boundary day.
5. **Shadow comparison audit trail (rev 2 addition).** `scheduler_shadow_comparisons` rows that record "would have called" decisions also write to `audit_logs` with `action='shadow_decision'`, `resource_type='senior'`, `resource_id=senior_id`. HIPAA review needs the decision trail to be queryable as part of the audit log, not as a side table.
6. PHI sentinel scan in CI gates PR merge for any change to scheduler / queue / materializer code.
7. Concurrent materializer tests at 10, 50, 100 due calls (correctness ladder).
8. Dual-path rollout setup starts here: staging runs `shadow_materialize`, legacy remains dial authority, and queue materialization/comparison runs beside it. Queue must not call Telnyx in this phase.

**Exit criteria:**

- Re-running materializer produces no duplicate queue entries (unique constraint enforced).
- 7+ days of shadow comparison data show ≥99% agreement with legacy on scheduled-call eligibility, 100% on paused/inactive suppression, 100% on reminder-instance dedupe.
- DST + timezone edge-case suite passes.
- Shadow comparisons appear in `audit_logs`.
- Concurrent materializer test passes at 10 / 50 / 100.
- `shadow_materialize` verified for 7 days with legacy as the only real dial authority.
- PHI sentinel scan clean.

**Phase 2 implementation artifacts on this branch:**

- Normalized schedule backfill: `npm run phase2:backfill-call-schedules -- --dry-run`.
- Rollout config preflight: `npm run phase2:validate-rollout-config`.
- Senior create/update dual-write: `services/seniors.js` writes `senior_call_schedules` when `CALL_QUEUE_DUAL_WRITE_SCHEDULES=true` or shadow materialization is enabled; senior read paths remain side-effect-free.
- Materializer: `services/call-schedules.js` creates queue rows 45 minutes ahead, advances `next_run_at`, and uses `pg_try_advisory_xact_lock` so only one materializer transaction runs at a time.
- DST/timezone and materializer correctness coverage: `tests/services/call-schedules.test.js`.
- Dual-path canary split guard: `services/call-queue.js` parses `CALL_QUEUE_COHORT_ALLOWLIST`, uses deterministic ID-only cohort buckets, and `services/scheduler.js` filters canary-owned seniors out of legacy execution when `canary_queue` is live.

## Phase 3 — Pipecat Multi-Instance Hardening (parallel with Phase 2; HARD prerequisite for Phase 7)

**Prerequisite gate:** Phase 1 exit criteria met.

This phase runs in parallel with Phase 2. It is a hard prerequisite for Phase 7 — live canary cannot start until every Phase 3 exit criterion is met.

**Work items:**

1. `PIPECAT_REQUIRE_REDIS=true`. Startup fails closed when Redis is missing or unreachable.
2. WebSocket token consume fail-closed in required mode (no local-fallback split brain).
3. Telnyx event dedupe moved to Redis (`telnyx:event:{event_id}`, TTL 600s, `SET NX EX`).
4. Media-stream-start lock moved to Redis (`telnyx:stream_started:{call_control_id}`, TTL = max call duration + buffer, `SET NX EX`).
5. Capacity heartbeat publisher (`pipecat:instance:{id}`, TTL 15s, interval 5s). Heartbeat fields are PHI-free: instance_id, service_version, active_calls, max_calls, pending_start_count, draining, healthy, db_pool_size, db_pool_idle, circuit_breakers_open.
6. `PIPECAT_DRAINING=true` admission behavior. Drain workflow: (1) flag set, (2) `/health` indicates no new admissions, (3) dispatcher stops routing reservations, (4) wait for active_calls=0 or max drain timeout (15 min), (5) terminate.
7. Redis-backed rate limits replace in-memory rate-limit counters in both Node and Pipecat.
8. **Replica readiness gate (rev 2 addition).** Beyond `/health=ok`, a new replica is marked "available capacity" by the autoscaler / dispatcher only after:
   - warm Neon pool (min connections established)
   - GrowthBook flags loaded
   - at least one warm Anthropic prompt-cache primer call completed (synthetic call against a stub senior to populate the 5-min cache)
   - Deepgram session creation tested successfully
   - ElevenLabs / Cartesia TTS session creation tested
   - circuit breakers all closed
   This addresses the cold-start cost during scale-up. Without it, the first ~10 calls on a freshly-spun-up replica during a peak window will see materially worse latency.
9. **Node-side dispatcher pool topology (rev 2 addition).** Separate the dispatcher worker(s) from the API server process so each can scale independently. Materializer + reconciler remain singletons behind Postgres advisory lock. Dispatcher workers are safe in parallel via `FOR UPDATE SKIP LOCKED`.
10. **Node-side drain (rev 2 addition).** SIGTERM handler on Node:
    - stop accepting new dispatcher leases
    - wait for in-flight leases to complete or hit `lease_expires_at`
    - release any unconfirmed Redis reservations the dispatcher acquired
    - exit
    Without this, deploying Node mid-window strands reservations and orphans queue leases.
11. **Inbound capacity lane wiring (rev 2 addition).** Pipecat heartbeat publishes `inbound_active_calls`. Dispatcher subtracts inbound activity from global capacity before leasing outbound. Inbound never blocks; outbound yields to inbound spikes within lane reserve.
12. Two-replica dev/staging integration test routing webhook + WebSocket across replicas. Includes:
    - duplicate webhook event ID arriving at both replicas (one wins, one suppressed)
    - WS token claim attempted on both replicas (one wins, one rejected)
    - stream-start race between replicas (one wins, one suppressed)

**Exit criteria:**

- Two-replica dev environment passes duplicate-webhook, WS-token-replay, and stream-start-race tests.
- Redis-outage in scaled mode fails closed without admitting calls (verified by killing Redis in staging).
- Replica readiness gate verified: a cold replica takes scheduled traffic only after the gate flips green. Time-to-green measured and recorded.
- Inbound surge test: 50 concurrent inbound + 200 concurrent outbound — no dropped calls, both lanes within SLOs from §1.3.
- Node-side drain verified: SIGTERM during in-flight dispatch completes without orphaned leases or reservations.

**Current implementation artifacts on `zuludev`:**

- Shared Pipecat state is Redis/Upstash-aware in `pipecat/lib/redis_client.py`; `PIPECAT_REQUIRE_REDIS=true` fails closed when shared state is unavailable.
- WebSocket token consume, Telnyx event dedupe, and media-stream start locks use shared atomic state in `pipecat/api/routes/call_context.py` and `pipecat/api/routes/telnyx.py`.
- Pipecat capacity heartbeats and queue reservations are implemented in `pipecat/services/capacity.py` and `services/pipecat-capacity.js`; heartbeat fields are ID/counter only and include `inbound_active_calls`.
- Replica readiness is implemented in `pipecat/services/readiness.py` and started from `pipecat/main.py`; heartbeats expose `ready` / `warmup_gate_green`, and readiness checks cover DB pool, GrowthBook, Anthropic primer, Deepgram, TTS, and circuit breakers.
- Redis-backed rate limits are implemented for Node in `services/redis-rate-limit-store.js` and `middleware/rate-limit.js`. Node supports `REDIS_URL` or Upstash REST when `REDIS_RATE_LIMITS_ENABLED=true`, and raw rate-limit keys are SHA-256 hashed before becoming Redis keys.
- Redis-backed rate limits are implemented for Pipecat in `pipecat/api/middleware/rate_limit.py`. Pipecat SlowAPI requires `REDIS_URL` when `REDIS_RATE_LIMITS_ENABLED=true`; Upstash REST is not compatible with that storage adapter.
- Node dispatcher drain is implemented in `services/call-queue.js` and `index.js`: SIGTERM/SIGINT set a process drain flag, stop new leases, wait up to `NODE_DISPATCHER_DRAIN_TIMEOUT_MS`, release unconfirmed capacity reservations, and log only PHI-free counts/IDs.
- Cross-replica primitive tests are implemented in `pipecat/tests/test_multi_instance.py`, `pipecat/tests/test_ws_token_cross_replica.py`, and `pipecat/tests/test_telnyx_stream_start_lock_fail_closed.py`.

## Phase 4 — Dispatcher (Dry-Run, Then Live) (~1–2 weeks)

**Prerequisite gate:** Phase 2 + Phase 3 exit criteria met.

**Work items:**

1. Postgres `FOR UPDATE SKIP LOCKED` lease.
2. Lane policy + protected capacity (§2.3, includes `inbound` reserve).
3. Capacity reservation in Redis with TTL (`pipecat:reservation:{reservation_id}`, queue reservation set, and slot guard keys, TTL 2–5 min).
4. Pass `queue_id` + `reservation_id` through Node → Pipecat `/telnyx/outbound`.
5. `call_attempts` persistence with architecture / cohort / test_run_id.
6. Reconciler for expired leases / reservations / queue rows past `latest_at`.
7. Guard acquisition shared with legacy (per §2.4).
8. **Service-to-service rate-limit carve-out (rev 2 addition).** Pipecat's per-IP rate limiter does not throttle requests authenticated by the labeled `dispatcher` API key. Without this, the dispatcher will throttle itself at 600 dials in 15 min from one IP. The labeled key is rate-limited separately (and far more loosely) than public traffic.
9. **Senior-delete-vs-in-flight guard recheck (rev 2 addition).** Per §2.4 — re-check senior `is_active` + `deleted_at` inside the same transaction that flips guard status from `acquired → initiating`, immediately before issuing HTTP to Pipecat. Cancel + release reservation if senior went inactive.
10. **Dispatcher prompt-cache awareness (rev 2 addition; conditional on Phase 0 measurement).** If Phase 0 baseline shows cross-call Anthropic cache hit rate is materially positive, the dispatcher groups calls for one senior on one replica when possible to maximize within-replica cache reuse. If Phase 0 shows cross-call cache hit rate is near zero (because per-senior context dominates), this work item is skipped and the dispatcher stays cache-agnostic. Decision tied to Phase 0 measurement, not assumed.
11. Dry-run dispatcher first; live dialing only after dry-run passes.
12. Dual-path dispatcher progression:
   - `shadow_dispatch`: legacy dials; queue performs dry-run leases, lane policy, capacity registry reads, reconciler, and comparison records only.
   - `canary_queue`: queue may dial only allowlisted/canary cohort after `CALL_QUEUE_ALLOW_REAL_DIAL=true`; legacy keeps non-canary dial authority.
   - `queue_primary`: queue owns dial authority; legacy execution is skipped but rollback visibility is preserved.

**Exit criteria:**

- Dry-run dispatcher produces no duplicate leases at 4, 8, 16 concurrent workers.
- Live dispatcher dials zero duplicates across 10,000 simulated calls.
- Guard race tests pass with legacy + queue dialers contending for the same call.
- Service-to-service auth path bypasses public rate limit (verified by 600-dial test from one IP).
- Senior-delete race resolves to `cancelled` 100% of the time in race test (1,000 trials).
- Reconciler recovers expired leases within one cycle.
- `shadow_dispatch` produces zero Telnyx calls from the queue path while still producing lease/comparison telemetry.

**Phase 4 implementation artifacts on this branch:**

- Dispatcher core (Phase 2 commit, used by Phase 4): `services/call-queue.js` — `dispatchQueuedCalls`, `dryRunDispatchQueuedCalls`, `leaseQueuedCalls`, `reconcileQueueLeases`, `acquireOutboundCallGuard`, `markOutboundCallGuardInitiatingIfCallable` (senior-delete recheck inside the same transaction), `recordCallAttempt` with `{architecture, cohort, test_run_id}`.
- Standalone dispatcher worker: `npm run phase4:dispatcher-worker` → `scripts/run-dispatcher-worker.js`. Separable from the API server per Phase 3 §9; honors `CALL_ARCHITECTURE_MODE` + `CALL_QUEUE_ALLOW_REAL_DIAL` and drains via SIGTERM through `drainQueueDispatcherReservations`.
- Pipecat dispatcher rate-limit carve-out: `pipecat/api/middleware/rate_limit.py` exposes `service_request_key` / `public_request_key` and `SERVICE_CALL_LIMIT`. `pipecat/api/routes/telnyx.py` `telnyx_outbound_call` / `telnyx_prewarm_call` stack `@limiter.limit(CALL_LIMIT, key_func=public_request_key)` with `@limiter.limit(SERVICE_CALL_LIMIT, key_func=service_request_key)` so the labeled `dispatcher` key bypasses the public per-IP bucket.
- Pipecat `call_attempts` lifecycle writer: `pipecat/services/call_attempts.py` updates `answered_at` / `media_started_at` / `ended_at` / `provider_error_code` from the Telnyx event stream. Wired into `_handle_call_answered`, `_record_streaming_event`, and the terminal-events branch of `telnyx_events` so the dispatcher's audit queries see the full lifecycle without Node ingesting webhooks.
- Pipecat outbound response surfaces `instanceId` so the dispatcher records senior→replica affinity on the actual replica that handled the dial (`create_telnyx_outbound_call`).
- Prompt-cache affinity hint pipeline: `services/dispatcher-affinity.js` (`getReplicaAffinityHint`, `recordReplicaAffinity`, `pickAffinityReplica`). Off by default; enabled via `DISPATCHER_PROMPT_CACHE_AFFINITY=true` once Phase 0 measurement supports it. Hint TTL bounded by Anthropic's 5-minute prompt-cache window.
- Tests:
  - `tests/services/dispatcher-affinity.test.js` — hint read/write, TTL, capacity-aware replica pick, disabled-by-default behavior.
  - `tests/services/dispatcher-worker.test.js` — `dispatchOnce` runs dry-run vs live based on mode; `reconcileOnce` honors reconciler flag; capacity registry fallback + required-mode fail-closed.
  - `tests/services/call-queue.test.js` (Phase 2-commit suite, 42 tests) covers SKIP LOCKED lease, capacity reservation, guard senior-delete recheck, dispatcher drain, lane policy, idempotent attempt insert.
  - `pipecat/tests/test_rate_limit.py` — service-label key returns `service:{label}` for valid DONNA_API_KEYS, None for public callers; public key returns IP for non-service callers, None when a service label is present (covers the 600-dial single-IP carve-out test).
  - `pipecat/tests/test_call_attempts.py` — answered/media_started/ended idempotent updates, terminal error vs ok classification, explicit error_reason override, missing-row no-op.


## Phase 5 — Synthetic Live A/B + Rollback Drill (~1 week)

**Prerequisite gate:** Phase 4 exit criteria met.

**Work items:**

1. Matched synthetic seniors (10 control on legacy / 10 treatment on queue). Test phone numbers only. All test reminder titles, caregiver notes, names are non-PHI sentinels.
2. Live call matrix:

| Scenario | Control calls | Treatment calls | Required checks |
| --- | ---: | ---: | --- |
| Manual call now | 5 | 5 | exactly one dial, conversation created, post-call complete |
| Scheduled check-in | 10 | 10 | window timing, no duplicate dial, context loaded |
| One-time reminder | 10 | 10 | delivery row created once, acknowledgement persists |
| Recurring reminder | 10 | 10 | normalized scheduled instance, no duplicate delivery |
| No answer / busy | 5 | 5 | reservation released, retry/defer state correct |
| Inbound known senior | 5 | 5 | metadata visible across replicas, ws token consumed once |
| Inbound new customer | 5 | 5 | prospect path unaffected |
| Post-call burst | 20 | 20 | job backlog drains inside SLO |
| **Inbound surge during outbound** (rev 2) | 0 | 200 outbound + 50 inbound concurrent | both lanes within SLO, no drops |

3. **Caller-ID answer-rate canary (rev 2 addition).** Outbound 50 → 100 → 250 dials from the caller-ID strategy chosen in Phase 0. Measured answer rate must be ≥ 80% of the single-call baseline established in Phase 0. If not, return to the Phase 0 caller-ID decision before progressing. Do not progress to Phase 7 with a failing answer-rate result.
4. **Rollback drill (rev 2 addition).** Toggle from `canary_queue` back to `legacy_only`. Measure elapsed time from flag flip to legacy fully owning dispatch. Update runbook with measured numbers. Drill must be executed at least once before Phase 7.
5. Daily PHI sentinel scan of Node logs, Pipecat logs, Redis, queue tables.
6. Cohort concurrency instructions:
   - Control cohort: legacy remains dial authority.
   - Treatment cohort: queue is dial authority.
   - Cohort assignment must be deterministic for the full test window.
   - A senior cannot move cohorts while a queue row, guard, reservation, or call attempt is active.
   - Every due-call decision records `{architecture, cohort, test_run_id}` so duplicate-call reconciliation can prove only one path dialed.

**Exit criteria:**

- 0 duplicate outbound calls.
- 0 duplicate `reminder_deliveries` for the same reminder instance.
- 0 duplicate conversation rows for one `call_control_id`.
- 0 WebSocket token replays accepted.
- 0 duplicate Telnyx stream starts.
- ≥95% successful media start for answered test calls.
- Post-call critical jobs meet §1.3 SLOs.
- Caller-ID answer rate ≥ 80% of baseline at 250 dials.
- Rollback drill executed; elapsed time recorded.
- PHI sentinel scan clean.

**Phase 5 implementation artifacts on this branch:**

- Live A/B and rollback runbook: `docs/operations/scale-2000-phase5-live-ab-runbook.md`.
- Aggregate drill report: `npm run phase5:live-ab-report -- --test-run-id=<id> --answer-rate-baseline=<phase0-rate>`.
- Rollback timing report: same command with `--test-run-id=<id> --rollback-started-at=<iso> --rollback-completed-at=<iso> --rollback-target-seconds=300`.
- Report output is PHI-safe aggregate counts only. It verifies duplicate queue attempts, duplicate call-control IDs, duplicate conversation rows, duplicate reminder delivery keys, media-start rate, answer-rate baseline threshold, and rollback drain state.
- Test coverage: `tests/services/phase5-live-ab-report.test.js`.

## Phase 6 — Post-Call Queue (significantly expanded, ~2 weeks)

**Prerequisite gate:** Phase 4 exit criteria met.

This phase gets materially more detail than rev 1. Stampede at end-of-window is the single most failure-prone moment in the system.

### Implementation strategy: workflow engine recommended

The work items below describe a Postgres-backed `post_call_jobs` design. In the current branch this table is in the default application schema; if the §2.7 forward-compatible schema migration lands later, the same role moves to `ops.post_call_jobs`. The recommended production implementation is a durable workflow engine (Temporal Cloud or Inngest), with the Postgres table retained as a metadata/audit table, not necessarily as the work queue itself.

Why: the dependency graph, retry/backoff, dead-letter, and per-job-type concurrency caps described in items 2–5 below are all first-class features of Temporal/Inngest. Building them on Postgres is doable (this plan describes how) but every operational concern has to be re-implemented in app code, and the post-call burst is the single highest-value place in the system to use a managed workflow runtime.

Decision belongs to Phase 0 (Open Decisions closed in writing) — choose Temporal Cloud, Inngest, or stay with the Postgres-only Plan B. The work items below describe the canonical job semantics in either case; only the runtime engine differs. If a workflow engine is chosen, `post_call_jobs` becomes the system-of-record for "what work was enqueued for this call SID" and the workflow engine owns lease/retry/dead-letter execution. Rev 3 implements the Postgres-only Pipecat worker path so heavy work can leave the call-completion path before a managed workflow engine is selected.

**Work items:**

1. **Job state machine.** States: `queued → leased → running → completed | failed | dead_letter`. All transitions atomic with `FOR UPDATE SKIP LOCKED`. Worker concurrency per job type configurable.
2. **Job dependency graph (rev 2 addition — not in rev 1).** Some jobs cannot run until others succeed:
   - `caregiver_notifications` depends on `analysis` (notifications cite analysis output)
   - `interest_discovery` depends on `memory_extraction`
   - `snapshot_rebuild` depends on `memory_extraction` AND `daily_context`
   - `metrics_finalize` has no dependencies (critical path)
   - `reminder_recovery` has no dependencies (critical path)
   - `analysis` has no dependencies
   - `memory_extraction` has no dependencies
   - `daily_context` has no dependencies
   Implementation: `post_call_jobs.depends_on uuid[]` column listing prerequisite job IDs. Workers only lease rows whose dependencies are all in `completed` status. If a dependency dead-letters, the dependent job is also dead-lettered with reason `dependency_dead_lettered`.
3. **Retry policy with backoff numbers (rev 2 addition).**
   - Default: exponential backoff 30s → 2min → 8min → 32min → dead-letter after 5 attempts.
   - `analysis`, `memory_extraction`: longer backoff (1min → 5min → 30min → 2h → dead-letter at 5) — retry storms hit AI vendor caps and we'd rather retry slow than spike provider quota.
   - `caregiver_notifications`: aggressive retry (15s → 1min → 5min → dead-letter at 3) — notification freshness matters more than completeness.
   - `reminder_recovery`: aggressive retry (10s → 30s → 2min → dead-letter at 3) — user-facing correctness.
   - `metrics_finalize`: lenient (1min → 5min → 30min → dead-letter at 4) — operational visibility, not user-facing.
4. **Dead-letter handling (rev 2 addition).**
   - Dead-letter rows visible in admin UI.
   - Manual replay path available (re-queue with reset attempt count).
   - PHI in payload remains encrypted.
   - Retention policy applies (180d default).
   - Alerts fire if dead-letter rate per job type exceeds threshold.
5. **Per-provider concurrency caps (tied to Phase 0 vendor inventory).**
   - Anthropic Haiku post-call analysis: cap at 60% of measured concurrent capacity from Phase 0 when generation is in the worker.
   - Gemini Flash lane remains only for legacy/new-customer/artifact-verification paths unless a future handler intentionally routes analysis there.
   - OpenAI embeddings: cap at 50% of measured RPM.
   - Resend notifications: cap at 50% of measured send rate.
6. **Stampede test (rev 2 addition).** 600 simultaneous call completions against vendor stubs. Asserts:
   - critical jobs (conversation completion + reminder recovery) p95 ≤ 5 min
   - AI vendor concurrency caps never exceeded
   - DB pool idle stays ≥ 15%
   - non-critical job backlog drains within 30 min
7. PHI in `payload_encrypted` only; prefer passing IDs and loading source data at execution.

**Exit criteria:**

- 600-completion stampede test passes all §1.3 SLOs.
- Job dependencies execute in correct order under load.
- Dead-letter manual replay verified end-to-end.
- Encrypted payload + export + delete + retention + audit coverage verified.
- Provider concurrency caps verified not to exceed measured Phase 0 thresholds.

**Phase 6 implementation artifacts on this branch:**

- Post-call job state migration: `db/migrations/012_post_call_job_state_machine.sql` mirrored by `pipecat/db/migrations/025_post_call_job_state_machine.sql`.
- Node queue primitives and worker executor: `services/post-call-jobs.js` implements dependency-aware enqueue/lease, retry backoff policy, dead-letter propagation, manual replay, provider-cap math, in-process provider semaphores, and one-tick worker execution.
- Pipecat enqueue wiring: `pipecat/services/post_call.py` calls `pipecat/services/post_call_jobs.py` behind `POST_CALL_QUEUE_ENABLED`; default behavior remains inline post-call processing with no queue rows, but when the flag is enabled Pipecat enqueues the heavy job graph and skips inline analysis, memory extraction, daily-context, interest-discovery, and snapshot-rebuild work. Immediate completion, reminder recovery, notification delivery evidence, discovery suggestions, cache clearing, and call metrics still run inline.
- Pipecat worker executor: `pipecat/services/post_call_job_worker.py` leases `post_call_jobs` with `FOR UPDATE SKIP LOCKED`, enforces dependencies/retries/dead-letter propagation, and runs handlers for metrics, reminder recovery, analysis, memory extraction, daily context, caregiver notifications, interest discovery, and snapshot rebuild.
- Worker ticks: `npm run phase6:post-call-worker-once -- --confirm-db-writes` remains the Node workflow-handler/artifact-verification tick. `npm run phase6:post-call-pipecat-worker-once -- --confirm-db-writes --limit=100` runs the Pipecat heavy-job executor from `pipecat/scripts/run_post_call_worker_once.py`. Any staging command that writes to the shared Neon database must be limited to dummy or explicitly consenting test seniors.
- Admin dead-letter surface: `GET /api/post-call-jobs/dead-letter` and `POST /api/post-call-jobs/:id/replay`; responses omit encrypted payloads and replay writes a PHI-free audit record. `apps/admin-v2/src/pages/PostCallJobs.tsx` renders the dead-letter rows and manual replay action without exposing job payloads.
- Authorized export coverage: Node export already decrypts `payload_encrypted`; Pipecat export now includes post-call jobs and strips ciphertext after authorized decryption.
- Provider-stub stampede harness: `npm run phase6:post-call-stampede` runs a 600-completion, 4,800-job PHI-free simulation and checks critical p95, provider concurrency caps, DB pool idle ratio, and non-critical backlog drain.
- Test coverage: `tests/services/post-call-jobs.test.js`.

**Remaining Phase 6 work:**

- Run the 600-completion stampede harness with Phase 0 measured provider limits and real staging DB pool observations.
- Run the Pipecat worker tick against staging queue rows and record that heavy jobs drain within §1.3 SLOs without extending active call capacity occupancy.
- Choose production worker topology: managed workflow engine, dedicated Railway Pipecat worker service, or a looped/scheduled Pipecat worker process.

## Phase 7 — Small Live Canary (~1–2 weeks)

**Hard prerequisite gate:**

- Phase 3 exit criteria met.
- Phase 6 exit criteria met.
- BAAs signed for every PHI-touching vendor (per §1.6 table).
- Incident runbook v1 published.
- Phase 5 rollback drill executed and timed.
- Caller-ID answer-rate canary passed (≥80% of baseline).
- Cost projection approved.

**Work items:**

1. Allowlist 5 → 10 → 25 internal/pilot seniors. Hold each step for at least 2 days.
2. Compare treatment vs. control on all §1.3 SLOs.
3. Daily review with named oncall.
4. Rollback drill re-executed in canary environment with treatment traffic.
5. Legacy continues to own all non-allowlisted seniors during the canary. Queue real dialing is limited to the allowlist/cohort gate.

**Implementation artifacts:**

- `scripts/phase7-canary-daily-report.js` is the daily SLO report. It enforces setup success, duplicate rows, and post-call completion rate; current post-call critical-job p95 is informational.
- `scripts/phase7-canary-report.js` reuses the Phase 5 aggregate report checks and adds Phase 7 allowlist-size, 7-day SLO streak, PHI sentinel, incident, and rollback gates for exit evidence.
- `npm run phase7:canary-daily-report` is the daily canary reporting entry point; `npm run phase7:canary-report` is the aggregate exit report.
- `docs/operations/scale-2000-phase7-canary-runbook.md` records the 5 → 10 → 25 allowlist progression and hold/rollback criteria.

**Exit criteria:**

- All §1.3 SLOs met for 7 continuous days.
- No duplicate-call guard violations.
- No PHI sentinel findings in any of: Node logs, Pipecat logs, Sentry, Redis raw values, queue/job tables.
- No P0/P1 incidents.
- Rollback drill executed in canary environment; elapsed time within runbook target.

## Phase 8 — Scheduled Capacity and Autoscaler (~1 week)

**Prerequisite gate:** Phase 7 exit criteria met.

**Work items:**

1. Demand estimator reading future `call_queue` rows by window.
2. Scheduled Pipecat scale-up at T-20 min before known windows. Initial implementation: scheduled Railway scale changes via operator script or cron-controlled worker. Better implementation later: autoscaler service reading queue depth and calling Railway API.
3. **Replica warm-up gate consumed by autoscaler.** Autoscaler does not mark a replica as "available capacity" until the readiness gate from Phase 3 §8 flips green. Time-to-green logged and alerted on if it exceeds threshold.
4. **Cost-aware scale-down (rev 2 addition).** Off-peak runs minimum replicas (2). Scale-down only when active_calls + reservations + post-call critical backlog all below threshold. Cost per hour tracked against Phase 0 budget.
5. Operator override surface (admin UI button for emergency scale-up / scale-down).

**Implementation artifacts:**

- `services/phase8-capacity-plan.js` reads future `call_queue` demand by lane/status, Pipecat readiness heartbeats, and critical post-call backlog counts, then emits a PHI-free scale recommendation.
- `npm run phase8:capacity-plan` is the operator entry point for pre-window planning and budget checks.
- `services/phase8-autoscaler.js` and `npm run phase8:autoscaler-once` execute the capacity recommendation through a dry-run-by-default Railway CLI scale actuator. `--confirm-scale` is required before `railway scale` is invoked.
- `GET /api/scale-operations/phase8/plan`, `POST /api/scale-operations/phase8/autoscale-once`, and `POST /api/scale-operations/phase8/override` expose the same PHI-free plan and guarded operator override path to admins.
- `apps/admin-v2/src/pages/ScaleOperations.tsx` provides the admin operator override surface for emergency scale-up / scale-down, with dry-run default and scale-down guard enforcement.
- `docs/operations/scale-2000-phase8-capacity-runbook.md` captures the manual/cron/autoscaler workflow.

**Exit criteria:**

- Pipecat at target capacity ≥10 min before scheduled test window.
- No scale-down event while calls are active or post-call critical backlog non-empty.
- Cost during off-peak within Phase 0 budget.
- Time-to-readiness-green per replica recorded and within threshold.

## Phase 9 — Window Load Canary + Production Rollout (~4–6 weeks)

**Prerequisite gate:** Phase 8 exit criteria met.

**Rollout steps (each gated on §1.3 SLOs and clean PHI sentinel scan):**

- Production canary: 50 users for 3 days.
- Production canary: 100 users for 3 days.
- Production canary: 250 users for 3 days.
- Production canary: 600 users in one planned window for 7 days.
- Production rollout: 2,000 users.

Each production step keeps both paths available:

- During canary steps, `canary_queue` owns only the current treatment cohort; legacy owns everyone else.
- Before increasing the cohort, verify there are no active queue rows, leases, reservations, guards, or in-flight calls for seniors being moved.
- After a successful 600-user planned-window canary, switch to `queue_primary` only during a low-risk window with rollback owner present.
- Keep legacy scheduler code and flags deployable through the full 2,000-user rollout; remove it only in a separate cleanup phase after 14 clean days on `queue_primary`.

**Per-step exit criteria:**

- All §1.3 SLOs met for the step duration.
- 0 PHI sentinel findings.
- 0 P0/P1 incidents.
- Cost per senior within Phase 0 budget at observed traffic.
- Provider rate-limit errors below alert threshold.
- Post-call backlog returns to normal within 30 min for non-critical jobs after each window.

---

## Implementation Status Retrospective (updated 2026-05-25)

This section records the current `zuludev` reality after Phases 0-8 implementation commits and replaces the older Phase 0-3 retrospective.

### Confirmed implemented in code

- `CALL_ARCHITECTURE_MODE` enumerates the rollout modes in §2.8 (`legacy_only`, `shadow_materialize`, `shadow_dispatch`, `canary_queue`, `queue_primary`, `legacy_rollback`).
- The current queue/guard/job tables exist in mirrored Node and Pipecat migrations, with PHI-safe columns, idempotency indexes, retention, hard-delete, legal-hold, and export coverage.
- Senior-owned `memories` is now 64-way hash-partitioned by `senior_id`, prospect-owned rows are routed to `prospect_memories`, and Node/Pipecat memory services include the owner key for partition pruning.
- Pipecat can now enqueue heavy post-call work and skip the heavy inline chain when `POST_CALL_QUEUE_ENABLED=true`; `pipecat/services/post_call_job_worker.py` executes the queued heavy jobs with dependency and retry handling.
- Admin DB observability now includes a PHI-safe database pressure view for pool stats, aggregate activity, locks, hot tables, and queryid-only slow-query aggregates.
- `pipecat/services/capacity.py` publishes PHI-free heartbeats at 5 s interval / 15 s TTL, and Node reads them through `services/pipecat-capacity.js`.
- `PIPECAT_REQUIRE_REDIS=true` fails closed at startup; Redis-backed rate limits fail closed when enabled.
- `pipecat/services/readiness.py` implements the Phase 3 readiness gate, and `pipecat/main.py` starts it and exposes readiness through `/health` and capacity heartbeats.
- Cross-replica shared-state tests now exist for Telnyx duplicate-event dedupe, WebSocket token replay, and media-stream-start races.
- `services/call-queue.js` now includes the guard expiry policy and `reconcileOutboundCallGuards`; stale guards are released with PHI-free audit metadata.
- Pipecat service-key rate-limit carve-out is implemented through labeled `DONNA_API_KEYS` service buckets, with an end-to-end 600-dial test in `pipecat/tests/test_rate_limit_dispatcher_carveout.py`.
- Phase 5, 6, 7, and 8 have PHI-safe scripts/runbooks for A/B reporting, post-call stampede simulation, canary reporting, capacity planning, autoscaler dry-run/actuation, and admin operator override.

### Important mismatch vs original rev-2 target

The current Phase 1 operational queue/job/attempt migrations are **not** the `ops.*` / hash-partitioned schema described by the original rev-2 text. The active code and tests use flat default-schema operational tables. Treat §2.7's `ops.*` and operational-table partitioning design as a forward-compatible migration target, not as completed implementation. Senior memories are the exception: they are already hash-partitioned by `senior_id`.

This is the main remaining documentation/code distinction. It is not a runtime bug by itself, but it changes the migration decision before a live apply:

- If the current migrations have not been applied to any shared database, we can still rewrite them to the partitioned `ops.*` target.
- If they have already been applied, keep the current tables for the 2,000-user rollout unless Phase 0 measurements show DB write pressure, then schedule a separate online migration.

### Remaining live/manual gates

- Phase 0 evidence: 7-day production baseline, vendor cap confirmation, cost approval, caller-ID decision, BAA tracking if/when re-enabled, and migration timing on a production-sized clone.
- Phase 3/5 live drills: Redis outage in scaled mode, actual two-replica Railway behavior, inbound surge test, live Telnyx A/B, caller-ID answer-rate canary, and rollback drill timings.
- Phase 6 evidence: run the 600-completion stampede harness with Phase 0 provider limits and real staging DB pool observations.
- Phase 7/8 evidence: daily live canary reports, saved PHI sentinel outputs, readiness time-to-green, and dry-run/confirmed Railway capacity actions under operator review.

---

# 4. Operations

## 4.1 Observability

Metrics scaffolding lands in Phase 0; real data fills in as phases ship. Required metrics:

- `call_queue_depth{lane,status}`
- `call_queue_oldest_age_seconds{lane}`
- `call_queue_deadline_risk_count{lane}`
- `call_dispatch_leased_total{lane}`
- `call_dispatch_started_total{lane}`
- `call_dispatch_failed_total{lane,error_class}`
- `call_capacity_global_available`
- `call_capacity_global_active`
- `call_capacity_pending_reservations`
- `call_capacity_inbound_active` (rev 2)
- `pipecat_instance_active_calls{instance_id}`
- `pipecat_instance_inbound_active{instance_id}` (rev 2)
- `pipecat_instance_draining{instance_id}`
- `pipecat_instance_readiness{instance_id}` (rev 2 — green/yellow/red)
- `pipecat_replica_warmup_seconds{instance_id}` (rev 2)
- `telnyx_webhook_duplicate_total`
- `telnyx_stream_start_duplicate_suppressed_total`
- `post_call_job_depth{job_type,status}`
- `post_call_job_latency_seconds{job_type}`
- `post_call_job_dependency_blocked{job_type}` (rev 2)
- `post_call_job_dead_letter_total{job_type}` (rev 2)
- `db_pool_idle{service}`
- `db_slow_query_total{service}`
- `db_lock_waiting_count{service}`
- `db_hot_table_rows_written{table}`
- `db_hot_table_dead_tuple_ratio{table}`
- `provider_rate_limited_total{provider}`
- `provider_concurrency_used{provider}` (rev 2)
- `caller_id_answer_rate{caller_id}` (rev 2)
- `shadow_comparison_disagreement_total{decision_type}` (rev 2)

Alerts:

- Hard-reminder queue oldest age > 3 min.
- Scheduled-checkin queue oldest age > 10 min.
- Global capacity below required capacity at T-10 min.
- Redis unavailable in scaled mode.
- DB pool idle below 10% for 5 min.
- Post-call critical backlog older than 5 min.
- Telnyx or TTS provider rate-limit errors exceed threshold.
- Any Pipecat instance still active during planned scale-down deadline.
- Replica readiness gate stuck red for > 90 seconds.
- Outbound caller-ID answer rate drops below 80% of baseline.
- Dead-letter rate per job type exceeds threshold.

## 4.2 Incident Runbook

Required scenarios (must have runbook entries before Phase 7):

- DB pool exhausted at T-2 min before window
- Redis unavailable in scaled mode
- Dispatcher stuck (queue depth growing, no leases issued)
- Pipecat replica down at T-5 min
- Telnyx outbound failure storm
- Vendor rate-limit storm (Anthropic / Deepgram / ElevenLabs / Gemini)
- PHI sentinel hit in production
- Duplicate-call detected post-hoc
- Replica readiness gate stuck red
- Caller-ID answer rate collapse mid-window
- Senior-delete race detected post-call
- Dead-letter spike in any job type

Each entry includes: detection signal, immediate response, rollback decision criteria, escalation path.

## 4.3 Rollback

Rollback procedure:

1. `CALL_ARCHITECTURE_MODE=legacy_rollback`.
2. `CALL_QUEUE_ALLOW_REAL_DIAL=false`.
3. Stop dispatcher workers.
4. Preserve queue rows + attempts + guards for analysis.
5. Run duplicate-call + reminder-delivery reconciliation before re-enabling canary.

**Rollback triggers** (any one triggers immediate rollback):

- Any duplicate call to the same senior for the same schedule/reminder guard key.
- Any accepted WebSocket token replay.
- Any duplicate Telnyx media stream start for one call.
- Redis unavailable while scaled mode is enabled.
- Queue dispatcher creates real calls while not in `canary_queue` or `queue_primary`.
- Treatment call setup success drops > 2 percentage points below control.
- Hard-reminder queue lag exceeds 5 min for > 2% of reminders.
- DB connection exhaustion or sustained pool idle below 5%.
- PHI appears in logs, metrics, fixtures, screenshots, or CI output.

**Rollback drills** executed at least once in:

- Phase 5 (staging, treatment cohort)
- Phase 7 (canary, allowlisted seniors)
- Phase 9 (production, before each ramp step)

Each drill records elapsed time from flag flip to legacy fully owning dispatch. Runbook updated with measured timings.

## 4.4 PHI Protection

### Logging

- `LOG_LEVEL=INFO` in all public Railway environments (verified in Phase 0).
- Senior IDs truncated or hashed in external observability (Sentry already does this).
- No senior names, phone numbers, reminder titles, profile notes, transcripts, caregiver notes, or prompt context in scheduler / dispatcher / worker logs.

### Sentinel scanning

PHI sentinels for tests (Phase 0+):

- senior name: `Donna Phi Sentinel`
- phone: a controlled test number only
- reminder title: `PHI_SENTINEL_REMINDER_DO_NOT_LOG`
- caregiver note: `PHI_SENTINEL_NOTE_DO_NOT_LOG`
- medical note: `PHI_SENTINEL_MEDICAL_DO_NOT_LOG`
- transcript phrase: `PHI_SENTINEL_TRANSCRIPT_DO_NOT_LOG`

For every phase that introduces a new table, cache, queue, worker, log path, or dashboard, the sentinel scan asserts:

- Sentinels do not appear in application logs.
- Sentinels do not appear in Sentry/event payloads.
- Sentinels do not appear in Redis raw values except inside encrypted shared-state blobs.
- Sentinels do not appear in plaintext queue/job/test-run operational tables.
- PHI-bearing values are stored only in encrypted companion columns or encrypted payload fields.
- Authorized export paths can retrieve/decrypt new PHI-bearing data.
- Delete/retention paths cover new tables and encrypted payloads.
- Audit logs are created for PHI reads/hydration/export/delete paths and do not store raw PHI in metadata.

### Audit coverage

- Context hydration for calls reads PHI and continues to audit at system level.
- Exports/deletes include any new PHI-bearing job/cache tables.
- High-risk export and deletion paths fail closed if audit persistence fails.
- **Shadow-mode decisions written to `audit_logs`** with `action='shadow_decision'` (rev 2 — Phase 2 §5).

### Rate limits

- Node and Pipecat rate limits move to Redis-backed stores before multiple public replicas (Phase 3).
- Service-to-service scheduler/Pipecat traffic authenticated with labeled `DONNA_API_KEYS`; dispatcher key is separately rate-limited (Phase 4 §8).

---

# 5. Definition of Done

Architecture is ready for 2,000 users when every SLO in §1.3 has been met for 7 consecutive days at 2,000 active seniors, with all of:

- 600+ active calls sustained in load test, all §1.3 SLOs met.
- 0 duplicate dials across 10,000 dispatched calls in load test.
- Replica scale-up + scale-down drains active calls cleanly (no mid-call disconnects observed).
- Replica readiness gate green time-to-traffic < 60 seconds at scale-up.
- Redis required; single-replica fallback removed in production.
- Post-call backlog stays inside §1.3 SLOs during 600-completion stampede.
- All BAAs signed for PHI-touching vendors.
- Cost per senior per month within Phase 0 approved budget at observed traffic.
- All §4.2 runbook scenarios exercised in staging at least once.
- DST + timezone edge-case suite passes for all currently active senior timezones.
- Inbound surge test (50 inbound + 200 outbound concurrent) passes.
- Outbound answer rate at peak ≥ 80% of single-call baseline.
- PHI sentinel scan clean across Node logs, Pipecat logs, Sentry, Redis raw, queue/attempt/job tables.
- Senior-delete race resolves to `cancelled` 100% of the time in 1,000-trial race test.
- Materializer + dispatcher + reconciler each pass concurrent-worker tests at 4 / 8 / 16 workers.

---

# 6. Open Decisions — Closed in Phase 0

Below items move from "open" to "closed by Phase 0 exit." None of them is allowed to remain open into Phase 2+:

- Average + p95 call duration (derived from baseline metrics).
- Expected answer rate by window.
- Whether 600 or 900 active is the launch capacity target.
- Initial lane reserve percentages (currently 8/7/35/15/30/5; refined by Phase 0 windowed traffic measurements).
- Worker location: embedded in Node API process vs. dedicated Railway worker service. Affects Phase 3 §9 topology.
- TTS vendor at scale: ElevenLabs primary vs. Cartesia fallback ratio.
- Outbound caller-ID strategy: single ID vs. number pool vs. branded calling vs. STIR/SHAKEN attestation.
- Redis vendor: Railway TCP Redis vs. Upstash REST (failure-mode semantics differ materially; affects Phase 3 fail-closed behavior).
- Queue / job / guard / shadow-comparison retention windows (current proposal: 90/180/30/30 days).
- Overbook factor (initially 1.0; revised only after Phase 7 production canary measurements).
- Whether post-call workers run as a managed workflow engine, a dedicated Railway Pipecat worker service, or a looped/scheduled Pipecat worker process. The Postgres-backed Pipecat worker path exists now; production topology is still a Phase 0 decision.
- **Durable workflow engine for post-call jobs.** Temporal Cloud vs. Inngest vs. Postgres-only Pipecat worker. Decision drives whether Phase 6 stays on the implemented Postgres worker or moves execution to a managed workflow runtime.
- **Operational Postgres split trigger.** Default: stay on Neon until write throughput on `call_attempts` or `post_call_jobs` becomes a measurable bottleneck. Trigger metric: sustained alert on DB pool idle dropping below §1.3 SLO during burst windows or PHI-safe DB observability showing lock/hot-table pressure in the dispatcher/job tables. If the §2.7 `ops.*` migration has landed by then, the split is an operational-schema move; if not, the split first needs an online migration plan from the current flat tables.
- **Memory/vector split trigger.** Senior memories are already 64-way hash-partitioned. Move embeddings to dedicated pgvector/vector infrastructure only when memory search p95, embedding write backlog, table bloat, or DB pool pressure shows the partitioned in-DB design is consuming the primary database budget.

---

# 7. Implementation Order Summary

For the engineer or AI agent executing this plan, the build order is:

1. **Phase 0** — measure, decide, contract. Do not skip. Do not partial-skip. Phase 1 cannot start until baselines exist.
2. **Phase 1** — schema + idempotency + retention parity. Apply the current split migrations (`010` foundation, `011` concurrent indexes, `012` post-call state, `013` canary membership, `021`/`032` memory partitioning) and explicitly record whether live rollout uses the current flat operational tables or the `ops.*` / partitioned operational target from §2.7.
3. **Phase 2** (parallel with Phase 3) — materializer, shadow-only. DST suite required.
4. **Phase 3** (parallel with Phase 2) — Pipecat multi-instance hardening, replica readiness gate, Node-side drain, inbound lane wiring.
5. **Phase 4** — dispatcher, `shadow_dispatch` dry-run first, then `canary_queue` live only for allowlisted cohorts, with service-to-service rate-limit carve-out and senior-delete race recheck.
6. **Phase 5** — synthetic live A/B with legacy control + queue treatment running concurrently, caller-ID answer-rate canary, and rollback drill.
7. **Phase 6** — post-call queue with dependency graph, retry/backoff, dead-letter handling, Pipecat heavy-job worker validation, and 600-completion stampede test.
8. **Phase 7** — small live canary (HARD gate from Phases 3 + 6 + BAAs).
9. **Phase 8** — scheduled capacity + autoscaler with replica warm-up gate + cost-aware scale-down.
10. **Phase 9** — production rollout at 50 → 100 → 250 → 600 → 2,000, keeping legacy available for non-canary cohorts and rollback until 14 clean days on `queue_primary`.

Single biggest discipline: **Phase 0 is not optional.** Rev 1 let the team jump to building because Phase 0 was a thin guardrail. Rev 2/3 make Phase 0 produce measurements and close decisions. Everything downstream inherits Phase 0's quality.

---

# 8. Forward Path To 10,000 Users

This plan delivers durable, multi-instance voice infrastructure capable of 600 concurrent active calls and 2,000 daily users. Scaling further — to roughly 10,000 daily users and 3,000 concurrent at peak — is past the original design point of the architecture, but **rev 3 is now the in-flight 10k-shaped iteration** of the 2k plan: the move from "find due calls and fire" to durable queue + capacity-aware dispatcher + heavy post-call workers + proactive memory partitioning + numeric SLOs is a 10k-shaped architecture executed against a 2k milestone. The original rev-2 `ops.*`, operational-table partitioning, and region-key-shape items remain forward-compatible targets, not current branch implementation.

This section is not a deferred future plan and not a catalog of separate side-environment prototypes. It is the operating record of which 10k transitions are already addressed by rev 3 work items, which require additional work that is not yet in rev 3, and the triggers that determine when each transition starts. Refinements to this material land in rev 3 directly, not in parallel docs.

## 8.1 What rev 3 already does for 10k

Implemented decisions in the current scaling branch chosen with the 10k transition in mind:

- **Durable queue and guard model.** `call_queue`, `call_attempts`, `outbound_call_guards`, and `scheduler_shadow_comparisons` move dial authority from in-memory sets to Postgres rows with leases, unique guards, and audit/comparison records.
- **Indexed flat-table operational substrate.** Current queue/job/attempt migrations add the indexes needed for 2,000-user dry-run/canary validation. If they become hot, §2.7 names the online path to `ops.*` and `senior_id` partitions.
- **Senior memory partitioning.** `memories` is already split into 64 `senior_id` hash partitions, and prospect memory writes go to `prospect_memories`. This avoids the highest-risk user-data hot table becoming one giant search/write target.
- **Queued heavy post-call execution.** Pipecat can enqueue the heavy post-call job graph and skip inline analysis/memory/daily-context/snapshot work when `POST_CALL_QUEUE_ENABLED=true`, with a Pipecat worker available to drain those jobs.
- **PHI-safe DB pressure visibility.** Admin observability can now show pool pressure, lock waits, hot tables, and queryid-only slow-query aggregates, which makes the operational split trigger measurable instead of speculative.
- **`PIPECAT_REQUIRE_REDIS=true` from Phase 3.** Removes the single-instance code path. Multi-region Redis later requires Redis Cluster, but application code already assumes Redis as the source of truth.
- **Single-region Redis key discipline.** Heartbeats and reservations are ID-only and PHI-free. Region-aware schema/key reshaping is intentionally future work, not implicitly half-implemented.
- **Workflow engine recommendation (Phase 6).** Per-job-type concurrency caps, retry/backoff, and dead-letter are first-class in Temporal/Inngest; the implemented Postgres Pipecat worker is the Plan B execution path until the production runtime decision is made.
- **Numeric SLOs (§1.3).** The same metric framework extends to 10k; only the targets get retightened.

## 8.2 What breaks first as users grow past 2,000

In order of how soon the wall hits:

1. **Outbound caller-ID reputation.** Long before any code-level metric moves, ~3,000 outbound calls in a 15-minute window from a single caller ID triggers carrier spam analytics. Answer rate collapses silently. Already on the radar via §1.6 (caller-ID pool) and Phase 0 §4 (caller-ID strategy). At 10k, single-ID is not viable — number pool + STIR/SHAKEN + reputation monitoring become structural.
2. **Provider concurrency quotas.** 3,000 concurrent calls means 3,000 concurrent Deepgram streams, 3,000 active Claude contexts, ~6,000 Director LLM RPS. Per-org quotas become hard ceilings. Plan: committed-tier contracts on every minute-billed vendor; multi-provider sharding via AI Gateway for STT and LLM with documented failover paths exercised in chaos tests.
3. **Single Postgres write throughput.** Even with `FOR UPDATE SKIP LOCKED` and the current senior/status/time indexes, one Postgres primary handles a fixed write rate. `call_attempts`, `post_call_jobs`, `audit_logs`, and `conversations` all spike simultaneously during burst windows. Memory writes/searches are less risky than before because `memories` is already senior-hash-partitioned, but the operational and journal write paths can still get hot. Plan: if measurements show the current flat operational tables are hot, migrate operational tables to the §2.7 `ops.*` / partitioned target or a dedicated operational Postgres with provisioned IOPS; use read replicas for context hydration; consider moving the `audit_logs` append path to S3/Parquet rather than a Postgres table at 10k volume.
4. **Redis as a single point of failure.** Single-region Redis is acceptable for one Pipecat region. Multi-region voice requires Redis Cluster with cross-AZ failover, and capacity coherence becomes a consensus problem. Plan: Redis Cluster mode, capacity reservations consider Redis quorum, fallback path that leases through Postgres at higher latency if Redis degrades.
5. **Single-region voice latency.** US coast-to-coast users on a single Pipecat region accept ~80–100ms additional one-way audio latency. Tolerable but noticeable. International expansion makes this worse. Plan: deploy Pipecat in multiple regions, route on `seniors.preferred_region`, accept cross-region writes for shared state (Postgres + Redis primaries stay in one region; reads are local).
6. **Caregiver notification throughput.** ~10,000 daily notifications, bursty by call-end window. Resend (or any single provider) starts throttling. Plan: notification service tier with batching, provider failover, per-provider concurrency caps.
7. **Cost.** Roughly 1.7M call-minutes per day at 10k. STT + TTS + LLM costs dominate infrastructure costs and start determining margin. Plan: committed-tier contracts on every minute-billed vendor; evaluate self-hosted STT (Whisper, or self-hosted Deepgram) or cheaper TTS for low-stakes utterances.

## 8.3 Transitions between 2,000 and 10,000

For each transition, "Status in rev 3" records what is already addressed inside this plan and what is explicitly not. The trigger column records the SLO or product signal that escalates the row from "scheduled to be addressed" to "active work item."

| Transition | Driver | Trigger to escalate | Status in rev 3 |
| --- | --- | --- | --- |
| Move operational tables to `ops.*` / dedicated operational Postgres | Burst write throughput; DB pool exhaustion | Sustained §1.3 DB-pool-idle alert during burst, DB observability showing lock/hot-table pressure, or ~3,000 daily users | Target and trigger specified in §2.7 / §6, but current operational code still uses flat default-schema tables. Requires an online migration unless done before live Phase 1 apply. |
| Memory/vector store split | Memory search latency; embedding write backlog; primary DB pressure | Memory search p95 over target, embedding backlog sustained, or partitioned `memories` appears in hot-table/lock pressure | Senior `memories` already uses 64 hash partitions by `senior_id`; next move is dedicated pgvector/vector DB only after measured pressure. |
| Pipecat second region | Audio latency for West Coast / international users | Product signal, not capacity signal | Actual multi-region deploy explicitly out of scope per §1.7. Current code is single-region; adding this requires `region` schema/key changes and routing work. |
| Telnyx managed number pool / caller-ID strategy | Answer-rate decline correlated with outbound volume | First measurable drop below §1.3 80%-of-baseline target | Strategy decision is Phase 0 §4. Canary validation is Phase 5 §3 with answer-rate gate. Number-pool integration code not yet in rev 3. |
| Multi-provider sharding (STT/LLM via AI Gateway) | Provider rate-limit alerts at peak | First sustained provider 429s | Per-provider concurrency caps tied to Phase 0 measured peaks, applied in Phase 6 §5. Failover routing across providers (e.g., Deepgram + AssemblyAI) not yet in rev 3 — additional work. |
| Redis Cluster (HA / multi-region) | Pipecat multi-region rollout or single-AZ Redis incident | Either trigger first | Required-mode (`PIPECAT_REQUIRE_REDIS=true`) and fail-closed admission in Phase 3 §1. Cluster topology and cross-AZ failover not yet in rev 3 — additional work. |
| Workflow engine or Pipecat worker concurrency cap increase | Post-call job backlog growing | 10x current per-job-type cap with no DB stress | Postgres-backed Pipecat worker exists now. Engine choice remains a Phase 0 Open Decision; if staying Postgres-only, concurrency increases need staging proof that worker leases and DB pool stay healthy. |
| `audit_logs` archival to S3/Parquet | `audit_logs` write rate or storage cost | Storage-cost trigger before throughput trigger | Not yet addressed in rev 3 — additional work when triggered. |

Rows marked "additional work" are the explicit 10k-only items not covered by current rev 3 work items. They become PRs against rev 3 when the trigger fires.

## 8.4 Product transitions

Code and infrastructure are necessary but not sufficient at 10k. Two product-level changes become structurally important:

- **Schedule distribution.** Stop letting all users pick "9:00 AM." Offer scheduling bands ("morning: 8–9 AM, we'll pick a quiet minute"), use historical answer-rate data to suggest off-peak slots, and use deterministic jitter within the band to spread load. Possibly more capacity headroom than any single infrastructure change.
- **Tiered call types.** Hard reminders remain time-sensitive. Companion check-ins become flexible within a multi-hour window. The lane reservation policy in §2.3 extends naturally; the product change is exposing the flexibility to caregivers in the mobile app.

## 8.5 How 10k iteration happens inside rev 3

Rev 3 is the working doc for the 10k-shaped iteration; this is not a side environment. A few rules keep that workable:

- **Phase 0 measurements stay the gate for everything downstream.** Baseline data that drives §1.3 SLO targets, vendor concurrency inventory, and the cost model still close before Phase 1 starts. 10k-flavored work items consume those measurements as inputs; they do not skip them.
- **Additional 10k work items (the "additional work" rows in §8.3) land as edits to rev 3, not as separate plan docs.** When the trigger for a row in §8.3 fires, the corresponding phase in rev 3 gets the new work item appended, with the existing prerequisite-gate / work-items / exit-criteria structure. Examples:
  - "Multi-provider STT failover" becomes a Phase 3 or Phase 4 work item once first sustained provider 429s are observed.
  - "Redis Cluster topology" becomes a Phase 3 work item once a single-AZ Redis incident occurs or multi-region deploy is decided in.
  - "`audit_logs` archival to S3" becomes a Phase 1 or Phase 6 work item once storage-cost signals fire.
- **Out-of-scope items in §1.7 stay out of scope until explicitly reopened.** Multi-region call routing, multi-database/multi-tenant sharding, B2B tenancy, and replacing Telnyx or Claude are listed as separate-plan candidates. If 10k pressure forces one of them, the response is a new plan, not a rev-3 expansion.
- **Schema cheapness must be made real before it is counted as complete.** Senior memory partitioning is real now. The `ops.*` schema, operational-table partitioning, and region columns are still useful 10k-shaped ideas, but the current branch has not implemented them for queue/job/attempt tables. They either land before live Phase 1 apply or become explicit online migration work triggered by Phase 0/rollout measurements.

The forward-compatible decisions already captured in rev 3 (durable queue, Redis-required posture, queued post-call execution, senior memory partitioning, DB pressure observability, and the documented `ops.*` / operational-partitioning / region target) are what make further 10k iteration cheap to keep folding back into this document. New 10k work follows the same structure: prerequisite gate, work items, numeric exit criteria, rollback drill where applicable.
