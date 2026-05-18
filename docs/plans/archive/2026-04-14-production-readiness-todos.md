# Production Readiness TODOs

> Current status note (April 22, 2026): This dated TODO is retained for launch context. Active voice now uses Telnyx Call Control/media streams with L16/16k audio, Claude Haiku 4.5, Groq Director with Gemini fallback, ElevenLabs Flash, Gemini post-call analysis, and email/in-app notifications only. Treat Twilio voice/SMS, Sonnet, Cerebras, and 8kHz details below as superseded unless explicitly marked archived/inactive.

> Status: Not ready for real PHI-bearing production users.
> Baseline audited: `origin/main` at `dfa5956`; branch drift checked against `origin/zuludev` through `6073629`, with voice TODO fixes staged on `codex/voice-pipeline-todos`.
> Created: April 14, 2026.
> Updated: April 14, 2026 after `codex/voice-pipeline-todos` implementation.

This document tracks the remaining work to take Donna from technical beta to production with real users. It focuses on compliance, PHI security, call reliability, horizontal scaling, operational safety, and launch controls.

## Launch Position

Donna's core voice architecture is strong enough to continue controlled testing:

- Pipecat owns the real-time Telnyx voice path and post-call processing.
- Conversation Director work is non-blocking.
- Quick Observer owns programmatic goodbye handling.
- Redis-backed Pipecat call metadata and reminder context exist.
- Encrypted transcript persistence and post-call fallback are in place.
- Pipecat non-integration unit tests passed in the audit worktree: `700 passed, 3 skipped, 21 deselected`.

Donna is not ready for real production users discussing health, medications, medical appointments, or caregiver-linked senior data until the P0 items below are closed.

## Updates From Voice Pipeline TODO Work

The `codex/voice-pipeline-todos` branch closed several runtime issues that were part of the production-readiness backlog:

- Pipecat now rejects inactive senior phone matches through a no-PHI hangup path.
- Pipecat hydrates known manual/welfare outbound calls itself, so Node process-local prefetch maps are no longer required for correct call context.
- Node-scheduled reminder context can be recovered through shared Redis/DB paths already present on `zuludev`.
- `/ws` validates the Telnyx media-stream start frame and `ws_token` before consuming active-call capacity, then consumes the token after capacity is reserved.
- Reminder acknowledgments remain low-latency during the call, but post-call waits briefly and re-reads `reminder_deliveries.status` before retry decisions.
- Caregiver notes are marked delivered only after assistant transcript evidence.
- Assistant turns are persisted after guidance stripping.
- Gemini Live now mirrors the Claude post-call start-once/await lifecycle.
- Live in-call web search no longer caches arbitrary query results.

Remaining production blockers below are still real, especially BAAs/vendor gating, encrypted-only PHI storage, retention, audit coverage, log redaction, shared rate limits, and deployment gates.

## P0: Production Launch Blockers

### 1. Sign BAAs or remove non-compliant vendor paths

- [ ] Confirm whether Donna will operate as a HIPAA-covered entity, business associate, or direct-to-consumer health product.
- [ ] Assign named compliance owners for HIPAA Security Officer, breach response, vendor review, and data retention.
- [ ] Sign and file BAAs for critical vendors that receive, store, or transmit PHI:
  - [ ] Neon
  - [ ] Telnyx
  - [ ] Anthropic
  - [ ] Google/Gemini
  - [ ] Deepgram
  - [ ] OpenAI
  - [ ] Sentry
  - [ ] Clerk, if caregiver-senior linkage is treated as PHI by association
- [ ] Resolve vendors with unclear or unlikely BAA support:
  - [ ] Railway
  - [ ] Groq
  - [ ] ElevenLabs
  - [ ] Cartesia
  - [ ] Tavily
- [ ] Disable production PHI paths for any vendor without a signed BAA or approved compliant replacement.
- [ ] Add production startup checks that fail closed when a PHI path is configured to use a non-approved vendor.
- [ ] Update `docs/compliance/BAA_TRACKER.md` with signed dates, contract references, and replacement decisions.

Acceptance criteria:

- No production PHI leaves Donna for a vendor without a signed BAA or documented non-PHI classification.
- Production config has an allowlist for approved vendors.
- Tavily, Cartesia, and any other non-BAA vendor paths are disabled in production unless legal/compliance approves them.

Relevant files:

- `docs/compliance/HIPAA_OVERVIEW.md`
- `docs/compliance/BAA_TRACKER.md`
- `docs/compliance/VENDOR_SECURITY_EVALUATION.md`
- `pipecat/services/news.py`
- `pipecat/services/director_llm.py`
- `pipecat/services/call_analysis.py`
- `pipecat/services/memory.py`
- `pipecat/lib/growthbook.py`

### 2. Make PHI storage encrypted-only by default

- [x] Inventory every PHI-bearing column in `db/schema.js`; senior name/phone/timezone/location/interests remain documented operational PII for lookup/display.
- [x] Stop writing plaintext PHI where encrypted companion columns exist for conversations, memories, call analyses, senior profile PHI, reminders, daily context, notifications, waitlist signups, prospects, and caregiver notes.
- [ ] Backfill existing plaintext PHI into encrypted columns with `node scripts/backfill-encrypted-phi.js --write`, then clear legacy plaintext with `--write --null-plaintext` after verification.
- [x] Change read paths to prefer encrypted fields and treat plaintext as legacy-only fallback for conversations, memories, exports, weekly reports, call analyses, senior profiles, reminders, daily context, notifications, prospects, and caregiver notes.
- [ ] Decide which fields require searchable/indexed plaintext substitutes, and implement minimized derived values instead of raw PHI.
- [x] Add tests proving new write payloads do not populate plaintext PHI fields. Node covers encryption helpers used by write paths; Pipecat targeted reminder/daily-context/scheduler/call-snapshot route tests pass.
- [x] Add a production startup guard that refuses PHI writes if `FIELD_ENCRYPTION_KEY` is missing or invalid.

Known plaintext-risk areas:

- [x] `conversations.summary`
- [x] `conversations.concerns`
- [x] `call_analyses.summary`
- [x] `call_analyses.topics`
- [x] `call_analyses.concerns`
- [x] `call_analyses.positive_observations`
- [x] `call_analyses.follow_up_suggestions`
- [x] `call_analyses.call_quality`
- [x] `memories.content`
- [x] `reminders.title`
- [x] `reminders.description`
- [x] `reminder_deliveries.user_response`
- [x] `seniors.medical_notes`
- [x] `seniors.family_info`
- [x] `seniors.preferred_call_times`
- [x] `seniors.additional_info`
- [x] `seniors.call_context_snapshot`
- [x] `daily_call_context` summary/topic/advice/key moment fields
- [x] `notifications.content`
- [x] `notifications.metadata`
- [x] `waitlist` signup payload
- [x] `prospects` learned caller/loved-one context
- [x] `caregiver_notes.content`

Acceptance criteria:

- New production writes store raw transcripts, summaries, medical notes, reminder details, memories, and caregiver-facing call analysis in encrypted fields only.
- Legacy plaintext fields are either nulled, migrated, or explicitly documented as non-PHI/minimized.
- Unit tests cover Python and Node write paths.

Relevant files:

- `db/schema.js`
- `lib/encryption.js`
- `pipecat/lib/encryption.py`
- `services/conversations.js`
- `pipecat/services/conversations.py`
- `services/call-analyses.js`
- `pipecat/services/call_analysis.py`
- `services/memory.js`
- `pipecat/services/memory.py`
- `routes/reminders.js`
- `routes/notifications.js`
- `services/seniors.js`
- `lib/phi.js`
- `pipecat/lib/phi.py`
- `scripts/backfill-encrypted-phi.js`
- `pipecat/services/seniors.py`

### 3. Move all outbound call context handoff to shared state

- [x] Remove Node process-local call context maps from the correctness-critical path for manual/welfare calls. The maps still exist as optional prefetch, but Pipecat no longer depends on them to build the call.
- [ ] Store manual outbound prefetch context in Redis or Postgres keyed by `callSid` if we want to preserve Node's precomputed context instead of rehydrating in Pipecat.
- [x] Store Node-scheduled reminder context in shared state/DB paths Pipecat can read. Redis reminder context and DB `call_sid` fallback are present.
- [x] Make Pipecat hydrate generic outbound calls with senior context, memory context, caregiver notes, settings, greeting, recent turns, and daily context when a senior is known.
- [x] Historical Twilio reminder-row race item: superseded by Telnyx call-context/prewarm paths. Node/Pipecat reminder calls pass reminder context, and Pipecat waits briefly for the delivery row before falling back.
- [ ] Add remaining tests for manual outbound, Pipecat-scheduled reminder, and missing-context fallback. This branch added coverage for inactive senior handling, tagged Node-scheduled reminder race, and the affected WebSocket/reminder/post-call paths.

Acceptance criteria:

- Any Pipecat instance can answer known manual/welfare outbound calls and hydrate intended context from the database, even when Node and Pipecat run on different instances.
- Manual admin/caregiver calls are not downgraded to empty generic outbound calls when Node and Pipecat run on different instances.
- Reminder calls do not depend on same-process memory.
- Still open: optional shared manual prefetch if we want to avoid Pipecat duplicate context-building work.

Relevant files:

- `services/scheduler.js`
- `routes/calls.js`
- `pipecat/api/routes/voice.py`
- `pipecat/services/reminder_delivery.py`
- `pipecat/lib/redis_client.py`
- `services/context-cache.js`
- `pipecat/services/context_cache.py`

### 4. Align retention implementation with the retention policy

- [x] Make one service the authoritative retention runner: Node scheduler owns retention by default.
- [x] Disable or guard the Pipecat retention loop unless it is intentionally the owner. `PIPECAT_RETENTION_ENABLED=true` is now required to start it.
- [x] Change conversation retention from whole-row deletion to policy-specific PHI nulling before later metadata deletion.
- [ ] Add legal hold support.
- [ ] Add dry-run retention reports.
- [ ] Add deletion/retention audit logs with counts, table names, time window, and actor/job ID.
- [ ] Cover currently missed PHI areas:
  - [ ] reminders
  - [x] notifications
  - [ ] senior profile PHI
  - [ ] caregiver notes
  - [x] waitlist signups
  - [ ] prospect data
  - [ ] dev/staging data branches
- [ ] Add tests for Node and Python parity where both services can read affected tables.

Acceptance criteria:

- Runtime retention behavior matches `docs/compliance/DATA_RETENTION_POLICY.md`.
- Legal holds block deletion/nulling.
- Retention jobs are idempotent, observable, and auditable.

Relevant files:

- `docs/compliance/DATA_RETENTION_POLICY.md`
- `services/data-retention.js`
- `pipecat/services/data_retention.py`
- `services/scheduler.js`
- `pipecat/main.py`
- `pipecat/db/migrations/007_data_retention.sql`

### 5. Make audit logging comprehensive and reliable

- [ ] Define audit events required for every PHI create/read/update/delete/export action.
- [x] Add audit logging to newly identified admin PHI reads: observability transcript/timeline/turn/observer/metrics reads, call analyses, and daily context.
- [x] Add audit events for observability transcript reads and export routes.
- [x] Make audit failures visible for high-risk exports by awaiting audit writes before returning export bundles.
- [ ] Make non-export audit failures visible through metrics/alerts instead of logs only.
- [ ] Add tests proving key admin, caregiver, Pipecat, export, notification, reminder, and post-call flows emit audit records.
- [ ] Consider append-only/tamper-evident audit behavior for production.

Acceptance criteria:

- PHI reads and writes can be traced to actor, action, resource type, resource ID, time, IP/user agent where applicable, and outcome.
- Audit gaps are caught by automated tests.

Relevant files:

- `services/audit.js`
- `pipecat/services/audit.py`
- `routes/observability.js`
- `routes/caregivers.js`
- `routes/notifications.js`
- `routes/onboarding.js`
- `routes/call-analyses.js`
- `pipecat/api/routes/export.py`
- `pipecat/api/routes/data.py`

### 6. Sanitize errors and logs before production

- [x] Replace shared route-level `error.message` responses with safe client errors.
- [x] Stop logging raw error objects in the highest-risk sensitive routes reviewed here.
- [x] Expand structured logger sanitization beyond exact keys like `phone` and `name`.
- [ ] Sanitize common leak keys:
  - [x] `to`
  - [x] `from`
  - [x] `targetPhone`
  - [ ] `body`
  - [ ] `query`
  - [x] `transcript`
  - [x] `summary`
  - [x] `reminder`
  - [x] `medicalNotes`
  - [x] `memory`
  - [x] `prompt`
- [ ] Remove or gate raw `console.*` usage in backend services.
- [ ] Add log redaction tests for Node and Pipecat.
- [ ] Validate Sentry configuration and scrubbers with production-like error events.
- [x] Pipecat WebSocket auth path does not log raw `ws_token` values or Telnyx start-frame bodies.
- [x] Assistant transcript persistence now receives guidance-stripped text.

Acceptance criteria:

- Client-facing production errors do not expose database/vendor/internal messages.
- Railway/Sentry logs do not contain raw transcripts, medical notes, reminders, summaries, caregiver notes, phone numbers, or names.

Relevant files:

- `routes/helpers.js`
- `middleware/error-handler.js`
- `lib/logger.js`
- `lib/sanitize.js`
- `pipecat/lib/sanitize.py`
- `routes/observability.js`
- `routes/calls.js`
- `routes/memories.js`
- `routes/health.js`
- `pipecat/api/routes/calls.py`
- `pipecat/main.py`

### 7. Move rate limiting and abuse controls to production-grade shared state

- [ ] Use Redis-backed rate limits for Node APIs.
- [ ] Ensure invalid API-key attempts are rate-limited before expensive auth or route handling.
- [ ] Add explicit limits for:
  - [ ] caregiver auth-sensitive API routes
  - [ ] admin auth routes
  - [ ] call initiation
  - [ ] export routes
  - [ ] notification trigger routes
  - [ ] Pipecat API routes
  - [ ] Telnyx webhook endpoints, within Telnyx retry expectations
- [ ] Add metrics for rejected requests and repeated invalid-key attempts.

Acceptance criteria:

- Rate limits hold across multiple Node and Pipecat replicas.
- Brute force or accidental call storms cannot create unbounded Telnyx/vendor spend.

Relevant files:

- `middleware/rate-limit.js`
- `middleware/api-auth.js`
- `index.js`
- `pipecat/api/middleware/rate_limit.py`
- `pipecat/api/routes/calls.py`
- `pipecat/api/routes/export.py`
- `pipecat/api/routes/data.py`

### 8. Add production deployment gates and rollback discipline

- [ ] Add migration validation to CI/deploy before production traffic.
- [ ] Add production config validation for both Node and Pipecat.
- [ ] Add health checks that verify database, Redis, provider credentials, and encryption readiness.
- [ ] Add a live dev/staging Telnyx smoke call before production deploy.
- [ ] Add a production canary or staged rollout process.
- [ ] Document rollback commands and criteria.
- [ ] Add alert thresholds for:
  - [ ] call answer failures
  - [ ] Telnyx webhook failures
  - [ ] STT/TTS/LLM provider errors
  - [ ] post-call processing failures
  - [ ] audit write failures
  - [ ] retention job failures
  - [ ] Redis unavailability
  - [ ] database pool saturation
  - [ ] spend anomalies
- [ ] Keep `main` and the actual deployed production branch reconciled before release.
- [x] Document WebSocket token/capacity behavior and stripped transcript persistence in `docs/architecture/SECURITY.md`.

Acceptance criteria:

- A production deploy cannot proceed with pending migrations, missing critical secrets, missing Redis, missing encryption key, or non-approved vendor configuration.
- The team can identify and roll back a bad deploy without ad hoc investigation.

Relevant files:

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`
- `Makefile`
- `railway.toml`
- `pipecat/railway.toml`
- `.env.example`
- `pipecat/.env.example`
- `docs/architecture/SECURITY.md`
- `docs/architecture/PERFORMANCE.md`

## P1: Production Hardening

### 9. Capacity model and load testing

- [ ] Define target launch capacity: concurrent calls, daily calls, caregivers, seniors, reminders, and post-call jobs.
- [ ] Calculate database pool usage per Node and Pipecat replica.
- [ ] Calculate Redis connections per replica.
- [ ] Confirm Telnyx, Deepgram, Anthropic, Google, OpenAI, Groq, TTS, and Neon rate/concurrency limits.
- [ ] Add load tests for:
  - [ ] concurrent Pipecat calls
  - [ ] reminder scheduler bursts
  - [ ] caregiver dashboard reads
  - [ ] post-call analysis backlog
  - [ ] memory extraction backlog
- [ ] Add cost ceilings and vendor spend alerts.

Acceptance criteria:

- Production has a documented concurrency limit, autoscaling plan, and provider quota plan.
- Load tests prove the first-user cohort can run with margin.

### 10. Frontend and mobile release readiness

- [ ] Reconcile `origin/main` and `origin/zuludev` before mobile or caregiver release.
- [ ] Confirm whether `origin/zuludev` fixes are required for launch:
  - [x] timezone-aware fallback for call timing is on `zuludev`
  - [x] mobile signup password autofill is on `zuludev`
  - [x] iOS TestFlight submit app ID is on `zuludev`
  - [ ] recent docs and package lock changes still need final release review before main/prod promotion
- [ ] Run caregiver dashboard E2E tests against staging with real auth.
- [ ] Run admin dashboard E2E tests against staging with real API.
- [ ] Run mobile signup/onboarding/call summary flows on simulator and physical device.
- [ ] Wire push token registration if notifications are in launch scope.

Acceptance criteria:

- Caregiver, admin, and mobile launch flows have passing staging E2E coverage.
- The app can display caregiver call summaries without exposing encrypted payloads directly to clients.

### 11. Caregiver summary access model

- [ ] Define which call analysis fields caregivers can see.
- [ ] Decrypt server-side only after authorization confirms caregiver-senior relationship.
- [ ] Return minimized DTOs, not raw encrypted database rows.
- [ ] Audit every caregiver call summary read.
- [ ] Add tests for authorized caregiver, unauthorized caregiver, revoked caregiver, and no-summary cases.

Acceptance criteria:

- Caregivers can see intended summaries, but cannot fetch raw transcript, encrypted blobs, or another senior's data.

### 12. Data rights workflows

- [ ] Verify export includes encrypted-only data after the PHI migration. Node and Pipecat export code now decrypts encrypted senior PHI, reminders, daily context, conversations, memories, and call analyses; run against a migrated database before closing.
- [ ] Verify hard delete covers Node and Pipecat-created records.
- [ ] Verify delete/export routes are audited.
- [ ] Verify third-party deletion obligations are documented per BAA.
- [ ] Add end-to-end tests for export and deletion.

Acceptance criteria:

- A senior/caregiver data request can be fulfilled without manual database spelunking.

## P2: Operational Polish

- [ ] Refresh `README.md`, `DIRECTORY.md`, and onboarding docs after final production architecture decisions.
- [ ] Add a production launch checklist with named owners and sign-off dates.
- [ ] Add incident response tabletop notes after the first drill.
- [ ] Add quarterly compliance review reminders.
- [ ] Add vendor change review requirements to contribution docs.
- [ ] Decide whether dev/staging may ever contain production PHI; if not, enforce sanitized seed data only.

## Suggested Execution Order

1. Compliance/vendor gate and production vendor allowlist.
2. Encrypted-only PHI writes, backfill, and tests.
3. Shared outbound call context in Redis/DB.
4. Retention ownership and policy-correct implementation.
5. Audit coverage and log/error sanitization.
6. Redis-backed rate limits and abuse controls.
7. Deployment gates, smoke calls, monitoring, and rollback runbook.
8. Load testing and frontend/mobile production verification.

## Open Questions

- Which vendors already have signed BAAs outside the repo's current docs?
- Is Railway acceptable for production PHI hosting, or should production move to a BAA-backed cloud service?
- Should Donna launch as a no-PHI companion first, or is medication/health support required for the first user cohort?
- What is the first launch cohort size and expected concurrent call volume?
- Who owns compliance sign-off, breach response, and retention approval?
- Should `main` or `zuludev` be treated as the production source of truth for the next release?
