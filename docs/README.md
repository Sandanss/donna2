# Donna Documentation Index

> Start with [`../DIRECTORY.md`](../DIRECTORY.md) before editing code. It is the active navigation map for current vs. legacy surfaces.

## Current References

| Area | Document |
|---|---|
| Codebase map | [`../DIRECTORY.md`](../DIRECTORY.md) |
| Project/agent context | [`../claude.md`](../claude.md) |
| Current audit findings | [`audits/2026-05-05-codebase-audit.md`](audits/2026-05-05-codebase-audit.md) |
| Current remediation plan | [`plans/2026-05-05-engineering-remediation-plan.md`](plans/2026-05-05-engineering-remediation-plan.md) |
| Architecture overview | [`architecture/OVERVIEW.md`](architecture/OVERVIEW.md), [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) |
| Security architecture | [`architecture/SECURITY.md`](architecture/SECURITY.md) |
| Testing architecture | [`architecture/TESTING.md`](architecture/TESTING.md) |
| HIPAA/compliance | [`compliance/HIPAA_OVERVIEW.md`](compliance/HIPAA_OVERVIEW.md), [`compliance/BAA_TRACKER.md`](compliance/BAA_TRACKER.md), [`compliance/DATA_RETENTION_POLICY.md`](compliance/DATA_RETENTION_POLICY.md) |
| Frontend E2E | [`guides/FRONTEND_TESTING.md`](guides/FRONTEND_TESTING.md) |
| Historical plans | [`plans/README.md`](plans/README.md) |
| Developer onboarding | [`ONBOARDING.md`](ONBOARDING.md) |

## Important Status Notes

- Active voice is Telnyx + Pipecat; Twilio voice/SMS references in dated plans are historical unless explicitly marked active.
- The May 5 audit documents known launch blockers and code gaps. The current remediation plan intentionally excludes BAA/vendor agreement gates while keeping code-level privacy, security, retention, and reliability fixes in scope.
- Do not claim audit, retention, logging, or deletion gaps are fixed until runtime code and validation prove it.
- Dated files under `docs/plans/` are retained for context and may describe superseded architecture.

---

# New Engineer Prototype TODOs

> Active architecture and compliance references live in `docs/architecture/`, `docs/compliance/`, `DIRECTORY.md`, and `pipecat/docs/`. Dated files under `docs/plans/` are historical unless their own status says otherwise.

This is the starter backlog for getting Donna ready to test with real prototype users before a full production launch.

Priority definitions:

- P0: Must work before putting the prototype in front of people.
- P1: Should fix before a wider beta, but not a first-pilot blocker.
- P2: Good cleanup once the main pilot path is stable.

Before starting any item:

- Read [`../DIRECTORY.md`](../DIRECTORY.md) to confirm the active surface.
- Work on one small branch per task.
- Use dummy test accounts until the pilot starts.
- Do not put real transcripts, reminder text, medical notes, phone numbers, names, or caregiver data in logs, fixtures, screenshots, or PR notes.
- Prefer mocked tests and local builds before any Railway dev deploy. Use Railway dev only when validating real calls, real scheduler behavior, or environment wiring.

## Priority 0 - Prototype Pilot Blockers

| Priority | Task | Files | Done when | Validation |
|---|---|---|---|---|
| P0 | Prove mobile login and sign-up. | `apps/mobile/app/(auth)/sign-in.tsx`, `apps/mobile/app/(auth)/create-account.tsx`, `apps/mobile/app/_layout.tsx`, `apps/mobile/src/lib/auth.ts`, `apps/mobile/src/lib/pendingOnboardingSession.ts`, `routes/caregivers.js` | A new caregiver can create an account with a dummy test user, sign in, sign out, sign back in, and recover from bad credentials without a crash or stuck loading state. If Clerk asks for a second factor, the app shows a visible code-entry field and Maestro enters the code there instead of relying on an app-code bypass. Sign-in is only valid for users with a Donna profile; a signed-in Clerk user with no linked senior is treated as an incomplete onboarding account, cleaned up through `DELETE /api/caregivers/me/incomplete-account`, signed out locally, and returned to landing. | `cd apps/mobile && npm run test:unit`; `cd apps/mobile && npm run test:auth-guard`; `cd apps/mobile && npm run test:e2e:auth`; `cd apps/mobile && npm run test:e2e:auth-2fa` with a 2FA-enabled dummy Clerk user; `cd apps/mobile && maestro test .maestro/flows/12_incomplete_account_cleanup.yaml`; manual simulator pass with a dummy Clerk test user |
| P0 | Prove the mobile onboarding path. | `apps/mobile/app/(onboarding)/`, `apps/mobile/src/stores/onboarding.ts`, `apps/mobile/src/lib/pendingOnboardingSession.ts`, `routes/onboarding.js`, `routes/caregivers.js` | Fresh onboarding starts from the visible Create Account UI, marks a runtime pending-onboarding session before Donna profile creation, validates the loved-one phone before completion, creates/links the senior transactionally, clears the pending marker and encrypted local draft on success, and lands on the dashboard. Quitting or tapping Back before profile creation deletes/clears the incomplete account path and returns to landing instead of trapping the user in setup. | `cd apps/mobile && npm run test:e2e:onboarding`; `cd apps/mobile && maestro test .maestro/flows/12_incomplete_account_cleanup.yaml`; `cd apps/mobile && maestro test .maestro/flows/13_leave_setup_cleanup.yaml`; manual simulator pass with a fresh `+clerk_test` account |
| P0 | Prove mobile reminder CRUD works end to end. | `apps/mobile/app/(tabs)/reminders.tsx`, `apps/mobile/src/hooks/useReminders.ts`, `apps/mobile/src/lib/api.ts`, `routes/reminders.js`, `validators/schemas.js` | A caregiver can create, edit, refresh, and delete a reminder from the mobile app. The time picker can change a new reminder away from 9:00 AM, and the saved reminder displays in the senior's local time. Errors show actionable API messages, not a generic failure. | `cd apps/mobile && npm run test:e2e:reminders`; `npm test` |
| P0 | Prove reminder delivery works in a dev call. | `services/scheduler.js`, `routes/reminders.js`, `pipecat/services/reminder_delivery.py`, `pipecat/flows/tools.py` | A reminder created through the app or API is picked up by the active Node scheduler using the senior profile timezone, Donna mentions it in the dev call, and delivery state is updated. Start in Node; only touch Pipecat if the reminder reaches the call but is not mentioned or marked. | `make deploy-dev`; test with the dev Telnyx number and a dummy/consenting pilot phone; verify DB/admin state and logs |
| P0 | Prove the mobile schedule and call controls. | `apps/mobile/app/(tabs)/schedule.tsx`, `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/src/lib/api.ts`, `routes/calls.js` | A caregiver can view/edit the call schedule in the senior's local time, and the dashboard call action handles success and failure without hanging or crashing. | `cd apps/mobile && npm run test:e2e:schedule`; `cd apps/mobile && npm run test:e2e:instant-call` against a dev/test backend; manual simulator pass against dev API |
| P0 | Prove manual call initiation reaches the Pipecat voice pipeline. | `routes/calls.js`, `pipecat/api/routes/telnyx.py`, `pipecat/main.py`, `pipecat/bot.py` | A caregiver/admin-triggered call from Node `/api/call` asks Pipecat `/telnyx/outbound` to create a Telnyx call, then the `/ws` pipeline starts with the expected senior context. Logs show only masked phone data. | `make deploy-dev`; trigger a dev call with a dummy/consenting pilot phone; verify Telnyx callback events and Pipecat call metadata |
| P0 | Prove inbound known-senior and onboarding voice calls. | `pipecat/api/routes/telnyx.py`, `pipecat/bot.py`, `pipecat/flows/nodes.py`, `pipecat/services/prospects.py` | A known senior inbound call loads the senior profile and normal flow. An unrecognized caller uses the onboarding flow on the same Pipecat STT/LLM/TTS stack, creates or resumes a prospect, and does not deliver senior reminders. | Dev Telnyx inbound test for one known test number and one unrecognized test number; verify prospect/senior DB state |
| P0 | Prove post-call analysis, memory, and observability after a dev call. | `pipecat/services/post_call.py`, `pipecat/services/call_analysis.py`, `pipecat/services/memory.py`, `routes/observability.js`, `apps/observability/` | A completed dev call writes the conversation, call analysis, extracted memory, daily context, call metrics, and updated snapshot without raw PHI in logs. Observability can show the call timeline and metrics. | `make deploy-dev`; complete a dummy/consenting call; verify DB/admin/observability state and sanitized logs |
| P0 | Run a mobile no-crash pass through all main screens. | `apps/mobile/app/_layout.tsx`, `apps/mobile/app/(tabs)/`, `apps/mobile/app/settings/`, `apps/mobile/src/components/` | Sign-in, dashboard, schedule, reminders, settings, loved-one profile, caregiver profile, notification settings, help, and sign-out confirmation are navigable without crashes or stuck modals. | `cd apps/mobile && npm run test:e2e`; manual physical iPhone pass if available |
| P0 | Keep pilot-blocking sensitive debug logs out. | `apps/website/src/`, `routes/calls.js`, `routes/onboarding.js`, `routes/caregivers.js`, `apps/mobile/app/_layout.tsx`, `pipecat/processors/`, `pipecat/services/` | Browser/mobile/server logs do not print raw onboarding payloads, full dialed phone numbers, push tokens, transcripts, memory queries, or web-search queries. Mobile incomplete-account cleanup logs only audit metadata and never raw PHI. | `cd apps/website && npm run build`; `cd apps/mobile && npx tsc --noEmit`; `npm test`; `make test-python` |

## Priority 1 - Wider Beta Hardening

| Priority | Task | Files | Done when | Validation |
|---|---|---|---|---|
| P1 | Make the mobile Maestro flows reliable enough to run before every pilot build. | `apps/mobile/.maestro/flows/` | The flows assert real user outcomes and avoid unnecessary sleeps or brittle selectors. | `cd apps/mobile && npm run test:e2e` |
| P1 | Add focused API coverage for reminders and schedules. | `tests/`, `routes/reminders.js`, `routes/seniors.js`, `validators/schemas.js` | Reminder create/update/delete and schedule update behavior are covered without using real PHI. | `npm test` |
| P1 | Replace placeholder store links on the public website. | `apps/website/src/` | App Store and Google Play actions no longer use dead `#` links. If store URLs are not ready, route users to the waitlist or clearly say the app is coming soon. | `cd apps/website && npm run build`; `npm run test:e2e:consumer` |
| P1 | Make the consumer FAQ Playwright test use semantic selectors. | `tests/e2e/consumer/landing.spec.ts` | The test avoids `.cursor-pointer` and asserts that opening a FAQ reveals answer content. | `npm run test:e2e:consumer` |
| P1 | Replace fixed sleeps in admin E2E tests with assertions. | `tests/e2e/admin/seniors.spec.ts`, `tests/e2e/admin/reminders.spec.ts` | `waitForTimeout()` calls are replaced with `expect(...)` checks on a success state, list update, or mocked API call. | `npm run test:e2e:admin` |

## Priority 2 - Polish And Docs

| Priority | Task | Files | Done when | Validation |
|---|---|---|---|---|
| P2 | Add a first-pilot checklist to the onboarding guide. | `docs/ONBOARDING.md` | A new engineer can find the pilot validation flow, test commands, and PHI logging reminder in one place. | Review rendered Markdown |
| P2 | Update root README documentation links if responsibilities drift. | `README.md`, `DIRECTORY.md` | The root README points to the current docs and does not contradict `DIRECTORY.md`. | Review rendered Markdown |
| P2 | Add one focused E2E assertion for observability navigation. | `tests/e2e/observability/navigation.spec.ts` | At least one navigation path has a deterministic expected heading, panel, or URL assertion. | `npm run test:e2e:observability` |

## Save For Later

These areas are important, but they are not good first tasks unless paired with an experienced reviewer:

- Major voice behavior, prompts, Director, Quick Observer, and post-call analysis changes in `pipecat/`.
- Database schema or migration changes in `db/` and `pipecat/db/`.
- Data retention, audit logging, encryption, and token revocation changes across Node and Python.
- Production deploy work before the dev pilot path is repeatable.
