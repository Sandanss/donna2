# Prototype Pilot Backlog

> Active architecture and compliance references live in [`../architecture/`](../architecture/), [`../compliance/`](../compliance/), [`../../DIRECTORY.md`](../../DIRECTORY.md), and [`../../pipecat/docs/`](../../pipecat/docs/). Dated files under `docs/plans/` are historical unless their own status says otherwise.

This backlog tracks the work needed before Donna is tested with real prototype users. Use dummy test accounts until the pilot starts, and never put real transcripts, reminder text, profile notes, phone numbers, names, or caregiver data in logs, fixtures, screenshots, or PR notes.

## Priority Definitions

- **P0:** Must work before putting the prototype in front of people.
- **P1:** Should fix before a wider beta, but not a first-pilot blocker.
- **P2:** Good cleanup once the main pilot path is stable.

## Priority 0 - Prototype Pilot Blockers

| Priority | Task | Files | Done when | Validation |
|---|---|---|---|---|
| P0 | Prove mobile login and sign-up. | `apps/mobile/app/(auth)/sign-in.tsx`, `apps/mobile/app/(auth)/create-account.tsx`, `apps/mobile/app/_layout.tsx`, `apps/mobile/src/lib/auth.ts`, `apps/mobile/src/lib/pendingOnboardingSession.ts`, `routes/caregivers.js` | A new caregiver can create an account with a dummy test user, sign in, sign out, sign back in, recover from bad credentials, and recover from no-profile Clerk sessions through incomplete-account cleanup. | `cd apps/mobile && npm run test:unit`; `cd apps/mobile && npm run test:auth-guard`; `cd apps/mobile && npm run test:e2e:auth`; `cd apps/mobile && npm run test:e2e:auth-2fa`; Maestro cleanup flows; manual simulator pass |
| P0 | Prove the mobile onboarding path. | `apps/mobile/app/(onboarding)/`, `apps/mobile/src/stores/onboarding.ts`, `apps/mobile/src/lib/pendingOnboardingSession.ts`, `routes/onboarding.js`, `routes/caregivers.js` | Fresh onboarding starts from Create Account, marks pending setup before Donna profile creation, validates the loved-one phone, creates/links the senior transactionally, clears local draft on success, and handles abandoned setup cleanly. | `cd apps/mobile && npm run test:e2e:onboarding`; Maestro incomplete/leave-setup flows; manual simulator pass |
| P0 | Prove mobile reminder CRUD works end to end. | `apps/mobile/app/(tabs)/reminders.tsx`, `apps/mobile/src/hooks/useReminders.ts`, `apps/mobile/src/lib/api.ts`, `routes/reminders.js`, `validators/schemas.js` | A caregiver can create, edit, refresh, and delete reminders. Saved times display in the senior's local time, and API errors are actionable. | `cd apps/mobile && npm run test:e2e:reminders`; `npm test` |
| P0 | Prove reminder delivery works in a dev call. | `services/scheduler.js`, `routes/reminders.js`, `pipecat/services/reminder_delivery.py`, `pipecat/flows/tools.py` | A reminder created through the app/API is picked up by the active Node scheduler, Donna mentions it in a dev Telnyx call, and delivery state updates. | `make deploy-dev`; dummy/consenting dev call; verify DB/admin state and sanitized logs |
| P0 | Prove mobile schedule and call controls. | `apps/mobile/app/(tabs)/schedule.tsx`, `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/src/lib/api.ts`, `routes/calls.js` | A caregiver can view/edit the call schedule and the dashboard call action handles success/failure without hanging. | `cd apps/mobile && npm run test:e2e:schedule`; `cd apps/mobile && npm run test:e2e:instant-call`; manual simulator pass |
| P0 | Prove manual call initiation reaches Pipecat. | `routes/calls.js`, `pipecat/api/routes/telnyx.py`, `pipecat/main.py`, `pipecat/bot.py` | Node `/api/call` asks Pipecat `/telnyx/outbound` to create a Telnyx call, then `/ws` starts with expected senior context and masked logs. | `make deploy-dev`; trigger a dummy/consenting dev call; verify Telnyx events and Pipecat metadata |
| P0 | Prove inbound known-senior and new customer voice calls. | `pipecat/api/routes/telnyx.py`, `pipecat/bot.py`, `pipecat/flows/nodes.py`, `pipecat/services/prospects.py` | Known senior inbound calls load profile context; unknown callers use `new_customer` flow and prospect handling without senior reminders. | Dev Telnyx inbound tests for one known test number and one unrecognized test number |
| P0 | Prove post-call analysis, memory, and observability. | `pipecat/services/post_call.py`, `pipecat/services/call_analysis.py`, `pipecat/services/memory.py`, `routes/observability.js`, `apps/observability/` | A completed dev call writes conversation, analysis, memory, daily context, metrics, and snapshot; observability shows timeline/metrics without raw PHI in logs. | `make deploy-dev`; complete a dummy/consenting call; verify DB/admin/observability state |
| P0 | Run a mobile no-crash pass. | `apps/mobile/app/_layout.tsx`, `apps/mobile/app/(tabs)/`, `apps/mobile/app/settings/`, `apps/mobile/src/components/` | Sign-in, dashboard, schedule, reminders, settings, loved-one profile, caregiver profile, notifications, help, and sign-out are navigable. | `cd apps/mobile && npm run test:e2e`; manual iPhone pass if available |
| P0 | Keep sensitive debug logs out. | `apps/website/src/`, `routes/calls.js`, `routes/onboarding.js`, `routes/caregivers.js`, `apps/mobile/app/_layout.tsx`, `pipecat/processors/`, `pipecat/services/` | Logs do not print raw onboarding payloads, phone numbers, push tokens, transcripts, memory queries, or web-search queries. | `cd apps/website && npm run build`; `cd apps/mobile && npx tsc --noEmit`; `npm test`; `make test-python` |

## Priority 1 - Wider Beta Hardening

| Priority | Task | Files | Done when | Validation |
|---|---|---|---|---|
| P1 | Make mobile Maestro flows reliable before every pilot build. | `apps/mobile/.maestro/flows/` | Flows assert visible user outcomes and avoid unnecessary sleeps or brittle selectors. | `cd apps/mobile && npm run test:e2e` |
| P1 | Increase and audit mobile app text sizes. | `apps/mobile/app/`, `apps/mobile/src/components/ui/`, `apps/mobile/src/constants/theme.ts` | Core mobile screens use larger, caregiver-friendly base typography, especially inputs, helper text, settings rows, dashboard summaries, and onboarding copy. System font scaling still works without clipping, overlap, or hidden CTAs at larger iOS text sizes. | `cd apps/mobile && npx tsc --noEmit`; manual simulator pass with iOS Larger Text / Dynamic Type settings; focused Maestro smoke pass for auth, onboarding, dashboard, reminders, and settings |
| P1 | Add focused API coverage for reminders and schedules. | `tests/`, `routes/reminders.js`, `routes/seniors.js`, `validators/schemas.js` | Reminder CRUD and schedule updates are covered without real PHI. | `npm test` |
| P1 | Replace placeholder store links on the public website. | `apps/website/src/` | Store actions no longer use dead `#` links; if stores are not ready, route users to waitlist/coming-soon copy. | `cd apps/website && npm run build`; `npm run test:e2e:consumer` |
| P1 | Make the consumer FAQ Playwright test use semantic selectors. | `tests/e2e/consumer/landing.spec.ts` | The test avoids `.cursor-pointer` and asserts answer content appears. | `npm run test:e2e:consumer` |
| P1 | Replace fixed sleeps in admin E2E tests. | `tests/e2e/admin/seniors.spec.ts`, `tests/e2e/admin/reminders.spec.ts` | `waitForTimeout()` is replaced with deterministic success/list/API assertions. | `npm run test:e2e:admin` |

## Priority 2 - Polish And Docs

| Priority | Task | Files | Done when | Validation |
|---|---|---|---|---|
| P2 | Add a first-pilot checklist to onboarding docs. | `docs/ONBOARDING.md` | A new engineer can find pilot validation flow, test commands, and PHI logging reminders in one place. | Rendered Markdown review |
| P2 | Keep root README and directory map aligned. | `README.md`, `DIRECTORY.md` | README points to current docs and does not contradict `DIRECTORY.md`. | Rendered Markdown review |
| P2 | Add one deterministic observability navigation assertion. | `tests/e2e/observability/navigation.spec.ts` | At least one navigation path asserts an expected heading, panel, or URL. | `npm run test:e2e:observability` |

## Save For Later

These areas are important but should be paired with an experienced reviewer:

- Major voice behavior, prompts, Director, Quick Observer, and post-call analysis changes in `pipecat/`.
- Database schema or migration changes in `db/` and `pipecat/db/`.
- Data retention, audit logging, encryption, and token revocation changes across Node and Python.
- Production deploy work before the dev pilot path is repeatable.
