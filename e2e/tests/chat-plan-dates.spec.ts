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

// Plan dates and progress: a 15-item plan seeded out of date order renders in
// date order on first paint with "No date" items last, the agency card shows
// team and client counts (a client sees the client count only), and the agency
// sets and clears a concept's date. Runs in both colour schemes (the dark and
// light projects) on the iPhone viewport. Linux WebKit approximates iOS WebKit.

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

/** The fixture's titles of one kind in the expected order: by day, undated last by position. */
function expectedTitles(kind: 'concept' | 'post'): string[] {
  const own = DATED_PLAN_ITEMS.map((it, position) => ({ ...it, position })).filter(
    (it) => it.kind === kind,
  );
  const dated = own.filter((it) => it.date !== null);
  dated.sort(
    (a, b) => (a.date as string).localeCompare(b.date as string) || a.position - b.position,
  );
  return [...dated, ...own.filter((it) => it.date === null)].map((it) => it.title);
}

function counts(): { team: number; client: number; changes: number; total: number } {
  return {
    team: DATED_PLAN_ITEMS.filter((it) => it.team === 'approved').length,
    client: DATED_PLAN_ITEMS.filter((it) => it.client === 'approved').length,
    changes: DATED_PLAN_ITEMS.filter((it) => it.kind === 'concept' && it.client === 'changes')
      .length,
    total: DATED_PLAN_ITEMS.length,
  };
}

async function rowTitles(page: Page): Promise<string[]> {
  return page_(page, 'plan').locator('[data-plan-row] span.truncate').allInnerTexts();
}

test.describe('phone', () => {
  test('agency: sorted 15-item plan, both counts, set and clear a concept date', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const network = await installHarnessNetwork(page);
    seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
    await openChat(page, PEER_NAME);

    const c = counts();
    const card = page.locator(`[data-plan-card="${DATED_PLAN_ID}"]`);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('[data-plan-progress]')).toHaveText(
      `Team ${c.team} of ${c.total} · Client ${c.client} of ${c.total} · ${c.changes} change asked`,
    );
    await page.waitForTimeout(300);
    await shot(page, 'dates-01-card-agency');

    await card.locator('[data-plan-open]').click();
    const plan = page_(page, 'plan');
    await expect(plan).toBeVisible();
    await expect(plan.locator('[data-plan-row]').first()).toBeVisible();
    // First paint is already in date order (the list paints once, sorted).
    expect(await rowTitles(page)).toEqual(expectedTitles('concept'));
    await expect(plan.locator('[data-plan-screen-progress]')).toHaveText(
      `Team ${c.team} of ${c.total} · Client ${c.client} of ${c.total} · ${c.changes} change asked`,
    );
    const dates = plan.locator('[data-plan-row-date]');
    const undated = DATED_PLAN_ITEMS.filter((it) => it.kind === 'concept' && it.date === null);
    const conceptCount = DATED_PLAN_ITEMS.filter((it) => it.kind === 'concept').length;
    await expect(dates.first()).toHaveText('12 Oct');
    for (let k = conceptCount - undated.length; k < conceptCount; k += 1) {
      await expect(dates.nth(k)).toHaveText('No date');
      await expect(dates.nth(k)).toHaveAttribute('data-plan-row-date', 'none');
      await expect(dates.nth(k)).toHaveClass(/text-fg-3/);
    }
    await page.waitForTimeout(300);
    await shot(page, 'dates-02-concepts-sorted');
    await plan
      .locator('[data-plan-row]')
      .nth(conceptCount - 1)
      .scrollIntoViewIfNeeded();
    await shot(page, 'dates-03-concepts-no-date-last');

    await plan.locator('[data-plan-tab="post"]').click();
    expect(await rowTitles(page)).toEqual(expectedTitles('post'));
    await expect(dates.last()).toHaveText('No date');
    await page.waitForTimeout(300);
    await shot(page, 'dates-04-posts-sorted');

    // "Concept i of n" follows the date order.
    await plan.locator('[data-plan-tab="concept"]').click();
    await plan.locator('[data-plan-row]').first().click();
    const item = page_(page, 'item');
    await expect(item).toBeVisible();
    await expect(item.getByText(`Concept 1 of ${conceptCount}`)).toBeVisible();
    await expect(item.locator('[data-plan-item-date]')).toHaveText('12 Oct');
    await page.goBack();
    await expect(item).toBeHidden();

    // Set a date on an undated concept: it moves to the front.
    const target = undated[1];
    if (target === undefined) throw new Error('fixture');
    await plan.locator(`[data-plan-row="${target.id}"]`).click();
    await expect(item).toBeVisible();
    await expect(item.locator('[data-plan-item-date]')).toHaveText('No date');
    await page.waitForTimeout(300);
    await shot(page, 'dates-05-item-no-date');
    await item.locator('[data-plan-edit-date]').click();
    const sheet = page.getByRole('dialog', { name: 'Concept date' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-plan-concept-date]')).toHaveValue('');
    await expect(sheet.locator('[data-plan-concept-date-clear]')).toHaveCount(0);
    await sheet.locator('[data-plan-concept-date]').fill('2026-10-11');
    const clear = sheet.locator('[data-plan-concept-date-clear]');
    const box = await clear.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.waitForTimeout(300);
    await shot(page, 'dates-06-edit-sheet');
    await sheet.locator('[data-plan-date-save]').click();
    await expect(sheet).toBeHidden();
    await expect(item.locator('[data-plan-item-date]')).toHaveText('11 Oct');
    const row = (network.world.tables.plan_items ?? []).find((i) => i.id === target.id);
    expect(row?.target_date).toBe('2026-10-11');
    await expect(item.getByText(`Concept 1 of ${conceptCount}`)).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, 'dates-07-item-dated');
    await page.goBack();
    await expect(item).toBeHidden();
    await expect.poll(async () => (await rowTitles(page))[0]).toBe(target.title);

    // Clear it again: back among the undated, in position order.
    await plan.locator(`[data-plan-row="${target.id}"]`).click();
    await expect(item).toBeVisible();
    await item.locator('[data-plan-edit-date]').click();
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-plan-concept-date]')).toHaveValue('2026-10-11');
    await sheet.locator('[data-plan-concept-date-clear]').click();
    await expect(sheet.locator('[data-plan-concept-date]')).toHaveValue('');
    await sheet.locator('[data-plan-date-save]').click();
    await expect(sheet).toBeHidden();
    await expect(item.locator('[data-plan-item-date]')).toHaveText('No date');
    expect(
      (network.world.tables.plan_items ?? []).find((i) => i.id === target.id)?.target_date,
    ).toBeNull();
    await page.goBack();
    await expect(item).toBeHidden();
    await expect.poll(() => rowTitles(page)).toEqual(expectedTitles('concept'));
    await page.waitForTimeout(300);
    await shot(page, 'dates-08-cleared');
    expectClean(network);
  });

  test('client: the card and screen show the client count only', async ({ page }) => {
    test.setTimeout(120_000);
    const network = await installHarnessNetwork(page);
    for (const m of network.world.tables.workspace_members ?? []) {
      if (m.user_id === ME) m.role = 'client';
      if (m.user_id === PEER) m.role = 'agency';
    }
    seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: PEER });
    await openChat(page, PEER_NAME);
    const c = counts();
    const card = page.locator(`[data-plan-card="${DATED_PLAN_ID}"]`);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('[data-plan-progress]')).toHaveText(
      `${c.client} of ${c.total} approved by client · ${c.changes} change asked`,
    );
    await expect(card.getByText(/Team \d/)).toHaveCount(0);
    await page.waitForTimeout(300);
    await shot(page, 'dates-09-card-client');
    await card.locator('[data-plan-open]').click();
    const plan = page_(page, 'plan');
    await expect(plan.locator('[data-plan-screen-progress]')).toHaveText(
      `${c.client}/${c.total} approved`,
    );
    expect(await rowTitles(page)).toEqual(expectedTitles('concept'));
    await expect(plan.locator('[data-plan-pill="team"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    await shot(page, 'dates-10-plan-client');
    expectClean(network);
  });
});
