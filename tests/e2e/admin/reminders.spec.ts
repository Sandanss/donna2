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

    await expect(page.getByText('Water porch plants')).toBeVisible();
    await expect(page.getByText('Bridge club')).toBeVisible();
  });

  test('create a new reminder', async ({ page }) => {
    await page.goto('/reminders');

    await page.locator('select').first().selectOption({ label: 'Martha Johnson' });

    await page.getByPlaceholder('e.g. Water porch plants').fill('Evening walk reminder');

    await page.locator('input[type="time"]').fill('18:00');

    await page.getByLabel('daily').check();

    await page.getByRole('button', { name: /add reminder/i }).click();

    await page.waitForTimeout(500);
  });

  test('delete a reminder', async ({ page }) => {
    await page.goto('/reminders');

    const deleteBtn = page.locator('button').filter({ hasText: /delete/i }).first();
    if (await deleteBtn.isVisible()) {
      await deleteBtn.click();
      await page.waitForTimeout(500);
    }
  });
});
