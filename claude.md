# Donna Project - AI Context

> **AI Assistants**: You have permission to update this file as the project evolves. Keep it accurate and current.

## MANDATORY: Read Before Coding

**Before writing or modifying any code, read [`DIRECTORY.md`](DIRECTORY.md).** It tells you:
- What each directory does and whether it's active or legacy
- Which backend (Pipecat Python vs Node.js Express) owns which functionality
- Exactly which file to open for any given task
- Which files are large and should only be loaded when necessary

Do NOT confuse the Node.js `services/` with `pipecat/services/` — they are separate implementations sharing the same database.

---

## Project Goal

**Donna** is an AI-powered companion that makes friendly phone calls to elderly individuals, providing:
- **Daily check-ins** - Warm, conversational calls to combat loneliness
- **Medication reminders** - Gentle, natural reminders woven into conversation
- **Companionship** - Discussing interests, sharing news, being a friendly presence
- **Caregiver peace of mind** - Summaries and alerts for family members

**Target Users**:
- **Seniors** (70+) who live alone or have limited social contact
- **Caregivers** (adult children, family) who want to ensure their loved ones are okay

---

## Current Status: v5.3

The voice pipeline runs on **Python Pipecat** (`pipecat/` directory). Node.js (repo root) serves admin/consumer APIs and the reminder scheduler. See "Architecture Decision: Two Backends" below.

### Working Features (Pipecat)
- **2-Layer Observer Architecture + Post-Call**
  - Layer 1: Quick Observer (0ms) - 268 regex patterns + guarded programmatic goodbye (minimum call age + delayed EndFrame)
  - Layer 2: Split Conversation Director — Two specialized Groq calls:
    - Query Director (~200ms): Extracts `memory_queries` continuously on interims
    - Guidance Director (~400ms): Conversation guidance on 250ms silence (speculative)
    - Ephemeral context: All injections tagged `[EPHEMERAL:`, stripped each turn
    - Metrics: Logs speculative hit rate per call
  - Post-Call: Analysis, interest discovery, memory extraction, daily context, snapshot rebuild (Gemini Flash)
- **Caregiver summaries and alerts** — Post-call Gemini analysis generates privacy-respecting caregiver-facing summaries and follow-up guidance for email/in-app notifications. SMS is inactive for now.
- **Director-First Architecture** — Eliminated ~14s of Claude tool-call latency per call:
  - `search_memories` → Director injects memories as ephemeral context (500ms gate)
  - `save_important_detail` → Removed; post-call `extract_from_conversation` handles it
  - `check_caregiver_notes` → Pre-fetched at call start, injected into system prompt
  - `mark_reminder_acknowledged` → Fire-and-forget (handler returns instantly, DB write in background)
- **Predictive Context Engine** — Speculative memory prefetch eliminates tool-call latency
  - 1st wave: Regex entity/topic extraction on final transcriptions → background `memory.search()`
  - 2nd wave: Query Director extracts `memory_queries` → anticipatory prefetch
  - Interim transcriptions: Debounced prefetch while user is still speaking (1s gap, 15+ chars)
  - 500ms memory gate: Waits for prefetch cache before passing frame to Claude
- **Pipecat Flows** - 4-phase call state machine (opening → main → winding_down → closing)
- **2 LLM Tools** - web_search (Tavily first, OpenAI fallback), mark_reminder_acknowledged (fire-and-forget)
- **Claude-Owned Web Search** — Claude calls `web_search` for current factual questions; the tool sanitizes PHI, uses Tavily raw snippets first, and falls back to OpenAI web search.
- **Programmatic Call Ending** - Quick Observer detects strong goodbye only after the minimum call-age guard, then schedules a delayed EndFrame (bypasses LLM)
- **Director Fallback Actions** - Force winding-down at 9min, force end at 12min (configurable per-senior)
- **Full In-Call Context Retention** - APPEND strategy keeps complete conversation history (no summary truncation)
- **Cross-Call Turn History** - Recent turns from previous calls loaded into system prompt via `get_recent_turns()`
- **In-Call Memory Tracking** - Topics, questions, advice tracked per call (ConversationTracker)
- **Mid-Call Memory Refresh** - After 5+ minutes, refreshes context with current conversation topics
- **Same-Day Cross-Call Memory** - Daily context + call summaries persist across calls per senior per day
- **Sentiment-Aware Greetings** - Uses last call's engagement/rapport score for greeting tone
- **Semantic Memory** - pgvector with HNSW index + decay + deduplication + tiered retrieval
- **Caregiver Notes** - Family can leave notes that are prefetched at call start and injected into Donna's context
- **Senior Profile Context** - Calls include local time, language, birthday/age, rich interest details, caregiver additional context, and topics to avoid from the senior profile
- **Interest Discovery** - Post-call analysis maps newly discovered topics to predefined mobile interest categories and writes editable `familyInfo.interestDetails`
- **Per-Senior Call Settings** - Configurable time limits, greeting style, memory decay via `call_settings` JSONB
- **Scheduled Reminder Calls** - Polling scheduler with prefetch + delivery tracking
- **Call Context Snapshot** - Pre-computed JSONB snapshot (analysis, summaries, turns, daily context) rebuilt after each call, eliminates 6 DB queries at call time
- **Context Pre-caching** - Senior context + news cached at 5 AM local time, news persisted to `seniors.cached_news`
- Real-time voice calls (Telnyx Voice API → Pipecat WebSocket)
- Speech transcription (Deepgram Nova 3 via Pipecat)
- LLM responses (Claude Haiku 4.5 via Pipecat AnthropicLLMService, prompt caching enabled)
- TTS (ElevenLabs via Pipecat)
- English/Spanish Donna call language support from caregiver settings (`familyInfo.donnaLanguage`), including Deepgram language, prompt instruction, and optional Spanish TTS voice IDs
- VAD (Silero — confidence=0.6, min_volume=0.5; stop_secs=1.2 for senior calls, 0.8 for onboarding calls)
- News via OpenAI web search (1hr cache), in-call web search via Tavily raw snippets with OpenAI fallback
- Security: JWT admin auth, API key auth, Telnyx webhook validation, rate limiting, security headers

### Infrastructure & Reliability
- **Circuit Breakers** - Groq, Gemini, OpenAI embedding/news, and Tavily — `lib/circuit_breaker.py`
- **Feature Flags** - GrowthBook Cloud SDK integrated (Pipecat + Node.js), managed at app.growthbook.io
- **Graceful Shutdown** - Tracks active calls, 7s drain on SIGTERM
- **Enhanced /health** - Database connectivity + circuit breaker states
- **CI/CD Pipelines** - PR → tests → staging → smoke tests; push to main → production
- **Multi-Environment** - dev/staging/production with Neon branching + Railway environments

### HIPAA Compliance & Security
- **HIPAA Audit Logging** - Fire-and-forget audit trail for all PHI access (`services/audit.py` + `services/audit.js`). Records userId, userRole, action, resourceType, resourceId, IP, user-agent. Never blocks the request path.
- **Field-Level Encryption** - AES-256-GCM encryption for PHI fields (summaries, transcripts, memory content, analysis). Dual-column strategy: `*_encrypted` columns alongside plaintext for gradual migration. `enc:` prefix wire format. (`lib/encryption.py` + `lib/encryption.js`)
- **Dual-Key JWT Rotation** - `JWT_SECRET` + `JWT_SECRET_PREVIOUS` for zero-downtime credential rotation. Both Python and Node.js auth middleware verify against both keys.
- **Token Revocation** - DB-backed revoked_tokens table with SHA-256 hashed tokens. Per-token and per-admin revocation. Automatic cleanup of expired entries. (`services/token_revocation.py` + `services/token-revocation.js`)
- **Data Retention** - Node-owned automated batched purge with configurable retention periods (conversation PHI: 365d, conversation metadata: 1095d, memories: 730d, call_analyses: 365d, daily_context: 90d, call_metrics: 180d, reminder_deliveries: 90d, notifications: 180d, waitlist: 365d, audit_logs: 2190d). Pipecat has a disabled-by-default parity loop. (`services/data-retention.js` + `pipecat/services/data_retention.py`)
- **Right-to-Access Export** - HIPAA-compliant data export endpoint (`GET /api/seniors/:id/export`) returns all senior data in one JSON bundle (profile, conversations, memories, reminders, analyses, daily context, caregiver links)
- **Hard Delete** - Complete senior data deletion across all tables (`DELETE /api/seniors/:id/data`) with audit logging
- **Sentry PII Scrubbing** - Senior IDs SHA-256 hashed in error reports, exception values truncated to 200 chars, `send_default_pii=False`
- **PII-Safe Logging** - `maskName()` and `maskPhone()` helpers across both backends
- **Compliance Documentation** - Full HIPAA docs in `docs/compliance/`: overview, BAA tracker (active vendors plus inactive legacy providers), breach notification runbook, data retention policy, vendor security evaluations

### Frontend Apps (unchanged, on Vercel/separate)
- **Admin Dashboard (v2)** - React + Vite + Tailwind (`apps/admin-v2/`) on Vercel
- **Consumer App** - React + Vite + Clerk (`apps/consumer/`) on Vercel
- **Observability Dashboard** - React (`apps/observability/`)

### Mobile Simulator, EAS, and Maestro
- **Codex instruction file** - Codex uses root `AGENTS.md` as its equivalent of Claude's `claude.md`/`CLAUDE.md`.
- **Active mobile app** - `apps/mobile` is the Expo/React Native app. It talks to the repo-root Node API and Clerk; it does not call Pipecat directly.
- **Required public mobile config** - Every local or EAS build must resolve `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` through `apps/mobile/.env` or the selected EAS environment. Print variable names only, not values.
- **Clean worktree simulator rule** - If testing latest `main` from a clean temporary worktree, copy only `apps/mobile/.env` from the primary checkout before building. Without it, Clerk/API config can be missing from the native bundle and sign-in/profile loading will fail.
- **EAS environment rule** - `development`, `preview`, and `production` EAS environments must all contain `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`. `development`/`preview` builds are common for simulator/internal testing, so do not assume production env coverage is enough.
- **Dev-client requirement** - EAS simulator development builds require `expo-dev-client` in `apps/mobile/package.json`. After adding it or changing dependencies, regenerate the lockfile with npm 10: `cd apps/mobile && npx --yes npm@10.9.3 install --package-lock-only --include=dev`.
- **Lockfile preflight** - EAS runs `npm ci --include=dev`. Always run `cd apps/mobile && npx --yes npm@10.9.3 ci --include=dev` before starting an EAS simulator build. If this fails, fix `package-lock.json`; otherwise EAS will fail in `INSTALL_DEPENDENCIES`.
- **Fresh simulator build path** - Local `expo run:ios` can fail when Apple Sign-In entitlements require Apple Development signing. When local signing is unavailable, use `cd apps/mobile && npx eas build:dev --platform ios --profile development`, then install with `npx eas build:run --platform ios --id <build-id>`.
- **Apple sign-in simulator caveat** - A stale simulator dev client can load fresh JS but still lack native entitlements. For Apple auth issues, verify the installed app includes `com.apple.developer.applesignin`, or test with a fresh EAS simulator build/TestFlight build.
- **Maestro input rule** - Maestro must exercise visible human paths. For iOS `phone-pad` and `number-pad`, focus the field and tap visible keypad digits using `.maestro/subflows/tap_digits.yaml`; do not use `inputText` for numeric keypad fields. Tests must assert real entered values, not placeholders.

---

## Architecture

**Full documentation**: [docs/architecture/](docs/architecture/) — Architecture, Security, Scalability, Cost, Testing, Performance

**Pipeline details**: [pipecat/docs/ARCHITECTURE.md](pipecat/docs/ARCHITECTURE.md)

### Pipecat Pipeline (bot.py)

Linear pipeline of `FrameProcessor`s. Frames flow top to bottom. The Conversation Director is in the pipeline but **non-blocking for LLM analysis** — Groq/Gemini work runs in the background, while final transcripts may briefly wait for the memory prefetch cache before Claude responds.

```
Telnyx Audio ──► FastAPIWebsocketTransport
                        │
                   Deepgram STT (Nova 3, 16kHz)
                        │ TranscriptionFrame
                        ▼
              ┌─────────────────────┐
              │   Quick Observer     │  Layer 1 (0ms): 268 regex patterns
              │   (BLOCKING)         │  Injects guidance for THIS turn
              │                      │  Strong goodbye → guarded EndFrame after minimum call age
              └─────────┬───────────┘
                        │
                        ▼
              ┌─────────────────────┐     ┌──────────────────────────┐
              │ Conversation         │────►│  Background Analysis      │
              │ Director             │     │  (asyncio.create_task)    │
              │ (PASS-THROUGH)       │     │                           │
              │                      │     │  Groq (~200-400ms) primary│
              │ 1. Check speculative │     │  Gemini Flash fallback    │
              │    → inject SAME or  │     │                           │
              │    PREVIOUS turn's   │     │  Speculative: on 250ms    │
              │    guidance          │     │  silence onset, starts    │
              │ 2. Gate briefly for  │     │  Groq analysis early      │
              │    memory prefetch   │     │                           │
              │    cache population  │     │  Also: Query Director     │
              │ 3. Fires background  │     │  memory_queries, dynamic  │
              │    analysis ────────►│     │  news injection,          │
              │                      │     │  predictive prefetch,     │
              │                      │     │  force end at 9min/12min  │
              └─────────┬───────────┘     └──────────────────────────┘
                        │ (0-500ms memory gate)
                        ▼
              Context Aggregator (user) ← builds LLM context from transcriptions
                        ▼
              Claude Haiku 4.5 + FlowManager (4-phase state machine)
                        │ TextFrame
                        ▼
              Conversation Tracker (topics, questions, advice + shared transcript)
                        ▼
              Guidance Stripper (strips <guidance> tags + [BRACKETED] directives)
                        ▼
              ElevenLabs TTS (eleven_flash_v2_5)
                        ▼
              FastAPIWebsocketTransport ──► Telnyx Audio (L16 16kHz)
                        ▼
              Context Aggregator (assistant) ← tracks assistant responses
```

**Key mechanism**: Both Quick Observer and Director inject guidance into Claude's context via `LLMMessagesAppendFrame(run_llm=False)`. Quick Observer's guidance is for the **current** turn (instant regex). Director's guidance can be **same-turn** (when speculative Groq analysis completes before the final transcription) or **previous-turn** (fallback). Both appear as user-role messages in Claude's context before the next LLM call.

**Predictive Context Engine**: The Director also runs speculative memory prefetch in the background. On each transcription, regex extracts topics/entities and pre-fetches memories. After Groq analysis completes, a second wave prefetches based on memory queries, upcoming reminders, and news topics. Results are cached in `session_state["_prefetch_cache"]` (TTL=30s, Jaccard fuzzy match). Memory retrieval is now Director-owned context injection, so Claude does not need a `search_memories` tool call in the live path. Interim transcriptions also trigger debounced prefetch while the user is still speaking.

**Web Search Tool**: Claude has an active `web_search` tool in the main flow for current factual questions. The tool prompts Donna to speak a brief filler before searching, sanitizes PHI from the query, uses Tavily raw snippets first, and falls back to OpenAI web search if Tavily is unavailable or empty.

### Call Phase State Machine (Pipecat Flows)

| Phase | Tools | Context Strategy |
|-------|-------|-----------------|
| **Main** | web_search, mark_reminder_acknowledged, transition_to_winding_down | APPEND, ephemeral injections |
| **Winding Down** | mark_reminder_acknowledged, transition_to_closing | APPEND |
| **Closing** | *(none — post_action: end_conversation)* | APPEND |

### Post-Call Processing

On disconnect: complete conversation → call analysis (Gemini) → summary persistence → caregiver notification → memory extraction (OpenAI) → interest discovery → interest scores → daily context save → reminder cleanup → cache clear → **snapshot rebuild**.

---

## Key Files (Pipecat)

```
pipecat/
├── main.py                          ← FastAPI entry, /health, /ws, graceful shutdown (258 LOC)
├── bot.py                           ← Pipeline assembly + sentiment greetings + prompt caching (335 LOC)
├── config.py                        ← All env vars centralized (110 LOC)
├── prompts.py                       ← System prompts + phase task instructions (129 LOC)
│
├── flows/
│   ├── nodes.py                     ← 4 call phase NodeConfigs (imports prompts.py) (319 LOC)
│   └── tools.py                     ← 2 LLM tool schemas (web_search, mark_reminder) + handlers (303 LOC)
│
├── processors/
│   ├── patterns.py                  ← Pattern data: 268 regex patterns, 19 categories (503 LOC)
│   ├── quick_observer.py            ← Layer 1: analysis logic + goodbye EndFrame (386 LOC)
│   ├── conversation_director.py     ← Layer 2: Split Director (Query+Guidance) + memory/news injection + ephemeral context (850 LOC)
│   ├── conversation_tracker.py      ← Topic/question/advice tracking + transcript (246 LOC)
│   ├── metrics_logger.py            ← Call metrics + prefetch stats logging (110 LOC)
│   ├── goodbye_gate.py              ← False-goodbye grace period — NOT in active pipeline (135 LOC)
│   └── guidance_stripper.py         ← Strip <guidance> tags + [BRACKETED] directives (115 LOC)
│
├── services/
│   ├── scheduler.py                 ← Reminder polling + outbound calls (427 LOC)
│   ├── reminder_delivery.py         ← Delivery CRUD + prompt formatting (95 LOC)
│   ├── post_call.py                 ← Post-call: analysis, memory, cleanup, snapshot rebuild (338 LOC)
│   ├── prefetch.py                  ← Predictive Context Engine: cache + query extraction + runner (250 LOC)
│   ├── director_llm.py              ← Split Director LLM: Query Director + Guidance Director (580 LOC)
│   ├── call_analysis.py             ← Post-call analysis + call quality scoring (246 LOC)
│   ├── memory.py                    ← Semantic memory (pgvector, HNSW, circuit breaker) (392 LOC)
│   ├── interest_discovery.py        ← Interest extraction, category mapping, editable details
│   ├── call_snapshot.py             ← Pre-computed call context snapshot for seniors (53 LOC)
│   ├── context_cache.py             ← Pre-cache at 5 AM local + news persistence (304 LOC)
│   ├── conversations.py             ← Conversation CRUD (250 LOC)
│   ├── daily_context.py             ← Cross-call same-day memory (161 LOC)
│   ├── greetings.py                 ← Sentiment-aware greeting templates + rotation (326 LOC)
│   ├── seniors.py                   ← Senior profile CRUD + encrypted PHI fields + per-senior call_settings
│   ├── caregivers.py                ← Caregiver relationships + notes delivery (101 LOC)
│   ├── news.py                      ← Tavily web search (raw results) + OpenAI fallback + circuit breaker (213 LOC)
│   ├── data_retention.py            ← HIPAA data retention: batched purge of 7 tables, 24h loop
│   ├── audit.py                     ← Fire-and-forget HIPAA audit logging (log_audit, auth_to_role)
│   └── token_revocation.py          ← JWT token revocation: per-token, per-admin, expired cleanup
│
├── lib/
│   ├── growthbook.py                ← GrowthBook feature flag SDK helper (99 LOC)
│   ├── circuit_breaker.py           ← Async circuit breaker for external services (84 LOC)
│   ├── encryption.py                ← AES-256-GCM field encryption for PHI (enc: prefix, graceful degradation)
│   └── sanitize.py                  ← PII-safe logging
│
├── api/
│   ├── routes/
│   │   ├── telnyx.py                ← /telnyx/events, /telnyx/outbound, Telnyx signature validation
│   │   ├── call_context.py          ← Shared encrypted call metadata + senior context hydration
│   │   ├── calls.py                 ← /api/call, /api/calls
│   │   ├── auth.py                  ← Token revocation: revoke-token, revoke-all, logout
│   │   └── export.py                ← HIPAA right-to-access: /api/seniors/{id}/export
│   ├── middleware/                   ← auth (dual-key JWT + revocation + JWKS), rate_limit, security, error_handler
│   └── validators/schemas.py        ← Pydantic input validation
│
├── db/
│   ├── client.py                    ← asyncpg pool + query helpers + health check (69 LOC)
│   └── migrations/                  ← SQL migrations (HNSW, snapshots, audit_logs, revoked_tokens, encrypted_phi)
├── tests/                           ← 61 test files + helpers/mocks/scenarios
├── pyproject.toml                   ← Python 3.12, Pipecat v0.0.101+
└── Dockerfile                       ← python:3.12-slim + uv
```

### Node.js Admin API (repo root)

```
/
├── index.js                    ← Express server (port 3001, admin/consumer APIs)
├── lib/
│   ├── growthbook.js           ← GrowthBook feature flag SDK helper (Node.js)
│   └── encryption.js           ← AES-256-GCM field encryption for PHI (mirrors pipecat/lib/encryption.py)
├── services/                   ← 12 service files (dual implementation with pipecat/services/)
├── routes/                     ← 16 route modules (all /api/* endpoints) + helpers.js (routeError, canAccessSenior)
├── middleware/                  ← 7 middleware files (auth w/ dual-key JWT + revocation, rate-limit, security)
└── apps/                       ← Frontend apps (still active)
    ├── admin-v2/               ← Admin dashboard (Vercel)
    ├── consumer/               ← Consumer app (Vercel)
    └── observability/          ← Observability dashboard
```

---

## Development Workflow

### Three Environments

Donna runs fully isolated environments. Each has its own Railway services, Neon database branch, and Telnyx voice number.

| Environment | Purpose | Database | Voice # | Pipecat URL | API URL |
|---|---|---|---|---|---|
| **production** | Live customers | Neon `main` branch | +18064508649 | donna-pipecat-production.up.railway.app | donna-api-production-2450.up.railway.app |
| **staging** | Pre-merge CI validation | Neon `staging` branch | +19789235477 | (created on deploy) | (created on deploy) |
| **dev** | Your experiments | Neon `dev` branch | +19789235477 | donna-pipecat-dev.up.railway.app | donna-api-dev.up.railway.app |

**Isolation guarantees:**
- Each environment has its own database (Neon copy-on-write branches) — bad writes in dev never touch production data
- Each environment uses its own Telnyx voice number — dev calls never reach real seniors
- API keys (Anthropic, Deepgram, ElevenLabs, etc.) are shared across environments (safe — they're stateless services)

### Daily Development Workflow

```
# 1. Work on a feature branch
git checkout -b feat/better-greetings

# 2. Edit code locally
#    (e.g., change pipecat/services/greetings.py)

# 3. Deploy to dev (deploys whatever code is in your working directory)
make deploy-dev-pipecat          # ~30s — just Pipecat (fastest)
make deploy-dev                  # ~60s — both Pipecat + Node.js API

# 4. Test with a real call
#    Call +19789235477 (dev number) from your phone

# 5. Check logs if something's wrong
make logs-dev

# 6. Iterate: edit → deploy → call → repeat

# 7. When happy, push and open PR
git push -u origin feat/better-greetings
gh pr create
#    → CI runs tests → deploys to staging → smoke tests

# 8. Merge to main
#    → CI auto-deploys to production
```

### Git Branches vs Railway Environments

**Railway environments are NOT tied to git branches.** `make deploy-dev` uploads your current working directory to the dev environment, regardless of which git branch you're on. This is intentional — you can test any branch in dev without ceremony.

**The only automated git→deploy connections are:**
- **PR to `main`** → CI deploys to staging (after tests pass)
- **Push to `main`** → CI deploys to production

### Neon Database Branches

Neon branches are copy-on-write snapshots of the production database. The `dev` and `staging` branches contain all production data (seniors, memories, reminders) but changes stay isolated.

```bash
# Reset dev database to a fresh copy of production (if data gets messy)
neonctl branches delete dev --project-id ancient-hill-13451362 --org-id org-sparkling-voice-59093323
neonctl branches create --name dev --project-id ancient-hill-13451362 --org-id org-sparkling-voice-59093323
# Then update DATABASE_URL in Railway dev environment if the connection string changes
```

### Makefile Commands

```bash
# Deploy
make deploy-dev              # Both services to dev
make deploy-dev-pipecat      # Just Pipecat to dev (fastest for voice changes)
make deploy-staging          # Both services to staging
make deploy-prod             # Both services to production

# Health checks
make health-dev              # Check dev services are up
make health-staging          # Check staging
make health-prod             # Check production

# Logs
make logs-dev                # Tail dev Pipecat logs
make logs-staging            # Tail staging logs
make logs-prod               # Tail production logs

# Tests (run locally)
make test                    # All tests (Python + Node.js)
make test-python             # Pipecat tests only
make test-node               # Node.js tests only
make test-regression         # Regression scenario tests

# First-time setup
make setup                   # Create Neon branches + Railway environments
```

### Railway Services

The Railway project has four services per environment:

| Service | Railway Name | Port | Responsibility |
|---|---|---|---|
| Pipecat (Python) | `donna-pipecat` | 7860 | Voice pipeline: STT → Observer → Director → Claude → TTS |
| Node.js API | `donna-api` | 3001 | Admin/consumer APIs, reminder scheduler, call initiation |
**GrowthBook (feature flags):** Hosted on GrowthBook Cloud (app.growthbook.io), not self-hosted. Admin UI at app.growthbook.io, SDK connects to cdn.growthbook.io. No Railway services needed.

**Railway CLI in the repo root is linked to `donna-api` (Node.js) by default.** This means bare `railway logs` shows API request logs, NOT voice/call pipeline logs.

**IMPORTANT — Which service has which logs:**

| What you're looking for | Service | Command |
|---|---|---|
| Voice call logs, STT, Director, Claude, TTS, web search | `donna-pipecat` | `make logs-prod` or `railway logs --service donna-pipecat --environment production` |
| Post-call analysis, memory extraction, call metrics | `donna-pipecat` | Same as above |
| API requests, call initiation, reminder scheduler | `donna-api` | `railway logs --service donna-api --environment production` |
| Caregiver/senior CRUD, onboarding, notifications API | `donna-api` | Same as above |

**Common mistake:** Running `railway logs` without `--service donna-pipecat` when debugging call issues — you'll see nothing useful because the call pipeline runs on the Pipecat service.

Use `--environment dev` or `--environment staging` flags for other environments. If you switch with `railway environment dev`, remember to switch back with `railway environment production`.

### Testing Strategy

- **Unit tests (local):** `make test` — runs Python + Node.js tests, no external deps needed
- **Voice/call features:** Deploy to dev, test with real phone calls to dev number
- **Frontend E2E tests:** `npm run test:e2e` — Playwright browser tests across all 3 frontend apps (31 tests, ~15s)
- **Regression:** `make test-regression` — scenario-based tests run in CI on every PR

- **LLM-to-LLM Voice Simulation:** `cd pipecat && python -m pytest tests/test_live_simulation.py -v -m llm_simulation` — Haiku caller vs real Donna pipeline (real Claude, Director, Observer, DB). Tests web_search, memory injection, reminder processing across multiple calls. Requires ANTHROPIC_API_KEY + dev DATABASE_URL. Design doc: `docs/plans/2026-04-05-llm-voice-simulation-testing.md`

**Do NOT** test voice features locally with ngrok — always deploy to Railway dev environment

### Frontend E2E Tests (Playwright)

Browser tests for admin, consumer, and observability apps. Tests mock API responses by default — no backend needed.

```bash
# Run all E2E tests (starts dev servers automatically)
npm run test:e2e

# Run specific app tests
npm run test:e2e:admin            # Admin dashboard (17 tests)
npm run test:e2e:consumer         # Consumer public pages (4 tests)
npm run test:e2e:observability    # Observability dashboard (4 tests)

# Run authenticated consumer tests (requires .env.test with Clerk credentials)
npx playwright test --project=clerk-setup --project=consumer-authenticated

# Debug with UI mode
npx playwright test --ui

# First-time setup
npx playwright install chromium
```

**5 Playwright projects** in `playwright.config.ts`:

| Project | Tests | Auth |
|---------|-------|------|
| `clerk-setup` | Global Clerk token init | — |
| `admin` | Login, navigation, seniors, calls, reminders | JWT via localStorage |
| `consumer` | Landing page, protected route redirects | None |
| `consumer-authenticated` | Dashboard access, onboarding, sign out | Clerk `@clerk/testing` |
| `observability` | Call history, navigation, view switching | JWT via localStorage |

**Key files:**
- Config: `playwright.config.ts`
- Mock data: `tests/e2e/fixtures/test-data.ts`
- Auth helpers: `tests/e2e/fixtures/auth.ts`
- API mocks: `tests/e2e/fixtures/api-mocks.ts`
- Clerk setup: `tests/e2e/global.setup.ts`
- Clerk credentials: `tests/e2e/.env.test` (gitignored)

**Full guide:** [`docs/guides/FRONTEND_TESTING.md`](docs/guides/FRONTEND_TESTING.md)

---

## For AI Assistants

### When Making Changes (Pipecat)

| Task | Where to Look |
|------|---------------|
| Change conversation behavior | `pipecat/prompts.py` (prompt text) + `pipecat/flows/nodes.py` (flow logic) |
| Add/modify LLM tools | `pipecat/flows/tools.py` (schemas + handlers) |
| Modify Quick Observer patterns | `pipecat/processors/patterns.py` (data) + `pipecat/processors/quick_observer.py` (logic) |
| Modify Conversation Director | `pipecat/processors/conversation_director.py` + `pipecat/services/director_llm.py` |
| Modify call ending behavior | `pipecat/processors/quick_observer.py` (goodbye detection) + `pipecat/processors/goodbye_gate.py` (grace period) + `pipecat/processors/conversation_director.py` (time-based) |
| Change pipeline assembly | `pipecat/bot.py` |
| Modify post-call processing | `pipecat/services/post_call.py` + `pipecat/services/call_snapshot.py` (snapshot rebuild) |
| Modify post-call analysis | `pipecat/services/call_analysis.py` |
| Modify memory system | `pipecat/services/memory.py` |
| Modify predictive prefetch | `pipecat/services/prefetch.py` (cache + extraction + runner) + `pipecat/processors/conversation_director.py` (orchestration) |
| Modify greeting templates | `pipecat/services/greetings.py` |
| Modify context pre-caching | `pipecat/services/context_cache.py` |
| Modify cross-call daily context | `pipecat/services/daily_context.py` |
| Modify reminder scheduling | `pipecat/services/scheduler.py` (polling) + `pipecat/services/reminder_delivery.py` (CRUD) |
| Modify per-senior call settings | `pipecat/services/seniors.py` (`get_call_settings()`) |
| Modify caregiver notes delivery | `pipecat/services/caregivers.py` + `pipecat/flows/tools.py` |
| Modify circuit breaker behavior | `pipecat/lib/circuit_breaker.py` |
| Modify feature flags | `pipecat/lib/growthbook.py` (GrowthBook SDK integration) |
| Check/add environment variables | `pipecat/config.py` |
| Modify in-call tracking | `pipecat/processors/conversation_tracker.py` |
| Modify guidance stripping | `pipecat/processors/guidance_stripper.py` |
| Add API routes | `pipecat/api/routes/` |
| Modify auth/middleware | `pipecat/api/middleware/` |
| Database queries | `pipecat/db/client.py` |
| Server setup / graceful shutdown | `pipecat/main.py` |
| Modify data retention policies | `pipecat/services/data_retention.py` (Python) + `services/data-retention.js` (Node.js) |
| Modify audit logging | `pipecat/services/audit.py` (Python) + `services/audit.js` (Node.js) |
| Modify token revocation | `pipecat/services/token_revocation.py` (Python) + `services/token-revocation.js` (Node.js) |
| Modify field encryption | `pipecat/lib/encryption.py` (Python) + `lib/encryption.js` (Node.js) |
| Review HIPAA compliance | `docs/compliance/` (5 docs: overview, BAAs, breach, retention, vendor security) |
| Update admin UI (v2) | `apps/admin-v2/src/pages/` |
| Update admin API client | `apps/admin-v2/src/lib/api.ts` |
| Add/modify frontend E2E tests | `tests/e2e/` — see [`docs/guides/FRONTEND_TESTING.md`](docs/guides/FRONTEND_TESTING.md) |
| Add/modify route error handling | `routes/helpers.js` (`routeError()`) — all route catch blocks use this |
| Add/modify mobile error display | `apps/mobile/src/lib/api.ts` (`getErrorMessage()`) — all screens use this |
| Add/modify Zod validation schemas | `validators/schemas.js` — **do NOT add `.transform()` for DB-bound fields** |
| Add/modify LLM voice simulation tests | `pipecat/tests/simulation/` (framework) + `pipecat/tests/test_live_simulation.py` (tests) |

### Commit Messages & PR Titles

Write commit messages and PR squash titles that are **specific and descriptive** — someone scanning `git log` should understand what changed and why without opening the PR.

**Rules:**
- Lead with what was actually changed, not vague category labels
- Include the **why** or **effect**, not just the what
- PR squash titles are the permanent record — make them count (individual commit messages get squashed away)

**Bad:**
```
feat: analysis insights in prompt + memory limit 20
feat: update memory system
fix: improve conversation quality
```

**Good:**
```
feat: surface follow-up suggestions & empathy concerns from call analysis in system prompt
feat: reduce memory context to 20 items (recent turns already cover last 3 calls)
fix: lower memory similarity threshold 0.7→0.45 (was filtering all results)
```

### Documentation Updates

After each commit that adds features or changes architecture, update:

1. **`DIRECTORY.md`** - Directory map and wayfinding (agents read this FIRST)
2. **`pipecat/docs/ARCHITECTURE.md`** - Pipeline diagrams, file structure, tech stack
3. **`pipecat/docs/LEARNINGS.md`** - Engineering learnings from production debugging
4. **`CLAUDE.md`** (this file) - Working features, key files, AI assistant reference
5. **`README.md`** - Features, quick start, project structure
6. **`docs/architecture/`** - Architecture suite (OVERVIEW, ARCHITECTURE, SECURITY, SCALABILITY, COST, TESTING, PERFORMANCE)

### Deployment

Three environments: **dev** (your experiments), **staging** (pre-merge CI), **production** (customers).

```bash
# Quick deploy (use Makefile)
make deploy-dev              # Deploy both services to dev
make deploy-dev-pipecat      # Deploy only Pipecat to dev (faster iteration)
make deploy-staging          # Deploy both to staging
make deploy-prod             # Deploy both to production

# Health checks
make health-dev
make health-prod

# Logs
make logs-dev
```

See the **Development Workflow** section above for full environment details, Makefile commands, and iteration workflow.

**Admin v2 (Vercel):**
```bash
cd apps/admin-v2 && npx vercel --prod --yes
```
Live: https://admin-v2-liart.vercel.app

### Environment Variables

```bash
# Server
PORT=7860
ENVIRONMENT=production                  # Enables production fail-closed security checks
PIPECAT_PUBLIC_URL=https://...          # Public Pipecat URL; used for Telnyx signatures + wss:// streams

# Telnyx
TELNYX_API_KEY=...
TELNYX_PUBLIC_KEY=...
TELNYX_PHONE_NUMBER=+1...
TELNYX_CONNECTION_ID=...

# Database
DATABASE_URL=...                 # Neon PostgreSQL

# AI Services
ANTHROPIC_API_KEY=...            # Claude Haiku (voice LLM)
ANTHROPIC_MODEL=claude-haiku-4-5-20251001 # Voice LLM model
GOOGLE_API_KEY=...               # Gemini Flash (Director + Analysis)
DEEPGRAM_API_KEY=...             # STT
ELEVENLABS_API_KEY=...           # TTS (ElevenLabs)
ELEVENLABS_VOICE_ID=...          # Voice ID (optional)
ELEVENLABS_VOICE_ID_ES=...       # Optional Spanish Donna voice
ELEVENLABS_MODEL=eleven_flash_v2_5 # TTS model (optional, has default)
CARTESIA_API_KEY=...             # Optional/evaluation TTS provider
CARTESIA_VOICE_ID=...            # Optional/evaluation Cartesia voice override
CARTESIA_VOICE_ID_ES=...         # Optional Spanish Cartesia voice
TTS_PROVIDER=elevenlabs          # Override GrowthBook flag: "elevenlabs" or "cartesia"
OPENAI_API_KEY=...               # Embeddings + news search
GROQ_API_KEY=...                 # Groq primary Director

# Auth
JWT_SECRET=...
JWT_SECRET_PREVIOUS=...          # Old JWT secret during credential rotation (remove after 7d)
DONNA_API_KEYS=pipecat:...,scheduler:... # Labeled service-to-service API keys
CLERK_SECRET_KEY=...             # Required for Clerk-authenticated Node routes in production

# HIPAA Compliance
FIELD_ENCRYPTION_KEY=...         # 32-byte base64url key for AES-256-GCM PHI encryption
RETENTION_CONVERSATIONS_DAYS=365 # Data retention periods (configurable)
RETENTION_MEMORIES_DAYS=730
RETENTION_AUDIT_LOGS_DAYS=2190   # 6 years

# Scheduler
SCHEDULER_ENABLED=false          # MUST be false (Node.js runs scheduler)

# Feature Flags (GrowthBook Cloud)
GROWTHBOOK_API_HOST=...          # https://cdn.growthbook.io
GROWTHBOOK_CLIENT_KEY=...        # SDK connection key from app.growthbook.io

# Monitoring
SENTRY_DSN=...                               # Error monitoring (optional, both backends)

# Optional
FAST_OBSERVER_MODEL=gemini-3-flash-preview   # Director model (Gemini fallback)
GROQ_DIRECTOR_MODEL=openai/gpt-oss-20b       # Director model (Groq primary)
CALL_ANALYSIS_MODEL=gemini-3-flash-preview   # Post-call analysis model
LOG_LEVEL=INFO                               # DEBUG for verbose pipecat logs
REDIS_URL=redis://...                        # Required before multiple Pipecat instances
PIPECAT_REQUIRE_REDIS=true                   # Enforce Redis when horizontally scaled
```

Production boot intentionally fails closed if required security env vars are missing or unsafe. `DONNA_API_KEY` is only a local/test compatibility fallback; production must use labeled `DONNA_API_KEYS`.

Security deploy smoke tests before promotion:
- unsigned `/telnyx/events` rejects in production;
- valid Telnyx-signed `/telnyx/events` creates call metadata with `ws_token`;
- `/ws` rejects missing/invalid/expired/reused tokens;
- calls longer than five minutes continue normally after connection;
- manual call initiation uses `seniorId` and resolves the phone server-side after authZ.

Security follow-up: staged PHI encryption/export migration is intentionally separate. Do not mix it into ingress/auth hardening. The migration should add encrypted companions for the highest-risk plaintext fields, backfill in batches, switch reads/exports to encrypted-first decrypt-at-boundary behavior, and stop/null plaintext only after verification.

---

## Architecture Decision: Two Backends

Running separate Python (Pipecat) and Node.js (Express) backends is an **explicit decision**, not tech debt. Each backend owns a clear responsibility:
- **Pipecat (Python)** — Real-time voice pipeline (STT, Observer, Director, Claude, TTS)
- **Node.js (Express)** — REST APIs for frontends, reminder scheduler, call initiation

Both share the same Neon PostgreSQL database. Dual service implementations (e.g. `services/memory.js` and `pipecat/services/memory.py`) exist because each backend needs database access for its own purpose — they are not redundant.

## Roadmap

- ~~Streaming Pipeline~~ ✓ Completed
- ~~Dynamic Token Routing~~ ✓ Completed
- ~~Conversation Director~~ ✓ Completed (both Node.js and Pipecat)
- ~~Post-Call Analysis~~ ✓ Completed
- ~~Admin Dashboard v2~~ ✓ Completed (Vercel)
- ~~Security Hardening~~ ✓ Completed
- ~~Pipecat Migration~~ ✓ Completed (voice pipeline ported, Director ported)
- ~~Multi-Environment Workflow~~ ✓ Completed (dev/staging/prod with Neon branching + Railway environments)
- ~~Infrastructure Reliability~~ ✓ Completed (circuit breakers, feature flags, graceful shutdown, enhanced /health)
- ~~Conversation Quality~~ ✓ Completed (sentiment greetings, mid-call memory refresh, caregiver notes, per-senior settings, HNSW index)
- ~~CI/CD Pipelines~~ ✓ Completed (GitHub Actions: tests → staging → production)
- Pipecat context migration: `OpenAILLMContext` → `LLMContext` + `LLMContextAggregatorPair` (blocked — `AnthropicLLMService.create_context_aggregator()` requires `set_llm_adapter()` which only exists on `OpenAILLMContext` in v0.0.101. Revisit when pipecat updates the Anthropic adapter. Deprecation warnings are suppressed in `main.py`.)
- ~~Prompt Caching (Anthropic)~~ ✓ Completed (`enable_prompt_caching=True` in AnthropicLLMService)
- ~~Call Answer Optimization~~ ✓ Completed (parallel fetches + pre-computed snapshot + cached news: ~9s → ~2s inbound)
- ~~Observability & Reliability~~ ✓ Completed (call_metrics table, GrowthBook feature flags, circuit breakers, graceful shutdown)
- ~~HIPAA Compliance~~ ✓ Completed (audit logging, field encryption, data retention, token revocation, right-to-access export, hard delete, compliance docs, Sentry PII scrubbing)
- Telnyx Migration (65% cost savings)

---

## Business Context

Meeting notes from co-founder conversations are in `docs/meeting-notes/`.
Consult these for product direction, decisions, and priorities.

---

*Last updated: April 2026 — v5.3 with HIPAA compliance (audit logging, field encryption, data retention, token revocation, compliance docs)*
