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
              │   Quick Observer     │  Layer 1 (0ms): 250+ regex patterns
              │   (BLOCKING)         │  Injects guidance via LLMMessagesAppendFrame
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

**Key mechanism**: Both Quick Observer and Director inject guidance into Claude's context via `LLMMessagesAppendFrame(run_llm=False)`. Guidance appears as user-role messages before the next LLM call.

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
- **Method**: 250+ regex patterns across 19 categories (health, goodbye, emotion, cognitive, activity, etc.)
- **Output**: Injects guidance for the current turn
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
| **Reminder** *(conditional)* | mark_reminder_acknowledged, transition_to_main | APPEND, respond_immediately | After reminders delivered |
| **Main** | web_search, mark_reminder_acknowledged, transition_to_winding_down | APPEND | Natural wind-down or Director force |
| **Winding Down** | mark_reminder_acknowledged, transition_to_closing | APPEND | Closing cue or Director force |
| **Closing** | *(none — post_action: end_conversation)* | APPEND | Auto-end |

### LLM Tools (2 active)
1. **web_search** — In-call factual search via Tavily first, OpenAI fallback.
2. **mark_reminder_acknowledged** — Track reminder delivery status.

Retired handlers remain in `pipecat/flows/tools.py` for Gemini/future work, but `make_flows_tools()` exposes only the two active tools above. Memory and caregiver-note context is prefetched/injected instead of exposed as Claude tools.

### Senior Context Assembly

`pipecat/flows/nodes.py:_build_senior_context()` builds the senior-specific prompt context before the call flow starts. It includes:

- Current local date/time from the senior's IANA timezone
- Name and city/state profile context
- English/Spanish call-language instruction from `familyInfo.donnaLanguage`
- Date-of-birth derived age and birthday awareness from `familyInfo.dateOfBirth`
- Interest IDs plus caregiver/AI detail text from `familyInfo.interestDetails`
- Additional caregiver context from `seniors.additional_info`
- Topics to avoid from `familyInfo.topicsToAvoid`, falling back to `preferred_call_times.topicsToAvoid` for onboarding-created rows
- Health notes, memory context, recent turns, last-call follow-ups, and today's same-day context

Prompt context events are recorded through `services.context_trace` without logging raw PHI to application logs.

---

## Post-Call Processing (`services/post_call.py`)

Runs after the telephony WebSocket disconnects, parallelized with `asyncio.gather`:

```
Step 1: Complete conversation (prerequisite) ───────── sequential
    │
    ├── Step 2: Call analysis (Gemini Flash)  ─────┐
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
                       │ services/         │ acquires guard, dials Telnyx,
  scheduler.js tick ──►│ scheduler.js      │ records call_attempt (architecture=legacy)
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

**Modes (`CALL_ARCHITECTURE_MODE`):**

| Mode | Legacy dials | Queue inserts | Queue dispatches | Real queue dial |
|---|---|---|---|---|
| `legacy_only` | yes (no guard) | no | no | no |
| `shadow_materialize` | yes (guarded) | yes | no | no |
| `shadow_dispatch` | yes (guarded) | yes | dry-run lease + comparison | no |
| `canary_queue` | yes (non-canary, guarded) | yes | leases canary cohort | yes (requires `CALL_QUEUE_ALLOW_REAL_DIAL=true` + cohort selector) |
| `queue_primary` | no | yes | leases everything | yes |
| `legacy_rollback` | yes (guarded) | yes (for visibility) | no | no |

**Dial-authority guard.** `outbound_call_guards.guard_key` is `INSERT ... ON CONFLICT DO NOTHING`-protected. Both paths build the same guard key from `(callType, seniorId, scheduleOrReminderId, targetAt)` and race for it; the loser suppresses its dial. The transition `active → initiating` happens inside the transaction that issues the Telnyx call, after rechecking senior `is_active` and `deleted_at` (closes the senior-delete race).

**Materializer is canary-blind by design.** All due schedules materialize into `call_queue` regardless of cohort. Canary selection happens at dispatch time via `canaryPercent` + `canarySeniorIds`; the legacy scheduler removes canary seniors from its own plan in `canary_queue` mode so the guard mediates only between cohorts that should converge.

**Capacity coordination.** `pipecat/services/capacity.py` publishes per-replica heartbeats every 5s to `pipecat:instance:{id}` with a 15s TTL. `services/pipecat-capacity.js` reads via Redis → Upstash REST → local fallback. The dispatcher computes available slots per instance and respects lane reserves (`reminders`, `manual`, `scheduled`, `inbound`) before issuing leases.

**Reconciler.** `reconcileQueueLeases` recovers expired `call_queue` leases and expires overdue queued rows past `latest_at`. `outbound_call_guards` rows store `expires_at` but the queue-side reconciler does not yet release stale guards on its own — that is a tracked Phase 4 follow-up (see [plan §3 Phase 4](../plans/2026-05-18-scale-to-2000-users-technical-plan.md) work item 6).

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
| `call_queue` | Durable outbound dispatch queue with `FOR UPDATE SKIP LOCKED` leasing | unique `dedupe_key`, `(status, priority DESC, run_after)` |
| `call_attempts` | Per-dispatch attempt audit trail with architecture/cohort/test_run_id | `(queue_id, attempt_number)` unique, `call_control_id` unique where not null |
| `post_call_jobs` | Queued post-call work with attempt counts and leases | `dedupe_key` unique, `(status, priority DESC, run_after)` |
| `outbound_call_guards` | **Dial-authority guard** shared by legacy + queue paths; only one path may dial per `guard_key` | unique `guard_key`, status `active → initiating → completed/cancelled` |
| `scheduler_shadow_comparisons` | Side-by-side legacy/queue decision audit during shadow rollout | senior_id, decided_at |

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Voice Pipeline | Pipecat | v0.0.101+ |
| Call State Machine | Pipecat Flows | v0.0.22+ |
| Primary LLM | Anthropic Claude Haiku 4.5 | claude-haiku-4-5-20251001 |
| Director LLM (active fast path) | Groq | gpt-oss-20b |
| Director LLM (regular fallback helper) | Google Gemini Flash | gemini-3-flash-preview |
| Post-Call Analysis | Google Gemini Flash | gemini-3-flash-preview |
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
│   └── tools.py                ← 2 active Claude tools + retired handlers
├── processors/
│   ├── patterns.py             ← 250+ regex patterns, 19 categories
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
