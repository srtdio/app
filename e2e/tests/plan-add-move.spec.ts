import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DATED_PLAN_ID,
  DATED_PLAN_ITEMS,
  DM_CHANNEL,
  DRAFT_ITEM_ID,
  DRAFT_PLAN_ID,
  ME,
  PEER,
  PEER_NAME,
  PLAN_ID,
  POST_IDS,
  seedClientPlan,
  seedClientPlanWithDraft,
  seedDatedPlan,
} from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Plan list: aligned layout, add to any day, drag and move. The agency adds a
// concept or a post to a day (the post's own date stays), long-press drags a
// row to another day (ticks reset) or within a day (the order persists),
// moves or removes an item from its screen's overflow; a client sees the list
// and ticks only. Runs in both colour schemes (the dark and light projects)
// on the iPhone viewport.

const FILE_VERSION = '0190e100-0000-7000-8000-0000000000c1';

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

function viewAsClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
}

async function openPlan(page: Page, planId: string): Promise<Locator> {
  const card = page.locator(`[data-plan-card="${planId}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-plan-open]').click();
  const plan = page.locator('[data-plan-page="plan"]');
  await expect(plan.locator('[data-plan-day]').first()).toBeVisible();
  return plan;
}

const dayBlock = (plan: Locator, day: string): Locator => plan.locator(`[data-plan-day="${day}"]`);

async function titlesOn(plan: Locator, day: string): Promise<string[]> {
  return dayBlock(plan, day).locator('[data-plan-row-title]').allInnerTexts();
}

const dated = (title: string) => {
  const it = DATED_PLAN_ITEMS.find((i) => i.title === title);
  if (it === undefined) throw new Error(`fixture: ${title}`);
  return it;
};

/**
 * Long-press a row, carry it to `y` (a viewport y inside the target day),
 * optionally shoot mid-way, and let go.
 */
async function dragTo(
  page: Page,
  row: Locator,
  target: () => Promise<number>,
  midShot?: string,
): Promise<void> {
  // Keep the row mid-screen so the pointer never rests in an auto-scroll edge.
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await row.boundingBox();
  if (box === null) throw new Error('row box');
  const x = box.x + 80;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  const y1 = await target();
  await page.mouse.move(x, (y0 + y1) / 2, { steps: 6 });
  await page.mouse.move(x, y1, { steps: 6 });
  // Re-aim once the drop slot has opened (it shifts the rows below it).
  await page.waitForTimeout(150);
  await page.mouse.move(x, await target(), { steps: 2 });
  await expect(page.locator('[data-plan-drop-slot]')).toBeVisible();
  if (midShot !== undefined) {
    await page.waitForTimeout(200);
    await shot(page, midShot);
  }
  await page.mouse.up();
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
}

test('agency: aligned list, Add a concept and a post to a day', async ({ page }) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: ME, fileVersionId: FILE_VERSION });
  const ownDate = (network.world.tables.posts ?? []).find((p) => p.id === POST_IDS[1])?.target_date;
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, PLAN_ID);

  // Header: range and audience; "+" then progress.
  await expect(plan.getByText('12 to 18 Oct · Shared with client')).toBeVisible();
  const plus = plan.locator('[data-plan-add-header]');
  expectMinTouchTarget(await plus.boundingBox());

  // A1: weekday and digits centred as one block in a 48x44 column.
  const wed = dayBlock(plan, '2026-10-14');
  const col = await wed.locator('[data-plan-day-col]').boundingBox();
  const weekday = await wed.locator('[data-plan-day-weekday]').boundingBox();
  const digits = await wed.locator('[data-plan-day-number]').boundingBox();
  if (col === null || weekday === null || digits === null) throw new Error('day boxes');
  expect(col.width).toBe(48);
  expect(col.height).toBe(44);
  for (const b of [weekday, digits]) {
    expect(Math.abs(b.x + b.width / 2 - (col.x + col.width / 2))).toBeLessThanOrEqual(1);
  }
  const block = Math.round(digits.y + digits.height - weekday.y);
  expect(
    Math.abs(weekday.y - col.y - (col.y + col.height - (digits.y + digits.height))),
  ).toBeLessThanOrEqual(1);
  expect(block).toBe(44);
  // An empty day: Add sits right of "Nothing planned", 44px tall.
  const add = wed.locator('[data-plan-add="2026-10-14"]');
  expectMinTouchTarget(await add.boundingBox());
  await expect(wed.locator('[data-plan-day-empty]')).toHaveText('Nothing planned');
  await page.waitForTimeout(300);
  await shot(page, 'add-01-agency-list');

  // Add on an empty day, New concept: it lands under that day.
  await add.click();
  const sheet = page.getByRole('dialog', { name: 'Add to Wed 14 Oct' });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'add-02-add-sheet');
  await sheet.getByRole('button', { name: /New concept/ }).click();
  const concept = page.locator('[data-plan-concept-title]');
  await expect(concept).toBeVisible();
  await concept.fill('Lantern close-ups');
  await page.locator('[data-plan-concept-save]').click();
  await expect(page.getByText('Concept added to Wed 14 Oct')).toBeVisible();
  await expect.poll(() => titlesOn(plan, '2026-10-14')).toEqual(['Lantern close-ups']);
  const added = (network.world.tables.plan_items ?? []).find(
    (i) => i.title === 'Lantern close-ups',
  );
  expect(added?.target_date).toBe('2026-10-14');

  // Add, Pick a post: under that day; the post's own date is unchanged; posts
  // already in the plan are not offered.
  await dayBlock(plan, '2026-10-15').locator('[data-plan-add="2026-10-15"]').click();
  const thu = page.getByRole('dialog', { name: 'Add to Thu 15 Oct' });
  await thu.getByRole('button', { name: /Pick a post/ }).click();
  const posts = page.getByRole('dialog', { name: 'Share a post' });
  await expect(posts).toBeVisible();
  await expect(posts.getByRole('button', { name: /Monday carousel/ })).toHaveCount(0);
  await posts.getByRole('button', { name: /Friday reel/ }).click();
  await posts.getByRole('button', { name: 'Done (1)' }).click();
  await expect(page.getByText('Added to Thu 15 Oct')).toBeVisible();
  await expect.poll(() => titlesOn(plan, '2026-10-15')).toEqual(['Friday reel']);
  const item = (network.world.tables.plan_items ?? []).find((i) => i.post_id === POST_IDS[1]);
  expect(item?.target_date).toBe('2026-10-15');
  const post = (network.world.tables.posts ?? []).find((p) => p.id === POST_IDS[1]);
  expect(post?.target_date).toBe(ownDate);

  // Header "+": the same sheet with no day.
  await plus.click();
  await expect(page.getByRole('dialog', { name: 'Add to plan' })).toBeVisible();
  await page.keyboard.press('Escape');
  expectClean(network);
});

test('agency: long-press drag moves a Thu item to Wed and resets its ticks', async ({ page }) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  const moved = dated('Sweets flatlay');
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  const row = plan.locator(`[data-plan-row="${moved.id}"]`);
  await expect(dayBlock(plan, '2026-10-15').locator(`[data-plan-row="${moved.id}"]`)).toHaveCount(
    1,
  );

  await dragTo(
    page,
    row,
    async () => {
      const first = await dayBlock(plan, '2026-10-14')
        .locator('[data-plan-row-wrap]')
        .first()
        .boundingBox();
      if (first === null) throw new Error('target');
      return first.y + 4;
    },
    'move-01-drag-mid-way',
  );
  await expect(page.getByText('Moved to Wed 14 Oct. Its ticks were reset.')).toBeVisible();
  await expect
    .poll(() => titlesOn(plan, '2026-10-14'))
    .toEqual(['Sweets flatlay', 'Lantern workshop']);
  const stored = (network.world.tables.plan_items ?? []).find((i) => i.id === moved.id);
  expect(stored?.target_date).toBe('2026-10-14');
  const reviews = (network.world.tables.plan_item_reviews ?? []).filter(
    (r) => r.item_id === moved.id,
  );
  expect(reviews.every((r) => r.status === 'waiting')).toBe(true);
  await expect(plan.locator(`[data-plan-row-wrap="${moved.id}"] [data-plan-slot]`)).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.waitForTimeout(300);
  await shot(page, 'move-02-dropped');
  expectClean(network);
});

test('agency: a reorder within a day persists after reload; Escape cancels with no write', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  let plan = await openPlan(page, DATED_PLAN_ID);
  expect(await titlesOn(plan, '2026-10-12')).toEqual(['Countdown story', 'Opening offer']);

  // Escape mid-drag: nothing written, nothing moved.
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/rpc/plan_item_move')) calls.push(r.url());
  });
  const offer = plan.locator(`[data-plan-row="${dated('Opening offer').id}"]`);
  await offer.scrollIntoViewIfNeeded();
  const box = await offer.boundingBox();
  if (box === null) throw new Error('row box');
  await page.mouse.move(box.x + 80, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  await page.mouse.move(box.x + 80, box.y - 30, { steps: 4 });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(calls).toEqual([]);
  expect(await titlesOn(plan, '2026-10-12')).toEqual(['Countdown story', 'Opening offer']);

  // Drag Opening offer above Countdown story.
  await dragTo(page, offer, async () => {
    const first = await dayBlock(plan, '2026-10-12')
      .locator('[data-plan-row-wrap]')
      .first()
      .boundingBox();
    if (first === null) throw new Error('target');
    return first.y + 4;
  });
  await expect
    .poll(() => titlesOn(plan, '2026-10-12'))
    .toEqual(['Opening offer', 'Countdown story']);
  expect(calls).toHaveLength(1);

  await page.reload();
  await openChat(page, PEER_NAME);
  plan = await openPlan(page, DATED_PLAN_ID);
  expect(await titlesOn(plan, '2026-10-12')).toEqual(['Opening offer', 'Countdown story']);
  expectClean(network);
});

test('agency: Move to another day and Remove from plan from the item overflow', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  const target = dated('Rangoli timelapse');
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);

  await plan.locator(`[data-plan-row="${target.id}"]`).click();
  const item = page.locator('[data-plan-page="item"]');
  await expect(item).toBeVisible();
  const more = item.locator('[data-plan-item-more]');
  expectMinTouchTarget(await more.boundingBox());
  await more.click();
  const actions = page.locator('[data-plan-item-actions]');
  await expect(actions.getByRole('button', { name: /Edit concept/ })).toBeVisible();
  await actions.getByRole('button', { name: /Move to another day/ }).click();
  const days = page.locator('[data-plan-move-sheet]');
  await expect(days.locator('[data-plan-move-day="2026-10-16"]')).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(days.locator('[data-plan-move-day="none"]')).toHaveText('No date');
  await page.waitForTimeout(300);
  await shot(page, 'move-03-move-sheet');
  await days.locator('[data-plan-move-day="2026-10-13"]').click();
  await expect(page.getByText(/^Moved to Tue 13 Oct\.$/)).toBeVisible();
  await expect
    .poll(
      () => (network.world.tables.plan_items ?? []).find((i) => i.id === target.id)?.target_date,
    )
    .toBe('2026-10-13');

  await more.click();
  await page
    .locator('[data-plan-item-actions]')
    .getByRole('button', { name: /Remove from plan/ })
    .click();
  await page.locator('[data-plan-remove-confirm]').click();
  await expect(page.getByText('Removed from plan')).toBeVisible();
  await expect(item).toBeHidden();
  await expect(plan.locator(`[data-plan-row="${target.id}"]`)).toHaveCount(0);
  expect(await titlesOn(plan, '2026-10-13')).toEqual(['Family portraits']);

  // A post item: Move and Remove sit in the post view's own sheet.
  await plan.locator(`[data-plan-row="${dated('Thank you note').id}"]`).click();
  await item.locator('[data-plan-more]').click();
  const postSheet = page.getByRole('dialog', { name: 'Post actions', exact: true });
  await expect(postSheet.getByRole('button', { name: /Move to another day/ })).toBeVisible();
  await expect(postSheet.getByRole('button', { name: /Remove from plan/ })).toBeVisible();
  await page.keyboard.press('Escape');
  expectClean(network);
});

test('client: same list, no Add or +, long-press does nothing, no Move or Remove', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: PEER });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  await expect(plan.locator('[data-plan-add], [data-plan-add-header]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-row-status]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, 'client-01-list');

  const concept = dated('Rangoli timelapse');
  const row = plan.locator(`[data-plan-row="${concept.id}"]`);
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (box === null) throw new Error('row box');
  await page.mouse.move(box.x + 80, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
  await expect(page.locator('[data-plan-row-lifted]')).toHaveCount(0);
  // Letting go is a plain tap for a client: it opens the item.
  await page.mouse.up();
  const item = page.locator('[data-plan-page="item"]');
  await expect(item).toBeVisible();
  await expect(item.locator('[data-plan-item-more]')).toHaveCount(0);
  await expect(page.getByText('Move to another day')).toHaveCount(0);
  expectClean(network);
});

test('client: a draft row sits under the plan day it was moved to, not its own date', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedClientPlanWithDraft(network.world, { channelId: DM_CHANNEL, sender: PEER });
  const t = network.world.tables;
  const plan = (t.plans ?? []).find((p) => p.id === DRAFT_PLAN_ID);
  const hidden = (t.hidden_plan_items ?? []).find((i) => i.id === DRAFT_ITEM_ID);
  const post = (t.posts ?? []).find((p) => p.id === hidden?.post_id);
  if (plan === undefined || hidden === undefined || post === undefined) throw new Error('fixture');
  // The agency moved it to the plan's fifth day; the post's own date differs.
  const start = new Date(`${String(plan.starts_on)}T00:00:00Z`).getTime();
  const planDay = new Date(start + 5 * 24 * 3_600_000).toISOString().slice(0, 10);
  const ownDay = String(post.target_date).slice(0, 10);
  expect(ownDay).not.toBe(planDay);
  hidden.target_date = planDay;

  await openChat(page, PEER_NAME);
  const list = await openPlan(page, DRAFT_PLAN_ID);
  const draft = dayBlock(list, planDay).locator(`[data-plan-row="${DRAFT_ITEM_ID}"]`);
  await draft.scrollIntoViewIfNeeded();
  await expect(draft).toHaveAttribute('data-plan-row-draft', 'locked');
  await expect(dayBlock(list, ownDay).locator(`[data-plan-row="${DRAFT_ITEM_ID}"]`)).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, 'client-02-draft-on-plan-day');
  expectClean(network);
});
