# Donna Project - AI Context

> **AI Assistants**: You have permission to update this file as the project evolves. Keep it accurate and current.

## MANDATORY: Read Before Coding

**Before writing or modifying any code, read [`DIRECTORY.md`](DIRECTORY.md).** It is the source of truth for:
- What each directory does and whether it's active or legacy
- Which backend (Pipecat Python vs Node.js Express) owns which functionality
- Exactly which file to open for any given task

Do NOT confuse the Node.js `services/` with `pipecat/services/` — they are separate implementations sharing the same database.

---

## Project Goal

**Donna** is an AI-powered companion that makes friendly phone calls to elderly individuals (70+): daily check-ins, everyday/social reminders, companionship, and caregiver summaries.



---

## Architecture Decision: Two Backends

Running separate Python and Node.js backends is an **explicit decision**, not tech debt:
- **Pipecat (Python, `pipecat/`)** — Real-time voice pipeline (STT, Observer, Director, Claude, TTS). Runs on Railway service `donna-pipecat`, port 7860.
- **Node.js (Express, repo root)** — REST APIs for admin/website/mobile, reminder scheduler, call initiation. Runs on Railway service `donna-api`, port 3001.

Both share the same Neon PostgreSQL database. Dual service implementations (e.g. `services/memory.js` and `pipecat/services/memory.py`) exist because each backend needs DB access for its own purpose — they are **not** redundant.

**Deeper reading:**
- Pipeline diagram, frame flow, Observer/Director layers → [`pipecat/docs/ARCHITECTURE.md`](pipecat/docs/ARCHITECTURE.md)
- Production debugging learnings → [`pipecat/docs/LEARNINGS.md`](pipecat/docs/LEARNINGS.md)
- Architecture/security/scalability/cost/perf → [`docs/architecture/`](docs/architecture/)
- HIPAA program (audit, retention, BAAs, breach, vendors) → [`docs/compliance/`](docs/compliance/)
- Frontend E2E testing → [`docs/guides/FRONTEND_TESTING.md`](docs/guides/FRONTEND_TESTING.md)

### Voice pipeline at a glance

```
Telnyx → Deepgram STT → Quick Observer (regex, 0ms) → Conversation Director (Groq, background) → Claude Haiku 4.5 + Pipecat Flows → ElevenLabs TTS → Telnyx
```

- **Quick Observer** injects guidance for the current turn via `LLMMessagesAppendFrame(run_llm=False)` and triggers the programmatic call-end EndFrame on strong goodbyes (after a minimum call-age guard).
- **Split Conversation Director** is two Groq calls — Query Director (memory queries on interims) and Guidance Director (silence-based speculative). Director-owned context injection means Claude has no live `search_memories` tool.
- **Pipecat Flows** runs a 4-phase state machine for subscriber calls: opening → main → winding_down → closing. Dedicated flows live alongside it: `new_customer` (prospect/inbound), `consent` (capture call + recording permission), `discovery` (friends/hobbies/routines, including first senior call retry lifecycle).
- **Claude tools in main flow:** `web_search` (Tavily → OpenAI fallback) and `mark_reminder_acknowledged` (fire-and-forget). Everything else is Director/post-call. Other call types expose call-type-specific tools via `flows.tools.select_flows_tools`.
- **Consent calls bypass the Director.** `ConversationDirectorProcessor.process_frame` short-circuits when `call_type == "consent"` — script-driven flow, no improvisation. Scheduler gates dispatch on `seniors.callable = true AND seniors.consent_status = 'granted'`; existing seniors are grandfathered to `granted` by migration 014.
- **Post-call:** subscriber analysis (Claude Haiku forced tool-use), memory extraction (OpenAI), interest discovery, daily-context save, encrypted snapshot rebuild. Discovery calls additionally write a caregiver-reviewable `profile_suggestions` JSONB on `conversations`. Consent declines fire-and-forget POST to `/api/notifications/trigger` with `event_type=consent_declined`.

### Outbound Dispatch — Dual-Path Rollout (Phases 0–8 infra on `zuludev`; runtime defaults still legacy + inline post-call until canary flip)

Outbound dialing is mid-migration from the legacy in-process scheduler to a durable queue dispatcher. Both paths run side-by-side during rollout, gated by `CALL_ARCHITECTURE_MODE`. A shared dial-authority guard (`outbound_call_guards.guard_key`, unique) ensures only one path dials per call.

| `CALL_ARCHITECTURE_MODE` | Legacy dials? | Queue does | Real queue dial? |
|---|---|---|---|
| `legacy_only` | yes (no guard) | nothing | no |
| `shadow_materialize` | yes (guarded) | inserts queue rows for comparison | no |
| `shadow_dispatch` | yes (guarded) | dry-run leases + shadow comparisons | no |
| `canary_queue` | yes (non-canary, guarded) | leases canary cohort | yes (gated by `CALL_QUEUE_ALLOW_REAL_DIAL=true` + cohort selector) |
| `queue_primary` | no | leases everything | yes |
| `legacy_rollback` | yes (guarded) | off | no |

**Load-bearing primitives.** Postgres decides *what* (queue rows, leases, guards, attempts, post-call jobs); Redis decides *what is running right now* (capacity heartbeats, dedupe). `services/call-queue.js` leases via `FOR UPDATE SKIP LOCKED`. `pipecat/services/capacity.py` publishes heartbeats at `pipecat:instance:{id}` (5 s publish, 15 s TTL). `PIPECAT_REQUIRE_REDIS=true` fails closed at startup; `REDIS_RATE_LIMITS_ENABLED=true` makes SlowAPI fail closed under Redis outage. Materializer is canary-blind by design — cohort selection happens at dispatch, not at insert.

**Post-call job workflow (Phase 6).** `services/post-call-jobs.js` defines the 8-job DAG (`metrics_finalize`, `reminder_recovery`, `analysis`, `memory_extraction`, `daily_context`, `caregiver_notifications`, `interest_discovery`, `snapshot_rebuild`) with per-provider semaphores (`db=200`, `anthropicHaiku=1`, `geminiFlash=1`, `openAiEmbeddings=1`, `resend=1`) and per-type retry policies. Current JS handlers validate artifacts; inline Pipecat post-call analysis uses Claude Haiku. Terminal failures move to `dead_letter` (migration 012 adds `depends_on`, `dead_lettered_at`, `dead_letter_reason`); admins inspect/replay via `routes/post-call-jobs.js`. **Activation is gated**: Pipecat enqueues only when `POST_CALL_QUEUE_ENABLED=true`; the Node worker has no continuous loop in `index.js` and runs via `scripts/run-post-call-worker-once.js` (shadow mode). Inline `pipecat/services/post_call.py` is still the active path until the canary flip.

**Capacity planning (Phase 7/8).** `scripts/phase7-canary-report.js` produces daily aggregate-only reports for the 5→10→25 live canary. `services/phase8-capacity-plan.js` reads future `call_queue` rows, current backlog, critical post-call backlog, and `pipecat:instance:*` heartbeats to recommend `scale_up`/`hold`/`scale_down`/`wait_for_readiness`. `services/phase8-autoscaler.js` actuates via `services/railway-scaling.js` (`railway scale REGION=REPLICAS`); the long-running loop in `index.js` only starts when `PHASE8_AUTOSCALER_ENABLED=true` and requires `PHASE8_AUTOSCALER_CONFIRM_SCALE=true` + budget-pass to apply. Admin override at `POST /api/scale-operations/phase8/override`.

Plan and runbooks: [`docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`](docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md), [`docs/operations/scale-2000-*.md`](docs/operations/) (phase 0/1/5/7/8 + live drills).

---

## When Making Changes — File Lookup

| Task | Where to look |
|------|---------------|
| Conversation behavior / prompts | `pipecat/prompts.py` + `pipecat/flows/nodes.py` |
| LLM tools (schemas + handlers) | `pipecat/flows/tools.py` — `select_flows_tools` is the per-call-type dispatch |
| Add a new call type | `pipecat/prompts.py` + `pipecat/flows/nodes.py` (`CALL_TYPE_INITIAL_NODES`) + `pipecat/flows/tools.py` (`_CALL_TYPE_TOOL_FACTORIES`) + `services/call-queue.js` (`QUEUE_TO_PIPECAT_CALL_TYPE`). Wire old (`scheduler.js`) + new (`call-schedules.js`) dispatch paths together. |
| Consent flow (call_type=consent) | `pipecat/prompts.py` (`CONSENT_*`) + `pipecat/flows/nodes.py` (`build_consent_node`) + `pipecat/flows/tools.py` (`record_consent_response`) + `pipecat/services/seniors.py` (`record_consent` + `_notify_consent_declined`) |
| Discovery flow (call_type=discovery) | `pipecat/prompts.py` (`DISCOVERY_*`) + `pipecat/flows/nodes.py` (`build_discovery_node`) + `pipecat/flows/tools.py` (`record_discovery_fact`) + `pipecat/services/post_call.py` (`_save_discovery_profile_suggestions`) |
| Quick Observer patterns / logic | `pipecat/processors/patterns.py` + `pipecat/processors/quick_observer.py` |
| Conversation Director | `pipecat/processors/conversation_director.py` + `pipecat/services/director_llm.py` |
| Call ending behavior | `pipecat/processors/quick_observer.py` (goodbye) + `pipecat/processors/conversation_director.py` (time-based) |
| Pipeline assembly | `pipecat/bot.py` |
| Post-call processing | `pipecat/services/post_call.py` + `pipecat/services/call_snapshot.py` |
| Post-call analysis | `pipecat/services/call_analysis.py` |
| Memory / pgvector | `pipecat/services/memory.py` |
| Predictive prefetch | `pipecat/services/prefetch.py` + `pipecat/processors/conversation_director.py` |
| Greeting templates | `pipecat/services/greetings.py` |
| Context pre-cache (5 AM local) | `pipecat/services/context_cache.py` |
| Cross-call daily context | `pipecat/services/daily_context.py` |
| Reminder scheduling | `pipecat/services/scheduler.py` + `pipecat/services/reminder_delivery.py` |
| Outbound dispatcher / queue / lane policy | `services/call-queue.js` (Node; lease, dispatch, modes) + `services/call-schedules.js` (materializer) |
| Cross-replica capacity reporting | `pipecat/services/capacity.py` (publisher, 5s/15s TTL) + `services/pipecat-capacity.js` (Node reader) |
| Dial-authority guard | `services/call-queue.js` (`acquireOutboundCallGuard` + `markOutboundCallGuardInitiatingIfCallable`) — table `outbound_call_guards` |
| Shared-state / Redis fail-closed | `pipecat/lib/redis_client.py` (`require_shared_state`, Upstash circuit-breaker) |
| Post-call workflow / dead letters | `services/post-call-jobs.js` (DAG + provider semaphores) + `routes/post-call-jobs.js` (dead-letter admin) + `scripts/run-post-call-worker-once.js` (shadow runner) |
| Capacity planning / autoscaler | `services/phase8-capacity-plan.js` (planner) + `services/phase8-autoscaler.js` (actuator) + `services/railway-scaling.js` (CLI) + `routes/scale-operations.js` (admin) |
| Phase 5/7 live A/B + canary reports | `scripts/phase5-live-ab-report.js`, `scripts/phase7-canary-report.js`; runbooks in `docs/operations/scale-2000-phase{5,7}-*.md` |
| Scale-2000 drills + runbooks | `scripts/run-live-telnyx-drill.js`, `pipecat/scripts/redis_shared_state_drill.py`; `docs/operations/scale-2000-*.md` |
| Per-senior call settings | `pipecat/services/seniors.py` (`get_call_settings()`) |
| Caregiver notes | `pipecat/services/caregivers.py` + `pipecat/flows/tools.py` |
| Circuit breakers | `pipecat/lib/circuit_breaker.py` |
| Feature flags (GrowthBook) | `pipecat/lib/growthbook.py` + `lib/growthbook.js` |
| Env vars | `pipecat/config.py` |
| API routes / middleware (Pipecat) | `pipecat/api/routes/` + `pipecat/api/middleware/` |
| DB queries | `pipecat/db/client.py` |
| Server / graceful shutdown | `pipecat/main.py` |
| Data retention | `pipecat/services/data_retention.py` + `services/data-retention.js` |
| Audit logging | `pipecat/services/audit.py` + `services/audit.js` |
| Token revocation | `pipecat/services/token_revocation.py` + `services/token-revocation.js` |
| Field encryption (PHI) | `pipecat/lib/encryption.py` + `lib/encryption.js` |
| Admin UI / API client | `apps/admin-v2/src/pages/` + `apps/admin-v2/src/lib/api.ts` |
| Route error handling (Node) | `routes/helpers.js` (`routeError()`) |
| Mobile error display | `apps/mobile/src/lib/api.ts` (`getErrorMessage()`) |
| Zod schemas | `validators/schemas.js` — **do NOT add `.transform()` for DB-bound fields** |
| Frontend E2E tests | `tests/e2e/` — see [`docs/guides/FRONTEND_TESTING.md`](docs/guides/FRONTEND_TESTING.md) |
| LLM voice simulation tests | `pipecat/tests/simulation/` + `pipecat/tests/test_live_simulation.py` |
| Mock call testing (LLM-vs-LLM, see actual transcripts) | Guide: [`docs/guides/MOCK_CALL_TESTING.md`](docs/guides/MOCK_CALL_TESTING.md). One-liner: `cd pipecat && railway run --environment dev --service donna-pipecat -- uv run python scripts/run_simulated_demo.py --scenario web_search` |

---

## Development Workflow

### Git worktrees

- Prefer a separate `git worktree` for concurrent branch work, risky merges, rebases, release prep, or any task where the current checkout has user changes.
- One working tree can only have one branch checked out. Do not switch branches in a checkout the user is actively using when a parallel worktree would avoid disrupting them.
- Keep worktrees as sibling directories under `/Users/davidzuluaga/code/`, using descriptive names like `donna2-mobile-fix` or `donna2-main-merge`.
- Check existing worktrees first with `git worktree list`; reuse a suitable clean worktree when possible.
- For Claude Code sessions, prefer `claude --worktree --tmux` when starting isolated branch work.
- For Codex sessions, create the worktree explicitly, for example `git worktree add ../donna2-mobile-fix -b codex/mobile-fix origin/main`, then start Codex from that directory.

Three environments, fully isolated (own Railway services, own Neon DB branch, own Telnyx number):

| Env | Database | Voice # |
|---|---|---|
| **production** | Neon `main` | +18064508649 |
| **staging** | Neon `staging` | +19789235477 |
| **dev** | Neon `dev` | +19789235477 |

Railway environments are **not** tied to git branches — `make deploy-dev` uploads your working directory. The only automated git→deploy hooks: PR to `main` deploys staging; push to `main` deploys production.

```bash
# Deploy
make deploy-dev              # Both services to dev
make deploy-dev-pipecat      # Just Pipecat (fastest for voice changes)
make deploy-staging
make deploy-prod

# Health + logs
make health-dev / health-prod
make logs-dev / logs-prod    # Tails Pipecat (voice/call) logs

# Tests
make test                    # Python + Node.js
make test-regression         # Scenario tests, also runs in CI
npm run test:e2e             # Playwright across all frontends
```

**Do NOT test voice features locally with ngrok** — always deploy to the dev Railway environment.

### Railway logs gotcha

The Railway CLI in repo root is linked to `donna-api` (Node.js). Bare `railway logs` shows API logs, **not voice pipeline logs**.

| Looking for | Service | Command |
|---|---|---|
| Voice call, STT, Director, Claude, TTS, post-call | `donna-pipecat` | `make logs-prod` or `railway logs --service donna-pipecat --environment production` |
| API requests, call initiation, reminder scheduler | `donna-api` | `railway logs --service donna-api --environment production` |

### Admin v2 (Vercel)

```bash
cd apps/admin-v2 && npx vercel --prod --yes
# Live: https://admin-v2-liart.vercel.app
```

---

## Commit Messages & PR Titles

Write commit messages and PR squash titles that are **specific and descriptive** — someone scanning `git log` should understand what changed and why without opening the PR. Lead with what changed, include the **why** or **effect**. PR squash titles are the permanent record (individual commits get squashed away).

**Bad:** `feat: update memory system` · `fix: improve conversation quality`
**Good:** `feat: surface follow-up suggestions from call analysis in system prompt` · `fix: lower memory similarity threshold 0.7→0.45 (was filtering all results)`

---

## Documentation Updates

After commits that add features or change architecture, update:

1. [`DIRECTORY.md`](DIRECTORY.md) — agents read this FIRST
2. [`pipecat/docs/ARCHITECTURE.md`](pipecat/docs/ARCHITECTURE.md) — pipeline diagrams, file structure
3. [`pipecat/docs/LEARNINGS.md`](pipecat/docs/LEARNINGS.md) — production debugging lessons
4. This file (`CLAUDE.md`) — only for behavioral rules / new top-level structure
5. [`docs/architecture/`](docs/architecture/) — architecture suite

---

## Security & HIPAA — Non-Negotiables

Full program lives in [`docs/compliance/`](docs/compliance/). The rules below are load-bearing in code review:

- **Production fails closed.** Boot intentionally aborts if required security env vars are missing or unsafe. `DONNA_API_KEY` is a local/test fallback only; production must use labeled `DONNA_API_KEYS`.
- **Field-level encryption** for PHI uses dual-column strategy (`*_encrypted` alongside plaintext, `enc:` wire prefix). Decrypt at the boundary, never log decrypted content.
- **Audit logging** is fire-and-forget — never block the request path on it.
- **Dual-key JWT rotation:** verify against both `JWT_SECRET` and `JWT_SECRET_PREVIOUS`. Token revocation is DB-backed (`revoked_tokens`, SHA-256 hashed).
- **PII-safe logs:** use `maskName()` / `maskPhone()`. Sentry has `send_default_pii=False` and senior IDs are SHA-256 hashed.
- **Staged PHI encryption/export migration is intentionally separate from ingress/auth hardening — do not mix them.**

### Security deploy smoke tests (before promotion)
- Unsigned `/telnyx/events` rejects in production.
- Valid Telnyx-signed `/telnyx/events` creates call metadata with `ws_token`.
- `/ws` rejects missing/invalid/expired/reused tokens.
- Calls longer than five minutes continue normally after connection.
- Manual call initiation uses `seniorId`; phone is resolved server-side after authZ.

---

## Mobile-specific gotchas

`apps/mobile` (Expo/React Native, Clerk + Node API) has its own operational rules — see comments in the app and the Maestro tests under `.maestro/`. Key invariants:

- Every build must resolve `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (via `apps/mobile/.env` or EAS env). `development`, `preview`, and `production` EAS envs must all carry both.
- EAS simulator dev builds require `expo-dev-client`; lockfile must be regenerated with npm 10.9.3 after dep changes.
- Fresh setup must start at the visible Create Account flow. A Clerk user with no Donna profile is **not** a valid sign-in destination — `AuthGuard` cleans it up via `DELETE /api/caregivers/me/incomplete-account`.
- Maestro must exercise visible human paths. For `phone-pad`/`number-pad`, use `.maestro/subflows/tap_digits.yaml` — never `inputText` for numeric keypad fields.

Codex agents use the root `AGENTS.md` as their equivalent of this file.

---

## Business Context

Co-founder meeting notes live in `docs/meeting-notes/` — consult for product direction and priorities.

---

*Last updated: 2026-05-18 — slimmed; details moved to linked docs.*
