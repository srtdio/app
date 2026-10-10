import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DATED_PLAN_ID,
  DATED_PLAN_ITEMS,
  DM_CHANNEL,
  ME,
  PEER,
  PEER_NAME,
  seedDatedPlan,
} from '../fixtures/chat-data';

// Plan concept: full edit. The agency edits an approved concept's title and
// date in the Add concept sheet (edit mode): the reset line shows, Save sends
// one plan_concept_edit, both reviews read Waiting, the title updates and the
// item moves to its date position. The Date row's Edit opens the same sheet;
// an unchanged Save sends nothing. A client sees no Edit. Runs in both colour
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

async function rowTitles(page: Page): Promise<string[]> {
  return page_(page, 'plan').locator('[data-plan-row] span.truncate').allInnerTexts();
}

async function openPlan(page: Page): Promise<void> {
  const card = page.locator(`[data-plan-card="${DATED_PLAN_ID}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-plan-open]').click();
  await expect(page_(page, 'plan').locator('[data-plan-row]').first()).toBeVisible();
}

/** Count plan_concept_edit calls the page sends. */
function countEdits(page: Page): { count: () => number } {
  let n = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/rpc/plan_concept_edit')) n += 1;
  });
  return { count: () => n };
}

test('agency edits an approved concept: reset line, Waiting, new title, new position', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  const edits = countEdits(page);
  await openChat(page, PEER_NAME);
  await openPlan(page);
  const plan = page_(page, 'plan');
  const item = page_(page, 'item');

  const target = DATED_PLAN_ITEMS.find((it) => it.title === 'Lamp lighting reel');
  if (target === undefined) throw new Error('fixture');
  expect(await rowTitles(page)).not.toEqual([]);
  expect((await rowTitles(page))[0]).not.toBe(target.title);

  await plan.locator(`[data-plan-row="${target.id}"]`).click();
  await expect(item).toBeVisible();
  const edit = item.locator('[data-plan-edit-concept]');
  await expect(edit).toHaveText('Edit');
  const box = await edit.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expect(item.locator('[data-plan-pill="team"]')).toHaveText(/Approved/);
  await page.waitForTimeout(300);
  await shot(page, 'edit-01-item-approved');

  // Unchanged Save closes the sheet and sends nothing (reviews stay approved).
  await edit.click();
  const sheet = page.getByRole('dialog', { name: 'Edit concept' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-title]')).toHaveValue(target.title);
  await expect(sheet.locator('[data-plan-concept-date]')).toHaveValue(target.date ?? '');
  await expect(sheet.locator('[data-plan-concept-save]')).toHaveText('Save');
  await expect(sheet.locator('[data-plan-concept-reset]')).toHaveText(
    'Saving sends this back to waiting for team and client.',
  );
  await sheet.locator('[data-plan-concept-save]').click();
  await expect(sheet).toBeHidden();
  expect(edits.count()).toBe(0);
  await expect(item.locator('[data-plan-pill="team"]')).toHaveText(/Approved/);

  // Title and date: one call, both reviews back to Waiting.
  await edit.click();
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-plan-concept-title]').fill('Lamp lighting reel v2');
  await sheet.locator('[data-plan-concept-date]').fill('2026-10-11');
  await page.waitForTimeout(400);
  await shot(page, 'edit-02-sheet-reset-line');
  await sheet.locator('[data-plan-concept-save]').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText('Concept updated')).toBeVisible();
  expect(edits.count()).toBe(1);
  await expect(item.getByRole('heading', { name: 'Lamp lighting reel v2' })).toBeVisible();
  await expect(item.locator('[data-plan-item-date]')).toHaveText('11 Oct');
  await expect(item.locator('[data-plan-pill="team"]')).toHaveText(/Waiting/);
  await expect(item.locator('[data-plan-pill="client"]')).toHaveText(/Waiting/);
  await expect(item.getByText(/^Concept 1 of \d+$/)).toBeVisible();
  const row = (network.world.tables.plan_items ?? []).find((i) => i.id === target.id);
  expect(row?.title).toBe('Lamp lighting reel v2');
  expect(row?.target_date).toBe('2026-10-11');
  await page.waitForTimeout(300);
  await shot(page, 'edit-03-item-waiting');

  // The Date row's Edit opens the same sheet, prefilled; no reset line now.
  await item.locator('[data-plan-edit-date]').click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-title]')).toHaveValue('Lamp lighting reel v2');
  await expect(sheet.locator('[data-plan-concept-date]')).toHaveValue('2026-10-11');
  await expect(sheet.locator('[data-plan-concept-reset]')).toHaveCount(0);
  await page.waitForTimeout(400);
  await shot(page, 'edit-04-date-row-same-sheet');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  expect(edits.count()).toBe(1);

  // Back on the plan: the item moved to its date position (first).
  await page.goBack();
  await expect(item).toBeHidden();
  await expect.poll(async () => (await rowTitles(page))[0]).toBe('Lamp lighting reel v2');
  await page.waitForTimeout(300);
  await shot(page, 'edit-05-plan-moved');
  expectClean(network);
});

test('client: no Edit on a concept', async ({ page }) => {
  test.setTimeout(60_000);
  const network = await installHarnessNetwork(page);
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: PEER });
  await openChat(page, PEER_NAME);
  await openPlan(page);
  const target = DATED_PLAN_ITEMS.find((it) => it.title === 'Lamp lighting reel');
  if (target === undefined) throw new Error('fixture');
  await page_(page, 'plan').locator(`[data-plan-row="${target.id}"]`).click();
  const item = page_(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.locator('[data-plan-item-date]')).toHaveText('18 Oct');
  await expect(item.locator('[data-plan-edit-concept]')).toHaveCount(0);
  await expect(item.locator('[data-plan-edit-date]')).toHaveCount(0);
  await expect(item.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, 'edit-06-client-no-edit');
  expectClean(network);
});
