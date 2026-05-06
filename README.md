# Donna - AI Senior Companion

AI-powered companion that provides elderly individuals with friendly phone conversations via real-time voice AI.

## Features

### Voice Pipeline (Pipecat)
- **2-Layer Conversation Director Architecture**
  - Layer 1: Quick Observer (0ms) — 250+ regex patterns across health, emotion, safety, goodbye, and other categories
  - Layer 2: Conversation Director — non-blocking Groq fast path with Gemini fallback for non-speculative analysis
  - Post-Call Analysis — Summary, concerns, engagement score (Gemini Flash)
- **Pipecat Flows** — conditional reminder phase, main, winding_down, closing, plus onboarding flows
- **2 Active LLM Tools** — web_search and mark_reminder_acknowledged
- **Director-First Memory Architecture** — Memory search and caregiver notes moved from Claude tool calls to prefetch/context injection
- **Programmatic Call Ending** — Goodbye detection → EndFrame after configured delay, 5s by default (bypasses unreliable LLM tool calls)
- **Director Fallback Actions** — Force winding-down at 9min, force call end at 12min
- **Predictive Context Engine** — Speculative memory prefetch with 2-wave pipeline:
  - 1st wave: raw/interim utterance extraction → background memory search (~0ms added latency)
  - 2nd wave: Query Director analysis → anticipatory memory prefetch
  - Interim transcription prefetch while user speaks (debounced)
  - Proactive memory injection (~0ms hit vs 200-300ms memory search)
- **Director-Driven News Injection** — News context injected dynamically when Director signals relevance (saves ~300 tokens/turn vs static system prompt)
- **Barge-in support** — Interrupt detection via Silero VAD

### Core Capabilities
- Real-time voice calls (Telnyx Voice API → Pipecat WebSocket)
- Speech transcription (Deepgram Nova 3)
- LLM responses (Claude Haiku 4.5 via Pipecat AnthropicLLMService, prompt caching enabled)
- Text-to-speech (ElevenLabs by default; Cartesia remains an evaluation-only provider flag; active Telnyx calls use 16kHz PCM)
- English/Spanish Donna call language support (caregiver-selected; switches STT language, prompt instruction, and optional Spanish TTS voice)
- Rich senior profile context in calls: local timezone, age/birthday awareness, interest descriptions, caregiver-provided additional context, and topics to avoid
- Semantic memory with decay + deduplication (pgvector + HNSW index)
- Full in-call context retention (APPEND strategy, no summary truncation)
- Cross-call turn history (recent turns from previous calls in system prompt)
- In-call memory tracking (topics, questions, advice per call)
- Mid-call memory refresh (after 5+ minutes, refreshes context with current topics)
- Same-day cross-call memory (timezone-aware daily context + call summaries)
- Sentiment-aware greetings (uses last call's engagement/rapport for tone)
- News via OpenAI web search (1hr cache, Director-driven injection)
- In-call web search via Claude `web_search` tool (Tavily first, OpenAI fallback)
- Scheduled reminder calls with delivery tracking
- Call context snapshot (pre-computed JSONB, eliminates 6 DB queries per call)
- Context + news pre-caching at 5 AM local time
- Caregiver notes delivery (family can leave notes read during calls)
- AI interest discovery maps post-call topics to predefined mobile interest categories and saves editable interest details
- Per-senior profile and call settings (timezone, language, birthday, interests, time limits, greeting style, memory decay)
- 2 active LLM tools: web_search and mark_reminder_acknowledged (fire-and-forget)
- Ephemeral context model (Director injections stripped each turn, prevents prompt bloat)

### Infrastructure & Reliability
- Circuit breakers for external services (Groq, Gemini, OpenAI embeddings/news, Tavily)
- GrowthBook feature flags with default fallback behavior
- Graceful shutdown with active call tracking (7s drain on SIGTERM)
- Enhanced /health endpoint (database + circuit breaker states)
- Multi-environment workflow (dev/staging/production with Neon branching)

### Frontend Apps
- **Admin Dashboard v2** — React + Vite + Tailwind ([admin-v2-liart.vercel.app](https://admin-v2-liart.vercel.app))
- **Public Website** — Marketing, signup, legal pages, and caregiver dashboard ([calldonna.co](https://calldonna.co))
- **Mobile App** — Expo + React Native caregiver app (`apps/mobile`, bundle ID `com.donna.caregiver`)
- **Observability Dashboard** — Live call monitoring ([observability-five.vercel.app](https://observability-five.vercel.app))

### Security
- JWT admin authentication + Cofounder API keys
- Labeled service API key authentication (`DONNA_API_KEYS`; legacy `DONNA_API_KEY` only outside production)
- Telnyx webhook signature verification plus single-use WebSocket token validation
- Rate limiting in Node and Pipecat middleware
- Security headers (HSTS, X-Frame-Options)
- Zod/Pydantic input validation

## Quick Start

### Local Bootstrap

```bash
npm ci
npm run install:apps
cd pipecat && uv sync && cd ..
cp apps/mobile/.env.example apps/mobile/.env
```

Set `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in `apps/mobile/.env` before running the mobile app. The mobile client no longer falls back to production when either value is missing.

### Railway-First Development

Voice and API features are developed directly against Railway — not localhost. Three isolated environments: dev, staging, production.

```bash
# Deploy to dev environment (fast iteration)
make deploy-dev-pipecat      # Just Pipecat (~30s)
make deploy-dev              # Both services (~60s)

# Test with a real call to the current dev Telnyx number.
# Confirm the number in Railway/Telnyx and use only an approved dummy/consenting test phone.
# Check logs
make logs-dev
```

Test health:
```bash
make health-dev
# or: curl https://donna-pipecat-dev.up.railway.app/health
```

**Unit tests** (pure logic, no external services):
```bash
make test                    # All tests (Python + Node.js)
make test-python             # Pipecat only
make test-regression         # Scenario-based regression tests
```

**Frontend E2E tests** (Playwright across admin, website/consumer, and observability):
```bash
npx playwright install chromium  # First time only
npm run test:e2e                 # Run all (~15s)
npm run test:e2e:admin           # Admin dashboard only
npm run test:e2e:website         # Public website only
npx playwright test --ui         # Interactive debug mode
```

See [`docs/guides/FRONTEND_TESTING.md`](docs/guides/FRONTEND_TESTING.md) for full guide.

**Frontend apps** (run locally against a configured dev/mock API; do not default tests or local clients to production Railway APIs):
- Admin dashboard: `cd apps/admin-v2 && npm run dev` → http://localhost:5175
- Public website and caregiver web app: `cd apps/website && npm run dev` → http://localhost:5174
- Observability: `cd apps/observability && npm run dev` → http://localhost:3002
- Mobile app: `cd apps/mobile && npm run ios` after setting `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in `apps/mobile/.env`

**Mobile checks**:
```bash
cd apps/mobile
npm run test:unit
npm run test:auth-guard
npm run verify:assets
npx tsc --noEmit
maestro check-syntax .maestro/subflows/sign_in.yaml
```

Fresh mobile onboarding must start from the visible Create Account screen. A Clerk session with no Donna profile is treated as incomplete setup, cleaned up through the Node API, signed out locally, and returned to landing. Maestro flow `10_onboarding_full.yaml` covers successful setup; `12_incomplete_account_cleanup.yaml` and `13_leave_setup_cleanup.yaml` cover abandoned setup and explicit leave-setup cleanup.

## Architecture

### Pipecat Voice Pipeline (bot.py)

Linear pipeline of `FrameProcessor`s. The Conversation Director is **non-blocking for LLM analysis** — Groq/Gemini work runs in background tasks, while final transcripts may briefly wait for the memory prefetch cache before Claude responds.

```
Phone Call → Telnyx → WebSocket → Pipecat Pipeline
                                       │
                                  Deepgram STT (Nova 3)
                                       │ TranscriptionFrame
                                       ▼
                             ┌─────────────────────┐
                             │   Quick Observer     │  Layer 1 (0ms, BLOCKING)
                             │   250+ regex patterns│  Injects guidance for THIS turn
                             │                      │  Goodbye → EndFrame
                             └─────────┬───────────┘
                                       │
                                       ▼
                             ┌─────────────────────┐   ┌───────────────────────┐
                             │   Conversation       │──►│ Two Background Paths:  │
                             │   Director           │   │                        │
                             │   (PASS-THROUGH)     │   │ 1. Query Director      │
                             │                      │   │    (~200ms, continuous) │
                             │ • Strips ephemeral   │   │    memory queries      │
                             │   context each turn  │   │                        │
                             │ • Injects guidance   │   │ 2. Guidance Director   │
                             │ • Injects memories   │   │    (~400ms, on silence)│
                             │                      │   │    same-turn guidance  │
                             │                      │   │                        │
                             │                      │   │ + Memory prefetch      │
                             │                      │   └───────────────────────┘
                             └─────────┬───────────┘
                                       │ (0-500ms memory gate)
                                       ▼
                             Context Aggregator (user)
                                       ▼
                             Claude Haiku 4.5 + Pipecat Flows (2 tools)
                                       │ TextFrame
                                       ▼
                             Guidance Stripper → Conversation Tracker
                                       ▼
                             TTS 16kHz PCM → Telnyx Audio Out (L16)
                                       │
                                       ▼ (on disconnect)
                             Post-Call: Analysis + Interest Discovery + Memory + Daily Context
```

### Split Director Architecture

The Director is split into two specialized Groq calls for optimal latency:

| Director | Latency | Fires | Purpose |
|----------|---------|-------|---------|
| **Query Director** | ~200ms | Continuously on interims (45 chars first, 60+25 re-fire) | Extract `memory_queries` |
| **Guidance Director** | ~400ms | On 250ms silence (speculative) | Phase, engagement, reminders, guidance |

Both run non-blocking via `asyncio.create_task()`. The Query Director feeds memory prefetch only; in-call factual questions go through Claude's active `web_search` tool.

| Feature | Description |
|---------|-------------|
| **Ephemeral Context** | All injections tagged `[EPHEMERAL:`, stripped each turn (prevents prompt bloat) |
| **Web Search** | Claude `web_search` tool → Tavily raw snippets → OpenAI fallback |
| **Memory Injection** | Prefetched memories injected as ephemeral context (500ms gate) |
| **Same-Turn Guidance** | Silence-based speculative enables guidance before Claude responds |
| **Goodbye Suppression** | `_goodbye_in_progress` flag skips all Director injection during goodbye |
| **Time-Based Fallbacks** | Force winding-down at 9min, force end at 12min |
| **Predictive Prefetch** | Raw utterance first-wave + Query Director second-wave memory prefetch |

See [`pipecat/docs/LEARNINGS.md`](pipecat/docs/LEARNINGS.md) for engineering learnings and debugging insights.

## Architecture Decision: Two Backends

Donna runs two backend services by design — each owns a clear responsibility:

- **Pipecat (Python, Railway:7860)** — Real-time voice pipeline (STT, Observer, Director, Claude, TTS)
- **Node.js (Express, Railway:3001)** — REST APIs for frontends, reminder scheduler, call initiation

Both share the same Neon PostgreSQL database.

## Project Structure

```
pipecat/                                # Voice pipeline (Python, Railway port 7860)
├── main.py                             # FastAPI entry point, /health, /ws
├── bot.py                              # Pipeline assembly + run_bot()
├── config.py                           # All env vars centralized
├── prompts.py                          # System prompts + phase instructions
├── flows/
│   ├── nodes.py                        # 4 call phase NodeConfigs
│   └── tools.py                        # 2 active Claude tools + retired handlers
├── processors/
│   ├── patterns.py                     # 250+ regex patterns, 19 categories
│   ├── quick_observer.py               # Layer 1: analysis + goodbye EndFrame
│   ├── conversation_director.py        # Layer 2: Groq speculative guidance + memory/news injection
│   ├── conversation_tracker.py         # Topic/question/advice tracking
│   ├── metrics_logger.py              # Call metrics logging
│   ├── goodbye_gate.py                 # False-goodbye grace period (not in active pipeline)
│   └── guidance_stripper.py            # Strip <guidance> tags before TTS
├── services/
│   ├── post_call.py                    # Post-call orchestration + snapshot rebuild
│   ├── call_analysis.py                # Post-call analysis (Gemini Flash)
│   ├── prefetch.py                     # Predictive Context Engine (speculative prefetch)
│   ├── director_llm.py                 # Groq Director analysis with Gemini fallback helper
│   ├── memory.py                       # Semantic memory (pgvector, decay)
│   ├── scheduler.py                    # Pipecat-side scheduling helpers; Node scheduler is active
│   ├── reminder_delivery.py            # Delivery CRUD + prompt formatting
│   ├── call_snapshot.py                # Pre-computed call context snapshot
│   ├── context_cache.py                # Pre-cache at 5 AM local + news persistence
│   ├── conversations.py                # Conversation CRUD
│   ├── daily_context.py                # Cross-call same-day memory
│   ├── greetings.py                    # Greeting templates + rotation
│   ├── interest_discovery.py           # Interest extraction, category mapping, editable details
│   ├── seniors.py                      # Senior profile CRUD + encrypted PHI fields
│   ├── caregivers.py                   # Caregiver-senior relationships
│   └── news.py                         # OpenAI cached news + Tavily/OpenAI web_search
├── api/
│   ├── routes/                         # telnyx.py, call_context.py, calls.py, auth.py, metrics.py, export.py, data.py
│   ├── middleware/                      # auth, api_auth, rate_limit, security
│   └── validators/schemas.py           # Pydantic input validation
├── db/
│   ├── client.py                       # asyncpg pool + query helpers + health check
│   └── migrations/                     # SQL migrations (HNSW index, snapshots, metrics, audit, encryption)
├── lib/
│   ├── circuit_breaker.py              # Async circuit breaker for external services
│   ├── growthbook.py                   # GrowthBook feature flags
│   └── sanitize.py                     # PII-safe logging
├── tests/                              # 61 test files + helpers/mocks/scenarios
├── pyproject.toml                      # Python 3.12, Pipecat v0.0.101+
└── Dockerfile                          # python:3.12-slim + uv

/                                       # Node.js admin API (Express, Railway port 3001)
├── index.js                            # Express server entry
├── routes/                             # 17 route modules (frontend APIs, health, waitlist)
├── services/                           # DB access and scheduler services for admin/website APIs
├── middleware/                          # auth, api-auth, rate-limit, security, validation
└── db/                                 # Drizzle ORM schema + client

apps/                                   # Frontend apps (Vercel)
├── admin-v2/                           # Admin dashboard (React + Vite + Tailwind)
├── website/                            # Public site + caregiver onboarding/dashboard (React + Clerk)
├── mobile/                             # Expo/React Native caregiver app + Maestro flows
├── _old-consumer-do-not-use/           # Archived previous caregiver web app
└── observability/                      # Live call monitoring dashboard
```

## Environment Variables

```bash
# Server
PORT=7860
ENVIRONMENT=production                  # Required in production; enables fail-closed security checks
PIPECAT_PUBLIC_URL=https://...          # Public Pipecat URL used for Telnyx webhooks and wss:// streams

# Telnyx voice
TELNYX_API_KEY=...
TELNYX_PUBLIC_KEY=...
TELNYX_CONNECTION_ID=...
TELNYX_PHONE_NUMBER=+1...
TELNYX_STREAM_CODEC=L16
TELNYX_STREAM_SAMPLE_RATE=16000
TELNYX_STREAM_TRACK=inbound_track
TELNYX_BIDIRECTIONAL_TARGET_LEGS=both
TELNYX_L16_INPUT_BYTE_ORDER=little
TELNYX_L16_OUTPUT_BYTE_ORDER=little

# Database
DATABASE_URL=postgresql://...           # Neon PostgreSQL + pgvector

# AI Services
ANTHROPIC_API_KEY=...                   # Claude Haiku 4.5 (voice LLM)
ANTHROPIC_MODEL=claude-haiku-4-5-20251001 # Voice LLM model
GOOGLE_API_KEY=...                      # Gemini 3 Flash (Director + Analysis)
DEEPGRAM_API_KEY=...                    # STT (Nova 3)
ELEVENLABS_API_KEY=...                  # TTS
ELEVENLABS_VOICE_ID_ES=...              # Optional Spanish Donna voice
CARTESIA_API_KEY=...                    # Optional Cartesia TTS provider
CARTESIA_VOICE_ID=...                   # Optional Cartesia voice override
CARTESIA_VOICE_ID_ES=...                # Optional Spanish Cartesia voice
OPENAI_API_KEY=...                      # Embeddings + news search
TAVILY_API_KEY=...                      # Optional fast in-call web search

# Auth
JWT_SECRET=...                          # Admin JWT signing
JWT_SECRET_PREVIOUS=...                 # Optional old JWT secret during rotation
DONNA_API_KEYS=pipecat:...,scheduler:... # Labeled service-to-service API keys
CLERK_SECRET_KEY=...                    # Required for Clerk-authenticated routes in production

# HIPAA / PHI
FIELD_ENCRYPTION_KEY=...                # 32-byte base64url key for AES-256-GCM PHI encryption
RETENTION_AUDIT_LOGS_DAYS=2190          # 6 years by default

# Scheduler
SCHEDULER_ENABLED=false                 # Must be false (Node.js runs scheduler)

# Optional
FAST_OBSERVER_MODEL=gemini-3-flash-preview  # Director fallback model
GROQ_API_KEY=...                        # Groq active fast Director provider
ELEVENLABS_VOICE_ID=...                 # Voice ID (has default)
TTS_PROVIDER=elevenlabs                 # Optional: cartesia when enabled/configured
ELEVENLABS_MODEL=eleven_flash_v2_5      # ElevenLabs TTS model
TELEPHONY_INTERNAL_INPUT_SAMPLE_RATE=16000 # Internal STT input after telephony conversion
ELEVENLABS_OUTPUT_SAMPLE_RATE=44100     # Internal ElevenLabs TTS output
CARTESIA_OUTPUT_SAMPLE_RATE=48000       # Internal Cartesia PCM output
GEMINI_INTERNAL_OUTPUT_SAMPLE_RATE=24000 # Internal Gemini Live output
GROWTHBOOK_API_HOST=...                 # Optional GrowthBook feature flag host
GROWTHBOOK_CLIENT_KEY=...               # Optional GrowthBook client key
REDIS_URL=redis://...                   # Required before running multiple Pipecat instances
PIPECAT_REQUIRE_REDIS=true              # Set true when Pipecat is scaled horizontally
```

Production boot is intentionally fail-closed. Node and Pipecat refuse to start if required production secrets are missing or unsafe. `DONNA_API_KEY` is a local/test compatibility fallback only; production must use labeled `DONNA_API_KEYS`.

## API Endpoints (Pipecat)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with active call count |
| `/telnyx/events` | POST | Telnyx Call Control webhook |
| `/telnyx/outbound` | POST | Service-to-service outbound Telnyx call creation |
| `/telnyx/calls/:id/end` | POST | Service-to-service Telnyx call hangup |
| `/api/call` | POST | Initiate outbound Telnyx call |
| `/api/calls` | GET | List recent calls |
| `/api/calls/:sid/end` | POST | Force-end a call |

## Deployment

Three environments: **dev** (experiments), **staging** (CI), **production** (customers).

```bash
make deploy-dev              # Both services to dev
make deploy-dev-pipecat      # Just Pipecat to dev (faster)
make deploy-staging          # Both services to staging
make deploy-prod             # Both services to production
```

> **Do NOT test voice/call features locally.** Deploy to the Railway dev environment and test with real Telnyx calls against the current dev Telnyx number.

Before promoting to production, verify production-like env readiness in Railway:

- `ENVIRONMENT=production`
- `PIPECAT_PUBLIC_URL=https://...`
- `JWT_SECRET` is non-default
- `DONNA_API_KEYS` contains labeled keys, including a Pipecat/notification key
- `FIELD_ENCRYPTION_KEY` decodes to 32 bytes
- `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_CONNECTION_ID`, and `TELNYX_PHONE_NUMBER` are present on Pipecat
- `CLERK_SECRET_KEY` is present on Node
- `REDIS_URL` is present before scaling Pipecat beyond one instance
- Pipecat `LOG_LEVEL=INFO` is set before Railway dev/staging/prod smoke tests

Live Telnyx smoke test checklist:

- Unsigned `/telnyx/events` requests are rejected in production mode.
- A valid Telnyx-signed `call.initiated` webhook answers inbound calls and starts a media stream.
- `/ws` rejects missing, invalid, expired, and reused tokens.
- A normal call lasting longer than five minutes does not drop because the token only gates connection startup.
- Manual call initiation uses `seniorId`; the server resolves the phone number after authorization.
- Railway logs from the smoke call do not include prompt context, transcripts, medical notes, caregiver notes, raw WebSocket parameters, or `ws_token` values.

Security follow-up: see [`docs/audits/2026-05-05-codebase-audit.md`](docs/audits/2026-05-05-codebase-audit.md) for current launch-blocking security, BAA, retention, logging, and test/prod separation gaps. Do not treat those findings as fixed until code changes and validation prove remediation.

**CI/CD:** PRs to main → tests → staging deploy → smoke tests. Push to main → production deploy.

**Frontend apps (Vercel):**
```bash
cd apps/admin-v2 && npx vercel --prod --yes     # Admin dashboard
cd apps/website && npx vercel --prod --yes       # Public website and caregiver web app
```

| Service | Platform | URL |
|---------|----------|-----|
| Pipecat API | Railway | https://donna-pipecat-production.up.railway.app |
| Node.js API | Railway | https://donna-api-production-2450.up.railway.app |
| Admin Dashboard | Vercel | https://admin-v2-liart.vercel.app |
| Public Website | Vercel | https://calldonna.co |
| Observability | Vercel | https://observability-five.vercel.app |

## Documentation

- [pipecat/docs/ARCHITECTURE.md](./pipecat/docs/ARCHITECTURE.md) — Pipecat pipeline architecture (authoritative)
- [docs/architecture/](./docs/architecture/) — Architecture suite (overview, features, security, cost, testing, performance)
- [docs/audits/2026-05-05-codebase-audit.md](./docs/audits/2026-05-05-codebase-audit.md) — Current static audit summary and known gaps
- [docs/guides/FRONTEND_TESTING.md](./docs/guides/FRONTEND_TESTING.md) — Frontend E2E testing guide (Playwright)
- [docs/decisions/DONNA_ON_PIPECAT.md](./docs/decisions/DONNA_ON_PIPECAT.md) — Pipecat migration architecture
- [claude.md](./claude.md) — AI assistant context

## License

Private - All rights reserved
