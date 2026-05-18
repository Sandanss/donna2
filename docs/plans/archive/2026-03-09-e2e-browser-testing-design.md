# E2E Browser Testing Design

**Date:** 2026-03-09
**Status:** Approved

## Goal

Introduce Playwright browser tests across all 3 web apps (admin-v2, consumer, observability) to verify critical user flows work correctly. Mock-first approach for speed, with a separate integration suite against the dev API.

## Scope

~18 tests covering critical flows only. No visual regression, no mobile app (needs Detox), no CI integration yet.

## Test Structure

```
tests/e2e/
├── admin/
│   ├── login.spec.ts          # JWT login flow
│   ├── seniors.spec.ts        # Senior CRUD + search
│   ├── calls.spec.ts          # Call history + transcript viewer
│   ├── reminders.spec.ts      # Reminder create/edit/delete
│   └── navigation.spec.ts     # Sidebar nav + responsive layout
├── consumer/
│   ├── landing.spec.ts        # Public landing page
│   ├── onboarding.spec.ts     # Senior onboarding flow
│   └── dashboard.spec.ts      # Caregiver dashboard
├── observability/
│   ├── history.spec.ts        # History mode: call list, timeline, metrics
│   └── navigation.spec.ts     # Mode toggle, panel switching
├── integration/
│   └── admin-smoke.spec.ts    # Smoke tests against real dev API
├── fixtures/
│   ├── auth.ts                # Login helpers (JWT, Clerk mock, custom token)
│   ├── api-mocks.ts           # Reusable API response mocks
│   └── test-data.ts           # Fake seniors, calls, reminders
└── playwright.config.ts       # Multi-project config
```

## Test Coverage

### Admin Dashboard (10 tests)

| Test | Verifies |
|------|----------|
| Login success | JWT auth, redirect to dashboard |
| Login failure | Error message on bad credentials |
| Navigate all pages | Sidebar links load each page |
| Senior list loads | Table renders, search/filter works |
| Create senior | Form submission, validation, success |
| Call history loads | Call list renders, transcript on click |
| Create reminder | Form with time picker, save |
| Edit reminder | Pre-populated form, update |
| Delete reminder | Confirmation modal, deletion |
| Responsive layout | Sidebar collapses on mobile viewport |

### Consumer App (5 tests)

| Test | Verifies |
|------|----------|
| Landing page renders | Hero, CTA, sign-in visible |
| FAQ page | Accordion items expand |
| Onboarding flow | Step-by-step form progression |
| Dashboard loads | Senior info, call history visible |
| Dashboard actions | Leave note, view call details |

### Observability (3 tests)

| Test | Verifies |
|------|----------|
| History mode loads | Call list, selecting shows timeline |
| Panel switching | Timeline/Observer/Metrics toggle |
| Mode toggle | History vs Live mode switch |

### Integration (1 test, manual)

| Test | Verifies |
|------|----------|
| Admin smoke | Login, load seniors, view call, logout against dev API |

## Auth Strategy

- **Admin:** Mock JWT login API, inject token to localStorage for non-login tests
- **Consumer:** Mock Clerk API endpoints via `page.route()`, return fake session
- **Observability:** Inject auth token to localStorage

## API Mocking

All API calls intercepted with `page.route()`. Shared fixture provides default mock data. Per-test overrides for edge cases (empty states, errors).

Integration suite skips mocking and hits `donna-api-dev.up.railway.app`.

## Playwright Config

| Project | Dev server | Base URL |
|---------|-----------|----------|
| admin | `npm run dev --prefix apps/admin-v2` | localhost:5173 |
| consumer | `npm run dev --prefix apps/consumer` | localhost:5174 |
| observability | `npm run dev --prefix apps/observability` | localhost:5175 |

Settings: Chromium only, 0 retries locally, screenshots on failure, traces on retry, 30s timeout.

## Commands

```bash
npm run test:e2e                           # All apps
npm run test:e2e -- --project=admin        # Single app
npm run test:e2e:integration               # Against dev API
npm run test:e2e -- --headed               # Visible browser
npx playwright show-report                 # HTML report
```
