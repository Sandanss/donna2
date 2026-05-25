import { type Page } from '@playwright/test';

const MOCK_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InRlc3QtYWRtaW4iLCJlbWFpbCI6ImFkbWluQGRvbm5hLmNvbSIsImlhdCI6OTk5OTk5OTk5OX0.test-signature';

/**
 * Admin app: inject JWT into localStorage and mock /api/admin/me
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.route('**/api/admin/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'test-admin', email: 'admin@donna.com' }),
    })
  );

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
    localStorage.setItem('donna_obs_environment', 'dev');
    localStorage.setItem('donna_obs_token_dev', token);
  }, MOCK_JWT);
}

/**
 * Caregiver web app legacy helper: route Clerk session endpoints for tests
 * that do not use @clerk/testing.
 */
export async function loginAsCaregiver(page: Page): Promise<void> {
  await page.route('**clerk**', route => {
    const url = route.request().url();

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

    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

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
