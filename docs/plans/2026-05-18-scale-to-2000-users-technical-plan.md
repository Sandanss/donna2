# Donna 2,000 User Burst Scaling Technical Plan

Date: May 18, 2026
Revision: 2
Status: Proposed implementation plan
Primary surfaces: `services/scheduler.js`, `db/schema.js`, `pipecat/main.py`, `pipecat/api/routes/telnyx.py`, `pipecat/api/routes/call_context.py`, `pipecat/services/post_call.py`, Railway configuration

## Revision Notes (rev 2)

Rev 2 changes from rev 1:

- **Phase 0 reshaped from "guardrails" to "measure, decide, contract."** It now produces measured production baselines, closes all Open Decisions, completes the vendor concurrency inventory, kicks off the BAA chase, and publishes a cost model — all before any code change downstream.
- **New gaps closed.** Cost model, vendor concurrency inventory, outbound caller-ID / answer-rate risk, inbound capacity lane, Pipecat replica cold-start, Anthropic prompt-cache behavior at scale, DST and timezone edge cases, senior-delete vs. in-flight dispatch race, Node multi-instance topology, service-to-service rate-limit carve-out, shadow-mode audit trail, dead-letter and dependency graph for post-call jobs.
- **Definition of Done is numeric.** Every acceptance criterion has a measurable target. Qualitative "queue lag stays inside SLO" replaced with "p95 hard-reminder queue lag ≤ 180s."
- **Document reshaped to four sections.** Goals & constraints, Architecture, Phased implementation with explicit prerequisite gates, Operations. The single source of truth for SLOs, flags, and vendor capacity is a table at the top, not scattered across phases.
- **Phase 4 (Pipecat hardening) is a HARD prerequisite for Phase 7 (live canary).** Sequence isn't enough; it's a checkbox.
- **Rollback drills are acceptance criteria, not just triggers.** Each canary phase includes an executed rollback drill with elapsed time recorded.
- **Implementation bug noted.** Current `db/migrations/009_call_queue_foundation.sql` puts `CREATE INDEX CONCURRENTLY` inside a transactionally-wrapped migration; this will fail at apply time. Phase 1 work item §2 fixes it.

## Executive Summary

Donna can scale to 2,000 daily users, but the current architecture should not be scaled by raising `MAX_CONCURRENT_CALLS` and adding Pipecat replicas. The active scheduler is a single Node polling loop that discovers due work, deduplicates with in-memory sets, and fires calls with a fixed concurrency of 10. Pipecat admission control is per replica. Redis is optional. Telnyx webhook dedupe is local memory. Post-call work runs inline. Database pools multiply quickly as replicas are added.

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

Several schema-level decisions are baked in from day one to avoid expensive re-architecture later (full rationale in §2.7 Schema Layout And Partitioning):

- Operational tables (`call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`) live under a dedicated `ops.*` schema so they can later be moved to a dedicated operational Postgres without rewriting application SQL.
- Queue, attempt, and job tables are `PARTITION BY HASH (senior_id)` from Phase 1. Cheap to do now, painful to retrofit, and gives the dispatcher headroom past the 2,000-user target.
- Post-call work is recommended to run on a durable workflow engine (Temporal Cloud or Inngest) with `ops.post_call_jobs` retained as a metadata/audit table. The Postgres-only worker pattern in Phase 6 is the Plan B.
- A `region text not null default 'us-east-1'` column exists on `call_attempts` and region appears in Redis key shapes (heartbeats, reservations). Actual multi-region deploy is out of scope per §1.7; this is schema cheapness only.

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
- Multi-database or multi-tenant sharding.
- More than one scheduled call per senior per day.
- B2B / facility tenancy with shared admins.
- Real-time co-listening, three-way calling, or multi-party calls.
- Caregiver self-serve dispatch overrides ("call my dad now" beyond existing manual call).
- Replacing Telnyx as the call provider during this milestone.
- Replacing Claude Haiku as the in-call LLM during this milestone.
- Geographic anti-affinity for Pipecat replicas.

If demand emerges for any of these, they become a separate plan after the 2,000-user milestone is verified.

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
- `call:reservation:{reservation_id}` (TTL 2–5 min)
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
| `inbound` | Inbound caregiver / onboarding / senior callback | 7% | not dispatched (Pipecat admits); reservation accounted for global capacity |
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

## 2.7 Schema Layout And Partitioning

Two schema-level decisions are made now because retrofitting them once `call_queue` has live rows is significantly more work than getting them right in Phase 1.

### `ops.*` schema isolation

Operational tables (`call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`, `call_control_index`) live under a dedicated `ops.*` schema. Application-domain tables (`seniors`, `conversations`, `memories`, `reminders`, `caregivers`, etc.) stay under `public.*`.

App code never writes a SQL join from `ops.*` to `public.*`. Senior hydration for queued work happens through service calls or denormalized fields on the queue row itself. A CI lint or runtime startup check should fail if an app-level query attempts a cross-schema join, so the boundary is enforced from Phase 1 rather than rediscovered during a future migration.

The forward path is to migrate `ops.*` onto a dedicated operational Postgres cluster (separate Neon project, Crunchy Bridge, RDS, or CloudSQL with provisioned IOPS) once Neon's write-throughput characteristics start to bound dispatch latency. Today, all schemas live in the same Neon project; tomorrow, only the operational-pool connection string changes. The trigger for the split is documented in §6 Open Decisions and revisited in §8 (Forward Path To 10,000 Users).

### Hash partitioning by `senior_id`

All queue/attempt/job tables are hash-partitioned on `senior_id` from Phase 1:

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
  - Unique constraints all include `senior_id` as the leading column (e.g., `UNIQUE (senior_id, dedupe_key)`). Free strengthening because dedupe keys are already senior-scoped (`schedule:{senior_id}:{date}:...`).
- Foreign keys between partitioned tables use compound references: `ops.call_attempts.(senior_id, queue_id)` references `ops.call_queue.(senior_id, id)`. FKs from partitioned tables to non-partitioned tables (`ops.call_queue.senior_id references public.seniors(id)`) are simple FKs.
- `call_attempts` and `post_call_jobs` use the same partitioning scheme so cross-table operations for one senior stay within a single partition heap file. The dispatcher's hot path benefits from this locality.
- `FOR UPDATE SKIP LOCKED` works correctly across partitioned tables and benefits from reduced lock manager contention (per-partition heap locks instead of one global heap).
- One Postgres limitation: `UNIQUE (call_control_id)` cannot be enforced on a partitioned table without including the partition key. Global uniqueness comes from Telnyx itself (one `call_control_id` per call), and we maintain a small unpartitioned `ops.call_control_index` lookup mapping `call_control_id → (senior_id, queue_id, attempt_id)` for fast inbound webhook routing without scanning all partitions.

### Region column (forward-compat only)

`ops.call_attempts.region text not null default 'us-east-1'` is included in Phase 1. Heartbeat Redis keys take the shape `pipecat:instance:{region}:{instance_id}`, and capacity reservation keys take `call:reservation:{region}:{reservation_id}`. Multi-region call routing is explicitly out of scope per §1.7 — this column and key shape exist only so that the eventual multi-region plan does not require a schema migration. Today there is one value (`us-east-1`) and behavior does not branch on region.

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

## Phase 1 — Schema and Idempotency (~1 week)

**Prerequisite gate:** Phase 0 exit criteria met.

**Work items:**

1. **Schema, partitioning, and migrations.** See §2.7 for full rationale.
   - Create the `ops` schema. Place all operational tables under `ops.*`: `call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`, `call_control_index`. `senior_call_schedules` stays in `public.*` because it shares a senior-profile concern with `public.seniors`.
   - Migrations for `public.senior_call_schedules`, `ops.call_queue`, `ops.call_attempts`, `ops.post_call_jobs`, `ops.outbound_call_guards`, `ops.scheduler_shadow_comparisons`, `ops.call_control_index`. Parity migrations on the Pipecat side for any service that needs to read these tables.
   - `ops.call_queue`, `ops.call_attempts`, `ops.post_call_jobs` declared `PARTITION BY HASH (senior_id)` with 16 partitions each. Primary key `(senior_id, id)`. Unique constraints all include `senior_id` as leading column. Compound FK from `ops.call_attempts.(senior_id, queue_id)` to `ops.call_queue.(senior_id, id)`. `ops.call_control_index` remains unpartitioned for global `call_control_id` lookup.
   - `ops.call_attempts.region text not null default 'us-east-1'`. Forward-compat only; no behavior branches on region (§1.7 keeps multi-region out of scope).
   - CI check (regex or AST-level) that fails PR merge if app code includes a SQL join between `ops.*` and `public.*` tables.
2. **Fix: `CREATE INDEX CONCURRENTLY` outside transactional migration files.** Today's `db/migrations/009_call_queue_foundation.sql` puts `CONCURRENTLY` inside a file that the migration runner wraps in `BEGIN/COMMIT`. CONCURRENTLY cannot run inside a transaction; the two `CONCURRENTLY` index statements will fail at apply time. Move them to a separate non-transactional migration step (or to a runtime backfill job).
3. **`reminder_deliveries.delivery_key` backfill.** Existing rows have no delivery key. Backfill script that derives `delivery_key` from `reminder_id` + normalized `scheduled_for` (using the same tolerance window the current scheduler uses for dedupe). Run on a staging clone first; if any collisions are found, document the collision-resolution policy before applying the unique index in production.
4. **Migration timing measured on prod-sized clone**, not asserted. Each migration completes within the threshold set in Phase 0 dry-run.
5. Idempotency constraints:
   - Unique `conversations.call_sid` where not null (CONCURRENTLY, separate step).
   - Unique `reminder_deliveries.delivery_key` where not null (CONCURRENTLY, separate step).
   - Unique `call_metrics.call_sid` if one metrics row per call is intended.
6. Retention coverage extended in both Node `services/data-retention.js` and Pipecat `services/data_retention.py` for all new tables (queue: 90d, attempts: 180d, jobs: 180d, guards: 30d, shadow comparisons: 30d). **Parity verified** between Node and Pipecat retention loops.
7. Hard-delete + legal-hold coverage extended to all new senior-linked tables.
8. Senior export endpoint extended to include new tables (encrypted fields decrypted only at the response boundary).

**Exit criteria:**

- Migrations applied on staging clone, timing recorded, no errors.
- Delivery-key backfill applied with 0 unresolved collisions on staging clone of prod.
- Unit + integration tests cover unique constraints and dedupe behavior.
- PHI sentinel scan passes against all new tables.
- Retention / hard-delete / export coverage tested end-to-end on staging clone.
- Both Node and Pipecat retention loops verified to purge all 5 new tables.

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

**Exit criteria:**

- Re-running materializer produces no duplicate queue entries (unique constraint enforced).
- 7+ days of shadow comparison data show ≥99% agreement with legacy on scheduled-call eligibility, 100% on paused/inactive suppression, 100% on reminder-instance dedupe.
- DST + timezone edge-case suite passes.
- Shadow comparisons appear in `audit_logs`.
- Concurrent materializer test passes at 10 / 50 / 100.
- PHI sentinel scan clean.

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

## Phase 4 — Dispatcher (Dry-Run, Then Live) (~1–2 weeks)

**Prerequisite gate:** Phase 2 + Phase 3 exit criteria met.

**Work items:**

1. Postgres `FOR UPDATE SKIP LOCKED` lease.
2. Lane policy + protected capacity (§2.3, includes `inbound` reserve).
3. Capacity reservation in Redis with TTL (`call:reservation:{reservation_id}`, TTL 2–5 min).
4. Pass `queue_id` + `reservation_id` through Node → Pipecat `/telnyx/outbound`.
5. `call_attempts` persistence with architecture / cohort / test_run_id.
6. Reconciler for expired leases / reservations / queue rows past `latest_at`.
7. Guard acquisition shared with legacy (per §2.4).
8. **Service-to-service rate-limit carve-out (rev 2 addition).** Pipecat's per-IP rate limiter does not throttle requests authenticated by the labeled `dispatcher` API key. Without this, the dispatcher will throttle itself at 600 dials in 15 min from one IP. The labeled key is rate-limited separately (and far more loosely) than public traffic.
9. **Senior-delete-vs-in-flight guard recheck (rev 2 addition).** Per §2.4 — re-check senior `is_active` + `deleted_at` inside the same transaction that flips guard status from `acquired → initiating`, immediately before issuing HTTP to Pipecat. Cancel + release reservation if senior went inactive.
10. **Dispatcher prompt-cache awareness (rev 2 addition; conditional on Phase 0 measurement).** If Phase 0 baseline shows cross-call Anthropic cache hit rate is materially positive, the dispatcher groups calls for one senior on one replica when possible to maximize within-replica cache reuse. If Phase 0 shows cross-call cache hit rate is near zero (because per-senior context dominates), this work item is skipped and the dispatcher stays cache-agnostic. Decision tied to Phase 0 measurement, not assumed.
11. Dry-run dispatcher first; live dialing only after dry-run passes.

**Exit criteria:**

- Dry-run dispatcher produces no duplicate leases at 4, 8, 16 concurrent workers.
- Live dispatcher dials zero duplicates across 10,000 simulated calls.
- Guard race tests pass with legacy + queue dialers contending for the same call.
- Service-to-service auth path bypasses public rate limit (verified by 600-dial test from one IP).
- Senior-delete race resolves to `cancelled` 100% of the time in race test (1,000 trials).
- Reconciler recovers expired leases within one cycle.

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
| Inbound onboarding | 5 | 5 | prospect path unaffected |
| Post-call burst | 20 | 20 | job backlog drains inside SLO |
| **Inbound surge during outbound** (rev 2) | 0 | 200 outbound + 50 inbound concurrent | both lanes within SLO, no drops |

3. **Caller-ID answer-rate canary (rev 2 addition).** Outbound 50 → 100 → 250 dials from the caller-ID strategy chosen in Phase 0. Measured answer rate must be ≥ 80% of the single-call baseline established in Phase 0. If not, return to the Phase 0 caller-ID decision before progressing. Do not progress to Phase 7 with a failing answer-rate result.
4. **Rollback drill (rev 2 addition).** Toggle from `canary_queue` back to `legacy_only`. Measure elapsed time from flag flip to legacy fully owning dispatch. Update runbook with measured numbers. Drill must be executed at least once before Phase 7.
5. Daily PHI sentinel scan of Node logs, Pipecat logs, Redis, queue tables.

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

## Phase 6 — Post-Call Queue (significantly expanded, ~2 weeks)

**Prerequisite gate:** Phase 4 exit criteria met.

This phase gets materially more detail than rev 1. Stampede at end-of-window is the single most failure-prone moment in the system.

### Implementation strategy: workflow engine recommended

The work items below describe a Postgres-backed `ops.post_call_jobs` design. The recommended production implementation is a durable workflow engine (Temporal Cloud or Inngest), with `ops.post_call_jobs` retained as a metadata/audit table — not as the work queue itself.

Why: the dependency graph, retry/backoff, dead-letter, and per-job-type concurrency caps described in items 2–5 below are all first-class features of Temporal/Inngest. Building them on Postgres is doable (this plan describes how) but every operational concern has to be re-implemented in app code, and the post-call burst is the single highest-value place in the system to use a managed workflow runtime.

Decision belongs to Phase 0 (Open Decisions closed in writing) — choose Temporal Cloud, Inngest, or stay with the Postgres-only Plan B. The work items below describe the canonical job semantics in either case; only the runtime engine differs. If a workflow engine is chosen, `ops.post_call_jobs` becomes the system-of-record for "what work was enqueued for this call SID" and the workflow engine owns lease/retry/dead-letter execution.

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
   - Anthropic Haiku post-call analysis: cap at 60% of measured peak TPM from Phase 0.
   - Gemini Flash analysis fallback: cap at 60% of measured concurrent capacity.
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

**Per-step exit criteria:**

- All §1.3 SLOs met for the step duration.
- 0 PHI sentinel findings.
- 0 P0/P1 incidents.
- Cost per senior within Phase 0 budget at observed traffic.
- Provider rate-limit errors below alert threshold.
- Post-call backlog returns to normal within 30 min for non-critical jobs after each window.

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
- No senior names, phone numbers, reminder titles, medical notes, transcripts, caregiver notes, or prompt context in scheduler / dispatcher / worker logs.

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
- Whether post-call workers run inside Node API process or as a separate Railway worker service.
- **Durable workflow engine for post-call jobs.** Temporal Cloud vs. Inngest vs. Postgres-only Plan B. Decision drives Phase 6 implementation per its "Implementation strategy" section.
- **Operational Postgres split trigger.** When `ops.*` moves from the Neon project to a dedicated operational Postgres (Crunchy Bridge / RDS / CloudSQL). Default: stay on Neon until write throughput on `ops.call_attempts` or `ops.post_call_jobs` becomes a measurable bottleneck. Trigger metric: sustained alert on DB pool idle dropping below §1.3 SLO during burst windows.

---

# 7. Implementation Order Summary

For the engineer or AI agent executing this plan, the build order is:

1. **Phase 0** — measure, decide, contract. Do not skip. Do not partial-skip. Phase 1 cannot start until baselines exist.
2. **Phase 1** — schema + idempotency + retention parity. Fix the `CONCURRENTLY`-inside-transaction bug in `009_call_queue_foundation.sql`.
3. **Phase 2** (parallel with Phase 3) — materializer, shadow-only. DST suite required.
4. **Phase 3** (parallel with Phase 2) — Pipecat multi-instance hardening, replica readiness gate, Node-side drain, inbound lane wiring.
5. **Phase 4** — dispatcher, dry-run → live, with service-to-service rate-limit carve-out and senior-delete race recheck.
6. **Phase 5** — synthetic live A/B + caller-ID answer-rate canary + rollback drill.
7. **Phase 6** — post-call queue with dependency graph, retry/backoff, dead-letter handling, 600-completion stampede test.
8. **Phase 7** — small live canary (HARD gate from Phases 3 + 6 + BAAs).
9. **Phase 8** — scheduled capacity + autoscaler with replica warm-up gate + cost-aware scale-down.
10. **Phase 9** — production rollout at 50 → 100 → 250 → 600 → 2,000.

Single biggest discipline: **Phase 0 is not optional.** Rev 1 let the team jump to building because Phase 0 was a thin guardrail. Rev 2 makes Phase 0 produce measurements and close decisions. Everything downstream inherits Phase 0's quality.

---

# 8. Forward Path To 10,000 Users

This plan delivers durable, multi-instance voice infrastructure capable of 600 concurrent active calls and 2,000 daily users. Scaling further — to roughly 10,000 daily users and 3,000 concurrent at peak — is past the design point of the architecture described above. It is not a "more replicas" exercise. Each of the assumptions below breaks before 10,000 users.

10k design work is being prototyped in parallel with the 2,000-user delivery. This section is not a deferred plan; it is the operating record of what 10k infrastructure decisions are forward-compatible with rev 2, what breaks first when daily users grow past 2,000, and what transitions are being staged in parallel. Specific in-flight 10k prototypes are tracked in `docs/plans/` and linked here as they land.

## 8.1 What rev 2 already does for 10k

Decisions in rev 2 / §2.7 chosen with the 10k transition in mind:

- **`ops.*` schema isolation.** Moving operational tables to a dedicated Postgres later is a connection-string change, not a code refactor (§2.7).
- **Hash partitioning by `senior_id`.** 16 partitions hold ~625 seniors each at 10k. The partition key is also the natural shard key if we ever need to move from one partitioned table to many physical tables across shards (§2.7).
- **`PIPECAT_REQUIRE_REDIS=true` from Phase 3.** Removes the single-instance code path. Multi-region Redis later requires Redis Cluster, but application code already assumes Redis as the source of truth.
- **Region-aware schema and Redis key shapes (§2.7).** Adding a second Pipecat region later does not require a `region` column migration or Redis key reshape.
- **Workflow engine recommendation (Phase 6).** Per-job-type concurrency caps, retry/backoff, and dead-letter are first-class in Temporal/Inngest. Scaling job concurrency by 10x is a configuration knob.
- **Numeric SLOs (§1.3).** The same metric framework extends to 10k; only the targets get retightened.

## 8.2 What breaks first as users grow past 2,000

In order of how soon the wall hits:

1. **Outbound caller-ID reputation.** Long before any code-level metric moves, ~3,000 outbound calls in a 15-minute window from a single caller ID triggers carrier spam analytics. Answer rate collapses silently. Already on the radar via §1.6 (caller-ID pool) and Phase 0 §4 (caller-ID strategy). At 10k, single-ID is not viable — number pool + STIR/SHAKEN + reputation monitoring become structural.
2. **Provider concurrency quotas.** 3,000 concurrent calls means 3,000 concurrent Deepgram streams, 3,000 active Claude contexts, ~6,000 Director LLM RPS. Per-org quotas become hard ceilings. Plan: committed-tier contracts on every minute-billed vendor; multi-provider sharding via AI Gateway for STT and LLM with documented failover paths exercised in chaos tests.
3. **Single Postgres write throughput.** Even with `FOR UPDATE SKIP LOCKED` and `senior_id` partitioning, one Postgres primary handles a fixed write rate. `ops.call_attempts`, `ops.post_call_jobs`, `audit_logs`, and `conversations` all spike simultaneously during burst windows. Plan: split `ops.*` onto a dedicated operational Postgres with provisioned IOPS (per §6 Open Decisions trigger); read replicas for context hydration; consider moving the `audit_logs` append path to S3/Parquet rather than a Postgres table at 10k volume.
4. **Redis as a single point of failure.** Single-region Redis is acceptable for one Pipecat region. Multi-region voice requires Redis Cluster with cross-AZ failover, and capacity coherence becomes a consensus problem. Plan: Redis Cluster mode, capacity reservations consider Redis quorum, fallback path that leases through Postgres at higher latency if Redis degrades.
5. **Single-region voice latency.** US coast-to-coast users on a single Pipecat region accept ~80–100ms additional one-way audio latency. Tolerable but noticeable. International expansion makes this worse. Plan: deploy Pipecat in multiple regions, route on `seniors.preferred_region`, accept cross-region writes for shared state (Postgres + Redis primaries stay in one region; reads are local).
6. **Caregiver notification throughput.** ~10,000 daily notifications, bursty by call-end window. Resend (or any single provider) starts throttling. Plan: notification service tier with batching, provider failover, per-provider concurrency caps.
7. **Cost.** Roughly 1.7M call-minutes per day at 10k. STT + TTS + LLM costs dominate infrastructure costs and start determining margin. Plan: committed-tier contracts on every minute-billed vendor; evaluate self-hosted STT (Whisper, or self-hosted Deepgram) or cheaper TTS for low-stakes utterances.

## 8.3 Transitions between 2,000 and 10,000

| Transition | Driver | Trigger | Parallel work status |
| --- | --- | --- | --- |
| Split `ops.*` to dedicated operational Postgres | Burst write throughput; DB pool exhaustion | ~3,000 daily users or sustained §1.3 DB pool idle alert | TBD — link prototype doc when started |
| Pipecat second region | Audio latency complaints from West Coast / international users | Product signal, not capacity signal | TBD |
| Telnyx managed number pool | Answer rate decline correlated with outbound volume | First measurable drop below §1.3 80%-of-baseline target | TBD |
| Multi-provider sharding (STT/LLM) | Provider rate-limit alerts at peak | First sustained provider 429s | TBD |
| Redis Cluster | Pipecat multi-region rollout or single-AZ Redis incident | Either trigger first | TBD |
| Workflow engine concurrency cap increase | Post-call job backlog growing | 10x current per-job-type cap with no DB stress | TBD |
| `audit_logs` archival to S3/Parquet | `audit_logs` write rate or storage cost | Storage-cost trigger before throughput trigger | TBD |

The "Parallel work status" column is intentionally TBD here so this section stays the operating record. As 10k prototypes land in `docs/plans/`, those rows get linked and updated.

## 8.4 Product transitions

Code and infrastructure are necessary but not sufficient at 10k. Two product-level changes become structurally important:

- **Schedule distribution.** Stop letting all users pick "9:00 AM." Offer scheduling bands ("morning: 8–9 AM, we'll pick a quiet minute"), use historical answer-rate data to suggest off-peak slots, and use deterministic jitter within the band to spread load. Possibly more capacity headroom than any single infrastructure change.
- **Tiered call types.** Hard reminders remain time-sensitive. Companion check-ins become flexible within a multi-hour window. The lane reservation policy in §2.3 extends naturally; the product change is exposing the flexibility to caregivers in the mobile app.

## 8.5 Coordination with 2k delivery

Running 10k design in parallel with 2k delivery is supportable as long as a few rules hold:

- **2k Phase 0 measurements are not blocked by 10k work.** The baseline data that drives §1.3 SLO targets, vendor concurrency inventory, and the cost model must still close before Phase 1 starts. 10k prototypes that need those measurements should consume them as outputs, not lobby for skipping them.
- **10k prototypes do not couple into rev 2's critical path.** A prototype of `ops.*` on a separate Postgres, or a Redis Cluster spike, or a number-pool integration with Telnyx, can run in a side environment with its own DB / Redis / Telnyx subaccount. It should not change `db/migrations/`, `ops` schema definitions, or production env vars on the path of the 2k rollout.
- **What's learned in a 10k prototype updates this section.** When a prototype validates or invalidates an assumption in §8.2 or §8.3, the table here gets the link and the row gets updated. This section is the durable record; prototype docs are the working space.
- **A 10k prototype that needs to land in production code (not a side environment) gets its own design doc and PR review.** No silent landing.

The forward-compatible decisions in rev 2 (`ops.*` schema, hash partitioning, Redis-required, region-aware key shapes, workflow engine recommendation) are what made parallel 10k work cheap to start. Everything in §8.2 / §8.3 can be prototyped while 2k ships, as long as the prototype work does not block 2k Phase 0 or alter rev 2's critical path without explicit review.
