import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';
import {
  IN_USE_NAME,
  installDeletedRoutes,
  seedRecentlyDeleted,
} from '../fixtures/assets-recently-deleted';

// PR C: anything with a long-press menu on touch opens the same ActionMenu on
// right-click on a laptop (useMenuGesture): a message bubble and a Members row.
// List cards carry no menu (7 Nov 2026): a right-click on a chat card, a
// Pipeline card or an Assets card enters that list's select mode with the card
// ticked (ui/ListCard `select`); an Activity card has neither (no menu, no
// select). Laptop only (@desktop, desktop-webkit 1280x800); the iPhone project
// skips (long-press is covered by the chat and assets specs).

test.beforeEach(({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'laptop only');
});

/** The open ActionMenu (role menu) with at least one row. */
const openMenu = (page: Page): Locator =>
  page
    .getByRole('menu')
    .filter({ has: page.getByRole('menuitem') })
    .first();

async function rightClickOpensMenu(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible({ timeout: 15_000 });
  await target.scrollIntoViewIfNeeded();
  await target.click({ button: 'right' });
  await expect(openMenu(page)).toBeVisible();
  await expect(page.getByRole('menuitem').first()).toBeVisible();
}

/** A right-click on a list card: select mode with that card ticked, no menu. */
async function rightClickSelects(page: Page, card: Locator, bar: Locator): Promise<void> {
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: 'right' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1 selected');
  await expect(card.locator('[data-list-card-tick]')).toHaveAttribute('data-list-card-tick', 'on');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

test('right-click a chat card selects it (Hide chat on the bar) @desktop', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  const card = page
    .locator('[data-chat-list] [data-list-card]')
    .filter({ hasText: PEER_NAME })
    .first();
  const bar = page.locator('[data-chat-select-bar]');
  await rightClickSelects(page, card, bar);
  await expect(bar.locator('[data-selection-hide]')).toHaveAccessibleName('Hide chat');
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

test('right-click a Pipeline card selects it @desktop', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  const card = page
    .locator('[data-list-card]')
    .filter({ has: page.getByRole('button', { name: 'Open post Monday carousel' }) })
    .first();
  await rightClickSelects(page, card, page.locator('[data-select-bar]'));
  await expect(page.locator('[data-select-bar-action="open"]')).toBeVisible();
});

test('right-click a file card on Assets selects it @desktop', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedRecentlyDeleted(network);
  await installDeletedRoutes(page, network);
  await page.goto('/assets');
  const card = page
    .locator('[data-asset-card]')
    .filter({ has: page.getByRole('button', { name: `View ${IN_USE_NAME}`, exact: true }) });
  await rightClickSelects(page, card, page.locator('[data-select-bar]'));
  await expect(page.locator('[data-select-bar-action="delete"]')).toBeVisible();
});

test('right-click a Members row opens its ActionMenu @desktop', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/settings?panel=members');
  const row = page.locator('[data-member-row]').filter({ hasText: PEER_NAME }).first();
  await rightClickOpensMenu(page, row.getByText(PEER_NAME, { exact: true }).first());
});
