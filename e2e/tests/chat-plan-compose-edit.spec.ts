import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork, solidPng, type HarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// New plan screen: a concept opens in the same concept sheet ("Edit concept",
// "Save", no review line) prefilled, its day on the plan's day tiles, and Save
// replaces it in place with no RPC until Create (one plan_create_with_items);
// Cancel leaves it; the X still removes. The plan dates sheet's From / To
// boxes fit inside the screen at 320px and 390px. Runs in both colour
// schemes (the dark and light projects) on the iPhone viewport.

const page_ = (page: Page, id: string) => page.locator(`[data-plan-page="${id}"]`);

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

const planRpcs = (network: HarnessNetwork) =>
  network.rpcCalls.filter((c) => c.name.startsWith('plan_') || c.name === 'chat_plan_share');

async function openCompose(page: Page): Promise<ReturnType<typeof page_>> {
  await page.getByRole('button', { name: 'Add attachment' }).click();
  await page.locator('[data-tray-tile="plan"]').click();
  await page.getByRole('dialog', { name: 'Plans' }).locator('[data-plan-pick-new]').click();
  const compose = page_(page, 'compose');
  await expect(compose).toBeVisible();
  return compose;
}

test('tap a concept to edit it; Save replaces it in place; Create plan carries it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const compose = await openCompose(page);
  await compose.locator('[data-plan-title]').fill('Launch week');

  // Two concepts: one on the plan's first day (tile 0), one with No date.
  const tile = (sheet: Locator, at: number) => sheet.locator('[data-plan-day-tile]').nth(at);
  const add = async (title: string, at: number | null): Promise<void> => {
    await compose.locator('[data-plan-add-concept]').click();
    const sheet = page.getByRole('dialog', { name: 'Add concept' });
    await expect(sheet).toBeVisible();
    await sheet.locator('[data-plan-concept-title]').fill(title);
    await expect(sheet.locator('[data-plan-day-none]')).toHaveAttribute('aria-pressed', 'true');
    if (at !== null) await tile(sheet, at).click();
    await sheet.locator('[data-plan-concept-save]').click();
    await expect(sheet).toBeHidden();
  };
  await add('Opening reel', 0);
  // The first concept carries one uploaded file, which must stay attached.
  const rows = compose.locator('[data-plan-compose-item="concept"]');
  await expect(rows).toHaveCount(1);
  await rows.first().locator('[data-plan-draft-concept-edit]').click();
  const upSheet = page.getByRole('dialog', { name: 'Edit concept' });
  await expect(upSheet).toBeVisible();
  await upSheet.locator('[data-plan-concept-upload-input]').setInputFiles({
    name: 'storyboard.png',
    mimeType: 'image/png',
    buffer: solidPng(64, 48, [200, 120, 80]),
  });
  await expect(upSheet.locator('[data-plan-concept-file]')).toHaveCount(1);
  await upSheet.locator('[data-plan-concept-save]').click();
  await expect(upSheet).toBeHidden();
  await add('Story', null);
  await expect(rows).toHaveCount(2);
  const titles = () => rows.locator('[data-plan-item-title]').allInnerTexts();
  expect(await titles()).toEqual(['Opening reel', 'Story']);

  const edit = rows.first().locator('[data-plan-draft-concept-edit]');
  expectMinTouchTarget(await edit.boundingBox());
  expectMinTouchTarget(await rows.first().locator('[data-plan-compose-remove]').boundingBox());
  expectMinTouchTarget(await rows.first().locator('[data-plan-day-button]').boundingBox());

  // Cancel leaves it unchanged. With an edit typed, Cancel asks first (X3 /
  // FN25): Keep editing keeps the sheet and the typed title; Discard closes it
  // and the row is as it was.
  await edit.click();
  const sheet = page.getByRole('dialog', { name: 'Edit concept' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-title]')).toHaveValue('Opening reel');
  await expect(tile(sheet, 0)).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('[data-plan-concept-file]')).toHaveCount(1);
  await expect(sheet.locator('[data-plan-concept-save]')).toHaveText('Save');
  await expect(sheet.locator('[data-plan-concept-reset]')).toHaveCount(0);
  await sheet.locator('[data-plan-concept-title]').fill('Thrown away');
  await sheet.locator('[data-plan-concept-cancel]').click();
  const discard = page.getByRole('alertdialog', { name: 'Discard this concept?' });
  await expect(discard).toBeVisible();
  await expect(discard).toContainText('Your changes will be lost.');
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(discard).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-title]')).toHaveValue('Thrown away');
  await sheet.locator('[data-plan-concept-cancel]').click();
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(sheet).toBeHidden();
  expect(await titles()).toEqual(['Opening reel', 'Story']);
  // A clean Cancel closes at once.
  await edit.click();
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-plan-concept-cancel]').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  // Edit: title and day change (tile 2), same position, file kept.
  await edit.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-title]')).toHaveValue('Opening reel');
  await sheet.locator('[data-plan-concept-title]').fill('Opening reel v2');
  const day = await tile(sheet, 2).getAttribute('data-plan-day-tile');
  await tile(sheet, 2).click();
  await sheet.locator('[data-plan-concept-save]').click();
  await expect(sheet).toBeHidden();
  expect(await titles()).toEqual(['Opening reel v2', 'Story']);
  await expect(rows.first().locator('[data-plan-day-button]')).toHaveAttribute(
    'data-plan-day-button',
    'day',
  );
  await expect(rows.nth(1).locator('[data-plan-day-button]')).toContainText('No date');
  expect(planRpcs(network), 'no RPC on a local edit').toEqual([]);

  // The X still removes.
  await rows.nth(1).locator('[data-plan-compose-remove]').click();
  await expect(rows).toHaveCount(1);
  await expect(compose.locator('[data-plan-compose-summary]')).toHaveText('Ready');

  await compose.locator('[data-plan-create]').click();
  await expect(compose).toBeHidden();
  // Create plan: one call, a Draft plan, no card sent; its Plan screen opens.
  const creates = network.rpcCalls.filter((c) => c.name.startsWith('plan_create'));
  expect(creates.map((c) => c.name)).toEqual(['plan_create_with_items']);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_concept_add')).toEqual([]);
  expect(network.rpcCalls.filter((c) => c.name === 'chat_plan_share')).toEqual([]);
  await expect(page.locator('[data-plan-page="plan"]')).toBeVisible();
  await expect(page.locator('[data-plan-page="plan"] [data-plan-page-subtitle]')).toContainText(
    'Draft',
  );
  expect(creates[0]?.args.p_posts).toEqual([]);
  expect(creates[0]?.args.p_concepts).toEqual([
    {
      title: 'Opening reel v2',
      description: '',
      attachment_version_ids: ['0190f100-0000-7000-8000-000000000001'],
      target_date: day,
    },
  ]);
  expect(network.world.tables.plans?.[0]?.audience).toBe('team');
  expectClean(network);
});

for (const width of [320, 390]) {
  test(`From and To fit inside the screen at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 780 });
    const network = await installHarnessNetwork(page);
    await openChat(page, PEER_NAME);
    const compose = await openCompose(page);
    await compose.locator('[data-plan-dates-change]').click();
    const dates = page.getByRole('dialog', { name: 'Plan dates' });
    await expect(dates).toBeVisible();
    for (const field of ['startsOn', 'endsOn']) {
      const box = await dates.locator(`[data-plan-date="${field}"]`).boundingBox();
      expect(box, field).not.toBeNull();
      if (box === null) return;
      expect(box.x, `${field} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${field} right edge`).toBeLessThanOrEqual(width);
      expect(box.height, `${field} height`).toBeGreaterThanOrEqual(44);
    }
    expectClean(network);
  });
}
