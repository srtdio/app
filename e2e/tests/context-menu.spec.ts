import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';
import {
  IN_USE_NAME,
  installDeletedRoutes,
  seedRecentlyDeleted,
} from '../fixtures/assets-recently-deleted';

// PR C: anything with a long-press menu on touch opens the same ActionMenu on
// right-click on a laptop (useMenuGesture). Laptop only (@desktop,
// desktop-webkit 1280x800): a right-click on a chat row, a message bubble, a
// Pipeline card and a file tile on Assets opens a menu with its rows. The
// iPhone project skips (long-press is covered by the chat and assets specs).

test.beforeEach(({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'laptop only');
});

/** The open ActionMenu (role menu) with at least one row. */
const openMenu = (page: Page): Locator =>
  page.getByRole('menu').filter({ has: page.getByRole('menuitem') });

async function rightClickOpensMenu(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 });
  await target.scrollIntoViewIfNeeded();
  await target.click({ button: 'right' });
  await expect(openMenu(page)).toBeVisible();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
}

test('right-click a chat row opens its ActionMenu @desktop', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  const row = page.getByRole('button', { name: new RegExp(`^Open ${PEER_NAME}`) }).first();
  await rightClickOpensMenu(page, row);
});

test('right-click a message bubble opens the message menu @desktop', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const bubble = page.locator('[data-bubble]', { hasText: 'Done, it reads well now.' }).last();
  await rightClickOpensMenu(page, bubble);
});

test('right-click a Pipeline card opens its ActionMenu @desktop', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  const card = page.getByRole('button', { name: 'Open post Monday carousel' }).first();
  await rightClickOpensMenu(page, card);
});

test('right-click a file tile on Assets opens its ActionMenu @desktop', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedRecentlyDeleted(network);
  await installDeletedRoutes(page, network);
  await page.goto('/assets');
  const tile = page.getByRole('button', { name: `View ${IN_USE_NAME}`, exact: true });
  await rightClickOpensMenu(page, tile);
});
