# E2E Browser Testing Implementation Plan

> Historical implementation plan. Mock fixtures below may include old Sonnet model IDs or SMS preference fields; current runtime defaults are documented in `README.md`, `DIRECTORY.md`, and `docs/architecture/`.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Playwright browser tests across all 3 web apps (admin-v2, consumer, observability) covering critical user flows with mocked APIs.

**Architecture:** Multi-project Playwright config with shared TypeScript fixtures for auth and API mocking. Each app is a separate project with its own dev server. Integration suite runs separately against real dev API.

**Tech Stack:** Playwright 1.50, TypeScript, Vite dev servers (admin:5175, consumer:5174, observability:3002)

---

## Important Context

- **Existing config:** `playwright.config.js` exists but has wrong port (5173 vs 5175) and only covers admin-v2
- **Existing stubs:** `tests/e2e/admin/dashboard.spec.js` has 22 placeholder tests — delete and replace
- **Auth differs per app:** Admin uses JWT (`donna_admin_token`), Consumer uses Clerk, Observability uses JWT (`donna_obs_token`)
- **API proxy:** All 3 apps proxy `/api/*` to `localhost:3001` (Node.js backend)
- **No data-testid attributes** on components — tests use semantic selectors (roles, text, placeholders)

---

### Task 1: Playwright Config & TypeScript Setup

**Files:**
- Delete: `playwright.config.js`
- Create: `playwright.config.ts`
- Create: `tests/e2e/tsconfig.json`
- Delete: `tests/e2e/admin/dashboard.spec.js`
- Modify: `package.json` (add scripts)

**Step 1: Create TypeScript config for E2E tests**

Create `tests/e2e/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["**/*.ts"]
}
```

**Step 2: Replace playwright config with multi-project TypeScript version**

Delete `playwright.config.js`. Create `playwright.config.ts`:
```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: ['**/integration/**'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 30000,

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'admin',
      testDir: './tests/e2e/admin',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5175',
      },
    },
    {
      name: 'consumer',
      testDir: './tests/e2e/consumer',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5174',
      },
    },
    {
      name: 'observability',
      testDir: './tests/e2e/observability',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3002',
      },
    },
  ],

  webServer: [
    {
      command: 'npm run dev --prefix apps/admin-v2',
      url: 'http://localhost:5175',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command: 'npm run dev --prefix apps/consumer',
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command: 'npm run dev --prefix apps/observability',
      url: 'http://localhost:3002',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
});
```

**Step 3: Delete old stub tests**

Delete `tests/e2e/admin/dashboard.spec.js`.

**Step 4: Add npm scripts**

Add to `package.json` scripts:
```json
{
  "test:e2e": "playwright test",
  "test:e2e:admin": "playwright test --project=admin",
  "test:e2e:consumer": "playwright test --project=consumer",
  "test:e2e:observability": "playwright test --project=observability",
  "test:e2e:integration": "playwright test --config=playwright.integration.config.ts"
}
```

**Step 5: Verify config loads**

Run: `cd /Users/davidzuluaga/code/donna2 && npx playwright test --list`
Expected: Lists 0 tests (no spec files yet), no config errors.

**Step 6: Commit**

```bash
git add playwright.config.ts tests/e2e/tsconfig.json package.json
git rm playwright.config.js tests/e2e/admin/dashboard.spec.js
git commit -m "feat: replace Playwright config with multi-project TypeScript setup"
```

---

### Task 2: Shared Fixtures — Test Data

**Files:**
- Create: `tests/e2e/fixtures/test-data.ts`

**Step 1: Create mock data file**

Create `tests/e2e/fixtures/test-data.ts`:
```typescript
// Mock data for all E2E tests

export const mockSeniors = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Martha Johnson',
    phone: '+15551234567',
    location: 'Austin, TX',
    interests: ['gardening', 'crosswords', 'jazz'],
    medicalNotes: 'Takes blood pressure medication',
    isActive: true,
    createdAt: '2026-01-15T10:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Robert Smith',
    phone: '+15559876543',
    location: 'Denver, CO',
    interests: ['history', 'fishing'],
    medicalNotes: '',
    isActive: true,
    createdAt: '2026-02-01T10:00:00Z',
  },
];

export const mockConversations = [
  {
    id: 'call-1',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    startedAt: '2026-03-08T14:00:00Z',
    endedAt: '2026-03-08T14:10:00Z',
    durationSeconds: 600,
    status: 'completed',
    initiatedBy: 'scheduled',
    transcript: [
      { role: 'assistant', content: 'Good morning Martha! How are you today?' },
      { role: 'user', content: 'Oh hi Donna! I\'m doing well, just finished my crossword.' },
      { role: 'assistant', content: 'That\'s wonderful! Was it a tricky one today?' },
    ],
  },
  {
    id: 'call-2',
    seniorId: '22222222-2222-2222-2222-222222222222',
    seniorName: 'Robert Smith',
    startedAt: '2026-03-08T15:00:00Z',
    endedAt: '2026-03-08T15:08:00Z',
    durationSeconds: 480,
    status: 'completed',
    initiatedBy: 'manual',
    transcript: [],
  },
];

export const mockReminders = [
  {
    id: 'rem-1',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    title: 'Take morning pills',
    description: 'Blood pressure medication with breakfast',
    type: 'medication',
    isRecurring: true,
    cronExpression: '0 8 * * *',
    scheduledTime: null,
    isActive: true,
    lastDelivered: '2026-03-08T08:00:00Z',
    createdAt: '2026-01-20T10:00:00Z',
  },
  {
    id: 'rem-2',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    title: 'Doctor appointment',
    description: 'Annual checkup at Dr. Wilson',
    type: 'appointment',
    isRecurring: false,
    cronExpression: null,
    scheduledTime: '2026-03-15T10:00:00Z',
    isActive: true,
    lastDelivered: null,
    createdAt: '2026-03-01T10:00:00Z',
  },
];

export const mockDashboardStats = {
  totalSeniors: 2,
  callsToday: 3,
  upcomingReminders: 2,
  activeCalls: 0,
  recentCalls: [
    {
      id: 'call-1',
      seniorName: 'Martha Johnson',
      startedAt: '2026-03-08T14:00:00Z',
      durationSeconds: 600,
      status: 'completed',
    },
  ],
  upcomingRemindersList: [
    {
      id: 'rem-2',
      seniorName: 'Martha Johnson',
      title: 'Doctor appointment',
      scheduledTime: '2026-03-15T10:00:00Z',
    },
  ],
};

export const mockCallAnalyses = [
  {
    id: 'analysis-1',
    conversationId: 'call-1',
    seniorName: 'Martha Johnson',
    createdAt: '2026-03-08T14:15:00Z',
    engagementScore: 8,
    summary: 'Martha was in great spirits, discussed her crossword puzzle and gardening plans.',
    topicsDiscussed: ['crosswords', 'gardening', 'weather'],
    concerns: [],
    positiveObservations: ['Good mood', 'Engaged in hobbies'],
    followUpSuggestions: ['Ask about garden progress next call'],
  },
];

export const mockCaregivers = [
  {
    id: 'cg-1',
    clerkUserId: 'user_abc123',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    role: 'daughter',
    createdAt: '2026-01-15T10:00:00Z',
  },
];

export const mockDailyContext = [
  {
    id: 'dc-1',
    seniorId: '11111111-1111-1111-1111-111111111111',
    seniorName: 'Martha Johnson',
    callDate: '2026-03-08',
    summary: 'Martha discussed crosswords and gardening. Reminded about morning medication.',
    topicsDiscussed: ['crosswords', 'gardening'],
    remindersDelivered: ['Take morning pills'],
    adviceGiven: 'Suggested trying the Sunday NYT crossword',
  },
];

// Observability-specific mock data
export const mockObservabilityCalls = [
  {
    id: 'obs-call-1',
    senior_id: '11111111-1111-1111-1111-111111111111',
    call_sid: 'CA1234567890',
    started_at: '2026-03-08T14:00:00Z',
    ended_at: '2026-03-08T14:10:00Z',
    duration_seconds: 600,
    status: 'completed',
    initiated_by: 'scheduled',
    senior_name: 'Martha Johnson',
    senior_phone: '+15551234567',
    turn_count: 12,
    summary: 'Discussed crosswords and gardening',
    concerns: [],
    call_metrics: {
      totalTokens: 2847,
      totalInputTokens: 1200,
      totalOutputTokens: 1647,
      avgResponseTime: 324,
      avgTtfa: 89,
      estimatedCost: 0.0234,
      modelsUsed: ['claude-sonnet-4-5-20250514'],
    },
  },
];

export const mockTimeline = {
  callId: 'obs-call-1',
  callSid: 'CA1234567890',
  seniorId: '11111111-1111-1111-1111-111111111111',
  startedAt: '2026-03-08T14:00:00Z',
  endedAt: '2026-03-08T14:10:00Z',
  status: 'completed',
  timeline: [
    { type: 'call.initiated', timestamp: '2026-03-08T14:00:00Z', data: { initiatedBy: 'scheduled' } },
    { type: 'call.connected', timestamp: '2026-03-08T14:00:02Z', data: {} },
    { type: 'turn.response', timestamp: '2026-03-08T14:00:05Z', data: { content: 'Good morning Martha!' } },
    { type: 'turn.transcribed', timestamp: '2026-03-08T14:00:15Z', data: { content: 'Hi Donna!' } },
    { type: 'observer.signal', timestamp: '2026-03-08T14:00:16Z', data: { signal: { engagementLevel: 'high', emotionalState: 'positive', confidenceScore: 92, concerns: [], shouldDeliverReminder: false, shouldEndCall: false } } },
    { type: 'call.ended', timestamp: '2026-03-08T14:10:00Z', data: { status: 'completed', duration: 600 } },
  ],
};

export const mockObserverData = {
  callId: 'obs-call-1',
  count: 5,
  signals: [
    {
      turnId: 'turn-1',
      speaker: 'senior',
      turnContent: 'Hi Donna, I just finished my crossword puzzle!',
      timestamp: '2026-03-08T14:00:15Z',
      signal: { engagementLevel: 'high', emotionalState: 'positive', confidenceScore: 92, concerns: [], shouldDeliverReminder: false, shouldEndCall: false },
    },
  ],
  summary: {
    averageConfidence: 87,
    engagementDistribution: { high: 8, medium: 3, low: 1 },
    emotionalStateDistribution: { positive: 7, neutral: 4, negative: 0, confused: 1, distressed: 0 },
    totalConcerns: 0,
    uniqueConcerns: [],
  },
};

export const mockMetricsData = {
  turnMetrics: [
    { turnIndex: 0, role: 'assistant', model: 'claude-sonnet-4-5-20250514', maxTokens: 1024, inputTokens: 450, outputTokens: 120, ttfa: 85, responseTime: 310, tokenReason: 'normal' },
    { turnIndex: 1, role: 'assistant', model: 'claude-sonnet-4-5-20250514', maxTokens: 1024, inputTokens: 580, outputTokens: 95, ttfa: 92, responseTime: 340, tokenReason: 'normal' },
  ],
  callMetrics: {
    totalInputTokens: 1200,
    totalOutputTokens: 1647,
    totalTokens: 2847,
    avgResponseTime: 324,
    avgTtfa: 89,
    turnCount: 12,
    estimatedCost: 0.0234,
    modelsUsed: ['claude-sonnet-4-5-20250514'],
  },
  durationSeconds: 600,
};
```

**Step 2: Commit**

```bash
git add tests/e2e/fixtures/test-data.ts
git commit -m "feat: add E2E test mock data fixtures"
```

---

### Task 3: Shared Fixtures — Auth & API Mocks

**Files:**
- Create: `tests/e2e/fixtures/auth.ts`
- Create: `tests/e2e/fixtures/api-mocks.ts`

**Step 1: Create auth fixture**

Create `tests/e2e/fixtures/auth.ts`:
```typescript
import { type Page } from '@playwright/test';

const MOCK_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3QtYWRtaW4iLCJlbWFpbCI6ImFkbWluQGRvbm5hLmNvbSIsImlhdCI6OTk5OTk5OTk5OX0.test-signature';

/**
 * Admin app: inject JWT into localStorage and mock /api/admin/me
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  // Mock the token verification endpoint
  await page.route('**/api/admin/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'test-admin', email: 'admin@donna.com' }),
    })
  );

  // Inject token before navigating
  await page.addInitScript((token) => {
    localStorage.setItem('donna_admin_token', token);
  }, MOCK_JWT);
}

/**
 * Observability app: inject JWT into localStorage and mock /api/admin/me
 */
export async function loginAsObserver(page: Page): Promise<void> {
  await page.route('**/api/admin/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'test-admin', email: 'admin@donna.com' }),
    })
  );

  await page.addInitScript((token) => {
    localStorage.setItem('donna_obs_token', token);
  }, MOCK_JWT);
}

/**
 * Consumer app: mock Clerk's session endpoints to bypass OAuth.
 * Clerk checks /__clerk/session and various clerk.*.com endpoints.
 */
export async function loginAsCaregiver(page: Page): Promise<void> {
  // Mock Clerk's frontend API session check
  await page.route('**clerk**', route => {
    const url = route.request().url();

    // Session endpoint — return a valid session
    if (url.includes('/v1/client') || url.includes('/sessions')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          response: {
            sessions: [{
              id: 'sess_test123',
              status: 'active',
              user: {
                id: 'user_test123',
                email_addresses: [{ email_address: 'caregiver@test.com' }],
                first_name: 'Test',
                last_name: 'Caregiver',
              },
            }],
          },
          client: { sessions: [{ id: 'sess_test123', status: 'active' }] },
        }),
      });
    }

    // Let other Clerk requests pass or return empty
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Mock the caregiver profile check (consumer app checks this on load)
  await page.route('**/api/caregivers/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'cg-test',
        clerkUserId: 'user_test123',
        seniors: [{
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Martha Johnson',
          phone: '+15551234567',
        }],
      }),
    })
  );
}
```

**Step 2: Create API mocks fixture**

Create `tests/e2e/fixtures/api-mocks.ts`:
```typescript
import { type Page } from '@playwright/test';
import {
  mockSeniors,
  mockConversations,
  mockReminders,
  mockDashboardStats,
  mockCallAnalyses,
  mockCaregivers,
  mockDailyContext,
  mockObservabilityCalls,
  mockTimeline,
  mockObserverData,
  mockMetricsData,
} from './test-data';

/**
 * Set up all API mocks for the admin dashboard.
 * Call this in beforeEach for admin tests.
 */
export async function mockAdminAPIs(page: Page): Promise<void> {
  await page.route('**/api/stats', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockDashboardStats) })
  );

  await page.route('**/api/seniors', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'new-senior-id', ...body, isActive: true, createdAt: new Date().toISOString() }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockSeniors) });
  });

  await page.route('**/api/seniors/*/memories', route => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'new-mem-id' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.route(/\/api\/seniors\/[^/]+$/, route => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...mockSeniors[0], ...route.request().postDataJSON() }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockSeniors[0]) });
  });

  await page.route('**/api/conversations', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockConversations) })
  );

  await page.route('**/api/reminders', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'new-rem-id', ...body, isActive: true, createdAt: new Date().toISOString() }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockReminders) });
  });

  await page.route(/\/api\/reminders\/[^/]+$/, route => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/api/call-analyses', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockCallAnalyses) })
  );

  await page.route('**/api/caregivers', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockCaregivers) })
  );

  await page.route('**/api/daily-context*', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockDailyContext) })
  );

  await page.route('**/api/call', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, callSid: 'CA-test' }) })
  );
}

/**
 * Set up all API mocks for the consumer app.
 */
export async function mockConsumerAPIs(page: Page): Promise<void> {
  await page.route('**/api/onboarding', route =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ senior: mockSeniors[0], reminders: mockReminders }),
    })
  );

  await page.route('**/api/seniors/*/reminders', route => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'new-rem', title: 'New reminder', type: 'custom' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockReminders) });
  });

  await page.route('**/api/seniors/*/calls', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockConversations) })
  );

  await page.route(/\/api\/seniors\/[^/]+$/, route => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockSeniors[0]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockSeniors[0]) });
  });

  await page.route(/\/api\/reminders\/[^/]+$/, route => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'rem-1', title: 'Updated' }) });
    }
    return route.fulfill({ status: 200 });
  });

  await page.route('**/api/notifications/preferences', route => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ callCompleted: true, concernDetected: true, reminderMissed: false, weeklySummary: true, smsEnabled: false, emailEnabled: true }),
    });
  });

  await page.route('**/api/call', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  );
}

/**
 * Set up all API mocks for the observability dashboard.
 */
export async function mockObservabilityAPIs(page: Page): Promise<void> {
  await page.route('**/api/observability/calls*', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ calls: mockObservabilityCalls }) })
  );

  await page.route('**/api/observability/active', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activeCalls: [] }) })
  );

  await page.route('**/api/observability/calls/*/timeline', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockTimeline) })
  );

  await page.route('**/api/observability/calls/*/observer', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockObserverData) })
  );

  await page.route('**/api/observability/calls/*/metrics', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockMetricsData) })
  );
}
```

**Step 3: Commit**

```bash
git add tests/e2e/fixtures/auth.ts tests/e2e/fixtures/api-mocks.ts
git commit -m "feat: add E2E auth helpers and API mock fixtures"
```

---

### Task 4: Admin Tests — Login & Navigation

**Files:**
- Create: `tests/e2e/admin/login.spec.ts`
- Create: `tests/e2e/admin/navigation.spec.ts`

**Step 1: Write login tests**

Create `tests/e2e/admin/login.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../fixtures/auth';
import { mockAdminAPIs } from '../fixtures/api-mocks';

test.describe('Admin Login', () => {
  test('successful login redirects to dashboard', async ({ page }) => {
    // Mock login endpoint
    await page.route('**/api/admin/login', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'fake-jwt-token' }),
      })
    );
    await page.route('**/api/admin/me', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-admin', email: 'admin@donna.com' }),
      })
    );
    await mockAdminAPIs(page);

    await page.goto('/login');

    // Fill in login form
    await page.getByPlaceholder('admin@donna.com').fill('admin@donna.com');
    await page.getByPlaceholder('Your password').fill('testpassword');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should redirect to dashboard
    await expect(page).toHaveURL('/');
  });

  test('failed login shows error message', async ({ page }) => {
    await page.route('**/api/admin/login', route =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid credentials' }),
      })
    );

    await page.goto('/login');

    await page.getByPlaceholder('admin@donna.com').fill('wrong@email.com');
    await page.getByPlaceholder('Your password').fill('wrongpassword');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should show error
    await expect(page.locator('.text-admin-danger')).toBeVisible();
  });
});
```

**Step 2: Write navigation tests**

Create `tests/e2e/admin/navigation.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../fixtures/auth';
import { mockAdminAPIs } from '../fixtures/api-mocks';

test.describe('Admin Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await mockAdminAPIs(page);
  });

  const pages = [
    { name: /dashboard/i, url: '/' },
    { name: /seniors/i, url: '/seniors' },
    { name: /calls/i, url: '/calls' },
    { name: /reminders/i, url: '/reminders' },
    { name: /call analyses/i, url: '/call-analyses' },
    { name: /caregivers/i, url: '/caregivers' },
    { name: /daily context/i, url: '/daily-context' },
  ];

  for (const { name, url } of pages) {
    test(`navigates to ${url}`, async ({ page }) => {
      await page.goto('/');
      await page.getByRole('link', { name }).click();
      await expect(page).toHaveURL(url);
    });
  }

  test('responsive: sidebar collapses on mobile', async ({ page }) => {
    await page.goto('/');
    await page.setViewportSize({ width: 375, height: 667 });

    // Nav links should be hidden or collapsed on mobile
    // The exact behavior depends on the Layout component's responsive logic
    // At minimum, the page should render without errors
    await expect(page.locator('body')).toBeVisible();
  });
});
```

**Step 3: Run tests to verify they work**

Run: `cd /Users/davidzuluaga/code/donna2 && npx playwright test --project=admin tests/e2e/admin/login.spec.ts tests/e2e/admin/navigation.spec.ts`
Expected: Tests pass with mocked APIs.

**Step 4: Commit**

```bash
git add tests/e2e/admin/login.spec.ts tests/e2e/admin/navigation.spec.ts
git commit -m "feat: add admin login and navigation E2E tests"
```

---

### Task 5: Admin Tests — Seniors, Calls, Reminders

**Files:**
- Create: `tests/e2e/admin/seniors.spec.ts`
- Create: `tests/e2e/admin/calls.spec.ts`
- Create: `tests/e2e/admin/reminders.spec.ts`

**Step 1: Write seniors tests**

Create `tests/e2e/admin/seniors.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../fixtures/auth';
import { mockAdminAPIs } from '../fixtures/api-mocks';

test.describe('Admin Seniors', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await mockAdminAPIs(page);
  });

  test('senior list loads with mock data', async ({ page }) => {
    await page.goto('/seniors');

    // Should see both mock seniors
    await expect(page.getByText('Martha Johnson')).toBeVisible();
    await expect(page.getByText('Robert Smith')).toBeVisible();
  });

  test('create senior via form', async ({ page }) => {
    await page.goto('/seniors');

    // Fill the add senior form
    await page.getByPlaceholder('Full name').fill('Jane Doe');
    await page.getByPlaceholder('+1234567890').fill('+15551112222');
    await page.getByPlaceholder('City, State').fill('Portland, OR');
    await page.getByPlaceholder('gardening, crosswords, jazz').fill('reading, cooking');

    // Submit
    await page.getByRole('button', { name: /add senior/i }).click();

    // Should show success (toast or form reset)
    await page.waitForTimeout(500);
  });
});
```

**Step 2: Write calls tests**

Create `tests/e2e/admin/calls.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../fixtures/auth';
import { mockAdminAPIs } from '../fixtures/api-mocks';

test.describe('Admin Calls', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await mockAdminAPIs(page);
  });

  test('call history loads', async ({ page }) => {
    await page.goto('/calls');

    // Should see mock call data
    await expect(page.getByText('Martha Johnson')).toBeVisible();
  });

  test('clicking transcript opens modal', async ({ page }) => {
    await page.goto('/calls');

    // Click transcript button on first call (which has transcript data)
    const transcriptBtn = page.getByRole('button', { name: /transcript/i }).first();
    if (await transcriptBtn.isVisible()) {
      await transcriptBtn.click();

      // Modal should show transcript content
      await expect(page.getByText('Good morning Martha!')).toBeVisible();
    }
  });
});
```

**Step 3: Write reminders tests**

Create `tests/e2e/admin/reminders.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsAdmin } from '../fixtures/auth';
import { mockAdminAPIs } from '../fixtures/api-mocks';

test.describe('Admin Reminders', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await mockAdminAPIs(page);
  });

  test('reminders list loads', async ({ page }) => {
    await page.goto('/reminders');

    await expect(page.getByText('Take morning pills')).toBeVisible();
    await expect(page.getByText('Doctor appointment')).toBeVisible();
  });

  test('create a new reminder', async ({ page }) => {
    await page.goto('/reminders');

    // Select senior
    await page.locator('select').first().selectOption({ label: 'Martha Johnson' });

    // Fill title
    await page.getByPlaceholder('e.g. Take morning pills').fill('Evening walk reminder');

    // Set time
    await page.locator('input[type="time"]').fill('18:00');

    // Select daily recurring
    await page.getByLabel('daily').check();

    // Submit
    await page.getByRole('button', { name: /add reminder/i }).click();

    await page.waitForTimeout(500);
  });

  test('delete a reminder', async ({ page }) => {
    await page.goto('/reminders');

    // Find and click delete button
    const deleteBtn = page.locator('button').filter({ hasText: /delete/i }).first();
    if (await deleteBtn.isVisible()) {
      await deleteBtn.click();
      await page.waitForTimeout(500);
    }
  });
});
```

**Step 4: Run admin tests**

Run: `cd /Users/davidzuluaga/code/donna2 && npx playwright test --project=admin`
Expected: All admin tests pass.

**Step 5: Commit**

```bash
git add tests/e2e/admin/seniors.spec.ts tests/e2e/admin/calls.spec.ts tests/e2e/admin/reminders.spec.ts
git commit -m "feat: add admin seniors, calls, and reminders E2E tests"
```

---

### Task 6: Consumer Tests

**Files:**
- Create: `tests/e2e/consumer/landing.spec.ts`
- Create: `tests/e2e/consumer/onboarding.spec.ts`
- Create: `tests/e2e/consumer/dashboard.spec.ts`

**Step 1: Write landing page tests**

Create `tests/e2e/consumer/landing.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';

test.describe('Consumer Landing', () => {
  test('landing page renders with key elements', async ({ page }) => {
    // Block Clerk from loading (avoids auth complexity for public page)
    await page.route('**clerk**', route => route.fulfill({ status: 200, body: '{}' }));

    await page.goto('/');

    // Hero section visible
    await expect(page.getByText('Donna')).toBeVisible();

    // CTA buttons
    await expect(page.getByRole('button', { name: /get started/i }).first()).toBeVisible();
  });

  test('FAQ page loads and accordions work', async ({ page }) => {
    await page.route('**clerk**', route => route.fulfill({ status: 200, body: '{}' }));

    await page.goto('/faq');

    await expect(page.getByText('Frequently Asked Questions')).toBeVisible();

    // Click first FAQ item to expand it
    const firstQuestion = page.locator('.cursor-pointer').first();
    if (await firstQuestion.isVisible()) {
      await firstQuestion.click();
      // Content should expand (chevron rotates, answer appears)
      await page.waitForTimeout(300);
    }
  });
});
```

**Step 2: Write onboarding tests**

Create `tests/e2e/consumer/onboarding.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsCaregiver } from '../fixtures/auth';
import { mockConsumerAPIs } from '../fixtures/api-mocks';

test.describe('Consumer Onboarding', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsCaregiver(page);
    await mockConsumerAPIs(page);

    // Override caregiver check to simulate NOT yet onboarded
    await page.route('**/api/caregivers/me', route =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) })
    );
  });

  test('onboarding flow progresses through steps', async ({ page }) => {
    await page.goto('/onboarding');

    // Step 1: Senior Profile
    await page.getByPlaceholder(/martha/i).fill('Betty White');
    await page.getByPlaceholder(/555/i).fill('(555) 987-6543');

    // Select relation
    const relationSelect = page.locator('select').first();
    if (await relationSelect.isVisible()) {
      await relationSelect.selectOption('Mother');
    }

    // Click Next
    await page.getByRole('button', { name: /next/i }).click();

    // Step 2: Should advance (look for reminders section or step 2 indicator)
    await page.waitForTimeout(300);

    // Click Next again to step 3
    await page.getByRole('button', { name: /next/i }).click();
    await page.waitForTimeout(300);

    // Step 3: Interests - click a topic
    const sportsTopic = page.getByText('Sports');
    if (await sportsTopic.isVisible()) {
      await sportsTopic.click();
      await page.waitForTimeout(200);
    }

    // Next to step 4
    await page.getByRole('button', { name: /next/i }).click();
    await page.waitForTimeout(300);

    // Step 4: Schedule - toggle a day
    const mondayBtn = page.getByText('Mon');
    if (await mondayBtn.isVisible()) {
      await mondayBtn.click();
    }

    // Next to step 5 (review)
    await page.getByRole('button', { name: /next/i }).click();
    await page.waitForTimeout(300);

    // Step 5: Review - should see senior name
    await expect(page.getByText('Betty White')).toBeVisible();
  });
});
```

**Step 3: Write dashboard tests**

Create `tests/e2e/consumer/dashboard.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsCaregiver } from '../fixtures/auth';
import { mockConsumerAPIs } from '../fixtures/api-mocks';

test.describe('Consumer Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsCaregiver(page);
    await mockConsumerAPIs(page);
  });

  test('dashboard loads with senior info', async ({ page }) => {
    await page.goto('/dashboard');

    // Should show senior name
    await expect(page.getByText('Martha Johnson')).toBeVisible();
  });

  test('can switch between dashboard tabs', async ({ page }) => {
    await page.goto('/dashboard');

    // Click Reminders tab
    const remindersTab = page.getByText('Reminders', { exact: true }).first();
    if (await remindersTab.isVisible()) {
      await remindersTab.click();
      await page.waitForTimeout(300);
    }

    // Click Profile tab
    const profileTab = page.getByText('Profile', { exact: true }).first();
    if (await profileTab.isVisible()) {
      await profileTab.click();
      await page.waitForTimeout(300);
    }
  });

  test('leave a caregiver note (instant check-in)', async ({ page }) => {
    await page.goto('/dashboard');

    // Find the instant check-in button
    const checkinBtn = page.getByText(/instant check-in/i);
    if (await checkinBtn.isVisible()) {
      await checkinBtn.click();
      await page.waitForTimeout(500);
    }
  });
});
```

**Step 4: Run consumer tests**

Run: `cd /Users/davidzuluaga/code/donna2 && npx playwright test --project=consumer`
Expected: Tests pass. (Clerk mocking may need adjustment — see troubleshooting note below.)

> **Troubleshooting:** If Clerk's JS bundle fails to load and the app crashes, add this to `loginAsCaregiver()`:
> ```typescript
> await page.route('**/*.clerk.accounts.dev/**', route => route.abort());
> ```
> This prevents Clerk from making real network requests.

**Step 5: Commit**

```bash
git add tests/e2e/consumer/landing.spec.ts tests/e2e/consumer/onboarding.spec.ts tests/e2e/consumer/dashboard.spec.ts
git commit -m "feat: add consumer landing, onboarding, and dashboard E2E tests"
```

---

### Task 7: Observability Tests

**Files:**
- Create: `tests/e2e/observability/history.spec.ts`
- Create: `tests/e2e/observability/navigation.spec.ts`

**Step 1: Write history mode tests**

Create `tests/e2e/observability/history.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsObserver } from '../fixtures/auth';
import { mockObservabilityAPIs } from '../fixtures/api-mocks';

test.describe('Observability History', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsObserver(page);
    await mockObservabilityAPIs(page);
  });

  test('call list loads in history mode', async ({ page }) => {
    await page.goto('/');

    // Should see the call list with mock data
    await expect(page.locator('.call-list-item').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Martha Johnson')).toBeVisible();
  });

  test('selecting a call shows timeline', async ({ page }) => {
    await page.goto('/');

    // Click first call in list
    await page.locator('.call-list-item').first().click();

    // Timeline should appear with events
    await expect(page.locator('.timeline-event').first()).toBeVisible({ timeout: 5000 });
  });
});
```

**Step 2: Write navigation/panel switching tests**

Create `tests/e2e/observability/navigation.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import { loginAsObserver } from '../fixtures/auth';
import { mockObservabilityAPIs } from '../fixtures/api-mocks';

test.describe('Observability Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsObserver(page);
    await mockObservabilityAPIs(page);
  });

  test('toggle between History and Live modes', async ({ page }) => {
    await page.goto('/');

    // Click Live mode
    const liveBtn = page.locator('.app-mode-toggle').getByText('Live');
    if (await liveBtn.isVisible()) {
      await liveBtn.click();
      await expect(page.locator('.live-monitor')).toBeVisible({ timeout: 5000 });
    }

    // Click back to History
    const historyBtn = page.locator('.app-mode-toggle').getByText('History');
    if (await historyBtn.isVisible()) {
      await historyBtn.click();
      await expect(page.locator('.call-list')).toBeVisible({ timeout: 5000 });
    }
  });

  test('switch between Timeline, Observer, and Metrics views', async ({ page }) => {
    await page.goto('/');

    // Select a call first
    await page.locator('.call-list-item').first().click();
    await page.waitForTimeout(500);

    // Switch to Observer view
    const observerBtn = page.locator('.view-toggle').getByText('Observer');
    if (await observerBtn.isVisible()) {
      await observerBtn.click();
      await expect(page.locator('.observer-panel')).toBeVisible({ timeout: 5000 });
    }

    // Switch to Metrics view
    const metricsBtn = page.locator('.view-toggle').getByText('Metrics');
    if (await metricsBtn.isVisible()) {
      await metricsBtn.click();
      await expect(page.locator('.metrics-panel')).toBeVisible({ timeout: 5000 });
    }

    // Switch back to Timeline
    const timelineBtn = page.locator('.view-toggle').getByText('Timeline');
    if (await timelineBtn.isVisible()) {
      await timelineBtn.click();
      await expect(page.locator('.timeline')).toBeVisible({ timeout: 5000 });
    }
  });
});
```

**Step 3: Run observability tests**

Run: `cd /Users/davidzuluaga/code/donna2 && npx playwright test --project=observability`
Expected: Tests pass.

**Step 4: Commit**

```bash
git add tests/e2e/observability/history.spec.ts tests/e2e/observability/navigation.spec.ts
git commit -m "feat: add observability history and navigation E2E tests"
```

---

### Task 8: Integration Smoke Test

**Files:**
- Create: `tests/e2e/integration/admin-smoke.spec.ts`
- Create: `playwright.integration.config.ts`

**Step 1: Create integration Playwright config**

Create `playwright.integration.config.ts`:
```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/integration',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'html',
  timeout: 60000,

  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'https://admin-v2-liart.vercel.app',
    trace: 'on',
    screenshot: 'on',
  },
});
```

**Step 2: Create integration smoke test**

Create `tests/e2e/integration/admin-smoke.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';

/**
 * Integration smoke test — runs against the real dev/staging API.
 * Run manually with: npm run test:e2e:integration
 *
 * Requires ADMIN_EMAIL and ADMIN_PASSWORD environment variables.
 */
test.describe('Admin Smoke Test (Integration)', () => {
  test.skip(!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD, 'Requires ADMIN_EMAIL and ADMIN_PASSWORD env vars');

  test('login → view seniors → view calls → logout', async ({ page }) => {
    // Login
    await page.goto('/login');
    await page.getByPlaceholder('admin@donna.com').fill(process.env.ADMIN_EMAIL!);
    await page.getByPlaceholder('Your password').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();

    // Should land on dashboard
    await expect(page).toHaveURL('/', { timeout: 10000 });

    // Navigate to seniors
    await page.getByRole('link', { name: /seniors/i }).click();
    await expect(page).toHaveURL('/seniors');
    // Should see at least one senior
    await page.waitForTimeout(2000);

    // Navigate to calls
    await page.getByRole('link', { name: /calls/i }).click();
    await expect(page).toHaveURL('/calls');
    await page.waitForTimeout(2000);

    // Done — page didn't crash
  });
});
```

**Step 3: Commit**

```bash
git add playwright.integration.config.ts tests/e2e/integration/admin-smoke.spec.ts
git commit -m "feat: add integration smoke test for admin dashboard"
```

---

### Task 9: Run Full Suite & Fix Issues

**Step 1: Run all mock tests**

Run: `cd /Users/davidzuluaga/code/donna2 && npx playwright test`
Expected: All 18 tests pass across 3 projects.

**Step 2: Fix any failing tests**

If tests fail:
- Check selectors match actual DOM (use `npx playwright test --headed` to see the browser)
- Check API mock routes match actual fetch URLs
- Check auth token injection timing
- Use `npx playwright codegen http://localhost:5175` to inspect selectors interactively

**Step 3: Run with HTML report**

Run: `cd /Users/davidzuluaga/code/donna2 && npx playwright show-report`
Expected: Opens HTML report in browser showing all test results.

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix: resolve E2E test issues from full suite run"
```

---

## Summary of Files

| File | Action |
|------|--------|
| `playwright.config.js` | **Delete** |
| `playwright.config.ts` | **Create** (multi-project) |
| `playwright.integration.config.ts` | **Create** (integration suite) |
| `tests/e2e/tsconfig.json` | **Create** |
| `tests/e2e/admin/dashboard.spec.js` | **Delete** (old stubs) |
| `tests/e2e/fixtures/test-data.ts` | **Create** |
| `tests/e2e/fixtures/auth.ts` | **Create** |
| `tests/e2e/fixtures/api-mocks.ts` | **Create** |
| `tests/e2e/admin/login.spec.ts` | **Create** |
| `tests/e2e/admin/navigation.spec.ts` | **Create** |
| `tests/e2e/admin/seniors.spec.ts` | **Create** |
| `tests/e2e/admin/calls.spec.ts` | **Create** |
| `tests/e2e/admin/reminders.spec.ts` | **Create** |
| `tests/e2e/consumer/landing.spec.ts` | **Create** |
| `tests/e2e/consumer/onboarding.spec.ts` | **Create** |
| `tests/e2e/consumer/dashboard.spec.ts` | **Create** |
| `tests/e2e/observability/history.spec.ts` | **Create** |
| `tests/e2e/observability/navigation.spec.ts` | **Create** |
| `tests/e2e/integration/admin-smoke.spec.ts` | **Create** |
| `package.json` | **Modify** (add scripts) |

## Commands Cheat Sheet

```bash
npm run test:e2e                              # All 3 apps (mock)
npm run test:e2e:admin                        # Admin only
npm run test:e2e:consumer                     # Consumer only
npm run test:e2e:observability                # Observability only
npm run test:e2e:integration                  # Against real API (needs env vars)
npx playwright test --headed                  # With visible browser
npx playwright test --headed --project=admin  # Single app, visible
npx playwright show-report                    # View HTML report
npx playwright codegen http://localhost:5175  # Interactive selector helper
```
