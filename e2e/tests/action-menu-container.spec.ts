import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { POST_IDS } from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// PR B: one ⋯ menu (ui/ActionMenu). Its default trigger is "More actions" at
// the top right of the header. On a phone it opens a sheet titled with the
// menu's title; at 1280 wide (useIsLaptop, >= 768) it opens a popover anchored
// to the trigger with the same rows in the same order: Open first, Copy link
// second, Delete last. The untagged test runs on the iPhone projects; the
// @desktop one runs on desktop-webkit (1280x800) and skips below md.

const POST = POST_IDS[0] ?? '';

async function openPostMenu(page: Page): Promise<void> {
  await installHarnessNetwork(page);
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  const trigger = page.getByRole('button', { name: 'More actions', exact: true }).first();
  expectMinTouchTarget(await trigger.boundingBox());
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await trigger.click();
}

async function rowLabels(page: Page): Promise<string[]> {
  const texts = await page.getByRole('menuitem').allInnerTexts();
  return texts.map((text) => text.split('\n')[0]?.trim() ?? '');
}

test('phone: the post ⋯ opens a sheet titled Post actions, Copy link first, Delete last @theme', async ({
  page,
}) => {
  await openPostMenu(page);
  const sheet = page.getByRole('dialog', { name: 'Post actions', exact: true });
  await expect(sheet).toBeVisible();
  // Title left, close X right; no Cancel text in the header.
  await expect(sheet.getByRole('heading', { name: 'Post actions' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  const labels = await rowLabels(page);
  // The full page has nothing to open, so Copy link leads.
  expect(labels[0]).toBe('Copy link');
  expect(labels[labels.length - 1]).toBe('Delete post');
  for (const row of await sheet.getByRole('menuitem').all()) {
    expectMinTouchTarget(await row.boundingBox());
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
});

test('laptop: the post ⋯ opens a popover anchored to its trigger, not a sheet @desktop', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'laptop only');
  await openPostMenu(page);
  const menu = page.getByRole('menu').filter({ has: page.getByRole('menuitem') });
  await expect(menu).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Post actions', exact: true })).toHaveCount(0);
  const labels = await rowLabels(page);
  // The full page has nothing to open, so Copy link leads.
  expect(labels[0]).toBe('Copy link');
  expect(labels[labels.length - 1]).toBe('Delete post');
  // Anchored to the trigger: the popover's right edge lines up with the
  // trigger's and it starts at the trigger's row (no centred sheet).
  const trigger = await page
    .getByRole('button', { name: 'More actions', exact: true })
    .first()
    .boundingBox();
  const box = await menu.boundingBox();
  if (trigger === null || box === null) throw new Error('menu or trigger has no box');
  expect(Math.abs(box.x + box.width - (trigger.x + trigger.width))).toBeLessThan(4);
  expect(box.y).toBeGreaterThanOrEqual(trigger.y - 1);
  expect(box.y).toBeLessThan(trigger.y + trigger.height + 24);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
