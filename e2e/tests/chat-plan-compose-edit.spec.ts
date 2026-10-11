import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork, solidPng, type HarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// New plan screen: a draft concept opens in the same concept sheet ("Edit
// concept", "Save", no review line) prefilled, and Save replaces it in place
// with no RPC until Share; Cancel leaves it; the X still removes. The From /
// To date boxes fit inside the screen at 320px and 390px. Runs in both colour
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

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
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
  await page.getByRole('dialog', { name: 'Share a plan' }).locator('[data-plan-pick-new]').click();
  const compose = page_(page, 'compose');
  await expect(compose).toBeVisible();
  return compose;
}

test('tap a draft concept to edit it; Save replaces it in place; share carries it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const compose = await openCompose(page);
  await compose.locator('[data-plan-title]').fill('Launch week');

  // Two concepts: a dated one (first) and an undated one (second).
  const add = async (title: string, date: string): Promise<void> => {
    await compose.locator('[data-plan-add-concept]').click();
    const sheet = page.getByRole('dialog', { name: 'Add concept' });
    await expect(sheet).toBeVisible();
    await sheet.locator('[data-plan-concept-title]').fill(title);
    if (date !== '') await sheet.locator('[data-plan-concept-date]').fill(date);
    await sheet.locator('[data-plan-concept-save]').click();
    await expect(sheet).toBeHidden();
  };
  await add('Opening reel', '2026-10-13');
  // The first concept carries one uploaded file, which must stay attached.
  const rows = compose.locator('[data-plan-draft-concept]');
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
  await add('Story', '');
  await expect(rows).toHaveCount(2);
  const titles = () => rows.locator('[data-plan-draft-concept-title]').allInnerTexts();
  expect(await titles()).toEqual(['Opening reel', 'Story']);

  const edit = rows.first().locator('[data-plan-draft-concept-edit]');
  expectMinTouchTarget(await edit.boundingBox());
  expectMinTouchTarget(
    await rows.first().locator('[data-plan-draft-concept-remove]').boundingBox(),
  );
  await page.waitForTimeout(300);
  await shot(page, 'compose-edit-01-rows');

  // Cancel leaves it unchanged.
  await edit.click();
  const sheet = page.getByRole('dialog', { name: 'Edit concept' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-title]')).toHaveValue('Opening reel');
  await expect(sheet.locator('[data-plan-concept-date]')).toHaveValue('2026-10-13');
  await expect(sheet.locator('[data-plan-concept-file]')).toHaveCount(1);
  await expect(sheet.locator('[data-plan-concept-save]')).toHaveText('Save');
  await expect(sheet.locator('[data-plan-concept-reset]')).toHaveCount(0);
  await sheet.locator('[data-plan-concept-title]').fill('Thrown away');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  expect(await titles()).toEqual(['Opening reel', 'Story']);

  // Edit: title and date change, same position, file kept.
  await edit.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-title]')).toHaveValue('Opening reel');
  await sheet.locator('[data-plan-concept-title]').fill('Opening reel v2');
  await sheet.locator('[data-plan-concept-date]').fill('2026-10-15');
  await page.waitForTimeout(300);
  await shot(page, 'compose-edit-02-sheet');
  await sheet.locator('[data-plan-concept-save]').click();
  await expect(sheet).toBeHidden();
  expect(await titles()).toEqual(['Opening reel v2', 'Story']);
  await expect(rows.first().locator('[data-plan-draft-concept-date]')).toHaveText('15 Oct');
  await expect(rows.first()).toContainText('1 file');
  expect(planRpcs(network), 'no RPC on a local edit').toEqual([]);
  await page.waitForTimeout(300);
  await shot(page, 'compose-edit-03-saved');

  // The X still removes.
  await rows.nth(1).locator('[data-plan-draft-concept-remove]').click();
  await expect(rows).toHaveCount(1);

  await compose.locator('[data-plan-share]').click();
  await expect(compose).toBeHidden();
  const adds = network.rpcCalls.filter((c) => c.name === 'plan_concept_add');
  expect(adds).toHaveLength(1);
  expect(adds[0]?.args.p_title).toBe('Opening reel v2');
  expect(adds[0]?.args.p_target_date).toBe('2026-10-15');
  expect(adds[0]?.args.p_attachment_version_ids).toEqual(['0190f100-0000-7000-8000-000000000001']);
  expectClean(network);
});

for (const width of [320, 390]) {
  test(`From and To fit inside the screen at ${width}px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 780 });
    const network = await installHarnessNetwork(page);
    await openChat(page, PEER_NAME);
    const compose = await openCompose(page);
    for (const field of ['startsOn', 'endsOn']) {
      const box = await compose.locator(`[data-plan-date="${field}"]`).boundingBox();
      expect(box, field).not.toBeNull();
      if (box === null) return;
      expect(box.x, `${field} left`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${field} right edge`).toBeLessThanOrEqual(width);
      expect(box.height, `${field} height`).toBeGreaterThanOrEqual(44);
    }
    await page.waitForTimeout(300);
    await shot(page, `compose-dates-${width}`);
    expectClean(network);
  });
}
