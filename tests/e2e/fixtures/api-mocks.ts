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
  mockContextTraceData,
} from './test-data';

/**
 * Set up all API mocks for the admin dashboard.
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
 * Set up all API mocks for the website/caregiver web app.
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

  await page.route('**/api/observability/calls/*/context', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockContextTraceData) })
  );

  await page.route('**/api/observability/calls?*', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ calls: mockObservabilityCalls }) })
  );

  await page.route('**/api/observability/calls', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ calls: mockObservabilityCalls }) })
  );
}
