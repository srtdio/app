import { expect, test } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { COLLEAGUE_A, GROUP_CHANNEL } from '../fixtures/chat-data';

// Usernames in mentions (14 Oct 2026): the @ picker matches a username and
// shows it under the name, and a pick writes "@username" into the composer.
// Tagged @theme so the picker is seen in light and dark.

test('@ picker finds a member by username and inserts @username @theme', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  const leo = network.world.tables.users?.find((u) => u.id === COLLEAGUE_A);
  if (leo !== undefined) leo.username = 'leo.m';
  await page.goto(`/chat?channel=${encodeURIComponent(GROUP_CHANNEL)}`);
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 15_000 });

  const box = page.locator('form textarea').first();
  await box.click();
  await box.pressSequentially('Look @leo.');
  const option = page.locator(`[data-mention-option="${COLLEAGUE_A}"]`);
  await expect(option).toBeVisible();
  await expect(option).toContainText('@leo.m');
  await option.click();
  await expect(box).toHaveValue('Look @leo.m ');
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
