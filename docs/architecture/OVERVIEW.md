# Donna Architecture Overview

This document describes the Donna v5.3 system architecture with the **Pipecat voice pipeline**, **Conversation Director** (Groq fast path, Gemini fallback for non-speculative analysis), **Predictive Context Engine** (memory prefetch), **Pipecat Flows** call state machine, and **infrastructure reliability** features (circuit breakers, GrowthBook feature flags, graceful shutdown).

> For detailed Pipecat implementation specifics, see [pipecat/docs/ARCHITECTURE.md](../../pipecat/docs/ARCHITECTURE.md).

---

## Documentation Index

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | System architecture: pipeline, two-backend design, database schema, tech stack |
| [Features](FEATURES.md) | Complete product feature inventory with special optimizations |
| [Security](SECURITY.md) | Authentication, rate limiting, input validation, PII protection, security headers |
| [Scalability](SCALABILITY.md) | Admission control, DB indexes, connection pooling, leader election, Redis, rollout |
| [Cost](COST.md) | Per-call cost breakdown, infrastructure costs, optimization strategies |
| [Testing](TESTING.md) | 3-level test architecture, load testing, regression scenarios, mock infrastructure |
| [Performance](PERFORMANCE.md) | Pipeline latency, predictive prefetch, circuit breakers, graceful shutdown |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│              DONNA v5.3 — PIPECAT VOICE PIPELINE                            │
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
│   │    routes/ (17 files) — frontend APIs, health, waitlist      │          │
│   │    services/scheduler.js — active reminder polling           │          │
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
│   │              2. Call analysis — Gemini Flash (summary, concerns)     │   │
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
│   └──────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2-Layer Observer Architecture

| Layer | File | Model | Latency | Purpose |
|-------|------|-------|---------|---------|
| **1** | `processors/quick_observer.py` + `processors/patterns.py` | Regex | 0ms | 250+ patterns: health, goodbye, emotion, safety + programmatic call end after configured delay |
| **2** | `processors/conversation_director.py` + `services/director_llm.py` | Groq fast path, Gemini fallback helper | Non-blocking | Same-turn/previous-turn guidance, memory prefetch, news injection |

### Post-Call Analysis (Async)

| Process | File | Model | Trigger | Output |
|---------|------|-------|---------|--------|
| Call Analysis | `services/call_analysis.py` | Gemini 3 Flash Preview | Call ends | Summary, concerns, engagement score, follow-ups |
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
| **Health** | 30+ patterns (pain, falls, medication, symptoms) | Health signals in context |
| **Emotion** | 25+ patterns with valence/intensity | Emotional tone detection |
| **Family** | 25+ relationship patterns including pets | Context enrichment |
| **Safety** | Scams, strangers, emergencies | Safety concern flags |
| **Goodbye** | Explicit strong goodbye detection ("goodbye", "I gotta go", "talk to you later") | Schedules programmatic EndFrame only after the minimum call-age guard and goodbye audio delay |
| **Factual/Curiosity** | Question patterns ("what year", "how tall") | Direct-answer guidance |
| **Cognitive** | Confusion, repetition, time disorientation | Cognitive signals |

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
| **Post-Call** | Gemini 3 Flash Preview (`gemini-3-flash-preview`) | Summary, concerns, engagement |
| **STT** | Deepgram Nova 3 (`nova-3-general`) | Real-time, interim results, 16kHz linear PCM; English/Spanish based on senior call language |
| **TTS** | ElevenLabs (`eleven_flash_v2_5`) by default; Cartesia behind provider flag | Telnyx calls use native 16kHz PCM from TTS; optional Spanish voice IDs for Spanish calls |
| **VAD** | Silero | confidence=0.6, stop_secs=1.2, min_volume=0.5 |
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
├── tests/                           ← 61 test files + helpers/mocks/scenarios
├── pyproject.toml                   ← Python 3.12, dependencies
└── Dockerfile                       ← python:3.12-slim + uv
```

---

## Database Schema

### Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| **seniors** | User profiles | name, phone, timezone, interests, encrypted familyInfo/additionalInfo/medicalNotes, call_settings (JSONB), call_context_snapshot (JSONB), cached_news (TEXT) |
| **conversations** | Call records | callSid, encrypted transcript, duration, status, encrypted summary |
| **memories** | Long-term memory | content, type, importance, embedding (1536d, HNSW index) |
| **reminders** | Scheduled reminders | title, scheduledTime, isRecurring, type |
| **reminder_deliveries** | Delivery tracking | status, attemptCount, userResponse, callSid |
| **caregivers** | User-senior links | clerkUserId, seniorId, role |
| **caregiver_notes** | Notes from caregivers | content, is_delivered, delivered_at, call_sid |
| **call_analyses** | Post-call results | summary, engagementScore, concerns, followUps |
| **daily_call_context** | Same-day cross-call memory | seniorId, callDate, topicsDiscussed, remindersDelivered |
| **notifications** | Caregiver notification log | caregiverId, seniorId, eventType, channel |
| **waitlist** | Public waitlist signups | name, email, phone, whoFor |
| **audit_logs** | HIPAA audit events | userId, userRole, action, resourceType |
| **admin_users** | Admin dashboard accounts | email, passwordHash (bcrypt) |

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
| **Graceful Shutdown** | `main.py` | Tracks active calls, 7s drain on SIGTERM |
| **Enhanced /health** | `main.py` | Database connectivity + circuit breaker states |
| **Per-Senior Settings** | `seniors.call_settings` | JSONB column for time limits, greeting style, etc. |

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

*Last updated: May 2026 — v5.3 with Groq Director fast path, memory prefetch, GrowthBook feature flags, updated active-tool surface, and mobile onboarding cleanup*
