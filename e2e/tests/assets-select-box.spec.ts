import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { WORKSPACE_ID } from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Assets multi-select starts from a card's ⋮ menu (ui/ListCard): its Select row
// selects that file. While selecting, the 20 tick box takes the ⋮'s place, the
// header shows Cancel, the count and Select all; on a phone Delete sits in a bar
// at the bottom (there is no Move: Assets has no folders). The "New file" menu
// offers no Select. Tagged @theme for light and dark.

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

const menus = (page: Page) => page.locator('[data-card-menu]');
const ticks = (page: Page) => page.locator('[data-card-tick]');

test('a card ⋮ Select row selects it; Cancel, Select all and Delete @theme', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedAssets(network);
  await page.goto('/assets');
  await expect(menus(page)).toHaveCount(3, { timeout: 15_000 });

  // The "New file" menu offers upload and link, and no Select.
  await page.getByRole('button', { name: 'New file' }).click();
  await expect(page.getByRole('menuitem', { name: 'Upload files' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Add link' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Select' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Every ⋮ is a 44px target; nothing sits in the picture's corner.
  for (const menu of await menus(page).all()) expectMinTouchTarget(await menu.boundingBox());
  await expect(page.locator('[data-card-select]')).toHaveCount(0);

  // The ⋮ Select row: selecting, with that file ticked.
  const firstCard = page.locator('[data-asset-card]').first();
  const heightBefore = (await firstCard.boundingBox())?.height;
  await page.getByRole('button', { name: 'More actions for Logo.png', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Select' }).click();
  const bar = page.locator('[data-select-bar]');
  await expect(bar).toContainText('1 selected');
  await expect(page.getByRole('button', { name: 'Select Logo.png' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The tick takes the ⋮'s place on every card; the card keeps its height.
  await expect(menus(page)).toHaveCount(0);
  await expect(ticks(page)).toHaveCount(3);
  await expect(page.locator('[data-card-tick="on"]')).toHaveCount(1);
  expect((await firstCard.boundingBox())?.height).toBe(heightBefore);

  const actions = page.locator('[data-select-actions]');
  await expect(actions).toBeVisible();
  const del = actions.getByRole('button', { name: 'Delete 1' });
  await expect(del).toBeEnabled();
  expectMinTouchTarget(await del.boundingBox());
  await expect(page.getByRole('button', { name: 'Move' })).toHaveCount(0);

  // Tapping another card adds it; Select all takes the rest.
  await page.getByRole('button', { name: 'Select Lookbook.pdf' }).click();
  await expect(bar).toContainText('2 selected');
  await bar.getByRole('button', { name: 'Select all' }).click();
  await expect(bar).toContainText('3 selected');
  await expect(actions.getByRole('button', { name: 'Delete 3' })).toBeVisible();

  // Cancel leaves selecting: the ⋮ and tabs come back, the bar goes.
  const cancel = bar.getByRole('button', { name: 'Cancel' });
  expectMinTouchTarget(await cancel.boundingBox());
  await cancel.click();
  await expect(actions).toHaveCount(0);
  await expect(menus(page)).toHaveCount(3);
  await expect(ticks(page)).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'File types' })).toBeVisible();
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
