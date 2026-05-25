# Donna System Architecture

> Technical architecture reference for the Donna AI companion voice system.

---

## Two-Backend Design

Donna runs two backends sharing the same PostgreSQL database:

| Backend | Language | Platform | Responsibility |
|---------|----------|----------|----------------|
| **Pipecat** | Python 3.12 | Railway (port 7860) | Real-time voice pipeline, WebSocket, health monitoring |
| **Node.js** | Express | Railway (port 3001) | Admin, website, and mobile REST APIs; reminder scheduler; call initiation |

This is an **explicit architectural decision** — each backend owns a clear domain. Dual service implementations (e.g., `services/memory.js` and `pipecat/services/memory.py`) exist because each backend needs database access for its own purpose.

## Current Scale Status (`zuludev`)

Donna currently carries two outbound-call architectures:

| Path | Status | What it owns |
|---|---|---|
| **Legacy scheduler/dialer** | Still present and kept as current/rollback authority | `services/scheduler.js` builds due-call plans, filters paused/inactive seniors, uses legacy in-process dedupe maps, and dials through Pipecat `/telnyx/outbound`. |
| **Queue + capacity dispatcher** | Implemented behind rollout flags | `senior_call_schedules`, `call_queue`, `outbound_call_guards`, `call_attempts`, Pipecat capacity heartbeats/reservations, canary cohort membership, Phase 6 post-call jobs, and Phase 8 capacity planning. |

The queue path is the architecture intended to support the **2,000-user burst milestone**. It should not be called fully active until production is running `CALL_ARCHITECTURE_MODE=queue_primary`, `CALL_QUEUE_ALLOW_REAL_DIAL=true`, the capacity registry is required, and Phase 7/8 evidence has been saved. The legacy path remains intentionally deployable through the rollout and rollback window.

The path to **10,000 users** is documented as forward work in [the scale plan §8](../plans/2026-05-18-scale-to-2000-users-technical-plan.md#8-forward-path-to-10000-users): operational-table partitioning or `ops.*`, HA/multi-region Redis, caller-ID pool/reputation strategy, provider sharding/failover, workflow-engine post-call execution, and larger archive/retention handling. Those are trigger-based next steps, not completed runtime behavior.

---

## Voice Pipeline (bot.py)

Linear pipeline of Pipecat `FrameProcessor`s. Frames flow top to bottom:

```
Telnyx L16/16k audio ──► FastAPIWebsocketTransport
                        │
                   Deepgram STT (Nova 3, internal 16kHz PCM)
                        │ TranscriptionFrame
                        ▼
              ┌─────────────────────┐
              │   Quick Observer     │  Layer 1 (0ms): companion-call regex signals
              │   (BLOCKING)         │  Stashes guidance for Director injection
              │                      │  Strong goodbye → guarded EndFrame
              └─────────┬───────────┘
                        ▼
              ┌─────────────────────┐   ┌─────────────────────────┐
              │ Conversation         │──►│ Background Analysis      │
              │ Director             │   │ Groq fast path          │
              │ (PASS-THROUGH)       │   │ Gemini fallback helper  │
              │                      │   │ + Memory prefetch       │
              │ Injects guidance +   │   │ + Same-turn guidance    │
              │ dynamic news context │   │ + Force end at 9/12min  │
              └─────────┬───────────┘   └─────────────────────────┘
                        ▼ (0-500ms memory gate)
              Context Aggregator (user) ← builds LLM context from transcriptions
                        ▼
              Claude Haiku 4.5 + FlowManager (4-phase state machine)
                        │ TextFrame
                        ▼
              Guidance Stripper (strips <guidance> tags + [BRACKETED] directives)
                        ▼
              Conversation Tracker (topics, questions, advice + stripped transcript)
                        ▼
              ElevenLabs TTS or Cartesia Sonic 3 (16kHz PCM for Telnyx calls)
                        ▼
              FastAPIWebsocketTransport ──► Telnyx L16/16k audio
                        ▼
              Context Aggregator (assistant) ← tracks assistant responses
```

**Key mechanism**: Quick Observer is no longer an LLM-context writer. It stashes `_pending_observer_guidance`; Conversation Director is the single writer that injects Observer/Director/news guidance into Claude's context via `LLMMessagesAppendFrame(run_llm=False)`. This prevents duplicate ephemeral guidance while keeping the regex path on the current turn.

### Runtime Audio Profile

Source of truth: `pipecat/bot.py`, `pipecat/bot_gemini.py`, and the active telephony serializer.

| Segment | Runtime default | Why |
|---|---:|---|
| Telnyx wire input | 16kHz L16 PCM | Telnyx media stream profile |
| Internal STT input | 16kHz PCM | Matches the Telnyx wire profile for STT |
| Telnyx phone TTS output | 16kHz PCM | Selected TTS provider, matched to the Telnyx wire profile |
| Cartesia non-phone output | 48kHz `pcm_s16le` | `CARTESIA_OUTPUT_SAMPLE_RATE`; used outside active Telnyx calls |
| ElevenLabs non-phone output | 44.1kHz PCM | `ELEVENLABS_OUTPUT_SAMPLE_RATE`; used outside active Telnyx calls |
| Gemini Live internal output | 24kHz PCM | `GEMINI_INTERNAL_OUTPUT_SAMPLE_RATE`; preserved internally before serializer output |
| Telnyx wire output | 16kHz L16 PCM | Final provider edge handled by `DonnaTelnyxFrameSerializer` |

The guiding rule is: keep PCM throughout the pipeline and match active Telnyx calls to 16kHz before the serializer so output frames stay at a normal 20ms cadence. Do not request `pcm_mulaw` from Cartesia; the Telnyx path expects linear PCM through the serializer boundary.

---

## 2-Layer Observer Architecture

### Layer 1: Quick Observer (`processors/quick_observer.py`)
- **Latency**: 0ms (blocking, inline)
- **Method**: active companion-call regex categories for goodbye, emotion, family, social, activity, environment, help requests, end-of-life talk, news, questions, engagement, and reminder acknowledgments. `patterns.py` still contains legacy health/safety/ADL tables for reference, but those are not imported by the active Quick Observer.
- **Output**: Stores guidance for Director to inject on the current turn
- **Goodbye detection**: Explicit strong goodbye → programmatic EndFrame after the minimum call-age guard and configured delay (bypasses unreliable LLM tool calls)

### Layer 2: Conversation Director (`processors/conversation_director.py`)
- **Latency**: non-blocking via `asyncio.create_task`; Groq is the active fast provider
- **Providers**: Groq (`gpt-oss-20b`) for fast speculative/query analysis; Gemini Flash remains available for regular non-speculative fallback analysis
- **Speculative analysis**: Detects silence onset (250ms gap in interims), starts analysis during silence for same-turn injection
- **Output**: Same-turn guidance (speculative hit) or previous-turn cached guidance (fallback)
- **Dynamic news**: Injects news context when `should_mention_news` is signaled (one-shot per call)
- **Location/date context**: Senior's city/state + today's date in every turn for specific prefetch predictions
- **Time enforcement**: Force winding-down at 9 minutes, force end at 12 minutes

---

## Call Phase State Machine (Pipecat Flows)

Conditional reminder, main, winding_down, and closing phases are managed by `FlowManager` with `NodeConfig` definitions:

| Phase | Tools Available | Context Strategy | Transition |
|-------|----------------|-----------------|------------|
| **Reminder** *(conditional)* | mark_reminder_acknowledged, create_reminder, transition_to_main | APPEND, respond_immediately | After reminders delivered |
| **Main** | web_search, mark_reminder_acknowledged, create_reminder, transition_to_winding_down | APPEND | Natural wind-down or Director force |
| **Winding Down** | mark_reminder_acknowledged, create_reminder, transition_to_closing | APPEND | Closing cue or Director force |
| **Closing** | *(none — post_action: end_conversation)* | APPEND | Auto-end |

### LLM Tools (3 active subscriber-call tools)
1. **web_search** — In-call factual search via Tavily first, OpenAI fallback.
2. **mark_reminder_acknowledged** — Track reminder delivery status.
3. **create_reminder** — Save senior-requested reminders after Donna confirms title, date/time, recurrence, and readback.

Retired handlers remain in `pipecat/flows/tools.py` for Gemini/future work, but `make_flows_tools()` exposes only the three active subscriber-call tools above. Onboarding calls expose `web_search` only. Memory and caregiver-note context is prefetched/injected instead of exposed as Claude tools.

### Senior Context Assembly

`pipecat/flows/nodes.py:_build_senior_context()` builds the senior-specific prompt context before the call flow starts. It includes:

- Current local date/time from the senior's IANA timezone
- Name and city/state profile context
- English/Spanish call-language instruction from `familyInfo.donnaLanguage`
- Date-of-birth derived age and birthday awareness from `familyInfo.dateOfBirth`
- Interest IDs plus caregiver/AI detail text from `familyInfo.interestDetails`
- Additional caregiver context from `seniors.additional_info`
- Topics to avoid from `familyInfo.topicsToAvoid`, falling back to `preferred_call_times.topicsToAvoid` for onboarding-created rows
- Profile context, memory context, recent turns, last-call summaries/takeaways, and today's same-day context

Prompt context events are recorded through `services.context_trace` without logging raw PHI to application logs.

---

## Post-Call Processing (`services/post_call.py`)

Runs after the telephony WebSocket disconnects. If `POST_CALL_QUEUE_ENABLED=true`, Pipecat first seeds the `post_call_jobs` graph, but the current runtime still continues through the inline chain below. `run_bot()` awaits this post-call task before releasing the Pipecat active-call semaphore, so Phase 6 is a migration seam and evidence path, not yet a full capacity release until the inline work is disabled behind flags.

```
Step 1: Complete conversation (prerequisite) ───────── sequential
    │
    ├── Step 2: Call analysis (Claude Haiku)  ─────┐
    ├── Step 3: Memory extraction (OpenAI)    ─────┤  parallel
    ├── Step 5: Reminder cleanup              ─────┤
    └── Step 6: Cache clearing                ─────┘
                                                    │
Step 3.5: Interest discovery + category/detail merge ── sequential
Step 3.6: Interest scores (depends on Step 3.5)  ── sequential
Step 4: Daily context (depends on Step 2)        ── sequential
```

---

## Outbound Call Dispatch — Dual-Path Rollout

Donna is rolling the outbound dialer off the in-process Node scheduler onto a durable Postgres-backed queue. The two paths run side-by-side, gated by `CALL_ARCHITECTURE_MODE`, until the queue is dial authority (`queue_primary`). See [`docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`](../plans/2026-05-18-scale-to-2000-users-technical-plan.md) for the full plan.

```
                       ┌── Legacy plan ────┐
                       │ services/         │ acquires guard, dials through Pipecat
  scheduler.js tick ──►│ scheduler.js      │ (legacy path does not write call_attempts)
                       │ (in-process)      │
                       └─────────┬─────────┘
                                 │ (in shadow_materialize / shadow_dispatch / canary_queue / queue_primary)
                                 ▼ materialize each due call into call_queue
                       ┌── Queue path ─────┐
                       │ services/         │ FOR UPDATE SKIP LOCKED leases,
  dispatcher tick ────►│ call-queue.js     │ acquires guard, dials Telnyx,
                       │ (in-process)      │ records call_attempt (architecture=queue)
                       └─────────┬─────────┘
                                 │
                  outbound_call_guards (guard_key UNIQUE) ◄── one path wins per call
                                 │
                                 ▼
                  POST /telnyx/outbound on Pipecat with {queue_id?, reservation_id?}
```

**Consistency model.** Postgres decides *what* runs (queue rows, leases, guards, attempts, jobs); Redis decides *what is running right now* (capacity heartbeats, dedupe TTLs, rate limits). The dispatcher reads capacity from Redis but only commits dial authority by acquiring a Postgres row.

Manual caregiver/admin calls through Node `routes/calls.js` call Pipecat `/telnyx/outbound` directly until `CALL_ARCHITECTURE_MODE=queue_primary`. In `queue_primary`, manual, consent, and discovery calls enqueue into the queue `manual` lane before dispatch.

**Modes (`CALL_ARCHITECTURE_MODE`):**

| Mode | Legacy dials | Queue inserts | Queue dispatches | Real queue dial |
|---|---|---|---|---|
| `legacy_only` | yes (no guard) | no | no | no |
| `shadow_materialize` | yes (guarded) | yes | no | no |
| `shadow_dispatch` | yes (guarded) | yes | dry-run lease + comparison | no |
| `canary_queue` | yes (non-canary, guarded) | yes | leases canary cohort | yes (requires `CALL_QUEUE_ALLOW_REAL_DIAL=true` + cohort selector) |
| `queue_primary` | no | yes | leases everything | yes |
| `legacy_rollback` | yes (guarded) | no by default; existing queue rows retained | no | no |

**Dial-authority guard.** `outbound_call_guards.guard_key` is `INSERT ... ON CONFLICT DO NOTHING`-protected. Both paths build the same guard key from `(callType, seniorId, scheduleOrReminderId, targetAt)` and race for it; the loser suppresses its dial. The queue transition can move through `active`, `initiating`, `initiated`, `cancelled`, and `released_expired`; uninitiated guards may be deleted by cleanup. Before dialing, the transaction rechecks that the senior is active and not caregiver-paused. The current `seniors` schema does not have `deleted_at`, so deletion safety is handled by FK/cascade behavior and active-state checks rather than a soft-delete predicate.

**Materializer is canary-blind by design.** All due schedules materialize into `call_queue` regardless of cohort. Canary selection happens at dispatch time via `canaryPercent` + `canarySeniorIds`; the legacy scheduler removes canary seniors from its own plan in `canary_queue` mode so the guard mediates only between cohorts that should converge.

**Capacity coordination.** `pipecat/services/capacity.py` publishes per-replica heartbeats every 5s to `pipecat:instance:{id}` with a 15s TTL. `services/pipecat-capacity.js` reads via Redis or Upstash REST. There is no local heartbeat registry fallback; when no shared registry is configured and the registry is not required, queue code falls back to configured batch-size capacity rather than per-replica state. The dispatcher computes available slots per instance before issuing leases when the registry is available. Current queue lane reserves are defined in `DEFAULT_LANE_RESERVE_POLICY` for `manual`, `hard_reminder`, `reminder_retry`, `scheduled_checkin`, `welfare`, and `low_priority_retry`; inbound calls are accounted for through the heartbeat's `inbound_active_calls` and total active-capacity subtraction, not as a leased `call_queue` lane.

**Reconciler.** `reconcileQueueLeases` recovers expired `call_queue` leases and expires overdue queued rows past `latest_at`. The Phase 4 guard reconciler (PR #261) releases stale `outbound_call_guards` past `expires_at` so the queue side does not stay blocked when a legacy dial process dies mid-flight.

---

## Post-Call Job Workflow (Phase 6)

**Active files**: `services/post-call-jobs.js`, `pipecat/services/post_call_jobs.py`, `scripts/run-post-call-worker-once.js`, `routes/post-call-jobs.js`, `db/migrations/012_post_call_job_state_machine.sql`

Phase 6 lands the infrastructure for moving post-call work (analysis, memory extraction, snapshot rebuild, caregiver notifications, etc.) onto the `post_call_jobs` queue instead of running inline in `pipecat/services/post_call.py`. **Activation is still gated**: Pipecat only enqueues when `POST_CALL_QUEUE_ENABLED=true`, and the Node worker has no continuous loop in `index.js` — it runs via `scripts/run-post-call-worker-once.js` in shadow mode while the active runtime stays on the inline path. The state machine is `queued → leased → running → completed | failed | dead_letter`. Jobs with unresolved `depends_on` IDs are not leasable.

**Job graph (`POST_CALL_JOB_GRAPH`):**

| Type | Depends on | Provider lane |
|---|---|---|
| `metrics_finalize` | — | `db` |
| `reminder_recovery` | — | `db` |
| `analysis` | — | `geminiFlash` |
| `memory_extraction` | — | `openAiEmbeddings` |
| `daily_context` | — | `db` |
| `caregiver_notifications` | `analysis` | `resend` |
| `interest_discovery` | `memory_extraction` | `openAiEmbeddings` |
| `snapshot_rebuild` | `memory_extraction`, `daily_context` | `db` |

**Provider semaphores (`DEFAULT_PROVIDER_LIMITS`):** `db=200`, `anthropicHaiku=1`, `geminiFlash=1`, `openAiEmbeddings=1`, `resend=1`. These are in-process semaphores, so they cap concurrency per worker process, not globally across a fleet. The current JS worker validates artifacts instead of generating subscriber analysis; inline Pipecat analysis uses Claude Haiku. Limits can be overridden per process via `--{db,gemini-flash,openai-embeddings,resend}-concurrency` on `scripts/run-post-call-worker-once.js`.

**Retry policy (`POST_CALL_RETRY_POLICIES`):** default is 5 attempts with backoff `[30, 120, 480, 1920]` seconds. `analysis` and `memory_extraction` use longer per-type backoff. After `max_attempts`, the job moves to `dead_letter` with a PHI-free `dead_letter_reason`.

**Admin surface (`routes/post-call-jobs.js`, `requireAdmin`):**
- `GET /api/post-call-jobs/dead-letter` — list dead-lettered jobs with per-job operational fields (`id`, `call_sid`, `senior_id`, `dedupe_key`, job type/status/timestamps, and PHI-free failure reason).
- `POST /api/post-call-jobs/:id/replay` — requeue a single dead-lettered job after operator review.

The worker (`scripts/run-post-call-worker-once.js`) refuses to run without `--confirm-db-writes`. In `handler-mode=artifact_verification`, it validates existing artifacts while still mutating lease/status rows as part of the worker transaction; it is not a non-writing dry run. Use it for Phase 6 backlog-drain and provider-concurrency evidence only on an environment where those DB writes are intentional.

---

## Capacity Planning & Autoscaling (Phases 7-8)

**Active files**: `services/phase8-capacity-plan.js`, `services/phase8-autoscaler.js`, `services/railway-scaling.js`, `routes/scale-operations.js`, `services/canary-cohort.js`, `routes/canary.js`, `scripts/phase7-canary-daily-report.js`, `scripts/phase7-canary-rollback-check.js`, `scripts/phase7-canary-report.js`, `scripts/phase5-live-ab-report.js`

Phase 7 wraps the live canary in a daily report; Phase 8 turns Pipecat replica capacity into an actuated, budget-bounded decision.

**Phase 5/7 reports (PHI-free aggregates):** `scripts/phase5-live-ab-report.js` checks for duplicate outbound calls, duplicate conversations, reminder-delivery duplicates, cohort drift, caller-ID answer rate, media-start rate, and rollback timing. `scripts/phase7-canary-daily-report.js` is the daily SLO report; `scripts/phase7-canary-report.js` is the aggregate exit report that reuses Phase 5 and adds allowlist size, 7-day continuous canary SLO, `phi_sentinel_clear`, and `no_p0_p1_incidents`. All outputs are counts/rates only — no senior IDs, phone numbers, transcripts, or reminder text.

**Phase 8 capacity plan (`services/phase8-capacity-plan.js`).** Reads future `call_queue` rows for a window, current queue backlog, critical post-call backlog, and live `pipecat:instance:*` heartbeats. Returns `recommendation.action ∈ {scale_up, hold, scale_down, wait_for_readiness}` plus `targetReplicas` and a list of named `checks`. Budget and readiness checks gate autoscaler application; the planner can still emit the recommendation so operators can see why capacity is needed.

**Phase 8 autoscaler (`services/phase8-autoscaler.js`).** Wraps the planner and applies scaling only when the recommendation, budget/readiness checks, dry-run mode, and explicit confirmation allow it. Actuation goes through `services/railway-scaling.js`, which shells `railway scale REGION=REPLICAS --service <s> --environment <e> --json`. Defaults are safety-first: `PHASE8_AUTOSCALER_DRY_RUN=true` and `PHASE8_AUTOSCALER_CONFIRM_SCALE=false` mean the long-running loop is off in production until explicitly enabled. Every actuation writes an audit row with reason code `operator_override:<sanitized>` or the recommendation's reason.

**Admin surface (`routes/scale-operations.js`, `requireAdmin`):**
- `GET /api/scale-operations/phase8/plan` — current capacity plan for a window.
- `POST /api/scale-operations/phase8/autoscale-once` — one-shot autoscaler tick (dry-run unless body opts in).
- `POST /api/scale-operations/phase8/override` — operator override with reason code; audited and PHI-free.

**Canary surface (`routes/canary.js`, `requireAdmin`):**
- `GET /api/canary/members` — list active canary members by senior ID and ramp phase only.
- `POST /api/canary/members` — add one or more senior IDs to a ramp phase.
- `DELETE /api/canary/members/:seniorId` — remove one senior from the active canary cohort with a PHI-free reason.

---

## Database Schema

**Engine**: Neon PostgreSQL with pgvector extension

| Table | Purpose | Key Fields / Indexes |
|-------|---------|-------------|
| `seniors` | User profiles, interests, encrypted family/additional context, call settings | phone (unique), `family_info_encrypted`, `additional_info_encrypted`, `call_context_snapshot_encrypted` |
| `conversations` | Call records with encrypted transcripts and summaries | call_sid, senior_id + started_at DESC |
| `memories` | Semantic memory store (pgvector embeddings) | senior_id, HNSW on embedding |
| `reminders` | Scheduled reminders (one-time + recurring) | scheduled_time WHERE active, is_recurring |
| `reminder_deliveries` | Delivery tracking per call attempt | reminder_id + scheduled_for, status; `delivery_key` (unique) for idempotency |
| `caregivers` | Family member relationships | senior_id |
| `call_analyses` | Post-call analysis results | senior_id + created_at DESC |
| `daily_call_context` | Cross-call same-day memory | senior_id + call_date |
| `admin_users` | Dashboard admin accounts | email |
| `notifications` | Caregiver notification log | caregiver_id, senior_id, sent_at |
| `waitlist` | Public waitlist signups | name, email, phone, who_for |
| `audit_logs` | HIPAA audit events | user_id, action, resource_type, created_at |
| `prospects` | Onboarding callers (not yet seniors) | phone |
| `senior_call_schedules` | Normalized recurring/one-time call schedules (Phase 1 of queue rollout) | senior_id, next_run_at |
| `call_queue` | Durable outbound dispatch queue with `FOR UPDATE SKIP LOCKED` leasing | unique `dedupe_key`, ready lease index on `(status, priority_lane, earliest_at)` |
| `call_attempts` | Per-dispatch attempt audit trail with architecture/cohort/test_run_id | `(queue_id, attempt_number)` unique, `call_control_id` unique where not null |
| `post_call_jobs` | Queued post-call work with attempt counts, leases, dependency DAG (`depends_on UUID[]`), and dead-letter terminal state (`dead_lettered_at`, `dead_letter_reason`) | `dedupe_key` unique, lease/status priority indexes, GIN on `depends_on`, partial index on `dead_lettered_at` where `status='dead_letter'` |
| `outbound_call_guards` | **Dial-authority guard** shared by legacy + queue paths; only one path may dial per `guard_key` | unique `guard_key`, status `active → initiating → completed/cancelled` |
| `scheduler_shadow_comparisons` | Side-by-side legacy/queue decision audit during shadow rollout | senior_id, created_at |
| `canary_cohort_membership` | Source of truth for active Phase 7 queue canary members; env allowlist is emergency fallback | partial unique active senior_id index, ramp_phase, removed_at |

### Scale Roadmap Beyond 2,000 Users

The 2,000-user architecture is intentionally 10k-shaped, but the next step is not "turn the dial higher." Use the triggers in the scale plan:

| Transition | Trigger | Current status |
|---|---|---|
| Operational tables to `ops.*` or partitioning | Sustained DB pool/write pressure during burst, or roughly 3,000 daily users | Current code uses flat default-schema queue/job tables. |
| Redis Cluster / HA shared state | Single-AZ Redis incident, multi-region Pipecat, or shared-state latency/reliability pressure | Current key shapes are single-region and PHI-free. |
| Caller-ID pool and reputation management | Answer rate falls below the Phase 0 baseline target as outbound volume grows | Strategy is a Phase 0/5 gate; number-pool integration is not implemented. |
| Provider sharding/failover | Sustained STT/LLM/TTS/embedding 429s at peak despite caps | Current system has per-provider caps and circuit breakers, not full provider routing. |
| Workflow-engine post-call workers | Post-call backlog or retry/dead-letter operations exceed Postgres worker comfort | Current Phase 6 path is Postgres-backed and gated by `POST_CALL_QUEUE_ENABLED`. |

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Voice Pipeline | Pipecat | v0.0.101+ |
| Call State Machine | Pipecat Flows | v0.0.22+ |
| Primary LLM | Anthropic Claude Haiku 4.5 | claude-haiku-4-5-20251001 |
| Director LLM (active fast path) | Groq | gpt-oss-20b |
| Director LLM (regular fallback helper) | Google Gemini Flash | gemini-3-flash-preview |
| Post-Call Analysis | Anthropic Claude Haiku 4.5 | claude-haiku-4-5-20251001 |
| STT | Deepgram Nova 3 | Telnyx L16/16k reaches STT as 16kHz PCM; language follows `familyInfo.donnaLanguage` (`en`/`es`) |
| TTS | ElevenLabs by default; Cartesia behind provider flag | Telnyx L16 calls use 16kHz PCM from TTS; optional Spanish voice IDs selected for Spanish calls |
| VAD | Silero | confidence=0.68, start_secs=0.3, stop_secs=1.2 |
| Embeddings | OpenAI | text-embedding-3-small |
| News / Web Search | OpenAI GPT-4o-mini + Tavily | OpenAI cached news; Tavily first/OpenAI fallback for in-call web_search |
| Telephony | Telnyx | Call Control + bidirectional media streams |
| Database | Neon PostgreSQL | pgvector extension |
| Server (Python) | FastAPI + uvicorn | v0.115+ |
| Server (Node.js) | Express | — |
| Monitoring | Sentry | FastAPI integration |
| Deployment | Railway | Docker (python:3.12-slim) |
| Website/Admin Frontends | React + Vite + Tailwind | Vercel |
| Mobile App | Expo SDK 54 + React Native + Clerk | EAS/TestFlight/App Store, bundle ID `com.donna.caregiver` |

---

## Key File Map

```
pipecat/
├── main.py                     ← Server entry, /health, /ws, middleware, graceful shutdown
├── bot.py                      ← Pipeline assembly, LOAD_TEST_MODE swap
├── config.py                   ← All env vars centralized (frozen dataclass + lru_cache)
├── prompts.py                  ← System prompts + phase task instructions
├── flows/
│   ├── nodes.py                ← 4 call phase NodeConfigs
│   └── tools.py                ← 3 active subscriber-call Claude tools + retired handlers; onboarding exposes web_search only
├── processors/
│   ├── patterns.py             ← active companion-call regex patterns plus legacy inactive tables
│   ├── quick_observer.py       ← Layer 1: regex analysis + goodbye EndFrame
│   ├── conversation_director.py← Layer 2: Groq speculative guidance + memory/news injection
│   ├── conversation_tracker.py ← Topic/question/advice tracking
│   ├── guidance_stripper.py    ← Strip <guidance> tags from output
│   └── metrics_logger.py       ← Call metrics logging
├── services/
│   ├── scheduler.py            ← Pipecat-side scheduling helpers; Node scheduler is active
│   ├── post_call.py            ← Post-call: analysis, memory, cleanup, snapshot rebuild
│   ├── director_llm.py         ← Groq Director analysis + Gemini fallback helper
│   ├── memory.py               ← Semantic memory (pgvector, decay, dedup)
│   ├── prefetch.py             ← Predictive Context Engine (memory prefetch)
│   ├── news.py                 ← Cached news + live web_search provider fallback
│   ├── call_snapshot.py        ← Pre-computed call context snapshot
│   ├── context_cache.py        ← Pre-cache at 5 AM local + news persistence
│   └── ...                     ← 8+ additional service modules
├── api/
│   ├── routes/                 ← telnyx.py, call_context.py, calls.py, auth.py, metrics.py, export.py, data.py
│   ├── middleware/             ← auth, api_auth, rate_limit, security, error_handler
│   └── validators/schemas.py   ← Pydantic input validation
├── db/client.py                ← asyncpg pool + slow query logging
├── lib/
│   ├── circuit_breaker.py      ← Async circuit breaker (3 states)
│   ├── redis_client.py         ← Redis/InMemory shared state
│   ├── growthbook.py           ← GrowthBook feature flags
│   └── sanitize.py             ← PII-safe logging
└── tests/                      ← unit, regression, integration, and scenario tests
```
