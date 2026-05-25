import { test, expect } from '@playwright/test';

test.describe('Caregiver Web Protected Routes', () => {
  test('unauthenticated user is redirected from dashboard', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'networkidle' });

    await expect(page).not.toHaveURL(/\/dashboard$/, { timeout: 15000 });
  });

  test('signup route loads the onboarding entrypoint', async ({ page }) => {
    await page.goto('/signup', { waitUntil: 'networkidle' });

    await expect(page).toHaveURL(/\/signup/, { timeout: 15000 });
  });
});
