import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { POST_IDS } from '../fixtures/chat-data';
import { installDeletedRoutes, seedRecentlyDeleted } from '../fixtures/assets-recently-deleted';

// PR C: every popover, dropdown, ActionMenu, Sheet and dialog closes on Escape
// and hands focus back to the trigger that opened it. Laptop only (@desktop,
// desktop-webkit 1280x800): each trigger is focused and clicked, the overlay
// opens, Escape closes it, and the trigger holds focus again. The iPhone
// project skips (phone overlays are sheets, covered by their own specs).

const POST = POST_IDS[0] ?? '';

test.beforeEach(({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'laptop only');
});

/** Focus and click the trigger, see the overlay, press Escape: overlay gone, trigger focused. */
async function escReturnsFocus(page: Page, trigger: Locator, overlay: Locator): Promise<void> {
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.focus();
  await trigger.click();
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await expect(trigger).toBeFocused();
}

/** The open ActionMenu / menu popover with at least one row. */
const openMenu = (page: Page): Locator =>
  page.getByRole('menu').filter({ has: page.getByRole('menuitem') });

test('Escape: the post ⋯ ActionMenu popover closes and focus returns to More actions @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  const trigger = page.getByRole('button', { name: 'More actions', exact: true }).first();
  await escReturnsFocus(page, trigger, openMenu(page));
});

test('Escape: the New post sheet closes and focus returns to New post @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  const trigger = page.getByRole('button', { name: 'New post', exact: true }).first();
  await escReturnsFocus(page, trigger, page.getByRole('dialog').first());
});

test('Escape: the Due date DatePicker closes alone and focus returns to its field @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  await page.getByRole('button', { name: 'New post', exact: true }).first().click();
  const sheet = page.getByRole('dialog').first();
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  const trigger = sheet.getByRole('button', { name: 'Due date', exact: true }).first();
  await trigger.scrollIntoViewIfNeeded();
  await escReturnsFocus(page, trigger, page.getByRole('dialog', { name: 'Choose a date' }));
  // Escape closed only the top layer: the sheet under it stays open.
  await expect(sheet).toBeVisible();
});

test('Escape: the New chat sheet closes and focus returns to New chat @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  const trigger = page.getByRole('button', { name: 'New chat', exact: true }).first();
  await escReturnsFocus(page, trigger, page.getByRole('dialog').first());
});

test('Escape: the Empty now ConfirmDialog closes and focus returns to Empty now @desktop', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedRecentlyDeleted(network);
  await installDeletedRoutes(page, network);
  await page.goto('/deleted');
  const trigger = page.getByRole('button', { name: 'Empty now', exact: true });
  await escReturnsFocus(page, trigger, page.getByRole('alertdialog'));
});

test('Escape: the Activity SortMenu popover closes and focus returns to Sort activity @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto('/notifications');
  const trigger = page.getByRole('button', { name: 'Sort activity', exact: true });
  await escReturnsFocus(page, trigger, page.getByRole('menu', { name: 'Sort activity' }));
});

test('Escape: the Pipeline Filter and sort dropdown closes and focus returns to its button @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  const trigger = page.getByRole('button', { name: 'Filter and sort', exact: true });
  await escReturnsFocus(page, trigger, page.getByRole('menu', { name: 'Sort' }));
});

test('Escape: the topbar account menu closes and focus returns to Account menu @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  const trigger = page.getByRole('button', { name: 'Account menu', exact: true });
  await escReturnsFocus(page, trigger, openMenu(page));
});

test('Escape: the workspace switcher closes and focus returns to the sidebar workspace row @desktop', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  // The sidebar's workspace row (its name is the workspace name, so find it by its slot).
  const trigger = page.locator('aside [data-induction="topbar-workspace-slot"]');
  await escReturnsFocus(page, trigger, page.getByRole('dialog').first());
});
