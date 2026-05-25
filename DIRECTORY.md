# Donna Codebase Directory

> **Read this FIRST before writing any code.** This tells you what each directory does and where to make changes. Designed for AI agents — read only what's relevant to your task.

---

## Quick Reference: Where Do I Make Changes?

| I need to... | Go to |
|---|---|
| Change what Donna says / conversation behavior | `pipecat/prompts.py` (prompt text) + `pipecat/flows/nodes.py` (flow logic) |
| Add or modify LLM tools | `pipecat/flows/tools.py` (single `select_flows_tools` dispatch) |
| Add a new call type | Touch 4 files: `pipecat/prompts.py` (system + task prompts), `pipecat/flows/nodes.py` (`CALL_TYPE_INITIAL_NODES`), `pipecat/flows/tools.py` (`_CALL_TYPE_TOOL_FACTORIES`), and the queue dispatcher (`services/call-queue.js` `QUEUE_TO_PIPECAT_CALL_TYPE`) so old + new architectures both honor it |
| Change consent capture / audit | `pipecat/services/seniors.py` (`record_consent`) + `db/migrations/014_senior_consents.sql` + `pipecat/flows/tools.py` (`record_consent_response`) |
| Change discovery facts / profile suggestions | `pipecat/flows/tools.py` (`record_discovery_fact`) + `pipecat/services/post_call.py` (`_save_discovery_profile_suggestions`) + `pipecat/services/conversations.py` (`save_profile_suggestions`) |
| Gate the scheduler on consent | `services/scheduler.js` (legacy) + `services/call-schedules.js` (materializer); guard column is `seniors.callable` AND `seniors.consent_status` |
| Send caregiver notification on consent decline | `services/notifications.js` (`onConsentDeclined`) + `routes/notifications.js` (trigger dispatch) + `pipecat/services/seniors.py` (`_notify_consent_declined`) |
| Change Quick Observer pattern detection | `pipecat/processors/patterns.py` (data) + `pipecat/processors/quick_observer.py` (logic) |
| Change Conversation Director behavior | `pipecat/processors/conversation_director.py` + `pipecat/services/director_llm.py` |
| Change how calls end | `pipecat/processors/quick_observer.py` (goodbye) + `pipecat/processors/conversation_director.py` (time limits) |
| Change the voice pipeline order | `pipecat/bot.py` |
| Change post-call processing | `pipecat/services/post_call.py` |
| Change post-call analysis prompts | `pipecat/services/call_analysis.py` |
| Change memory search/storage | `pipecat/services/memory.py` |
| Change predictive prefetch | `pipecat/services/prefetch.py` (cache + extraction) + `pipecat/processors/conversation_director.py` (orchestration) |
| Change in-call web search | `pipecat/services/news.py` (Tavily/OpenAI search) + `pipecat/flows/tools.py` (Claude tool schema/handler) |
| Change greeting templates | `pipecat/services/greetings.py` |
| Change context pre-caching | `pipecat/services/context_cache.py` |
| Change reminder scheduling | `services/scheduler.js` (active polling/calls) + `routes/reminders.js`; touch `pipecat/services/reminder_delivery.py` only for in-call delivery acknowledgment |
| Change outbound call queue / dispatcher | `services/call-queue.js` (dispatch, lease, lane policy, dual-path modes) + `services/call-schedules.js` (materializer) |
| Change cross-replica Pipecat capacity reporting | `pipecat/services/capacity.py` (publisher) + `services/pipecat-capacity.js` (Node reader) |
| Change shared-state / Redis fallback behavior | `pipecat/lib/redis_client.py` (Redis + Upstash fail-closed) + `services/redis-rate-limit-store.js` (Node SlowAPI store) |
| Change call dial-authority guard | `services/call-queue.js` (`acquireOutboundCallGuard`, `markOutboundCallGuardInitiatingIfCallable`) — guards live in `outbound_call_guards` |
| Change post-call job workflow / DAG / provider semaphores | `services/post-call-jobs.js` (job types, dependency graph, retry policies, per-process provider locks) + `scripts/run-post-call-worker-once.js` (evidence worker; `--confirm-db-writes` required) |
| Inspect or replay post-call dead letters | `routes/post-call-jobs.js` (`GET /api/post-call-jobs/dead-letter`, `POST /api/post-call-jobs/:id/replay`) |
| Plan or actuate Pipecat replica capacity | `services/phase8-capacity-plan.js` (planner, PHI-free) + `services/phase8-autoscaler.js` (Railway actuator + operator override) + `services/railway-scaling.js` (CLI shell) |
| Operator overrides / one-shot autoscaler / capacity plan API | `routes/scale-operations.js` (`/api/scale-operations/phase8/{plan,autoscale-once,override}`, admin-only) |
| Run Phase 5/7 live A/B + canary reports | `scripts/phase5-live-ab-report.js`, `scripts/phase7-canary-report.js`, `scripts/phase7-canary-daily-report.js`, `scripts/phase7-canary-rollback-check.js`; runbooks `docs/operations/scale-2000-phase{5,7}-*.md` |
| Run scale-2000 drills / Phase 0 baseline / live Telnyx drill | `scripts/collect-phase0-scaling-baseline.js`, `scripts/run-live-telnyx-drill.js`, `pipecat/scripts/redis_shared_state_drill.py`; runbooks under `docs/operations/scale-2000-*.md` |
| Change per-senior call settings | `pipecat/services/seniors.py` (`get_call_settings()`) |
| Change caregiver notes delivery | `pipecat/services/caregivers.py` + `pipecat/flows/tools.py` |
| Change circuit breaker behavior | `pipecat/lib/circuit_breaker.py` |
| Change feature flags | `pipecat/lib/growthbook.py` (GrowthBook Cloud SDK) |
| Check all environment variables | `pipecat/config.py` |
| Add Pipecat API routes | `pipecat/api/routes/` |
| Change Pipecat auth/middleware | `pipecat/api/middleware/` |
| Change database queries (Python) | `pipecat/db/client.py` |
| Change Pipecat server startup | `pipecat/main.py` |
| Change Telnyx call-control/webhook path | `pipecat/api/routes/telnyx.py` + `pipecat/api/routes/call_context.py` |
| Change frontend/manual call initiation | `routes/calls.js` (Node asks Pipecat to create a Telnyx call) |
| Change admin dashboard UI | `apps/admin-v2/src/pages/` |
| Change admin API client | `apps/admin-v2/src/lib/api.ts` |
| Change public website / caregiver web app | `apps/website/src/` |
| Change admin, website, or mobile API endpoints | `routes/*.js` (Node.js — serves all /api/* for frontends) |
| Change admin API middleware/auth | `middleware/*.js` (Node.js) |
| Change database schema | `db/schema.js` (Drizzle ORM, shared app/API schema) + `pipecat/db/migrations/` (Pipecat/shared runtime additions) |
| Add/modify frontend E2E tests | `tests/e2e/` + `playwright.config.ts` — see [guide](docs/guides/FRONTEND_TESTING.md) |
| Run / extend mock call testing (LLM-vs-LLM Donna conversations) | `pipecat/tests/simulation/` — see [guide](docs/guides/MOCK_CALL_TESTING.md) for full anatomy + scenarios; `pipecat/scripts/run_simulated_demo.py` for one-off transcripts |
| Change data retention policies | `pipecat/services/data_retention.py` (Python) + `services/data-retention.js` (Node.js) |
| Change audit logging | `pipecat/services/audit.py` (Python) + `services/audit.js` (Node.js) |
| Change token revocation | `pipecat/services/token_revocation.py` (Python) + `services/token-revocation.js` (Node.js) |
| Change field encryption | `pipecat/lib/encryption.py` (Python) + `lib/encryption.js` (Node.js) |
| Review HIPAA compliance docs | `docs/compliance/` (overview, BAAs, breach notification, retention, vendor security) |

---

## Current Architecture Status (`zuludev`)

Donna currently has **two outbound-call architectures in the same codebase**:

| Architecture | Status | Main files | Scale posture |
|---|---|---|---|
| **Legacy scheduler / dialer** | Still deployed and kept as rollback authority | `services/scheduler.js`, `routes/calls.js`, `pipecat/api/routes/telnyx.py` | Good for today's lower-volume runtime, but not the 2,000-user burst target. It uses one Node scheduler leader, in-process dedupe maps, fixed legacy dial concurrency, and inline post-call work. |
| **Queue + capacity architecture** | Implemented on `zuludev`, gated by rollout flags | `services/call-queue.js`, `services/call-schedules.js`, `services/pipecat-capacity.js`, `pipecat/services/capacity.py`, `services/post-call-jobs.js`, `services/phase8-autoscaler.js` | The path to 2,000 active seniors: durable queue rows, Postgres leases/guards, Redis capacity heartbeats/reservations, canary cohorts, post-call job DAG, and pre-window replica planning. |

Do not describe the queue system as fully cut over until the environment is running `CALL_ARCHITECTURE_MODE=queue_primary` with `CALL_QUEUE_ALLOW_REAL_DIAL=true` and the Phase 7/8 evidence has been saved. Until then, legacy and queue code intentionally coexist.

The documented path beyond 2,000 users is in [`docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`](docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md#8-forward-path-to-10000-users). The 10k path is **not a completed runtime**; it is a forward plan built on the queue architecture, with explicit triggers for `ops.*`/partitioned operational tables, Redis Cluster or multi-region Redis, caller-ID pool strategy, provider sharding/failover, workflow-engine execution for post-call work, and larger retention/archive strategy.

---

## Two Backends in Production

Donna runs two backend services. Change the wrong one and nothing happens.

```
                  ┌─────────────────────────────────┐
  Phone Call ───► │  Pipecat (Python, Railway:7860)  │  Voice pipeline: STT → Observer →
  (Telnyx)        │  pipecat/ directory               │  Director → Claude → TTS
                  └──────────────┬──────────────────┘
                                 │
                     Shared DB (Neon PostgreSQL)
                                 │
                  ┌──────────────┴──────────────────┐
  Admin UI ─────► │  Node.js (Express, Railway:3001) │  Admin, website, mobile APIs,
  Website/Mobile► │  repo root: index.js              │  scheduler, call initiation
                  └─────────────────────────────────┘

  Frontends (Vercel) ──► Node.js APIs only ──► never talk to Pipecat directly
```

**Call lifecycle (Pipecat path — primary):**
1. Call arrives (inbound, scheduled, or manual; frontends initiate manual calls through Node `/api/call`)
2. Pipecat `/telnyx/events` verifies Telnyx signatures for inbound events, hydrates senior/prospect context, creates conversation records, stores encrypted call metadata, answers inbound calls, and starts a Telnyx media stream with a single-use `ws_token`
3. Telnyx connects WebSocket → `/ws` validates `call_control_id` + `ws_token` before consuming active-call capacity → **Pipecat runs full pipeline** (STT → Observer → Director → Claude → TTS)
4. Call ends → Pipecat `services/post_call.py` runs analysis, memory extraction, daily context save

**Note:** Frontends hit Node.js APIs for call initiation. The active Node `routes/calls.js` calls Pipecat `/telnyx/outbound`; Node does not call Twilio for voice. Twilio voice code is archived under `archive/twilio-voice/`. SMS notifications are inactive; `services/notifications.js` only sends email/in-app notifications while preserving legacy `smsEnabled` fields for compatibility.

**Current audio profile:** Telnyx voice uses `L16` at `16kHz` on the wire. Donna keeps the active Telnyx path linear PCM through the pipeline and uses little-endian L16 at the Telnyx WebSocket edge (`TELNYX_STREAM_CODEC=L16`, `TELNYX_STREAM_SAMPLE_RATE=16000`, `TELNYX_L16_INPUT_BYTE_ORDER=little`, `TELNYX_L16_OUTPUT_BYTE_ORDER=little`). Browser/internal TTS can still use higher-rate PCM when not constrained by a Telnyx call.

---

## Directory Map

### `pipecat/` — Voice Pipeline (Python)

The primary codebase. All voice/call features live here. **Clean architecture: no circular imports, flat service dependencies.**

```
pipecat/
├── main.py              FastAPI entry: /health, /live, /ws, graceful shutdown
├── bot.py               Pipeline assembly + audio profile + sentiment-aware greetings
├── bot_gemini.py        Gemini Live evaluation pipeline
├── config.py            All environment variables, centralized + production validation
├── prompts.py           System prompts + phase task instructions
│
├── flows/               Call state machine (Pipecat Flows)
│   ├── nodes.py         Conditional reminder → main → winding_down → closing (+ onboarding, consent, discovery)
│   │                    CALL_TYPE_INITIAL_NODES dispatch picks the entry node per call_type.
│   │                    Imports prompts from prompts.py
│   ├── tools.py         Tool factories per call type; select_flows_tools(session_state) is the
│   │                    shared dispatch used by bot.py + tests/simulation/pipeline.py.
│   │                    Subscriber: web_search, mark_reminder_acknowledged, create_reminder.
│   │                    Onboarding: web_search only.
│   │                    Consent: record_consent_response only (idempotent per consent_type).
│   │                    Discovery: record_discovery_fact + web_search.
│   └── gemini_tools.py  Gemini Live tool adapter
│
├── processors/          Frame processors in the audio pipeline
│   ├── patterns.py             250+ regex patterns across 19 Quick Observer categories
│   ├── quick_observer.py       Layer 1: analysis logic + goodbye detection
│   ├── conversation_director.py Layer 2: Split Director (Query + Guidance) + memory/news injection + ephemeral context
│   ├── conversation_tracker.py  Tracks topics/questions/advice per call
│   ├── metrics_logger.py        Call metrics + prefetch stats logging
│   ├── goodbye_gate.py          False-goodbye grace period — NOT in active pipeline
│   └── guidance_stripper.py     Strips <guidance> tags before TTS
│
├── services/            Business logic — mostly independent, DB-only deps
│   ├── scheduler.py         Pipecat-side reminder polling helpers + Redis context handoff; Node scheduler is active
│   ├── reminder_delivery.py Delivery CRUD + prompt formatting
│   ├── post_call.py         Post-call orchestration: analysis, memory, cleanup, snapshot rebuild
│   ├── memory.py            Semantic memory: pgvector, HNSW, decay, dedup, circuit breaker
│   ├── prefetch.py          Predictive Context Engine: cache, extraction, runner
│   ├── director_llm.py      Split Director LLM: Query Director (~200ms) + Guidance Director (~400ms)
│   ├── call_snapshot.py     Pre-computed call context snapshot for seniors
│   ├── context_cache.py     Pre-cache senior context + news at 5 AM
│   ├── call_analysis.py     Post-call analysis via Gemini + call quality
│   ├── interest_discovery.py Interest extraction from conversations
│   ├── greetings.py         Sentiment-aware greeting templates + rotation
│   ├── conversations.py     Conversation CRUD
│   ├── daily_context.py     Same-day cross-call memory
│   ├── seniors.py           Senior profile + per-senior call_settings
│   ├── news.py              OpenAI cached news; in-call web_search uses Tavily first, OpenAI fallback
│   ├── caregivers.py        Caregiver relationships + notes delivery
│   ├── data_retention.py    HIPAA data retention: batched purge of 7 tables
│   ├── audit.py             Fire-and-forget HIPAA audit logging
│   ├── token_revocation.py  JWT token revocation: per-token + per-admin + expired cleanup
│   ├── capacity.py          Per-replica capacity heartbeat published to Redis (5s publish, 15s TTL) for Node dispatcher
│   └── hard_delete.py       Right-to-delete cascade purge (child→parent order, post_call_jobs first)
│
├── lib/                 Shared utilities
│   ├── circuit_breaker.py   Async circuit breaker for external services
│   ├── encryption.py        AES-256-GCM field-level PHI encryption
│   ├── redis_client.py      Shared Redis client helpers
│   ├── growthbook.py        GrowthBook Cloud SDK feature flags
│   ├── phi.py               PHI-safe serialization helpers
│   ├── shared_state_phi.py  Encrypted shared-state payload helpers
│   └── sanitize.py          PII masking for logs
│
├── api/                 HTTP layer
│   ├── routes/telnyx.py     /telnyx/events, /telnyx/outbound, /telnyx/calls/{id}/end
│   ├── routes/call_context.py Shared encrypted call metadata + senior context hydration
│   ├── routes/voice.py      Archived Twilio placeholder; implementation lives in archive/twilio-voice
│   ├── routes/calls.py      /api/call, /api/calls
│   ├── routes/auth.py       Token revocation: /api/admin/revoke-token, revoke-all, logout
│   ├── routes/export.py     HIPAA right-to-access: /api/seniors/{id}/export (full data bundle)
│   ├── routes/data.py       Data retention management endpoints
│   ├── middleware/           auth, api_auth, rate_limit, security, error_handler
│   └── validators/schemas.py  Pydantic request validation
│
├── db/
│   ├── client.py            asyncpg pool + query helpers + health check
│   └── migrations/          SQL migrations (HNSW, snapshots, audit_logs, revoked_tokens, encrypted_phi)
├── tests/               Unit, regression, integration, and scenario tests
├── docs/ARCHITECTURE.md Full architecture docs
├── docs/LEARNINGS.md    Engineering learnings from production debugging
├── pyproject.toml       Python 3.12, dependencies
└── Dockerfile           python:3.12-slim + uv
```

**Service dependency graph** (most services only import `db`):
```
context_cache → seniors, conversations, memory, greetings, news  (orchestrator, persists cached news)
call_snapshot → conversations, daily_context                     (rebuilds snapshot post-call)
scheduler → memory, context_cache                           (needs context for calls)
memory, news → lib/circuit_breaker                          (external service resilience)
All other services → db only                                (independent)
```

### `apps/` — Frontend Applications (React, Vercel)

All frontends call Node.js `/api/*` endpoints. They never talk to Pipecat.

```
apps/
├── admin-v2/        PRIMARY admin dashboard (React + Vite + Tailwind)
│   ├── src/pages/   Dashboard, Seniors, Calls, Reminders, CallAnalyses, Caregivers, Login
│   ├── src/lib/     api.ts (API client → Node.js), auth.ts (JWT)
│   └── Live: https://admin-v2-liart.vercel.app
│
├── website/         Public website + caregiver web app (React + Vite + Clerk auth)
│   ├── src/pages/   Legal pages
│   ├── src/onboarding/  Signup/onboarding flow
│   ├── src/dashboard/   Caregiver dashboard
│   └── Live: https://calldonna.co
│
├── mobile/          Active iOS/Android caregiver app (Expo + React Native + Clerk)
│   ├── app/(auth)/       Sign-in, create-account, password reset, OAuth/Apple auth
│   ├── app/(onboarding)/ Fresh caregiver setup; creates senior through Node /api/onboarding
│   ├── app/(tabs)/       Dashboard, schedule, reminders, settings
│   ├── src/lib/          API client, runtime config, auth cache, onboarding-session marker
│   ├── src/stores/       Encrypted onboarding draft store
│   ├── .maestro/         Mobile E2E flows and subflows
│   └── EAS: @dmdzco/donna-caregiver / com.donna.caregiver
│
├── _old-consumer-do-not-use/  Archived previous caregiver web app
│
└── observability/   Call monitoring dashboard (REST polling, low use)
```

**Mobile onboarding invariant:** a Clerk user without a Donna profile is not a valid sign-in destination. Fresh setup must start from the visible Create Account flow, which marks a runtime pending-onboarding session before profile creation. If a no-profile Clerk session appears after app restart or sign-in, `AuthGuard` calls Node `DELETE /api/caregivers/me/incomplete-account`, clears the encrypted onboarding draft, signs out locally, and returns to landing. Maestro flows `10_onboarding_full.yaml`, `12_incomplete_account_cleanup.yaml`, and `13_leave_setup_cleanup.yaml` cover the success, abandoned-account, and explicit leave-setup paths.

### `tests/e2e/` — Frontend E2E Tests (Playwright)

Browser tests for all 3 frontend apps. Mock API responses by default (no backend needed).

```
tests/e2e/
├── global.setup.ts              Clerk testing token initialization
├── fixtures/
│   ├── test-data.ts             Mock data (seniors, calls, reminders, etc.)
│   ├── auth.ts                  JWT auth helpers for admin/observability
│   └── api-mocks.ts             page.route() API mock setup functions
├── admin/                       Admin dashboard tests
│   ├── login.spec.ts            Login flow, error handling
│   ├── navigation.spec.ts       Sidebar navigation, responsive layout
│   ├── seniors.spec.ts          Senior list, create form
│   ├── calls.spec.ts            Call history, transcript modal
│   └── reminders.spec.ts        Reminder CRUD
├── consumer/                    Website/caregiver app tests (legacy directory name)
│   ├── landing.spec.ts          Landing page, FAQ (public)
│   ├── dashboard.spec.ts        Protected route redirects (public)
│   ├── security.spec.ts         Signup storage/PHI credential persistence + same-origin waitlist routing
│   └── authenticated/           Clerk-authenticated tests
│       ├── dashboard.spec.ts    Dashboard access, nav, sign out
│       └── onboarding.spec.ts   Onboarding flow access
├── observability/               Observability tests
│   ├── history.spec.ts          Call history, timeline
│   └── navigation.spec.ts       History/Live toggle, view switching
└── integration/                 Real API integration tests (excluded by default)
    └── admin-smoke.spec.ts      Smoke test against live admin app
```

Config: `playwright.config.ts` (root). Guide: [`docs/guides/FRONTEND_TESTING.md`](docs/guides/FRONTEND_TESTING.md).

### Root — Build & Deploy Tooling

```
/
├── Makefile                     Deploy commands: make deploy-dev, make test, etc.
├── scripts/
│   ├── setup-environments.sh             One-time setup: Neon branches + Railway dev env
│   ├── create-admin.js                   Admin user creation
│   ├── collect-phase0-scaling-baseline.js  Phase 0 baseline aggregator (PHI-free, percentile-only)
│   ├── generate-phase0-cost-model.js     Phase 0 cost projection from baseline + assumptions JSON
│   ├── phi-sentinel-scan.js              Daily PHI sentinel scan (counts only, no matched lines)
│   ├── phase1-idempotency-preflight.js   Phase 1 schema/idempotency guard readiness check
│   ├── backfill-reminder-delivery-keys.js  Race-safe delivery_key backfill with collision detection
│   ├── backfill-call-schedules.js        preferredCallTimes → senior_call_schedules migration
│   ├── run-live-telnyx-drill.js          Phase 0/5 staging live-call drill (consenting test phones only)
│   ├── validate-call-rollout-config.js   Validate CALL_ARCHITECTURE_MODE + queue flags before flip
│   ├── phase5-live-ab-report.js          Phase 5 live A/B report (aggregate counters, PHI-free)
│   ├── phase7-canary-daily-report.js     Phase 7 daily canary SLO report (setup latency/success, duplicates, post-call completion; p95 post-call latency is informational)
│   ├── phase7-canary-report.js           Aggregate Phase 7 exit report (reuses Phase 5 + adds allowlist size, 7-day SLO, PHI sentinel, P0/P1 incidents)
│   ├── run-phase8-autoscaler-once.js     Phase 8 autoscaler single-tick driver (dry-run unless `--confirm-scale`)
│   └── run-post-call-worker-once.js      Phase 6 post-call worker evidence runner (`--confirm-db-writes` required; artifact_verification validates existing artifacts while mutating worker lease/status rows)
├── .github/workflows/
│   ├── ci.yml                   PR pipeline: tests/checks only; staging deploy + smoke tests are push-gated
│   └── deploy.yml               Production deploy on push to main
```

### Root Node.js — Admin APIs + Scheduler (Active)

Serves all API endpoints that frontends consume. Also runs the reminder scheduler.

```
/
├── index.js             Express server entry — CORS, middleware, GrowthBook, scheduler start
│
├── routes/              Frontend-facing /api/* endpoints plus public health/waitlist
│   ├── calls.js         /api/call — initiate manual outbound call through Pipecat /telnyx/outbound
│   ├── seniors.js       CRUD /api/seniors
│   ├── reminders.js     CRUD /api/reminders + delivery tracking
│   ├── observability.js Call monitoring endpoints
│   ├── notifications.js Notification preferences, in-app notifications, service-triggered sends
│   ├── waitlist.js      Public /waitlist endpoint
│   ├── onboarding.js    Consumer onboarding flow
│   ├── caregivers.js    Caregiver links, current profile, account deletion, incomplete onboarding cleanup
│   ├── admin-auth.js    JWT admin login
│   ├── stats.js         Dashboard statistics
│   ├── memories.js      Memory search/store
│   ├── daily-context.js Daily context queries
│   ├── conversations.js Conversation history
│   ├── call-analyses.js Analysis results
│   ├── post-call-jobs.js Phase 6 admin: list dead-letter jobs + replay one (`requireAdmin`)
│   ├── scale-operations.js Phase 8 admin: capacity plan, autoscaler one-shot, operator override (`requireAdmin`)
│   ├── canary.js       Phase 7 admin canary cohort membership (`requireAdmin`, senior IDs only)
│   └── health.js, helpers.js, index.js
│
├── services/            Dual implementation with pipecat/services/
│   ├── scheduler.js     Active reminder polling + outbound calls; materializes call_queue rows in shadow/canary/queue modes and acquires outbound guard outside legacy_only
│   ├── call-queue.js    Outbound dispatcher: FOR UPDATE SKIP LOCKED leasing, lane policy, dual-path modes (shadow_materialize → shadow_dispatch → canary_queue → queue_primary), reconciler
│   ├── call-schedules.js Materializer: normalizes preferredCallTimes → senior_call_schedules → call_queue rows
│   ├── pipecat-capacity.js Node reader of pipecat:instance:* heartbeats (Redis/Upstash/none; no local heartbeat registry fallback)
│   ├── redis-rate-limit-store.js Distributed rate-limit store for Node SlowAPI equivalent
│   ├── post-call-jobs.js Phase 6 post-call DAG: 8 job types, dependency graph, retry policies, provider semaphores (db/geminiFlash/openAiEmbeddings/resend), dead-letter handling
│   ├── phase8-capacity-plan.js Phase 8 PHI-free capacity planner (call_queue demand + heartbeats + budget checks)
│   ├── phase8-autoscaler.js Phase 8 actuator: reads capacity plan, applies Railway scale (dry-run by default), operator overrides
│   ├── railway-scaling.js Railway CLI shell (`railway scale REGION=REPLICAS`)
│   ├── canary-cohort.js Phase 7 canary membership source of truth; env allowlist remains emergency fallback
│   ├── context-cache.js Pre-cache senior context
│   ├── memory.js        Semantic memory, pgvector
│   ├── call-analyses.js Post-call analysis API queries
│   ├── notifications.js Notification preferences + send helpers
│   ├── weekly-report.js Weekly caregiver report helpers
│   ├── greetings.js     Greeting templates
│   ├── conversations.js Conversation CRUD
│   ├── news.js          OpenAI cached news helper
│   ├── caregivers.js    Caregiver relationships
│   ├── seniors.js       Senior profiles
│   ├── audit.js         HIPAA audit logging helpers; some latency-sensitive paths are best-effort while exports/deletes have stricter persistence requirements
│   ├── token-revocation.js  JWT token revocation (per-token + per-admin + cleanup)
│   └── data-retention.js    HIPAA data retention purge
│
├── middleware/
│   ├── auth.js          Clerk + JWT mixed auth
│   ├── validate.js      Zod request validation
│   ├── idempotency.js   Idempotency middleware for safe retries
│   ├── rate-limit.js    5 rate limiter configs
│   ├── api-auth.js      API key auth
│   ├── security.js      Security headers
│   └── error-handler.js Error formatting
│
├── db/
│   ├── schema.js        Drizzle tables for seniors, reminders, notifications, waitlist, audit logs, etc.
│   ├── client.js        Neon PostgreSQL + Drizzle ORM init
│   ├── setup-pgvector.js
│   └── migrations/      Queue rollout tables/indexes: 010 foundation, 011 concurrent indexes, 012 post-call job state machine, 013 canary cohort membership. Pipecat mirrors queue/job migrations as 023/024/025; canary membership is Node-owned.
│
├── validators/schemas.js  Zod validation schemas
├── lib/                   logger.js, sanitize.js, encryption.js (AES-256-GCM PHI encryption)
└── tests/                 Node fixtures, helpers, mocks, and integration tests
```

**Dual implementations (by design):** Every `services/*.js` file has an equivalent `pipecat/services/*.py`. Both read/write the same database. This is intentional — each backend needs DB access for its own responsibilities. If you change DB schema or query logic, check both.

### `docs/` — Documentation

```
docs/
├── operations/                   Operational runbooks (active rollouts)
│   ├── scale-2000-phase0-readiness.md         Phase 0 baseline + decision-log gate
│   ├── scale-2000-phase1-migration-runbook.md Queue/idempotency migration order + safety
│   ├── scale-2000-live-drills.md              Staging dual-path scheduler + live Telnyx drill
│   ├── scale-2000-phase5-live-ab-runbook.md   Phase 5 live A/B and rollback timing drill
│   ├── scale-2000-phase7-canary-runbook.md    Phase 7 5→10→25 senior live canary + daily report
│   ├── scale-2000-phase8-capacity-runbook.md  Phase 8 pre-window capacity plan + autoscaler tick
│   └── templates/                             phase0-cost-assumptions JSON templates
├── architecture/                 Architecture suite (current, authoritative)
│   (see also: pipecat/docs/LEARNINGS.md for engineering learnings)
│   ├── OVERVIEW.md               High-level architecture
│   ├── ARCHITECTURE.md           System architecture reference
│   ├── FEATURES.md               Complete product feature inventory
│   ├── SECURITY.md               Authentication, validation, PII
│   ├── SCALABILITY.md            Legacy vs queue scale architecture, 2,000-user target, and 10k path
│   ├── COST.md                   Per-call cost breakdown
│   ├── TESTING.md                3-level test architecture
│   └── PERFORMANCE.md            Latency, prefetch, circuit breakers
├── compliance/                   HIPAA compliance documentation
│   ├── HIPAA_OVERVIEW.md         Full HIPAA compliance status (safeguards, controls, gaps)
│   ├── BAA_TRACKER.md            16 vendor BAA status and tracking
│   ├── BREACH_NOTIFICATION.md    Incident response runbook + notification procedures
│   ├── DATA_RETENTION_POLICY.md  Retention schedule per table + purge procedures
│   └── VENDOR_SECURITY_EVALUATION.md  16 vendor security evaluations
├── plans/
│   ├── PROTOTYPE_PILOT_BACKLOG.md               Current pilot backlog
│   ├── 2026-05-05-engineering-remediation-plan.md Current remediation plan
│   └── archive/                                  Historical dated plans and old bug tracker
└── decisions/
    ├── DONNA_ON_PIPECAT.md       Pipecat migration architecture (reference)
    └── VOICE_AI_FRAMEWORK_ANALYSIS.md  Framework comparison (reference)
```

---

## Architectural Patterns (Follow These)

1. **Lazy client init** — Services use `_client = None` + `_get_client()`. Never instantiate API clients at import time.

2. **Closure-based tool handlers** — `flows/tools.py` creates handlers via closure over `session_state` dict. This is how per-call state flows through Pipecat.

3. **In-memory + Redis caching** — `context_cache.py`, `news.py`, and scheduler handoff maps use module-level dicts first. Call metadata and reminder context are also encrypted into Redis when shared state is configured.

4. **Async everywhere** — All Python service functions are `async`. DB is `asyncpg`. Use `asyncio.create_task()` for fire-and-forget work.

5. **PII-safe logging** — Always use `lib/sanitize.py` when logging user data. Never log phone numbers or conversation content raw.

6. **Processors are pipeline-independent** — Quick Observer, Director, Tracker don't import services (except Director→director_llm). They process frames and pass them downstream.

7. **Fire-and-forget audit logging** — All PHI access is logged via `log_audit()` / `logAudit()`. Never awaited in the request path — uses `asyncio.create_task()` (Python) or unawaited `.then().catch()` (Node.js).

8. **Dual-column encryption** — PHI fields have `*_encrypted` companion columns. New writes encrypt to both. Reads prefer encrypted, fall back to plaintext. Gradual migration via backfill scripts.

9. **Dual-key JWT rotation** — `JWT_SECRET` + `JWT_SECRET_PREVIOUS` for zero-downtime credential rotation. Remove previous key after all old tokens expire (7 days).

---

## High-Context Files

Only load these when your task specifically requires them.

| File | Why it needs focus |
|---|---|
| `pipecat/processors/patterns.py` | Large Quick Observer regex pattern data |
| `pipecat/services/scheduler.py` | Pipecat-side scheduler helpers/context handoff; Node scheduler is active |
| `pipecat/services/memory.py` | pgvector, HNSW, circuit breaker, and mid-call refresh |
| `pipecat/processors/quick_observer.py` | Analysis logic, goodbye detection, and model recommendations |
| `pipecat/services/director_llm.py` | Groq/Gemini Director prompts and response parsing |
| `pipecat/bot.py` | Pipeline assembly, audio profile, and sentiment greetings |
| `pipecat/flows/nodes.py` | Subscriber/onboarding flow config and context builders |
| `services/scheduler.js` | Active Node.js reminder polling + outbound dispatch + dual-path coexistence (legacy plan, queue shadow materialize, shadow dispatch, queue dispatch) |
| `services/call-queue.js` | Dispatcher core: enqueue, lease, lane policy, reconciler, modes |
| `services/pipecat-capacity.js` | Cross-replica capacity registry reader with Redis/Upstash/none; queue code falls back to batch-size capacity only when the registry is not required |
| `routes/observability.js` | Call monitoring and metrics aggregation |

---

## Testing

```bash
# All tests (Python + Node.js)
make test

# Pipecat only
make test-python

# Regression scenario tests
make test-regression

# Node.js
npm test

# Frontend E2E tests (Playwright — all 3 apps)
npm run test:e2e                  # Full suite (~15s)
npm run test:e2e:admin            # Admin dashboard only
npm run test:e2e:consumer         # Website public project only
npx playwright test --project=clerk-setup --project=consumer-authenticated  # Website authenticated project
npm run test:e2e:observability    # Observability dashboard only
npx playwright test --ui          # Interactive debug mode
```

Python test files follow `pipecat/tests/test_<module>.py` naming. Regression scenarios in `pipecat/tests/scenarios/`.

Frontend E2E tests are in `tests/e2e/` — see [`docs/guides/FRONTEND_TESTING.md`](docs/guides/FRONTEND_TESTING.md) for full guide.

---

## Deployment

Three environments: **dev** (experiments), **staging** (CI), **production** (customers). Each has its own Neon DB branch and Telnyx number for voice.

```bash
# Deploy to dev (your iteration environment)
make deploy-dev              # Both services
make deploy-dev-pipecat      # Just Pipecat (faster)

# Deploy to production
make deploy-prod             # Or push to main → auto-deploys via CI

# Health checks & logs
make health-dev
make logs-dev

# Admin dashboard (Vercel)
cd apps/admin-v2 && npx vercel --prod --yes

# First-time setup (creates Neon branches + Railway env vars)
make setup
```

Workflow: `edit → make deploy-dev-pipecat → call dev number → repeat`

---

*Source of truth for codebase navigation. Update when directories or responsibilities change. Last updated: May 2026.*
