import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { WORKSPACE_ID } from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { selectBar, selectBarAction, selectGesture } from '../helpers/select-mode';
import { undoStrip } from '../helpers/undo-strip';

// Assets multi-select (ui/ListCard `select`, ui/SelectBar): a long-press (or a
// right-click on laptop) on a card enters select mode with that file ticked.
// No card carries a ⋮. While selecting, the tick sits on the picture, a tap
// toggles, and the bottom bar shows Cancel, "N selected", Select all and the
// old ⋮ rows: the one-file rows only with exactly one ticked, Delete for any
// count (Undo). There is no Move (Assets has no folders). The "New file" menu
// offers no Select: the visible Select is pinned at the chip row's end and a
// tap starts (or ends) select mode. Tagged @theme for light and dark.

const AT = Date.parse('2026-10-01T09:00:00Z');
const NAMES = ['Logo.png', 'Lookbook.pdf', 'Reel.mp4'];
const MIMES = ['image/png', 'application/pdf', 'video/mp4'];
const KINDS = ['image', 'pdf', 'video'];

function seedAssets(network: HarnessNetwork): void {
  const t = network.world.tables;
  NAMES.forEach((name, n) => {
    const suffix = String(n + 1).padStart(12, '0');
    const id = `0190e800-0000-7000-8000-${suffix}`;
    const version = `0190e900-0000-7000-8000-${suffix}`;
    (t.assets ??= []).push({
      id,
      workspace_id: WORKSPACE_ID,
      filename: name,
      display_name: null,
      folder_path: '/',
      folder_id: null,
      tags: [],
      uploaded_at: new Date(AT - n * 60_000).toISOString(),
      current_version_id: version,
      current_version: {
        id: version,
        asset_id: id,
        kind: KINDS[n],
        mime_type: MIMES[n],
        size_bytes: 120_000,
        width: null,
        height: null,
        duration_ms: null,
        page_count: null,
        external_url: null,
        r2_key: `${WORKSPACE_ID}/${id}/v1`,
        version_number: 1,
      },
      deleted_at: null,
    });
  });
}

const cards = (page: Page) => page.locator('[data-asset-card]');
const card = (page: Page, name: string) => cards(page).filter({ hasText: name });
const ticks = (page: Page, state: 'on' | 'off' | 'hidden') =>
  page.locator(`[data-asset-card] [data-list-card-tick="${state}"]`);

test('a long-press selects a file; tap toggles; Cancel, Select all and Delete @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedAssets(network);
  await page.goto('/assets');
  await expect(cards(page)).toHaveCount(3, { timeout: 15_000 });

  // No card carries a ⋮; the ticks are hidden until select mode.
  await expect(page.locator('[data-asset-card] [aria-label^="More actions"]')).toHaveCount(0);
  await expect(ticks(page, 'hidden')).toHaveCount(3);

  // The "New file" menu offers upload and link, and no Select.
  await page.getByRole('button', { name: 'New file' }).click();
  await expect(page.getByRole('menuitem', { name: 'Upload files' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Add link' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Select' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The long-press: selecting, with that file ticked; the card keeps its height.
  const first = card(page, 'Logo.png');
  const heightBefore = (await first.boundingBox())?.height;
  await selectGesture(page, first);
  const bar = selectBar(page);
  await expect(bar.locator('[data-select-bar-count]')).toHaveText('1 selected');
  await expect(first).toHaveAttribute('data-list-card-selecting', '');
  await expect(first.locator('[data-list-card-tick]')).toHaveAttribute('data-list-card-tick', 'on');
  await expect(ticks(page, 'off')).toHaveCount(2);
  expect((await first.boundingBox())?.height).toBe(heightBefore);

  // One file ticked: its one-file rows (Copy link, Info) and Delete, each a 44 target.
  await expect(selectBarAction(page, 'copy-link')).toBeVisible();
  await expect(selectBarAction(page, 'info')).toBeVisible();
  const del = selectBarAction(page, 'delete');
  await expect(del).toBeEnabled();
  await expect(del).toHaveAccessibleName('Delete');
  expectMinTouchTarget(await del.boundingBox());
  await expect(bar.getByRole('button', { name: 'Move' })).toHaveCount(0);

  // A tap on another card adds it (it never opens the viewer); the one-file rows go.
  await card(page, 'Lookbook.pdf').click();
  await expect(bar.locator('[data-select-bar-count]')).toHaveText('2 selected');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(selectBarAction(page, 'copy-link')).toHaveCount(0);
  await expect(selectBarAction(page, 'info')).toHaveCount(0);
  await expect(selectBarAction(page, 'delete')).toBeVisible();

  // Select all takes the rest.
  await bar.getByRole('button', { name: 'Select all' }).click();
  await expect(bar.locator('[data-select-bar-count]')).toHaveText('3 selected');
  await expect(ticks(page, 'on')).toHaveCount(3);

  // Cancel leaves selecting: the bar goes, the ticks hide, the tabs stay.
  const cancel = bar.locator('[data-select-bar-cancel]');
  expectMinTouchTarget(await cancel.boundingBox());
  await cancel.click();
  await expect(bar).toHaveCount(0);
  await expect(ticks(page, 'hidden')).toHaveCount(3);
  await expect(page.getByRole('tablist', { name: 'File types' })).toBeVisible();

  // Delete from the bar: the file leaves the list at once, with Undo.
  await selectGesture(page, card(page, 'Reel.mp4'));
  await expect(bar.locator('[data-select-bar-count]')).toHaveText('1 selected');
  await selectBarAction(page, 'delete').click();
  await expect(bar).toHaveCount(0);
  await expect(card(page, 'Reel.mp4')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2);
  await expect(undoStrip(page)).toBeVisible();
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

test('the chip row Select, pinned at the row end, starts and ends select mode @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedAssets(network);
  await page.goto('/assets');
  await expect(cards(page)).toHaveCount(3, { timeout: 15_000 });

  // Decision E: the visible Select sits at the chip row's end, a 44 target.
  const select = page.locator('[data-chip-row] [data-chip-row-select] [data-section-select]');
  await expect(select).toHaveText('Select');
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  expectMinTouchTarget(await select.boundingBox());

  // A tap starts select mode with nothing ticked; every card shows its open tick.
  await select.click();
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(ticks(page, 'off')).toHaveCount(3);
  await card(page, 'Logo.png').click();
  await expect(selectBar(page).locator('[data-select-bar-count]')).toHaveText('1 selected');

  // A second tap ends it: the ticks hide again.
  await select.click();
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  await expect(ticks(page, 'hidden')).toHaveCount(3);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
