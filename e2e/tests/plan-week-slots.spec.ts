import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DATED_PLAN_ID,
  DATED_PLAN_ITEMS,
  seedDatedPlan,
  DM_CHANNEL,
  DRAFT_ITEM_ID,
  DRAFT_PLAN_ID,
  ME,
  PEER,
  PEER_NAME,
  PLAN_ID,
  PLAN_POST_ITEM,
  PLAN_TITLE,
  POST_IDS,
  seedClientPlan,
  seedClientPlanWithDraft,
} from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Plan week list and slot approval: one list grouped by day (empty days read
// "Nothing planned"), a slot checkbox per row (client side for a client, team
// side for the agency), an optimistic tick with Undo on its toast, a draft
// row without a checkbox for a client, the post item's "Slot approved" header
// and its overflow (the post view's own sheet), the delete confirm naming the
// plan, and the withdrawal in Activity. Runs in both colour schemes (the dark
// and light projects) on the iPhone viewport.

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

/** Make the viewer a client (the DM peer agency side). */
function viewAsClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
}

/**
 * L1-L3: the checkbox is the row's last element, its right edge within 16px
 * of the row's right edge, and the day column sits left of the items.
 */
async function expectRowLayout(page: Page, itemId: string): Promise<void> {
  const wrap = page.locator(`[data-plan-row-wrap="${itemId}"]`);
  const last = await wrap.evaluate((el) => el.lastElementChild?.getAttribute('data-plan-slot'));
  expect(last === 'client' || last === 'team').toBe(true);
  const row = await wrap.boundingBox();
  const box = await wrap.locator('[data-plan-slot]').boundingBox();
  expect(row !== null && box !== null).toBe(true);
  if (row === null || box === null) return;
  expect(row.x + row.width - (box.x + box.width)).toBeLessThanOrEqual(16);
  expect(row.x + row.width - (box.x + box.width)).toBeGreaterThanOrEqual(0);
  const day = page.locator('[data-plan-day]').filter({ has: wrap });
  const col = await day.locator('[data-plan-day-col]').boundingBox();
  expect(col !== null && col.x + col.width <= row.x).toBe(true);
  expect(col?.width).toBe(40);
}

const planPage = (page: Page, id: string) => page.locator(`[data-plan-page="${id}"]`);

async function openPlan(page: Page, planId: string) {
  const card = page.locator(`[data-plan-card="${planId}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-plan-open]').click();
  const plan = planPage(page, 'plan');
  await expect(plan.locator('[data-plan-row]').first()).toBeVisible();
  return plan;
}

test('client: week list, tick with Undo, counts, slot header, overflow, Activity withdrawal', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedClientPlan(network.world, {
    channelId: DM_CHANNEL,
    sender: PEER,
    fileVersionId: FILE_VERSION,
  });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, PLAN_ID);

  // One list by day: every day of the range, empty ones "Nothing planned".
  await expect(plan.locator('[data-plan-tab]')).toHaveCount(0);
  // Day column on the left: weekday over the date number.
  const firstDay = plan.locator('[data-plan-day]').first();
  await expect(firstDay).toHaveAttribute('data-plan-day', '2026-10-12');
  await expect(firstDay.locator('[data-plan-day-weekday]')).toHaveText(/^mon$/i);
  await expect(firstDay.locator('[data-plan-day-number]')).toHaveText('12');
  await expect(plan.locator('[data-plan-day-empty]').first()).toHaveText('Nothing planned');
  expect(await plan.locator('[data-plan-day-empty]').count()).toBeGreaterThan(0);
  await expect(plan.locator('[data-plan-week-header]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-row-kind]')).toHaveCount(2);
  const progress = plan.locator('[data-plan-screen-progress]');
  await expect(progress).toHaveText('0/2 approved');

  // The client box writes the client side; no team state anywhere.
  const box = plan.locator(`[data-plan-row-wrap="${PLAN_POST_ITEM}"] [data-plan-slot]`);
  await expect(box).toHaveAttribute('data-plan-slot', 'client');
  await expect(box).toHaveAttribute('aria-checked', 'false');
  await expect(plan.locator('[data-plan-slot="team"]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-pill="team"]')).toHaveCount(0);
  expectMinTouchTarget(await box.boundingBox());
  await expectRowLayout(page, PLAN_POST_ITEM);
  await box.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, 'slots-01-client-week-list');

  // Tick: optimistic, the count moves, the toast offers Undo.
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await expect(progress).toHaveText('1/2 approved');
  const undo = page.locator('[data-toast-action]');
  await expect(undo).toHaveText('Undo');
  await expect(page.getByText(/^Slot approved · \w{3} \d{1,2} \w{3}$/)).toBeVisible();
  // L5: the success-tinted toast with Undo at its right end.
  const success = page.locator('[data-toast-tone="success"]');
  await expect(success).toBeVisible();
  await expect(success.locator('[data-toast-action]')).toHaveText('Undo');
  expectMinTouchTarget(await undo.boundingBox());
  expect(network.world.tables.plan_item_reviews).toEqual([
    expect.objectContaining({ item_id: PLAN_POST_ITEM, side: 'client', status: 'approved' }),
  ]);
  // A slot never moves the post's stage.
  const post = (network.world.tables.posts ?? []).find((p) => p.id === POST_IDS[0]);
  const stage = post?.stage;
  expect(stage).not.toBe('approved');
  await page.waitForTimeout(300);
  await shot(page, 'slots-02-client-ticked-toast');

  // Undo: back to waiting, the count back, a withdrawal registered.
  await undo.click();
  await expect(box).toHaveAttribute('aria-checked', 'false');
  await expect(progress).toHaveText('0/2 approved');
  await expect
    .poll(() => (network.world.tables.plan_item_reviews ?? [])[0]?.status)
    .toBe('waiting');
  const withdrawals = (network.world.tables.inbox_entries ?? []).filter(
    (r) => (r.payload as Record<string, unknown> | null)?.withdrawn === true,
  );
  expect(withdrawals.length).toBeGreaterThan(0);
  expect(post?.stage).toBe(stage);
  await page.waitForTimeout(300);
  await shot(page, 'slots-03-client-undone');

  // Tick again, then the post item's header reads "Slot approved".
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await plan.locator(`[data-plan-row="${PLAN_POST_ITEM}"]`).click();
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.locator('[data-plan-page-subtitle]')).toHaveText('Slot approved');
  await expect(item.getByText('Fixture caption')).toBeVisible();
  // The overflow is the post view's own sheet: Open in pipeline first, no Delete for a client.
  const more = item.locator('[data-plan-more]');
  expectMinTouchTarget(await more.boundingBox());
  await more.click();
  const sheet = page.getByRole('dialog', { name: 'Post actions', exact: true });
  await expect(sheet.getByRole('button', { name: /Open in pipeline/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Send to chat/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Copy link/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Delete post/ })).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, 'slots-04-client-item-overflow');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Untick from the list: removed (no Undo); the withdrawal is the newest entry.
  await page.goBack();
  await expect(item).toBeHidden();
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Slot approval removed')).toBeVisible();
  await expect(progress).toHaveText('0/2 approved');
  expectClean(network);

  // Activity shows the withdrawal row.
  await page.goto('/activity');
  await expect(page.getByText(/withdrew slot approval/).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await shot(page, 'slots-05-activity-withdrawal');
  expectClean(network);
});

test('agency: team checkbox and client pill, header subtitle, long title, delete confirm names the plan', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: ME, fileVersionId: FILE_VERSION });
  const long = `${PLAN_TITLE} with a much longer name that keeps going past the header width`;
  for (const p of network.world.tables.plans ?? []) if (p.id === PLAN_ID) p.title = long;
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, PLAN_ID);

  const box = plan.locator(`[data-plan-row-wrap="${PLAN_POST_ITEM}"] [data-plan-slot]`);
  await expect(box).toHaveAttribute('data-plan-slot', 'team');
  await expectRowLayout(page, PLAN_POST_ITEM);
  await expect(plan.locator('[data-plan-slot="client"]')).toHaveCount(0);
  const row = plan.locator(`[data-plan-row="${PLAN_POST_ITEM}"]`);
  await expect(row.getByText('Client · Waiting')).toBeVisible();
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await expect(plan.locator('[data-plan-screen-progress]')).toHaveText(
    'Agency 1 of 2 · Client 0 of 2',
  );
  expect(network.world.tables.plan_item_reviews).toEqual([
    expect.objectContaining({ item_id: PLAN_POST_ITEM, side: 'team', status: 'approved' }),
  ]);
  await page.waitForTimeout(300);
  await shot(page, 'slots-06-agency-team-ticked');

  // The post item: client side on a client plan reads pending.
  await row.click();
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.locator('[data-plan-page-subtitle]')).toHaveText('Slot pending');
  // The title column never runs under the overflow button.
  const titles = await item.locator('[data-plan-page-titles]').boundingBox();
  const more = await item.locator('[data-plan-more]').boundingBox();
  expect(titles !== null && more !== null).toBe(true);
  if (titles !== null && more !== null) expect(titles.x + titles.width).toBeLessThanOrEqual(more.x);

  await item.locator('[data-plan-more]').click();
  const sheet = page.getByRole('dialog', { name: 'Post actions', exact: true });
  for (const name of [/Open in pipeline/, /Send to chat/, /Copy link/, /Delete post/]) {
    await expect(sheet.getByRole('button', { name })).toBeVisible();
  }
  await page.waitForTimeout(300);
  await shot(page, 'slots-07-agency-overflow');
  await sheet.getByRole('button', { name: /Delete post/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete post', exact: true });
  await expect(confirm.locator('[data-post-delete-text]')).toHaveText(
    `Delete this post? This cannot be undone. It's in ${long} and will leave that plan.`,
  );
  await page.waitForTimeout(300);
  await shot(page, 'slots-08-agency-delete-confirm');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press('Escape');
  expectClean(network);
});

test('client: a long plan shows week headers, 36px empty days, and a draft with no checkbox', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedClientPlanWithDraft(network.world, { channelId: DM_CHANNEL, sender: PEER });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DRAFT_PLAN_ID);
  await expect(plan.locator('[data-plan-week-header]').first()).toHaveText(
    /^Week of \d{1,2} \w{3}$/,
  );
  expect(await plan.locator('[data-plan-week-header]').count()).toBeGreaterThan(1);
  const empty = plan.locator('[data-plan-day-empty]').first();
  expect((await empty.boundingBox())?.height).toBe(36);
  const draft = plan.locator(`[data-plan-row="${DRAFT_ITEM_ID}"]`);
  await draft.scrollIntoViewIfNeeded();
  await expect(draft).toHaveAttribute('aria-disabled', 'true');
  await expect(plan.locator(`[data-plan-row-wrap="${DRAFT_ITEM_ID}"]`)).toHaveCount(0);
  await expect(draft.locator('[data-plan-slot]')).toHaveCount(0);
  // Today's weekday is in the accent.
  const today = plan.locator('[data-plan-today] [data-plan-day-weekday]');
  if ((await today.count()) > 0) await expect(today).toHaveClass(/text-accent/);
  await page.waitForTimeout(300);
  await shot(page, 'slots-09-client-long-plan-draft');
  expectClean(network);
});

test('client: Undo after ticking a concept with changes asked restores changes', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: PEER });
  const concept = DATED_PLAN_ITEMS.find((it) => it.kind === 'concept' && it.client === 'changes');
  if (concept === undefined) throw new Error('fixture');
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  const box = plan.locator(`[data-plan-row-wrap="${concept.id}"] [data-plan-slot]`);
  await box.scrollIntoViewIfNeeded();
  await expect(box).toHaveAttribute('aria-checked', 'false');
  const status = () =>
    (network.world.tables.plan_item_reviews ?? []).find(
      (r) => r.item_id === concept.id && r.side === 'client',
    )?.status;
  expect(status()).toBe('changes');
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await expect.poll(status).toBe('approved');
  await page.locator('[data-toast-action]').click();
  await expect(box).toHaveAttribute('aria-checked', 'false');
  await expect.poll(status).toBe('changes');
  await expect(
    plan.locator(`[data-plan-row="${concept.id}"] [data-plan-pill="client"]`),
  ).toHaveText('Changes asked');
  await page.waitForTimeout(300);
  await shot(page, 'slots-10-client-undo-restores-changes');
  expectClean(network);
});
