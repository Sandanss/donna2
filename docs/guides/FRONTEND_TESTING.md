# Frontend E2E Testing Guide

## Overview

We use [Playwright](https://playwright.dev/) for end-to-end browser testing across the admin dashboard, website/caregiver web app, and observability dashboard. Tests mock API responses by default (no backend needed) and verify that UI components, navigation, and user flows work correctly.

**Current coverage:** 31 tests across 5 projects (~15s total runtime).

## Quick Start

```bash
# Install app-local dependencies once after clone
npm run install:apps

# Install Playwright browser (first time only)
npx playwright install chromium

# Run all tests
npm run test:e2e

# Run a specific app's tests
npm run test:e2e:admin
npm run test:e2e:consumer   # legacy project/script name for website tests
npm run test:e2e:website
npm run test:e2e:observability

# Run authenticated website/caregiver tests only
npx playwright test --project=clerk-setup --project=consumer-authenticated

# Run with UI mode (interactive debugging)
npx playwright test --ui

# View last test report
npx playwright show-report
```

The root repo and each frontend app keep separate `package-lock.json` files. If `apps/admin-v2`, `apps/website`, or `apps/observability` fail to boot under Playwright, run `npm run install:apps` again from the repo root before debugging the tests.

## Project Structure

```
tests/e2e/
├── global.setup.ts                  # Clerk testing token initialization
├── fixtures/
│   ├── test-data.ts                 # Mock data (seniors, calls, reminders, etc.)
│   ├── auth.ts                      # JWT auth helpers for admin/observability
│   └── api-mocks.ts                 # page.route() API mock setup functions
├── admin/
│   ├── login.spec.ts                # Login flow, error handling
│   ├── navigation.spec.ts           # Sidebar navigation, responsive layout
│   ├── seniors.spec.ts              # Senior list, create form
│   ├── calls.spec.ts                # Call history, transcript modal
│   └── reminders.spec.ts            # Reminder CRUD
├── consumer/                           # Legacy test directory name; targets apps/website
│   ├── landing.spec.ts              # Landing page, FAQ
│   ├── dashboard.spec.ts            # Protected route redirect tests
│   └── authenticated/
│       ├── dashboard.spec.ts        # Dashboard access, nav, sign out
│       └── onboarding.spec.ts       # Onboarding flow access
├── observability/
│   ├── history.spec.ts              # Call history, timeline
│   └── navigation.spec.ts           # History/Live toggle, view switching
└── integration/
    └── admin-smoke.spec.ts          # Real API integration test
```

## Playwright Config

The config (`playwright.config.ts`) defines 5 test projects:

| Project | App | Port | Auth Method |
|---------|-----|------|-------------|
| `clerk-setup` | — | — | Initializes Clerk testing token |
| `admin` | Admin Dashboard | 5175 | JWT via localStorage |
| `consumer` | Website/caregiver web (public), legacy project name | 5174 | None |
| `consumer-authenticated` | Website/caregiver web (auth), legacy project name | 5174 | Clerk `@clerk/testing` |
| `observability` | Observability | 3002 | JWT via localStorage |

Dev servers are started automatically by Playwright (configured in `webServer`).

## How API Mocking Works

Tests use `page.route()` to intercept API requests at the network level:

```typescript
import { mockAdminAPIs } from '../fixtures/api-mocks';
import { loginAsAdmin } from '../fixtures/auth';

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);     // Inject JWT into localStorage
  await mockAdminAPIs(page);    // Intercept all /api/* routes
  await page.goto('/');
});
```

The mock functions in `fixtures/api-mocks.ts` return data from `fixtures/test-data.ts`. No backend server is needed.

### Adding a New Mock

1. Add mock data to `fixtures/test-data.ts`
2. Add a `page.route()` call in the appropriate mock function in `fixtures/api-mocks.ts`
3. Use the mock in your test's `beforeEach`

```typescript
// In api-mocks.ts
await page.route('**/api/new-endpoint', route =>
  route.fulfill({ json: mockNewData })
);
```

## Clerk Authentication (Website/Caregiver Web)

Authenticated website/caregiver tests use `@clerk/testing` to sign in as a real Clerk test user.

### How It Works

1. **Global setup** (`global.setup.ts`): Calls `clerkSetup()` to fetch a testing token from Clerk's API using `CLERK_SECRET_KEY`
2. **Per-test**: Each test calls `setupClerkTestingToken({ page })` then `clerk.signIn({ page, emailAddress })` to authenticate

```typescript
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';

test.beforeEach(async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto('/', { waitUntil: 'networkidle' });
  await clerk.signIn({
    page,
    emailAddress: process.env.E2E_CLERK_USER_EMAIL!,
  });
});
```

### Credentials

Stored in `tests/e2e/.env.test` (gitignored):

```
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
E2E_CLERK_USER_EMAIL=e2etest@calldonna.co
E2E_CLERK_USER_PASSWORD=...
```

The test user was created in Clerk's development instance. To create a new one:

```bash
curl -X POST https://api.clerk.com/v1/users \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email_address": ["newuser@calldonna.co"],
    "phone_number": ["+19785550199"],
    "password": "SomeSecurePassword123"
  }'
```

### Important: Use `emailAddress` Mode

Always use `clerk.signIn({ page, emailAddress })` — NOT `clerk.signIn({ page, signInParams: { strategy: 'password', ... } })`.

The `password` strategy has a bug in `@clerk/testing@2.0.1` where it silently fails to establish a session. The `emailAddress` mode uses a sign-in token via Clerk's Backend API, which works correctly.

## Writing New Tests

### Admin / Observability (JWT Auth)

```typescript
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../fixtures/auth';
import { mockAdminAPIs } from '../fixtures/api-mocks';

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
  await mockAdminAPIs(page);
  await page.goto('/your-page');
});

test('your test', async ({ page }) => {
  await expect(page.getByText('Expected Content')).toBeVisible();
});
```

### Website Public Pages

```typescript
import { test, expect } from '@playwright/test';

test('landing page works', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByText('Donna').first()).toBeVisible({ timeout: 15000 });
});
```

### Website Authenticated Pages

Place test files in `tests/e2e/consumer/authenticated/`. They run in the `consumer-authenticated` project which depends on `clerk-setup`.

```typescript
import { clerk, setupClerkTestingToken } from '@clerk/testing/playwright';
import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

test.beforeEach(async ({ page }) => {
  await setupClerkTestingToken({ page });
  await page.goto('/', { waitUntil: 'networkidle' });
  await clerk.signIn({ page, emailAddress: process.env.E2E_CLERK_USER_EMAIL! });
  await page.waitForTimeout(1000);
});

test('authenticated page works', async ({ page }) => {
  await page.goto('/dashboard');
  // ...
});
```

## Integration Tests

Integration tests in `tests/e2e/integration/` run against a real API and are excluded from the default suite. Run them separately:

```bash
npx playwright test --config playwright.integration.config.ts
```

These require real credentials in environment variables (e.g., `ADMIN_EMAIL`, `ADMIN_PASSWORD`).

## Troubleshooting

### Tests fail with "Executable doesn't exist"

Install the Playwright browser: `npx playwright install chromium`

### Consumer tests show blank white page

The Clerk JS SDK might not be loading. Check that `VITE_CLERK_PUBLISHABLE_KEY` is set in the `webServer` env config in `playwright.config.ts`.

### Authenticated tests show landing page (not signed in)

- Verify `tests/e2e/.env.test` exists with correct `CLERK_SECRET_KEY` and `E2E_CLERK_USER_EMAIL`
- Make sure you're using `emailAddress` mode, not `signInParams` with `password` strategy
- Run with `--project=clerk-setup --project=consumer-authenticated` to ensure the setup project runs

### "Failed to load profile" on dashboard

Expected when the Node.js API isn't running locally. The authenticated tests accept this error state as valid (confirms auth worked, just no API data).

### Proxy errors for `/api/caregivers/me`

Expected in authenticated tests when the Node API is not running locally. The website/caregiver web app tries to fetch from the API; these Vite proxy errors do not affect mocked test results.

### `__dirname is not defined in ES module scope`

Use the ESM-compatible pattern:
```typescript
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```
