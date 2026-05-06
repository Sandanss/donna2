# Engineering Remediation Plan - May 5, 2026

> Status: Current fix plan derived from the May 5, 2026 codebase audit.
> Per product direction, BAA/vendor agreement gates are out of scope for this plan. This plan still includes code-level privacy, security, retention, and reliability fixes that reduce PHI exposure and production risk.

## Source Material

- [`../audits/2026-05-05-codebase-audit.md`](../audits/2026-05-05-codebase-audit.md)
- [`../../DIRECTORY.md`](../../DIRECTORY.md)
- Runtime code is the source of truth where code and docs disagree.

## What Changed From The First Draft

- Removed BAA/vendor contract verification from the blocking path.
- Removed vendor agreement reconciliation from the remediation order.
- Kept engineering controls that are independent of vendor paperwork: storage minimization, PHI-safe logging, retention completeness, audit coverage, token revocation behavior, scheduler correctness, and voice-pipeline safety.
- Email and notification payload minimization remains in scope as an engineering privacy control, not as a vendor agreement gate.

## P0 - Engineering Launch Blockers

These items can leak PHI, touch production from tests, break deletion/retention guarantees, or prevent expected reminder/call behavior. They should be split into small PRs with focused tests.

| Order | Fix | Primary files | Done when | Validation |
|---|---|---|---|---|
| 1 | Remove plaintext PHI and credential storage from website onboarding. | `apps/website/src/onboarding/store.jsx`, `apps/website/src/onboarding/CreateAccount.jsx`, `apps/website/src/onboarding/OnboardingFlow.jsx`, website dashboard guards | Passwords are never persisted client-side. Onboarding drafts are minimized, encrypted/short-lived, or moved server-side. Reload/back-flow behavior still works. | `rg -n "localStorage|sessionStorage" apps/website/src`; website build; focused onboarding E2E |
| 2 | Remove production Railway URLs from website and consumer E2E clients. | `apps/website/src/lib/api.js`, `apps/website/src/onboarding/api.js`, `apps/website/src/components/WaitlistModal.jsx`, `tests/e2e/consumer/` | Tests and local clients default to dev/mock configuration and cannot silently hit production. Production URLs come only from explicit production env. | `rg -n "railway|production|https://.*railway" apps/website tests`; `npm run test:e2e:consumer` |
| 3 | Eliminate raw PHI logging and unsafe audit metadata. | `apps/mobile/app/(tabs)/schedule.tsx`, `services/caregivers.js`, `services/news.js`, `services/context-cache.js`, `apps/website/src/components/IntakeModal.jsx`, `routes/onboarding.js`, `routes/memories.js`, validators | Logs and audit metadata avoid raw schedules, names, phone numbers, onboarding payloads, memory queries, reminder text, and search queries. Memory search validates and clamps `q`/`limit`, and audit metadata stores only safe summaries such as hashes, lengths, or result counts. | `rg -n "console\\.|logger\\.|audit.*metadata|schedule" apps/mobile apps/website services routes pipecat`; `npm test`; `make test-python` |
| 4 | Complete retention, legal-hold, hard-delete, and idempotency cleanup behavior. | `services/data-retention.js`, `pipecat/services/data_retention.py`, `services/seniors.js`, `pipecat/services/hard_delete.py`, `middleware/idempotency.js`, schema/migrations | Retention and hard delete cover inactive reminder definitions, senior profiles, caregiver notes, prospects, and replay/cache rows. Legal holds are checked at runtime, and manual review paths are documented for records that should not be automatically purged. | Focused Node and Python retention tests; hard-delete fixture tests; `npm test`; `make test-python` |
| 5 | Fill audit gaps and make token revocation fail closed for production paths. | `routes/notifications.js`, `routes/seniors.js`, `middleware/auth.js`, `routes/admin-auth.js`, `services/audit.js`, Python auth if parity is needed | Notification reads/mark-read and schedule reads/writes create audit events. Revocation storage errors fail closed in production/high-risk auth paths with tests for both failure and success cases. | Focused API tests; `npm test`; Python auth tests if touched |
| 6 | Restore active reminder-call behavior in the Node scheduler. | `services/scheduler.js`, `routes/reminders.js`, `pipecat/api/routes/telnyx.py`, `pipecat/services/reminder_delivery.py` | Due reminders created through app/API are picked up by the active Node scheduler, initiate the expected dev call path when configured, and update delivery state. | Scheduler tests; reminder API tests; dev Telnyx call only if live wiring is required |

## P1 - Voice And Backend Reliability

These reduce call failures, duplicate pipelines, stale PHI, and latency spikes. They should follow P0 unless a pilot depends on the specific behavior.

| Order | Fix | Primary files | Done when | Validation |
|---|---|---|---|---|
| 1 | Make `ws_token` consumption atomic and hang up Telnyx calls on capacity rejection. | `pipecat/main.py`, `pipecat/api/routes/call_context.py`, `pipecat/api/routes/telnyx.py`, `pipecat/lib/redis_client.py` | Duplicate WebSocket races cannot start two pipelines, and rejected calls are actively ended instead of left connected. | Pipecat route/unit tests; Redis race test if practical |
| 2 | Add TTL cleanup for local PHI-bearing call metadata. | `pipecat/api/routes/call_context.py`, `pipecat/lib/redis_client.py`, cleanup paths | Call metadata expires even if a terminal webhook or WebSocket cleanup path is missed. | Focused Redis TTL tests |
| 3 | Keep Gemini Live non-production unless it has invariant parity. | `pipecat/bot_gemini.py`, `pipecat/config.py`, related docs/tests | Gemini Live cannot run in production without Quick Observer, Director, ephemeral context stripping, programmatic goodbye handling, and test coverage for those invariants. | Config tests; pipeline invariant tests |
| 4 | Fix early goodbye and task cleanup behavior. | `pipecat/processors/quick_observer.py`, `pipecat/processors/conversation_director.py`, `pipecat/bot.py` | Clear senior goodbye intent can end promptly, while background Director/Observer work is cancelled on `EndFrame`. | Pipecat processor tests; regression scenarios |
| 5 | Tighten Telnyx VAD and provider-key production validation. | `pipecat/config.py`, Telnyx stream setup | Production boot fails fast if selected providers are missing keys, and senior-safe VAD defaults match documented behavior. | Config tests; dev call smoke if audio settings change |
| 6 | Fix encrypted read precedence and bound in-call search latency. | `routes/chat.js`, `pipecat/services/call_analysis.py`, `pipecat/services/news.py`, `pipecat/flows/tools.py` | Chat assistant and call analysis prefer encrypted PHI fields over legacy plaintext. `web_search` cannot block a voice turn for the full external timeout without a bounded fallback. | Node chat tests; Pipecat call-analysis/news tests |

## P2 - Hygiene And Documentation Cleanup

These are lower-risk correctness and maintenance items.

| Fix | Primary files | Done when | Validation |
|---|---|---|---|
| Align `POST /api/reminders` `isActive` behavior. | `routes/reminders.js`, `validators/schemas.js`, tests | The API either persists `isActive` or rejects unsupported input clearly. | Reminder API tests |
| Add waitlist validation and rate limiting. | `apps/website/src/components/WaitlistModal.jsx`, waitlist API route | Invalid/abusive input is rejected without noisy logs or production side effects. | Website build; API tests |
| Move or clearly mark stale Twilio validators/tests as historical. | Active validators/tests, `archive/twilio-voice/` | Active validation surfaces no longer imply Twilio voice is current. | Test suite or targeted validator tests |
| Refresh example env files and stale docs links. | `pipecat/.env.example`, `README.md`, `docs/`, `pipecat/docs/` | Example variables match runtime config, and docs point to active files. | Rendered Markdown review; config comparison |
| Remove archived generated artifacts from source control. | `archive/` tsbuildinfo files | Generated build cache files are not tracked. | `git status`; build unaffected |

## Execution Notes

- Work P0 in order unless the first available engineer can take a later item with no overlap.
- Keep PRs narrow. Do not mix retention schema changes with frontend storage or scheduler behavior.
- Use dummy data only. Do not add real transcripts, reminder text, names, phone numbers, caregiver notes, or medical notes to fixtures, screenshots, logs, or PR descriptions.
- If a fix touches shared privacy/security behavior, inspect both Node and Python implementations for parity before claiming the issue is closed.
- Prefer local and mocked validation first. Use Railway dev deploys only for live Telnyx/audio/environment wiring.
