# Donna Architecture Overview

This document describes Donna's current `zuludev` architecture with the **Pipecat voice pipeline**, **Conversation Director** (Groq fast path, Gemini fallback for non-speculative analysis), **Predictive Context Engine** (memory prefetch), **Pipecat Flows** call state machine, and the in-progress scale architecture.

Donna has **two outbound-call architectures right now**:

- **Legacy architecture:** `services/scheduler.js` remains deployed as the current/rollback dial authority. It plans due calls in a Node scheduler loop, relies on in-process dedupe for several scheduling decisions, dials through Pipecat `/telnyx/outbound`, and leaves post-call analysis inline in Pipecat.
- **New scale architecture:** the queue/capacity path in `services/call-queue.js`, `services/call-schedules.js`, `services/pipecat-capacity.js`, `pipecat/services/capacity.py`, `services/post-call-jobs.js`, and `services/phase8-autoscaler.js` is the path to the **2,000-user burst target**. It uses durable queue rows, Postgres leases and dial guards, Redis capacity heartbeats/reservations, canary cohorts, and pre-window replica planning. It is still gated by rollout flags until the production cutover.

The documented **10,000-user path** is forward work built on the new queue architecture, not a completed runtime. See [the scale plan §8](../plans/2026-05-18-scale-to-2000-users-technical-plan.md#8-forward-path-to-10000-users) and [Scalability](SCALABILITY.md).

> For detailed Pipecat implementation specifics, see [pipecat/docs/ARCHITECTURE.md](../../pipecat/docs/ARCHITECTURE.md).

---

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | System architecture: pipeline, two-backend design, database schema, tech stack |
| [Features](FEATURES.md) | Complete product feature inventory with special optimizations |
| [Security](SECURITY.md) | Authentication, rate limiting, input validation, PII protection, security headers |
| [Scalability](SCALABILITY.md) | Legacy vs queue scale status, 2,000-user target, Redis/capacity, 10k path |
| [Cost](COST.md) | Per-call cost breakdown, infrastructure costs, optimization strategies |
| [Testing](TESTING.md) | 3-level test architecture, load testing, regression scenarios, mock infrastructure |
| [Performance](PERFORMANCE.md) | Pipeline latency, predictive prefetch, circuit breakers, graceful shutdown |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│              DONNA — PIPECAT VOICE PIPELINE                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│   │  Admin Dashboard │  │ Website/Mobile  │  │  Observability  │            │
│   │  apps/admin-v2/  │  │ apps/website +  │  │   Dashboard     │            │
│   │                  │  │ apps/mobile     │  │                 │            │
│   └────────┬─────────┘  └────────┬────────┘  └────────┬────────┘            │
│            │                     │                     │                     │
│            ▼                     ▼                     ▼                     │
│   ┌──────────────────────────────────────────────────────────────┐          │
│   │                  Node.js API (Railway)                        │          │
│   │    routes/ — frontend APIs, health, waitlist                 │          │
│   │    services/scheduler.js — legacy plan + dual-write to queue │          │
│   │    services/call-queue.js — durable dispatcher (Phase 2+)    │          │
│   │    services/pipecat-capacity.js — cross-replica capacity read│          │
│   │    services/post-call-jobs.js — Phase 6 job DAG + dead letter│          │
│   │    services/phase8-autoscaler.js — Phase 8 Railway actuator  │          │
│   │    services/canary-cohort.js — Phase 7 cohort membership     │          │
│   └──────────────────────────────────────────────────────────────┘          │
│                                                                              │
│   ┌──────────────┐                                                          │
│   │ Senior's     │                                                          │
│   │ Phone        │                                                          │
│   └──────┬───────┘                                                          │
│          │                                                                   │
│          ▼                                                                   │
│   ┌──────────────────────────────────────────────────────────┐              │
│   │              Telnyx Voice API                              │              │
│   │         /telnyx/events + media fork → /ws                  │              │
│   └────────────────────┬─────────────────────────────────────┘              │
│                        │ WebSocket                                           │
│                        ▼                                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    Pipecat Pipeline (bot.py)                         │   │
│   ├─────────────────────────────────────────────────────────────────────┤   │
│   │                                                                      │   │
│   │   Audio In → Deepgram STT (Nova 3, internal 16kHz PCM)                │   │
│   │                     │ TranscriptionFrame                             │   │
│   │                     ▼                                                │   │
│   │         ┌───────────────────────┐                                    │   │
│   │         │  Layer 1: Quick       │  0ms — BLOCKING                    │   │
│   │         │  Observer             │  250+ regex patterns               │   │
│   │         │                       │  Injects guidance for THIS turn    │   │
│   │         │                       │  Goodbye → EndFrame                │   │
│   │         └───────────┬───────────┘                                    │   │
│   │                     ▼                                                │   │
│   │         ┌───────────────────────┐  ┌─────────────────────────┐      │   │
│   │         │  Layer 2: Conversation│─►│ Groq fast path          │      │   │
│   │         │  Director             │  │ Gemini fallback helper  │      │   │
│   │         │  (PASS-THROUGH)       │  │ asyncio.create_task     │      │   │
│   │         │                       │  │ Same-turn (speculative) │      │   │
│   │         │  Injects guidance +   │  │ or prev-turn (fallback) │      │   │
│   │         │  dynamic news context │  │ + predictive prefetch   │      │   │
│   │         │                       │  │ + memory prefetch       │      │   │
│   │         │                       │  │ + force end at 9/12min  │      │   │
│   │         └───────────┬───────────┘  └─────────────────────────┘      │   │
│   │                     │ (0-500ms memory gate)                         │   │
│   │                     ▼                                                │   │
│   │         Context Aggregator (user) ← builds LLM context              │   │
│   │                     ▼                                                │   │
│   │         Claude Haiku 4.5 + FlowManager (2 active tools)             │   │
│   │         (conditional reminder → main → winding_down → closing)      │   │
│   │                     │ TextFrame                                      │   │
│   │                     ▼                                                │   │
│   │         Guidance Stripper (strips <guidance> + [BRACKETED])          │   │
│   │                     ▼                                                │   │
│   │         Conversation Tracker (topics + stripped transcript)          │   │
│   │                     ▼                                                │   │
│   │         TTS 16kHz PCM → Audio Out → Telnyx (16kHz L16)               │   │
│   │                     ▼                                                │   │
│   │         Context Aggregator (assistant) ← tracks responses            │   │
│   │                                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                        │                                                     │
│                        ▼ (on disconnect)                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │              Post-Call Processing (services/post_call.py)             │   │
│   │              1. Complete conversation record (DB)                     │   │
│   │              2. Call analysis — Gemini Flash (summary, engagement)   │   │
│   │              3. Interest discovery + scores                           │   │
│   │              4. Memory extraction — OpenAI (facts, preferences)      │   │
│   │              5. Daily context — cross-call same-day memory            │   │
│   │              6. Reminder cleanup + cache clearing                     │   │
│   │              7. Snapshot rebuild — pre-compute context for next call  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                        Shared Services                                │  │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│   │  │ Memory System │  │   Scheduler  │  │  News Service│               │  │
│   │  │ (pgvector)    │  │  (reminders) │  │ (OpenAI web) │               │  │
│   │  │ + HNSW index  │  │  + prefetch  │  │  + 1hr cache │               │  │
│   │  │ + decay/dedup │  │              │  │              │               │  │
│   │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│   │  │ Daily Context │  │ Context Cache│  │  Caregivers  │               │  │
│   │  │ (cross-call)  │  │ (5 AM local) │  │ + notes      │               │  │
│   │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│   │  ┌──────────────┐  ┌──────────────┐                                 │  │
│   │  │Circuit Breaker│  │Feature Flags │                                 │  │
│   │  │(Groq, Gemini, │  │ (GrowthBook) │                                 │  │
│   │  │ OAI, news)    │  │              │                                 │  │
│   │  └──────────────┘  └──────────────┘                                 │  │
│   └────────────────────────────────────┬─────────────────────────────────┘  │
│                                        ▼                                     │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                     PostgreSQL (Neon + pgvector)                      │  │
│   │  seniors | conversations | memories | reminders | reminder_deliveries │  │
│   │  caregivers | caregiver_notes | call_analyses | daily_call_context    │  │
│   │  notifications | audit_logs | waitlist | admin_users                  │  │
│   │  Queue layer (Phase 1): senior_call_schedules | call_queue            │  │
│   │  call_attempts | post_call_jobs | outbound_call_guards                │  │
│   │  scheduler_shadow_comparisons                                         │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2-Layer Observer Architecture

| Layer | File | Model | Latency | Purpose |
|-------|------|-------|---------|---------|
| **1** | `processors/quick_observer.py` + `processors/patterns.py` | Regex | 0ms | Companion-call signals: goodbye, emotion, family, activity + programmatic call end after configured delay |
| **2** | `processors/conversation_director.py` + `services/director_llm.py` | Groq fast path, Gemini fallback helper | Non-blocking | Same-turn/previous-turn guidance, memory prefetch, news injection |

### Post-Call Analysis (Async)

| Process | File | Model | Trigger | Output |
|---------|------|-------|---------|--------|
| Call Analysis | `services/call_analysis.py` | Gemini 3 Flash Preview | Call ends | Summary, engagement score, mood, caregiver takeaways |
| Interest Discovery | `services/interest_discovery.py` | Rule/category mapping over analysis output | After call analysis | New interest categories, editable interest details, engagement scores |
| Memory Extraction | `services/memory.py` | OpenAI GPT-4o-mini | Call ends | Facts, preferences, events stored with embeddings |

---

## Conversation Director (Layer 2)

The Director runs **non-blocking** via `asyncio.create_task()`. The active speculative/query path uses Groq; `director_llm.py` also has a Gemini Flash fallback for regular non-speculative analysis.

1. **Per-turn analysis** — Calls Groq with conversation context + senior location + date
2. **Speculative analysis** — Starts during silence gaps (250ms) for same-turn guidance injection
3. **Cached injection** — Same-turn (speculative hit) or previous-turn guidance as `[Director guidance]` message
4. **Dynamic news** — Injects news context when `should_mention_news` is signaled (one-shot per call)
5. **Predictive prefetch** — 2-wave memory prefetch based on raw/interim transcript and Query Director memory queries
6. **Fallback actions** — Force winding-down at 9min, force call end at 12min
7. **Goodbye suppression** — Skips guidance injection when Quick Observer detects goodbye

### Director Output Schema

```json
{
  "analysis": {
    "call_phase": "opening|rapport|main|winding_down|closing",
    "engagement_level": "high|medium|low",
    "current_topic": "string",
    "emotional_tone": "positive|neutral|concerned|sad",
    "turns_on_current_topic": 0
  },
  "direction": {
    "stay_or_shift": "stay|transition|wrap_up",
    "next_topic": "string or null",
    "should_mention_news": false,
    "news_topic": "string or null",
    "pacing_note": "good|too_fast|dragging|time_to_close"
  },
  "reminder": {
    "should_deliver": false,
    "which_reminder": "string or null",
    "delivery_approach": "how to weave in naturally"
  },
  "guidance": {
    "tone": "warm|empathetic|cheerful|gentle|serious",
    "priority_action": "main thing to do",
    "specific_instruction": "actionable guidance"
  },
  "prefetch": {
    "memory_queries": ["gardening", "grandson Jake"]
  }
}
```

### Quick Observer (Layer 1)

Quick Observer pattern categories:

| Category | Patterns | Effect |
|----------|----------|--------|
| **Emotion** | 25+ patterns with valence/intensity | Emotional tone detection |
| **Family** | 25+ relationship patterns including pets | Context enrichment |
| **Goodbye** | Explicit strong goodbye detection ("goodbye", "I gotta go", "talk to you later") | Schedules programmatic EndFrame only after the minimum call-age guard and goodbye audio delay |
| **Factual/Curiosity** | Question patterns ("what year", "how tall") | Direct-answer guidance |

---

## Pipecat Flows — Call Phases

| Phase | Tools | Context Strategy |
|-------|-------|-----------------|
| **Reminder** *(conditional)* | mark_reminder_acknowledged, transition_to_main | APPEND, respond_immediately |
| **Main** | web_search, mark_reminder_acknowledged, transition_to_winding_down | APPEND |
| **Winding Down** | mark_reminder_acknowledged, transition_to_closing | APPEND |
| **Closing** | *(none — post_action: end_conversation)* | APPEND |

---

## Tech Stack

| Component | Technology | Details |
|-----------|------------|---------|
| **Runtime** | Python 3.12 | asyncio, FastAPI |
| **Framework** | Pipecat v0.0.101+ | FrameProcessor pipeline |
| **Flows** | pipecat-ai-flows v0.0.22+ | 4-phase call state machine |
| **Hosting** | Railway | Docker (python:3.12-slim), port 7860 |
| **Phone** | Telnyx Voice API media streaming | WebSocket wire audio is 16kHz L16 |
| **Voice LLM** | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | AnthropicLLMService (prompt caching enabled) |
| **Director** | Groq (`gpt-oss-20b`) | Active fast provider for query/speculative guidance |
| **Director Fallback Helper** | Gemini 3 Flash Preview (`gemini-3-flash-preview`) | Regular non-speculative fallback in `director_llm.py` |
| **Post-Call** | Gemini 3 Flash Preview (`gemini-3-flash-preview`) | Summary, engagement, caregiver takeaways |
| **STT** | Deepgram Nova 3 (`nova-3-general`) | Real-time, interim results, 16kHz linear PCM; English/Spanish based on senior call language |
| **TTS** | ElevenLabs (`eleven_flash_v2_5`) by default; Cartesia behind provider flag | Telnyx calls use native 16kHz PCM from TTS; optional Spanish voice IDs for Spanish calls |
| **VAD** | Silero | confidence=0.68, start_secs=0.3, stop_secs=1.2, min_volume=0.5 |
| **Database** | Neon PostgreSQL + pgvector | asyncpg, connection pooling |
| **Embeddings** | OpenAI text-embedding-3-small | 1536 dimensions |
| **News / Web Search** | OpenAI GPT-4o-mini for cached news; Tavily first/OpenAI fallback for in-call web_search | 1hr cache for news/search results |

### Frontend Apps

| App | Tech | URL |
|-----|------|-----|
| **Admin Dashboard v2** | React 18 + Vite + Tailwind + Radix UI | [admin-v2-liart.vercel.app](https://admin-v2-liart.vercel.app) |
| **Website / caregiver web** | React 18 + Vite + Clerk + Framer Motion | [calldonna.co](https://calldonna.co) |
| **Mobile app** | Expo SDK 54 + React Native + Clerk | TestFlight/App Store build, bundle ID `com.donna.caregiver` |
| **Observability** | React 18 + Vite (vanilla CSS) | [observability-five.vercel.app](https://observability-five.vercel.app) |

---

## Key Files

```
pipecat/
├── main.py                          ← FastAPI entry point, /health, /ws, middleware
├── bot.py                           ← Pipeline assembly + run_bot() + _run_post_call()
├── flows/
│   ├── nodes.py                     ← 4 call phase NodeConfigs + system prompts
│   └── tools.py                     ← 2 active Claude tools + retired handlers
├── processors/
│   ├── patterns.py                  ← 250+ regex patterns, 19 categories
│   ├── quick_observer.py            ← Layer 1: analysis logic + goodbye EndFrame
│   ├── conversation_director.py     ← Layer 2: Groq speculative guidance + memory/news injection
│   ├── conversation_tracker.py      ← In-call topic/question/advice tracking
│   ├── metrics_logger.py            ← Call metrics logging processor
│   ├── goodbye_gate.py              ← False-goodbye grace period (NOT in active pipeline)
│   └── guidance_stripper.py         ← Strip <guidance> tags before TTS
├── services/
│   ├── director_llm.py              ← Groq Director analysis + Gemini fallback helper
│   ├── call_analysis.py             ← Post-call analysis (Gemini Flash)
│   ├── memory.py                    ← Semantic memory (pgvector, decay, dedup)
│   ├── scheduler.py                 ← Pipecat-side scheduling helpers; Node scheduler is active
│   ├── call_snapshot.py             ← Pre-computed call context snapshot
│   ├── context_cache.py             ← Pre-cache at 5 AM local + news persistence
│   ├── conversations.py             ← Conversation CRUD + transcripts
│   ├── daily_context.py             ← Cross-call same-day memory
│   ├── greetings.py                 ← Greeting templates + rotation
│   ├── interest_discovery.py        ← Interest extraction, category mapping, editable details
│   ├── seniors.py                   ← Senior profile CRUD + encrypted PHI fields
│   ├── caregivers.py                ← Caregiver relationships
│   └── news.py                      ← Cached news + live web_search provider fallback
├── api/
│   ├── routes/                      ← telnyx.py, call_context.py, calls.py
│   └── middleware/                   ← auth, api_auth, rate_limit, security
├── db/client.py                     ← asyncpg pool + query helpers
├── tests/                           ← unit, regression, integration, and scenario tests
├── pyproject.toml                   ← Python 3.12, dependencies
└── Dockerfile                       ← python:3.12-slim + uv
```

---

## Database Schema

### Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| **seniors** | User profiles | name, phone, timezone, interests, encrypted familyInfo/additionalInfo, call_settings (JSONB), call_context_snapshot (JSONB), cached_news (TEXT). Legacy medical-note columns are deprecated and nulled by migration 014/026. |
| **conversations** | Call records | callSid, encrypted transcript, duration, status, encrypted summary |
| **memories** | Long-term memory | content, type, importance, embedding (1536d, HNSW index) |
| **reminders** | Scheduled reminders | title, scheduledTime, isRecurring, type |
| **reminder_deliveries** | Delivery tracking | status, attemptCount, userResponse, callSid |
| **caregivers** | User-senior links | clerkUserId, seniorId, role |
| **caregiver_notes** | Notes from caregivers | content, is_delivered, delivered_at, call_sid |
| **call_analyses** | Post-call results | summary, engagementScore, mood, caregiver takeaways; legacy concerns/followUps remain empty for compatibility |
| **daily_call_context** | Same-day cross-call memory | seniorId, callDate, topicsDiscussed, remindersDelivered |
| **notifications** | Caregiver notification log | caregiverId, seniorId, eventType, channel |
| **waitlist** | Public waitlist signups | name, email, phone, whoFor |
| **audit_logs** | HIPAA audit events | userId, userRole, action, resourceType |
| **admin_users** | Admin dashboard accounts | email, passwordHash (bcrypt) |
| **senior_call_schedules** | Normalized runtime call schedules for queue architecture | seniorId, nextRunAt, priorityLane |
| **call_queue** | Durable outbound dispatch queue | status, priorityLane, targetAt, leaseOwner |
| **call_attempts** | Per-dispatch attempt audit trail | queueId, callControlId, architecture, cohort |
| **outbound_call_guards** | Shared legacy/queue dial-authority guard | guardKey, architecture, queueId, status |
| **scheduler_shadow_comparisons** | Shadow rollout decision comparison | legacyDecision, queueDecision, capacityDecision |
| **post_call_jobs** | Gated post-call job DAG and dead-letter queue | jobType, dependsOn, status, leaseOwner |
| **canary_cohort_membership** | Phase 7 queue canary membership | seniorId, rampPhase, removedAt |

### Memory System

- **Embedding**: OpenAI `text-embedding-3-small` (1536 dimensions)
- **Index**: HNSW (cosine_ops, m=16, ef_construction=64) — approximate nearest-neighbor
- **Similarity**: Cosine similarity, 0.7 minimum threshold
- **Deduplication**: Skip if cosine > 0.9 with existing memory
- **Decay**: Effective importance = `base * 0.5^(days/30)` (30-day half-life)
- **Access Boost**: +10 importance if accessed in last week
- **Tiered Retrieval**: Critical → Contextual → Background
- **Mid-Call Refresh**: After 5+ minutes, refresh context with current conversation topics
- **Circuit Breaker**: OpenAI embedding calls wrapped with 10s timeout + 3-failure threshold

---

## Infrastructure & Reliability

| Feature | Implementation | Details |
|---------|---------------|---------|
| **Circuit Breakers** | `lib/circuit_breaker.py` | Groq, Gemini, OpenAI embedding/news, Tavily |
| **Feature Flags** | `lib/growthbook.py` | GrowthBook SDK wrapper with defaults when unavailable |
| **Graceful Shutdown (Pipecat)** | `main.py` | Tracks active calls, drain flag in capacity heartbeat, websocket rejects new connections when draining |
| **Graceful Shutdown (Node)** | `index.js` | `setQueueDispatcherDraining(true)` + drain reservations up to `NODE_DISPATCHER_DRAIN_TIMEOUT_MS` |
| **Cross-Replica Capacity** | `pipecat/services/capacity.py` + `services/pipecat-capacity.js` | Heartbeats at `pipecat:instance:{id}`, 5s publish, 15s TTL |
| **Shared-State Fail-Closed** | `pipecat/lib/redis_client.py` | `PIPECAT_REQUIRE_REDIS=true` aborts startup if Redis missing; Upstash REST has 60s circuit-breaker on failure |
| **Distributed Rate Limit** | `pipecat/api/middleware/rate_limit.py` | SlowAPI uses Redis storage with `swallow_errors=False` when `REDIS_RATE_LIMITS_ENABLED=true` |
| **Enhanced /health** | `main.py` | Database + circuit breakers + shared-state status + draining flag |
| **Per-Senior Settings** | `seniors.call_settings` | JSONB column for time limits, greeting style, etc. |

---

## Outbound Dispatch — Dual-Path Rollout

The outbound call path is mid-migration from the legacy in-process Node scheduler to a durable Postgres-backed queue dispatcher. Both paths run simultaneously during rollout, gated by `CALL_ARCHITECTURE_MODE`, mediated by a shared dial-authority guard.

```
Scheduler tick (every 60s):
  legacy plan ─┬─► acquire outbound_call_guards row ─► Telnyx dial ─► record call_attempt (architecture=legacy)
               │
               └─► materialize each due call into call_queue (shadow_materialize and above)

Dispatcher tick (every N seconds, in same Node process):
  call_queue ──► FOR UPDATE SKIP LOCKED lease ──► acquire same guard ──► Telnyx dial ──► record call_attempt (architecture=queue)
                                                          │
                                                          └─► loses the race when legacy already holds the guard → suppress
```

Mode progression: `legacy_only` → `shadow_materialize` → `shadow_dispatch` → `canary_queue` → `queue_primary`. `legacy_rollback` is the emergency exit. See [`ARCHITECTURE.md`](ARCHITECTURE.md#outbound-call-dispatch--dual-path-rollout) for the full mode matrix and the consistency-model rule (Postgres decides *what*, Redis decides *what is running right now*).

**Out-of-band post-call (Phase 6 infra).** `services/post-call-jobs.js` defines an 8-job DAG (`metrics_finalize`, `reminder_recovery`, `analysis`, `memory_extraction`, `daily_context`, `caregiver_notifications`, `interest_discovery`, `snapshot_rebuild`) backed by the `post_call_jobs` queue. Per-provider semaphores keep `geminiFlash`/`openAiEmbeddings`/`resend` at concurrency 1 across the fleet; `db` lane runs at 200. Terminal failures move to `dead_letter` and are admin-replayable. Pipecat enqueues only when `POST_CALL_QUEUE_ENABLED=true`; the worker has no continuous loop yet and runs via the shadow script — inline `pipecat/services/post_call.py` remains the active path until the canary flip.

**Phase 7 canary + Phase 8 capacity actuator.** `services/canary-cohort.js` and `routes/canary.js` store the queue canary allowlist in `canary_cohort_membership`, with the env allowlist kept as an emergency fallback. `scripts/phase7-canary-report.js` produces the daily aggregate report for the 5→10→25 live canary. `scripts/phase8-capacity-plan.js` + `services/phase8-autoscaler.js` recommend and (optionally) apply Railway replica scaling for known call windows; dry-run by default. Admin override at `POST /api/scale-operations/phase8/override`. See [`ARCHITECTURE.md`](ARCHITECTURE.md#capacity-planning--autoscaling-phases-7-8) for the full surface.

**Path to 10,000 users.** The queue architecture is deliberately shaped so the next scale step is incremental rather than a rewrite: move hot operational tables to `ops.*` or hash/time partitioning when DB pressure appears, move Redis/shared state to a HA or multi-region topology when reliability or latency demands it, add caller-ID pool/reputation management when answer rate declines, add provider sharding/failover when vendor 429s appear, and promote the post-call DAG to Temporal/Inngest or equivalent if Postgres-only workers become the bottleneck. These are documented triggers, not implemented guarantees.

---

## Deployment

Three environments: **dev** (experiments), **staging** (CI), **production** (customers).

| Service | Platform | Port | URL |
|---------|----------|------|-----|
| Pipecat voice pipeline | Railway | 7860 | donna-pipecat-production.up.railway.app |
| Node.js API | Railway | 3001 | donna-api-production-2450.up.railway.app |
| Admin Dashboard | Vercel | — | admin-v2-liart.vercel.app |
| Website / caregiver web | Vercel | — | calldonna.co |
| Mobile app | EAS/TestFlight/App Store | — | com.donna.caregiver |
| Observability | Vercel | — | observability-five.vercel.app |
| Database | Neon | — | Managed PostgreSQL + pgvector (3 branches) |

**CI/CD:** PRs → tests → staging deploy → smoke tests. Push to main → production auto-deploy.

---

*Last updated: May 2026 — current Groq Director fast path, memory prefetch, GrowthBook feature flags, active-tool surface, and mobile onboarding cleanup*
