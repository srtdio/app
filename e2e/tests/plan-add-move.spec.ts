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
// concept or a post to a day (a post's day is its post's target_date), and in
// Edit mode (X3) drags a row by its grip to another day (ticks reset on Save)
// or within a day (the order persists after Save changes: one plan_save with
// the queued ops; nothing is written before), moves an item from its screen's
// overflow and removes it with the screen's red "Remove from plan"; a client
// sees the list and ticks only. Runs in both colour schemes (the dark and
// light projects) on the iPhone viewport.

const FILE_VERSION = '0190e100-0000-7000-8000-0000000000c1';

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

/** Edit mode: the header's Edit button, then the edit header with its fields. */
async function enterEdit(plan: Locator): Promise<void> {
  await plan.locator('[data-plan-edit]').click();
  await expect(plan.locator('[data-plan-edit-header]')).toBeVisible();
}

/** Save changes: the toast, then view mode again. */
async function saveChanges(page: Page, plan: Locator): Promise<void> {
  await plan.locator('[data-plan-save]').click();
  await expect(page.getByText('Plan saved', { exact: true })).toBeVisible();
  await expect(plan.locator('[data-plan-edit-header]')).toHaveCount(0);
}

const saves = (network: HarnessNetwork) => network.rpcCalls.filter((c) => c.name === 'plan_save');
const opsOf = (call: { args: Record<string, unknown> } | undefined) =>
  (call?.args.p_ops ?? []) as Array<Record<string, unknown>>;

/**
 * Edit mode: press the row's grip, lift it after 4px of travel (no
 * long-press), carry it to `y` (a viewport y inside the target day), and let go.
 */
async function gripDrag(
  page: Page,
  plan: Locator,
  id: string,
  target: () => Promise<number>,
): Promise<void> {
  const wrap = plan.locator(`[data-plan-row-wrap="${id}"]`);
  // Keep the row mid-screen so the pointer never rests in an auto-scroll edge.
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const grip = wrap.locator('[data-plan-grip]');
  const box = await grip.boundingBox();
  if (box === null) throw new Error('grip box');
  const x = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 + 6);
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  const y1 = await target();
  await page.mouse.move(x, (y0 + y1) / 2, { steps: 6 });
  await page.mouse.move(x, y1, { steps: 6 });
  // Re-aim once the drop slot has opened (it shifts the rows below it).
  await page.waitForTimeout(150);
  await page.mouse.move(x, await target(), { steps: 2 });
  await expect(page.locator('[data-plan-drop-slot]')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
}

test('agency: aligned list, Add a concept and a post to a day', async ({ page }) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: ME, fileVersionId: FILE_VERSION });
  // The plan's post is dated "tomorrow" by the fixture; pin it to Tue 13 Oct so
  // Wed 14 Oct stays the empty day this test adds to, whatever today is.
  for (const p of network.world.tables.posts ?? []) {
    if (p.id === POST_IDS[0]) p.target_date = '2026-10-13T09:00:00Z';
  }
  const ownDate = (network.world.tables.posts ?? []).find((p) => p.id === POST_IDS[1])?.target_date;
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, PLAN_ID);

  // Header: range and audience; "+" then progress.
  await expect(plan.getByText('12 to 18 Oct · Shared with approvers')).toBeVisible();
  const plus = plan.locator('[data-plan-add-header]');
  expectMinTouchTarget(await plus.boundingBox());

  // A1: one 56x56 date tile per day: an 18px weekday strip on top, the
  // number centred below it.
  const wed = dayBlock(plan, '2026-10-14');
  await expect(wed.locator('[data-plan-day-col]')).toHaveCount(1);
  const col = await wed.locator('[data-plan-day-col]').boundingBox();
  const weekday = await wed.locator('[data-plan-day-weekday]').boundingBox();
  const digits = await wed.locator('[data-plan-day-number]').boundingBox();
  if (col === null || weekday === null || digits === null) throw new Error('day boxes');
  expect(col.width).toBe(56);
  expect(col.height).toBe(56);
  expect(Math.round(weekday.height)).toBe(18);
  expect(weekday.y - col.y).toBeLessThanOrEqual(1.5);
  expect(digits.y).toBeGreaterThanOrEqual(weekday.y + weekday.height - 0.5);
  for (const b of [weekday, digits]) {
    expect(Math.abs(b.x + b.width / 2 - (col.x + col.width / 2))).toBeLessThanOrEqual(1);
  }
  await expect(wed.locator('[data-plan-day-number]')).toHaveText('14');
  // An empty day: Add sits right of "Nothing planned", 44px tall.
  const add = wed.locator('[data-plan-add="2026-10-14"]');
  expectMinTouchTarget(await add.boundingBox());
  await expect(wed.locator('[data-plan-day-empty]')).toHaveText('Planned posts show up here.');

  // Add on an empty day, New concept: it lands under that day.
  await add.click();
  const sheet = page.getByRole('dialog', { name: 'Add to Wed 14 Oct' });
  await expect(sheet).toBeVisible();
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

  // Add, Pick a post: under that day (written onto the post itself, the slot
  // carries no day); posts already in the plan are not offered.
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
  expect(item?.target_date).toBeNull();
  const post = (network.world.tables.posts ?? []).find((p) => p.id === POST_IDS[1]);
  expect(post?.target_date).toBe('2026-10-15T12:00:00Z');
  expect(post?.target_date).not.toBe(ownDate);

  // Header "+": the same sheet with no day.
  await plus.click();
  await expect(page.getByRole('dialog', { name: 'Add to plan' })).toBeVisible();
  await page.keyboard.press('Escape');
  expectClean(network);
});

test('agency: in Edit, a grip drag moves a Thu item to Wed; Save changes writes it once and resets its ticks', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  const moved = dated('Sweets flatlay');
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  await expect(dayBlock(plan, '2026-10-15').locator(`[data-plan-row="${moved.id}"]`)).toHaveCount(
    1,
  );
  // View mode has no grip: nothing drags until Edit.
  await expect(plan.locator('[data-plan-grip]')).toHaveCount(0);
  await enterEdit(plan);

  await gripDrag(page, plan, moved.id, async () => {
    const first = await dayBlock(plan, '2026-10-14')
      .locator('[data-plan-row-wrap]')
      .first()
      .boundingBox();
    if (first === null) throw new Error('target');
    return first.y + first.height / 4; // upper quarter: above its middle at any line height
  });
  // Painted at once; nothing written until Save changes.
  await expect
    .poll(() => titlesOn(plan, '2026-10-14'))
    .toEqual(['Sweets flatlay', 'Lantern workshop']);
  expect(saves(network)).toEqual([]);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toEqual([]);
  const before = (network.world.tables.plan_items ?? []).find((i) => i.id === moved.id);
  const postBefore = (network.world.tables.posts ?? []).find((p) => p.id === before?.post_id);
  expect(postBefore?.target_date).toBe('2026-10-15T09:00:00Z');

  // Save: one plan_save carrying the one move op (a day change resets the ticks).
  await saveChanges(page, plan);
  expect(saves(network)).toHaveLength(1);
  const ops = opsOf(saves(network)[0]);
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({
    op: 'move',
    item_id: moved.id,
    target_date: '2026-10-14',
    keep_reviews: false,
  });
  expect(saves(network)[0]?.args.p_plan_id).toBe(DATED_PLAN_ID);
  expect(typeof saves(network)[0]?.args.p_trace_id).toBe('string');
  // A post slot moves by its post's date (12:00 in the workspace zone).
  const stored = (network.world.tables.plan_items ?? []).find((i) => i.id === moved.id);
  const movedPost = (network.world.tables.posts ?? []).find((p) => p.id === stored?.post_id);
  expect(movedPost?.target_date).toBe('2026-10-14T12:00:00Z');
  const reviews = (network.world.tables.plan_item_reviews ?? []).filter(
    (r) => r.item_id === moved.id,
  );
  expect(reviews.every((r) => r.status === 'waiting')).toBe(true);
  // The re-read keeps the order; the PLAN line reads not checked.
  await expect
    .poll(() => titlesOn(plan, '2026-10-14'))
    .toEqual(['Sweets flatlay', 'Lantern workshop']);
  const movedPlan = plan.locator(`[data-plan-row-wrap="${moved.id}"] [data-plan-slot]`);
  await expect(movedPlan).toHaveAttribute('data-plan-slot-state', 'pending');
  await expect(movedPlan).toHaveText('Not checked yet');
  expectClean(network);
});

test('agency: Escape mid-drag puts the row back with no write; a reorder within a day is saved once and persists after reload', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  let plan = await openPlan(page, DATED_PLAN_ID);
  expect(await titlesOn(plan, '2026-10-12')).toEqual(['Countdown story', 'Opening offer']);
  await enterEdit(plan);

  // Escape mid-drag: the row goes back, nothing moved, nothing written.
  const offerId = dated('Opening offer').id;
  const wrap = plan.locator(`[data-plan-row-wrap="${offerId}"]`);
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const grip = await wrap.locator('[data-plan-grip]').boundingBox();
  if (grip === null) throw new Error('grip box');
  const gx = grip.x + grip.width / 2;
  const gy = grip.y + grip.height / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx, gy + 6);
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  await page.mouse.move(gx, gy - 30, { steps: 4 });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect(saves(network)).toEqual([]);
  expect(await titlesOn(plan, '2026-10-12')).toEqual(['Countdown story', 'Opening offer']);

  // Drag Opening offer above Countdown story: painted, queued, not written.
  await gripDrag(page, plan, offerId, async () => {
    const first = await dayBlock(plan, '2026-10-12')
      .locator('[data-plan-row-wrap]')
      .first()
      .boundingBox();
    if (first === null) throw new Error('target');
    return first.y + first.height / 4; // upper quarter: above its middle at any line height
  });
  await expect
    .poll(() => titlesOn(plan, '2026-10-12'))
    .toEqual(['Opening offer', 'Countdown story']);
  expect(saves(network)).toEqual([]);

  // Save changes: one plan_save with the one move op (same day: a reorder).
  await saveChanges(page, plan);
  expect(saves(network)).toHaveLength(1);
  const ops = opsOf(saves(network)[0]);
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({ op: 'move', item_id: offerId, target_date: '2026-10-12' });
  expect((ops[0]?.item_ids as string[])[0]).toBe(offerId);

  await page.reload();
  await openChat(page, PEER_NAME);
  plan = await openPlan(page, DATED_PLAN_ID);
  expect(await titlesOn(plan, '2026-10-12')).toEqual(['Opening offer', 'Countdown story']);
  expect(saves(network)).toHaveLength(1);
  expectClean(network);
});

test('agency: Move to another day from the item overflow; Remove from plan is the red button', async ({
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
  await expect(page.getByRole('menuitem', { name: /Edit concept/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /Move to another day/ }).click();
  const days = page.locator('[data-plan-move-sheet]');
  await expect(days.locator('[data-plan-move-day="2026-10-16"]')).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(days.locator('[data-plan-move-day="none"]')).toHaveText('No date');
  await days.locator('[data-plan-move-day="2026-10-13"]').click();
  await expect(page.getByText(/^Moved to Tue 13 Oct\.$/)).toBeVisible();
  await expect
    .poll(
      () => (network.world.tables.plan_items ?? []).find((i) => i.id === target.id)?.target_date,
    )
    .toBe('2026-10-13');

  // The overflow has no Remove row; the screen's red button does it.
  await more.click();
  await expect(page.getByRole('menuitem', { name: /Edit concept/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Remove from plan/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const remove = item.locator('[data-plan-remove]');
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toHaveText(/Remove from plan/);
  expectMinTouchTarget(await remove.boundingBox());
  await remove.click();
  await page.locator('[data-plan-remove-confirm]').click();
  await expect(page.getByText('Removed from plan')).toBeVisible();
  await expect(item).toBeHidden();
  await expect(plan.locator(`[data-plan-row="${target.id}"]`)).toHaveCount(0);
  expect(await titlesOn(plan, '2026-10-13')).toEqual(['Family portraits']);

  // A post item: Move sits in the post view's own sheet; Remove is the button.
  await plan.locator(`[data-plan-row="${dated('Thank you note').id}"]`).click();
  await item.locator('[data-plan-more]').click();
  const postSheet = page.getByRole('dialog', { name: 'Post actions', exact: true });
  await expect(postSheet.getByRole('menuitem', { name: /Move to another day/ })).toBeVisible();
  await expect(postSheet.getByRole('menuitem', { name: /Remove from plan/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(item.locator('[data-plan-remove]')).toHaveText(/Remove from plan/);
  expectClean(network);
});

test('client: same list, no Add, + or Edit, a long press does nothing, no Move or Remove', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: PEER });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  await expect(plan.locator('[data-plan-add], [data-plan-add-header]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-edit], [data-plan-grip]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-row-status]')).toHaveCount(0);

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
  await expect(item.locator('[data-plan-remove]')).toHaveCount(0);
  expectClean(network);
});

test("client: a draft row sits under its post's target_date read in the workspace zone", async ({
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
  // The agency moved it to the plan's fifth day: plan_item_move wrote the
  // post's date (12:00 in the zone). A stale plan_items.target_date (the old
  // day) never places it.
  const start = new Date(`${String(plan.starts_on)}T00:00:00Z`).getTime();
  const planDay = new Date(start + 5 * 24 * 3_600_000).toISOString().slice(0, 10);
  const ownDay = String(post.target_date).slice(0, 10);
  expect(ownDay).not.toBe(planDay);
  hidden.target_date = ownDay;
  post.target_date = `${planDay}T12:00:00Z`;

  await openChat(page, PEER_NAME);
  const list = await openPlan(page, DRAFT_PLAN_ID);
  const draft = dayBlock(list, planDay).locator(`[data-plan-row="${DRAFT_ITEM_ID}"]`);
  await draft.scrollIntoViewIfNeeded();
  await expect(draft).toHaveAttribute('data-plan-row-draft', 'locked');
  await expect(dayBlock(list, ownDay).locator(`[data-plan-row="${DRAFT_ITEM_ID}"]`)).toHaveCount(0);
  expectClean(network);
});
