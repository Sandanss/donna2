# Codebase Audit Summary - May 5, 2026

> Scope: Static audit findings from May 5, 2026. This document records known code gaps and documentation drift; it does not mean the gaps have been remediated.

## Validation Notes

- Analysis was static/read-only except one repo-hygiene check that ran pytest collect-only.
- No full test suite, live Telnyx call, Railway deploy, EAS build, Maestro run, Playwright run, or end-to-end reminder flow was executed.
- Treat runtime code as the source of truth if it disagrees with this summary.
- Avoid adding real names, phone numbers, transcripts, reminder text, profile notes, or caregiver data to tickets, fixtures, logs, screenshots, or follow-up docs.

## Launch Blockers

| Area | Finding | Status |
|---|---|---|
| Vendor BAAs | Active PHI flows send data to vendors with no signed BAA recorded in `docs/compliance/BAA_TRACKER.md`. This includes voice, AI, search, storage, email, hosting, and error-monitoring vendors. | Code gap / compliance blocker unless signed BAAs are verified outside the repo. |
| Resend email | PHI-bearing caregiver email paths exist in `services/notifications.js` and `services/weekly-report.js`, but Resend was not tracked as a PHI vendor. | Documentation and vendor-control gap. |
| Retention | Policy says several PHI classes should be purged, but implementation coverage does not include inactive reminder definitions, senior profiles, caregiver notes, prospects, and related legal-hold handling. | Policy/implementation gap. |
| Website onboarding storage | Website onboarding stores credentials and PHI in plaintext `localStorage` under `donna_onboarding`. | High-risk client storage gap. |
| Test/prod separation | Website and consumer E2E clients are hardcoded to production Railway APIs in several places. | Test/prod contamination risk. |

## Critical / High Security And Compliance Findings

| Severity | Finding | Impact / Required Follow-Up |
|---|---|---|
| Critical | BAA tracker records zero signed BAAs while active PHI flows send data to OpenAI, Anthropic, Google/Gemini, Groq, Tavily/OpenAI search, Deepgram, TTS providers, Telnyx, Neon, Sentry, Railway, Clerk, and Resend. | Treat production PHI launch as blocked unless executed BAAs or a documented legal non-PHI/conduit determination exist outside the repo. |
| High | Resend was missing from the BAA tracker despite PHI-bearing email summaries/weekly reports. | Track Resend, minimize email content, confirm BAA status, or remove PHI from email bodies. |
| High | Retention implementation does not cover all policy-scoped PHI classes, including inactive reminder definitions, senior profiles, caregiver notes, prospects, and legal holds. | Update retention workers and tests before claiming automated retention compliance. |
| High | Hard delete can leave encrypted idempotency replay rows for up to 24 hours. | Deletion completeness gap; document and address replay/cache expiration or delete-on-hard-delete behavior. |
| High | Website onboarding persists credentials and PHI in plaintext `localStorage` under `donna_onboarding`. | Move to minimized, encrypted, short-lived storage or server-side session state; do not store passwords client-side. |
| High | Website/consumer E2E clients contain production Railway API URLs. | Risk of test data or automation touching production; require environment-specific config and mocked/default dev endpoints. |
| High | Mobile schedule save and several server/client debug paths log PHI-bearing payloads or raw inputs. Affected areas include schedule payloads, `services/caregivers.js`, `services/news.js`, `services/context-cache.js`, website `IntakeModal`, and `routes/onboarding.js`. | Sanitize or remove raw logs; production logs should not contain schedules, memory/search queries, profile details, reminders, or onboarding payloads. |
| High | Raw memory search query is stored in audit metadata, and `q`/`limit` lack validation/clamping. | Audit logs are long-lived; minimize query metadata and validate request size/count. |
| High | Notification reads and schedule reads/writes lack audit events. | Audit trail is incomplete for PHI access. |
| High | Token revocation fails open on storage errors. | Authentication/session revocation should fail closed for high-risk paths. |

## High / Medium Voice And Backend Reliability Findings

| Severity | Finding | Impact / Required Follow-Up |
|---|---|---|
| High | Gemini Live voice backend can bypass Quick Observer, Conversation Director, ephemeral context stripping, and programmatic goodbye invariants. | Keep Gemini Live eval/non-production only unless equivalent safeguards are implemented and tested. |
| High | WebSocket `ws_token` consumption is not atomic. | Concurrent duplicate pipelines may be possible during connection races. |
| High | At-capacity WebSocket rejection closes the media stream but does not hang up the Telnyx call. | Caller may remain connected to an unanswered or stalled call. |
| High | Early explicit goodbyes are blocked from force-ending for 60 seconds. | Seniors may be kept on calls after clear goodbye intent. |
| Medium | Telnyx senior VAD settings differ from documented elder-safe settings. | Behavior may regress for slower speech or pauses. |
| Medium | Director/Observer background tasks are not cancelled on `EndFrame`. | Background work can outlive calls and leak work/state. |
| Medium | Local PHI-bearing `call_metadata` lacks TTL cleanup if terminal webhook/WebSocket cleanup is missed. | Stale PHI can remain in shared state. |
| Medium | `web_search` can block up to 15 seconds and relies on the model to say filler. | Voice latency can spike on search turns. |
| Medium | Production Pipecat config can pass without selected AI/STT/TTS provider keys. | Misconfigured provider selection can fail at call time rather than boot time. |
| Medium | Due-reminder call path appears dead: `getDueReminders`/prewarm exist, but the active scheduler only schedules scheduled calls and welfare checks. | Reminders may not initiate calls, retries, or missed notifications. |
| Medium | One caregiver pause preference can suppress all calls for a shared senior. | Shared-caregiver setups can unintentionally disable a senior's calls. |
| Medium | Chat assistant reads encrypted schedule/reminder data incorrectly, and call-analysis normalization prefers legacy plaintext over encrypted data. | User-visible data may be stale, missing, or privacy-regressive. |

## Low / Hygiene / Documentation Drift

| Finding | Required Follow-Up |
|---|---|
| `POST /api/reminders` accepts `isActive` but drops it. | Align schema/API behavior or reject unsupported field. |
| Public waitlist route lacks validation/rate limit. | Add route-level input validation and abuse protection. |
| Stale Twilio validation/tests remain in active validator/test surfaces. | Move to archive or mark historical; active voice is Telnyx. |
| README/docs link to `CLAUDE.md` while `claude.md` is the tracked assistant context file. | Normalize links to the correct file. |
| `pipecat/.env.example` lags `pipecat/config.py` runtime variables. | Refresh example env from config. |
| Testing docs contain fragile counts and omit current marker filters. | Prefer command/marker guidance over exact counts. |
| README has stale Railway dev/facudev wording; onboarding lists the same phone number for dev and staging. | Clarify dev-only phone testing and staging caution. |
| `docs/README.md` is a backlog, not a documentation index. | Convert or prepend an index. |
| Archived app contains tracked `tsconfig.tsbuildinfo`. | Remove generated file from source control in a code cleanup PR. |

## Documentation Updates From This Audit

- `docs/compliance/BAA_TRACKER.md` should track Resend and make zero signed BAAs an explicit launch blocker unless contracts are verified outside the repo.
- `docs/compliance/DATA_RETENTION_POLICY.md` should call out retention implementation gaps, legal-hold gaps, and idempotency replay deletion completeness.
- `docs/compliance/HIPAA_OVERVIEW.md` should avoid stating audit logging and retention are automatic/comprehensive until coverage is verified.
- `docs/architecture/SECURITY.md` should call out client-side onboarding storage, PHI logging, audit coverage gaps, token revocation behavior, `ws_token` atomicity, and Gemini Live guardrail limitations.
- `docs/architecture/TESTING.md` should avoid stale test counts and document current marker filters plus the collect-only validation note.
- `docs/ONBOARDING.md` and `README.md` should point engineers to current docs and avoid stale `CLAUDE.md`, facudev, and staging-phone guidance.
