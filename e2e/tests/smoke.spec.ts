import { expect, test } from '@playwright/test';

test('harness renders with app tokens', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('harness ok')).toBeVisible();
});
