import { devices, expect, test } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { MENTION_PREVIEW, PEER_NAME } from '../fixtures/chat-data';

// PR C: one breakpoint. iPad portrait (820x1180, touch, iPad UA) is the laptop
// layout on every surface, Chat included: width alone decides (useIsLaptop,
// >= 768), never the pointer. Untagged, so it runs once in the iPhone project
// (dark) with this file's own iPad viewport; the light and desktop projects
// only run tagged tests.

test.use({
  viewport: { width: 820, height: 1180 },
  userAgent: devices['iPad (gen 7)'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

test('iPad portrait: Pipeline renders the laptop shell and laptop popovers', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  await expect(page.getByRole('button', { name: 'Open post Monday carousel' }).first()).toBeVisible(
    { timeout: 15_000 },
  );
  // Sidebar nav on the left, no bottom tab bar.
  const sidebar = page.locator('aside');
  await expect(sidebar.getByRole('link', { name: /^Pipeline/ })).toBeVisible();
  // BottomTabs is the nav carrying the bottom anchor (src/lib/bottom-inset.ts).
  await expect(page.locator('nav[data-undo-anchor]')).toBeHidden();
  // Activity stays in the laptop top bar; the phone pill's Activity tab is hidden.
  await expect(page.locator('header [data-notifications-button]')).toBeVisible();
  await expect(page.locator('[data-activity-tab]')).toBeHidden();
  // useIsLaptop: Filter and sort opens the laptop popover, not the phone sheet.
  await page.getByRole('button', { name: 'Filter and sort', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Sort' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Filter and sort' })).toHaveCount(0);
});

test('iPad portrait: Chat renders the laptop split and laptop type', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  // List and thread pane side by side: the empty pane shows beside the list.
  await expect(page.getByText('Select a conversation', { exact: true })).toBeVisible();
  await expect(page.locator('aside').getByRole('link', { name: /^Chat/ })).toBeVisible();
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);
  // The same message chat-thread.spec.ts measures at the touch 17px.
  const body = page
    .locator('[data-bubble]', { hasText: MENTION_PREVIEW })
    .getByText(MENTION_PREVIEW)
    .first();
  await body.scrollIntoViewIfNeeded();
  await expect(body).toBeVisible();
  // The list stays beside the open thread.
  await expect(page.getByRole('searchbox', { name: 'Search chats' })).toBeVisible();
  // Laptop chat type (chat-type.ts BUBBLE_BODY_TYPE): 14px, not the touch 17px.
  expect(await body.evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px');
});
