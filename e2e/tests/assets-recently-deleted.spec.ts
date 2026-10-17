import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { WORKSPACE_ID } from '../fixtures/chat-data';
import {
  DELETED_LONG_AGO_DAYS,
  DELETED_LONG_ID,
  DELETED_LONG_NAME,
  DELETED_RECENT_AGO_DAYS,
  DELETED_RECENT_ID,
  DELETED_RECENT_NAME,
  FREE_ID,
  FREE_NAME,
  IN_USE_ID,
  IN_USE_NAME,
  inUsePostId,
  installDeletedRoutes,
  makeMeMember,
  seedRecentlyDeleted,
  type DeletedRoutes,
} from '../fixtures/assets-recently-deleted';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Recently deleted: a delete refused with asset_in_use explains where the file
// is used; a delete moves the file to Recently deleted (31 days); the Assets
// row opens the list; the owner restores, deletes one now or empties it all
// through the asset-upload Worker's /purge; a member can only restore.
// Every test is tagged @theme so it runs in light and dark.

const DELETE_CONFIRM =
  'It moves to Recently deleted and is gone for good after 31 days. It keeps using storage until then, unless the owner empties it earlier.';
const HINT =
  'Files stay here 31 days, then are deleted for good. They still count toward storage until then.';
const DELETE_NOW_CONFIRM = "Gone for good. Nothing is saved, and this can't be undone.";
const EMPTY_CONFIRM = "2 files deleted for good. Nothing is saved, and this can't be undone.";

const RECENT_LINE = `2 MB · gone in ${31 - DELETED_RECENT_AGO_DAYS} days`;
const LONG_LINE = `3 MB · gone in ${31 - DELETED_LONG_AGO_DAYS} days`;

interface Setup {
  network: HarnessNetwork;
  calls: DeletedRoutes;
  errors: string[];
}

async function setup(page: Page, opts: { member?: boolean } = {}): Promise<Setup> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const network = await installHarnessNetwork(page);
  seedRecentlyDeleted(network);
  if (opts.member === true) makeMeMember(network);
  const calls = await installDeletedRoutes(page, network);
  return { network, calls, errors };
}

// Known noise outside this feature: the chat store logs its first load as failed
// when the shell cancels those reads on mount. `allow` lists a test's own
// expected errors (the refused delete's 400).
const NOISE = [/chat store: initial load failed.*read cancelled/];

function finish({ network, errors }: Setup, allow: RegExp[] = []): void {
  expect(network.blocked).toEqual([]);
  expect(errors.filter((e) => ![...NOISE, ...allow].some((re) => re.test(e)))).toEqual([]);
}

const toast = (page: Page, text: string): Locator =>
  page.locator('[aria-live="polite"]').getByRole('button', { name: text, exact: true });

/** The computed transform has no X move, scale or rotation (translateY only). */
async function expectTranslateYOnly(el: Locator): Promise<void> {
  await expect
    .poll(async () => el.evaluate((node) => getComputedStyle(node).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, -?[\d.]+\))$/);
}

/** Open a library image in the viewer, then its Info and the Delete confirm. */
async function openDeleteConfirm(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: `View ${name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Info', exact: true }).click();
  const details = page.getByLabel(`Details for ${name}`);
  await details.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(details.getByText(`Delete ${name}?`, { exact: true })).toBeVisible();
  await expect(details.getByText(DELETE_CONFIRM, { exact: true })).toBeVisible();
  return details;
}

const deletedRow = (page: Page, name: string): Locator =>
  page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });

test('a delete refused with asset_in_use opens Used in a post with Open post @theme', async ({
  page,
}) => {
  const s = await setup(page);
  await page.goto('/assets');
  const details = await openDeleteConfirm(page, IN_USE_NAME);
  await details.getByRole('button', { name: 'Delete', exact: true }).click();

  const sheet = page.getByRole('dialog', { name: 'Used in a post' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Used in a post', { exact: true })).toBeVisible();
  await expect(
    sheet.getByText(`${IN_USE_NAME} is part of a post. Delete the post first, then the file.`, {
      exact: true,
    }),
  ).toBeVisible();
  const ok = sheet.getByRole('button', { name: 'OK', exact: true });
  const openPost = sheet.getByRole('button', { name: 'Open post', exact: true });
  await expect(ok).toBeVisible();
  await expect(openPost).toBeVisible();
  expectMinTouchTarget(await ok.boundingBox());
  expectMinTouchTarget(await openPost.boundingBox());
  await expectTranslateYOnly(sheet);
  // The viewer closed; the file is back in the grid (rolled back).
  await expect(page.getByLabel(`Viewing ${IN_USE_NAME}`)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: `View ${IN_USE_NAME}`, exact: true }),
  ).toBeVisible();
  expect(s.calls.rpc).toEqual([
    { name: 'asset_delete', args: { p_asset_id: IN_USE_ID, p_trace_id: expect.any(String) } },
  ]);

  // OK closes; a second refusal's Open post opens the parent post.
  await ok.click();
  await expect(sheet).toBeHidden();
  const again = await openDeleteConfirm(page, IN_USE_NAME);
  await again.getByRole('button', { name: 'Delete', exact: true }).click();
  await sheet.getByRole('button', { name: 'Open post', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/posts/${inUsePostId(s.network)}$`));
  finish(s, [/status of 400/]);
});

test('Delete confirms, moves the file to Recently deleted and the row opens it @theme', async ({
  page,
}) => {
  const s = await setup(page);
  await page.goto('/assets');
  const row = page.getByRole('button', { name: /^Recently deleted/ });
  await expect(row).toContainText('2 files · Kept 31 days');

  const details = await openDeleteConfirm(page, FREE_NAME);
  // Soft: the viewer's confirm buttons pass className h-11 next to Button's
  // default h-9 (cn does not merge), so they render 36px. Product bug, reported.
  for (const label of ['Cancel', 'Delete']) {
    const box = await details.getByRole('button', { name: label, exact: true }).boundingBox();
    expect(box?.height ?? 0, `${label} touch target height`).toBeGreaterThanOrEqual(43.99);
  }
  await details.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(toast(page, 'Moved to Recently deleted')).toBeVisible();
  await expect(page.getByLabel(`Viewing ${FREE_NAME}`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: `View ${FREE_NAME}`, exact: true })).toHaveCount(0);
  expect(s.calls.rpc).toEqual([
    { name: 'asset_delete', args: { p_asset_id: FREE_ID, p_trace_id: expect.any(String) } },
  ]);

  // The row recounts after the delete, then opens the list.
  await expect(row).toContainText('3 files · Kept 31 days');
  expectMinTouchTarget(await row.boundingBox());
  await row.click();
  await expect(page).toHaveURL(/\/assets\/recently-deleted$/);
  await expect(deletedRow(page, FREE_NAME)).toBeVisible();
  finish(s);
});

test('owner: full names, days left, Restore, Delete now and their confirms @theme', async ({
  page,
}) => {
  const s = await setup(page);
  await page.goto('/assets/recently-deleted');
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();

  const recent = deletedRow(page, DELETED_RECENT_NAME);
  const long = deletedRow(page, DELETED_LONG_NAME);
  await expect(recent.getByText(RECENT_LINE, { exact: true })).toBeVisible();
  await expect(long.getByText(LONG_LINE, { exact: true })).toBeVisible();
  // Most recently deleted first.
  await expect(page.getByRole('listitem').filter({ hasText: 'gone in' })).toHaveText([
    new RegExp(DELETED_RECENT_NAME),
    new RegExp(DELETED_LONG_NAME),
  ]);

  // The long name is shown in full: wrapped, not clipped or ellipsized.
  const name = long.getByText(DELETED_LONG_NAME, { exact: true });
  const metrics = await name.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      height: el.getBoundingClientRect().height,
      lineHeight: parseFloat(style.lineHeight),
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      text: el.textContent,
    };
  });
  expect(metrics.text).toBe(DELETED_LONG_NAME);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.textOverflow).not.toBe('ellipsis');
  expect(metrics.whiteSpace).not.toBe('nowrap');
  expect(metrics.height).toBeGreaterThan(metrics.lineHeight * 1.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  for (const row of [recent, long]) {
    for (const label of ['Restore', 'Delete now']) {
      const button = row.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible();
      expectMinTouchTarget(await button.boundingBox());
    }
  }
  const empty = page.getByRole('button', { name: 'Empty now', exact: true });
  await expect(empty).toBeVisible();
  expectMinTouchTarget(await empty.boundingBox());
  await expect(page.getByText('Frees 5 MB right away.', { exact: true })).toBeVisible();
  await expect(page.getByText('Only the workspace owner can delete files early.')).toHaveCount(0);

  // Delete now's confirm copy (Cancel closes it, nothing sent).
  await long.getByRole('button', { name: 'Delete now', exact: true }).click();
  let dialog = page.getByRole('alertdialog', { name: `Delete ${DELETED_LONG_NAME} now?` });
  await expect(dialog.getByText(DELETE_NOW_CONFIRM, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete now', exact: true })).toBeVisible();
  await expectTranslateYOnly(dialog);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Empty now's confirm copy.
  await empty.click();
  dialog = page.getByRole('alertdialog', { name: 'Empty Recently deleted?' });
  await expect(dialog.getByText(EMPTY_CONFIRM, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Empty now', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(s.calls.purges).toEqual([]);

  // Restore: asset_restore, toast, row gone, the hint recounts.
  await recent.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(toast(page, 'Restored')).toBeVisible();
  await expect(recent).toHaveCount(0);
  await expect(page.getByText('Frees 3 MB right away.', { exact: true })).toBeVisible();
  expect(s.calls.rpc).toEqual([
    {
      name: 'asset_restore',
      args: { p_asset_id: DELETED_RECENT_ID, p_trace_id: expect.any(String) },
    },
  ]);

  // Delete now: POST /purge with the one id, toast, list re-read empty.
  await long.getByRole('button', { name: 'Delete now', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: `Delete ${DELETED_LONG_NAME} now?` })
    .getByRole('button', { name: 'Delete now', exact: true })
    .click();
  await expect(toast(page, 'Deleted for good')).toBeVisible();
  await expect(long).toHaveCount(0);
  expect(s.calls.purges).toEqual([{ workspace_id: WORKSPACE_ID, asset_ids: [DELETED_LONG_ID] }]);
  finish(s);
});

test('owner: Empty now purges everything and frees the space @theme', async ({ page }) => {
  const s = await setup(page);
  await page.goto('/assets/recently-deleted');
  await expect(deletedRow(page, DELETED_LONG_NAME)).toBeVisible();
  await page.getByRole('button', { name: 'Empty now', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Empty Recently deleted?' })
    .getByRole('button', { name: 'Empty now', exact: true })
    .click();
  await expect(toast(page, 'Emptied. Space freed.')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'gone in' })).toHaveCount(0);
  expect(s.calls.purges).toEqual([{ workspace_id: WORKSPACE_ID }]);
  finish(s);
});

test('member: only Restore, with the owner-only note @theme', async ({ page }) => {
  const s = await setup(page, { member: true });
  await page.goto('/assets/recently-deleted');
  const rows = page.getByRole('listitem').filter({ hasText: 'gone in' });
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.getByRole('button')).toHaveText(['Restore']);
    expectMinTouchTarget(await row.getByRole('button', { name: 'Restore' }).boundingBox());
  }
  await expect(
    page.getByText('Only the workspace owner can delete files early.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete now' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Empty now' })).toHaveCount(0);
  await expect(page.getByText(/^Frees /)).toHaveCount(0);
  finish(s);
});
