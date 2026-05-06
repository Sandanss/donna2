import { test, expect, type Page } from '@playwright/test';

const LEGACY_DRAFT = {
  email: 'legacy-caregiver-security@example.test',
  password: 'LegacyPasswordShouldNotPersist123!',
  firstName: 'LegacyCaregiver',
  lovedOneName: 'LegacyLovedOne',
  lovedOnePhone: '(312) 555-0199',
  reminders: ['Legacy morning medication reminder'],
};

const SENSITIVE_VALUES = [
  LEGACY_DRAFT.email,
  LEGACY_DRAFT.password,
  LEGACY_DRAFT.firstName,
  LEGACY_DRAFT.lovedOneName,
  LEGACY_DRAFT.lovedOnePhone,
  'security-caregiver@example.test',
  'NoStorePassword123!',
  'password123',
  'Margaret',
  'Blood pressure pills with breakfast',
  'Her grandchildren',
];

async function storageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const dumpStorage = (storage: Storage) => {
      const values: Record<string, string | null> = {};
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) values[key] = storage.getItem(key);
      }
      return values;
    };

    return JSON.stringify({
      localStorage: dumpStorage(window.localStorage),
      sessionStorage: dumpStorage(window.sessionStorage),
    });
  });
}

test.describe('Consumer Website Security', () => {
  test('signup clears legacy onboarding drafts and does not persist typed PHI or credentials', async ({ page }) => {
    await page.addInitScript((draft) => {
      window.localStorage.setItem('donna_onboarding', JSON.stringify(draft));
    }, LEGACY_DRAFT);

    await page.goto('/signup?dev=true', { waitUntil: 'networkidle' });

    await expect(page.getByRole('heading', { name: /create your account/i })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('donna_onboarding'))).toBeNull();

    await page.locator('input[type="email"]').first().fill('security-caregiver@example.test');
    await page.locator('input[type="password"]').first().fill('NoStorePassword123!');
    await page.getByRole('button', { name: /^fill mock data$/i }).click();

    const persisted = await storageText(page);
    for (const value of SENSITIVE_VALUES) {
      expect(persisted).not.toContain(value);
    }
    expect(await page.evaluate(() => window.localStorage.getItem('donna_onboarding'))).toBeNull();
  });

  test('waitlist submits to the same-origin website API path, not a hardcoded production host', async ({ page }) => {
    const waitlistUrls: string[] = [];

    await page.route('**/waitlist', async (route) => {
      waitlistUrls.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^download app$/i }).first().click();

    await page.getByLabel('Name *').fill('Security Test Caregiver');
    await page.getByLabel('Email *').fill('security-waitlist@example.test');
    await page.locator('#wl-phone').fill('(415) 555-0109');
    await page.locator('#wl-who').selectOption('Mother');
    await page.getByLabel(/thoughts or questions/i).fill('Please keep this private.');
    await page.getByRole('button', { name: /^join the waitlist$/i }).click();

    await expect(page.getByRole('heading', { name: /you're on the list/i })).toBeVisible();

    expect(waitlistUrls).toHaveLength(1);
    const waitlistUrl = new URL(waitlistUrls[0]);
    const pageUrl = new URL(page.url());
    expect(waitlistUrl.origin).toBe(pageUrl.origin);
    expect(waitlistUrl.pathname).toBe('/waitlist');
    expect(waitlistUrls[0]).not.toContain('donna-api-production');
    expect(waitlistUrls[0]).not.toContain('railway.app');
  });
});
