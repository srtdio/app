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
  PLAN_CONCEPT_ITEM,
  PLAN_ID,
  PLAN_POST_ITEM,
  PLAN_TITLE,
  POST_IDS,
  seedClientPlan,
  seedClientPlanWithDraft,
} from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { swipeStripDown, undoStrip } from '../helpers/undo-strip';

// Plan week list and slot approval: one list grouped by day (empty days read
// "Nothing planned", one date tile per day), a PLAN line per row (the OK | Not
// OK switch while undecided, a solid pill once decided; client side for a
// client, team side for the agency, read-only text for the agency on an Open
// plan), an optimistic OK behind a 4s Undo toast (X3 / FT52: the write goes
// when the strip ends or is swiped away, never after Undo), Not OK opening the item
// with the note box focused, a draft row without a PLAN line for a client, the
// post item's "Slot approved" header and its overflow (the post view's own
// sheet), and the delete confirm naming the plan. Runs in both colour schemes
// (the dark and light projects) on the iPhone viewport.

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

/** Make the viewer a client (the DM peer agency side). */
function viewAsClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
}

/**
 * A1: the row is date tile | title block | thumbnail, then the PLAN and POST
 * lines. The thumbnail (56px) sits 16px from the viewport's right edge; the
 * day's one date tile (56x56) sits left of the rows, its top level with the
 * day's first thumbnail.
 */
async function expectRowLayout(page: Page, itemId: string): Promise<void> {
  const wrap = page.locator(`[data-plan-row-wrap="${itemId}"]`);
  await expect(wrap.locator('[data-plan-line="plan"]')).toHaveCount(1);
  await expect(wrap.locator('[data-plan-line="post"]')).toHaveCount(1);
  const row = await wrap.locator('[data-plan-row]').boundingBox();
  const thumb = await wrap.locator('[data-plan-row-tile]').boundingBox();
  const viewport = page.viewportSize();
  expect(row !== null && thumb !== null && viewport !== null).toBe(true);
  if (row === null || thumb === null || viewport === null) return;
  expect(Math.round(thumb.width)).toBe(56);
  expect(Math.round(viewport.width - (thumb.x + thumb.width))).toBe(16);
  const day = page.locator('[data-plan-day]').filter({ has: wrap });
  await expect(day.locator('[data-plan-day-col]')).toHaveCount(1);
  const col = await day.locator('[data-plan-day-col]').boundingBox();
  expect(col !== null && col.x + col.width <= row.x).toBe(true);
  expect(col?.width).toBe(56);
  expect(col?.height).toBe(56);
  const tile = await day.locator('[data-plan-row-tile]').first().boundingBox();
  if (col !== null && tile !== null) expect(Math.round(col.y)).toBe(Math.round(tile.y));
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

test('client: week list, OK with Undo, counts, slot header, overflow, reopen the switch', async ({
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
  // Date tile on the left: weekday strip over the date number.
  const firstDay = plan.locator('[data-plan-day]').first();
  await expect(firstDay).toHaveAttribute('data-plan-day', '2026-10-12');
  await expect(firstDay.locator('[data-plan-day-weekday]')).toHaveText(/^mon$/i);
  await expect(firstDay.locator('[data-plan-day-number]')).toHaveText('12');
  await expect(plan.locator('[data-plan-day-empty]').first()).toHaveText(
    'Planned posts show up here.',
  );
  expect(await plan.locator('[data-plan-day-empty]').count()).toBeGreaterThan(0);
  await expect(plan.locator('[data-plan-week-header]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-row]')).toHaveCount(2);
  await expect(plan.locator('[data-plan-row-kind]')).toHaveCount(0);
  const progress = plan.locator('[data-plan-screen-progress="plan"]');
  await expect(progress).toContainText('0/2 OK');
  await expect(plan.locator('[data-plan-screen-progress="post"]')).toContainText('0/1 approved');

  // The client's switch writes the client side; no team state anywhere.
  const wrap = plan.locator(`[data-plan-row-wrap="${PLAN_POST_ITEM}"]`);
  const box = wrap.locator('[data-plan-control]');
  const ok = wrap.locator('[data-plan-ok]');
  await expect(box).toHaveAttribute('data-plan-control', 'switch');
  await expect(box).toHaveAttribute('data-plan-slot', 'client');
  await expect(box).toHaveAttribute('data-plan-slot-state', 'pending');
  await expect(ok).toHaveText('OK');
  await expect(wrap.locator('[data-plan-not-ok]')).toHaveText('Not OK');
  await expect(plan.locator('[data-plan-slot="team"]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-pill="team"]')).toHaveCount(0);
  await expect(plan.locator('[role="checkbox"]')).toHaveCount(0);
  expectMinTouchTarget(await ok.boundingBox());
  expectMinTouchTarget(await wrap.locator('[data-plan-not-ok]').boundingBox());
  await expectRowLayout(page, PLAN_POST_ITEM);
  await ok.scrollIntoViewIfNeeded();

  // OK: optimistic, the pill shows, the count moves, the toast offers Undo for
  // 4s. Nothing is written while it counts down (X3 / FT52).
  const reviews = () => network.world.tables.plan_item_reviews ?? [];
  const reviewCalls = () => network.rpcCalls.filter((c) => c.name === 'plan_item_review');
  await ok.click();
  await expect(box).toHaveAttribute('data-plan-control', 'pill');
  await expect(box).toHaveAttribute('data-plan-slot-state', 'approved');
  await expect(box).toHaveText('OK');
  await expect(progress).toContainText('1/2 OK');
  const undo = page.locator('[data-toast-action]');
  await expect(undo).toHaveText('Undo');
  // The fixture's post item has no plan day, so the toast names none.
  await expect(page.getByText(/^Slot approved( · \w{3} \d{1,2} \w{3})?$/)).toBeVisible();
  // The Undo strip at the bottom: label left, Undo its last child; no X and
  // no countdown bar.
  const strip = undoStrip(page, /Slot approved/);
  await expect(strip).toBeVisible();
  await expect(strip.locator('[data-toast-action]')).toHaveText('Undo');
  await expect(strip.getByRole('button', { name: 'Dismiss notification' })).toHaveCount(0);
  await expect(strip.locator('[data-toast-countdown]')).toHaveCount(0);
  expect(
    await strip.evaluate((el) => [...el.children].at(-1)?.hasAttribute('data-toast-action')),
  ).toBe(true);
  expectMinTouchTarget(await undo.boundingBox());
  expect(reviews()).toEqual([]);
  expect(reviewCalls()).toEqual([]);
  // A slot never moves the post's stage.
  const post = (network.world.tables.posts ?? []).find((p) => p.id === POST_IDS[0]);
  const stage = post?.stage;
  expect(stage).not.toBe('approved');

  // Undo: back to the switch, the count back; the write never goes, so nothing
  // to withdraw either.
  await undo.click();
  await expect(box).toHaveAttribute('data-plan-control', 'switch');
  await expect(box).toHaveAttribute('data-plan-slot-state', 'pending');
  await expect(progress).toContainText('0/2 OK');
  await page.waitForTimeout(500);
  expect(reviews()).toEqual([]);
  expect(reviewCalls()).toEqual([]);
  expect(
    (network.world.tables.inbox_entries ?? []).filter(
      (r) => (r.payload as Record<string, unknown> | null)?.withdrawn === true,
    ),
  ).toEqual([]);
  expect(post?.stage).toBe(stage);

  // OK again and swipe the strip down: the swipe accepts, so it commits at
  // once (one write), then the post item's header reads "Slot approved".
  await ok.click();
  await expect(box).toHaveAttribute('data-plan-control', 'pill');
  await swipeStripDown(page, undoStrip(page, /Slot approved/));
  await expect.poll(() => reviews()[0]?.status).toBe('approved');
  expect(reviews()).toEqual([
    expect.objectContaining({ item_id: PLAN_POST_ITEM, side: 'client', status: 'approved' }),
  ]);
  expect(reviewCalls()).toHaveLength(1);
  expect(post?.stage).toBe(stage);
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
  await expect(sheet.getByRole('menuitem', { name: /Open in pipeline/ })).toBeVisible();
  await expect(sheet.getByRole('menuitem', { name: /Send to chat/ })).toBeVisible();
  await expect(sheet.getByRole('menuitem', { name: /Copy link/ })).toBeVisible();
  await expect(sheet.getByRole('menuitem', { name: /Delete post/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // No untick: tapping the pill reopens the switch with OK pressed; nothing
  // is written.
  await page.goBack();
  await expect(item).toBeHidden();
  await expect(box).toHaveAttribute('data-plan-control', 'pill');
  expectMinTouchTarget(await box.boundingBox());
  await box.click();
  await expect(box).toHaveAttribute('data-plan-control', 'switch');
  await expect(ok).toHaveAttribute('aria-pressed', 'true');
  await expect(wrap.locator('[data-plan-not-ok]')).toHaveAttribute('aria-pressed', 'false');
  await expect(progress).toContainText('1/2 OK');
  await expect(page.getByText('Slot approval removed')).toHaveCount(0);
  expect(reviewCalls()).toHaveLength(1);
  expect(reviews()[0]?.status).toBe('approved');
  expectClean(network);
});

test('client: OK shows the pill with Undo; Not OK opens the item with the note box focused', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedClientPlan(network.world, {
    channelId: DM_CHANNEL,
    sender: PEER,
    fileVersionId: FILE_VERSION,
  });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, PLAN_ID);

  // OK on the post row: the pill reads OK and the Undo toast shows.
  const post = plan.locator(`[data-plan-row-wrap="${PLAN_POST_ITEM}"]`);
  await post.locator('[data-plan-ok]').scrollIntoViewIfNeeded();
  await post.locator('[data-plan-ok]').click();
  const pill = post.locator('[data-plan-control="pill"]');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText('OK');
  await expect(pill).toHaveAttribute('data-plan-slot-state', 'approved');
  await expect(page.locator('[data-toast-action]')).toHaveText('Undo');

  // Not OK on the undecided concept row: the item screen opens with the note
  // box open and focused.
  const concept = plan.locator(`[data-plan-row-wrap="${PLAN_CONCEPT_ITEM}"]`);
  await expect(concept.locator('[data-plan-control="switch"]')).toBeVisible();
  await concept.locator('[data-plan-not-ok]').scrollIntoViewIfNeeded();
  await concept.locator('[data-plan-not-ok]').click();
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(page.getByLabel('Comment', { exact: true })).toBeFocused();
  await expect(item.locator('[data-plan-ask-hint]')).toBeVisible();
  await expect(page.getByLabel('Comment', { exact: true })).toHaveAttribute(
    'placeholder',
    'What should change?',
  );
  // Not OK flushed the pending OK first; the changes are written only on Send.
  await expect
    .poll(
      () =>
        (network.world.tables.plan_item_reviews ?? []).find(
          (r) => r.item_id === PLAN_POST_ITEM && r.side === 'client',
        )?.status,
    )
    .toBe('approved');
  expect(
    (network.world.tables.plan_item_reviews ?? []).some((r) => r.item_id === PLAN_CONCEPT_ITEM),
  ).toBe(false);
  expectClean(network);
});

test('agency on an Open plan: read-only client PLAN text, header subtitle, long title, delete with Undo', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: ME, fileVersionId: FILE_VERSION });
  const long = `${PLAN_TITLE} with a much longer name that keeps going past the header width`;
  for (const p of network.world.tables.plans ?? []) if (p.id === PLAN_ID) p.title = long;
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, PLAN_ID);

  // One view: the client side for everyone, read-only text for the agency.
  const box = plan.locator(`[data-plan-row-wrap="${PLAN_POST_ITEM}"] [data-plan-slot]`);
  await expect(box).toHaveAttribute('data-plan-slot', 'client');
  await expect(box).toHaveAttribute('data-plan-control', 'text');
  await expect(box).toHaveAttribute('data-plan-slot-readonly', '');
  await expect(box).toHaveText('Not checked yet');
  await expect(plan.locator('[data-plan-ok]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-control="pill"]')).toHaveCount(0);
  await expectRowLayout(page, PLAN_POST_ITEM);
  await expect(plan.locator('[data-plan-slot="team"]')).toHaveCount(0);
  const row = plan.locator(`[data-plan-row="${PLAN_POST_ITEM}"]`);
  await expect(plan.locator('[data-plan-row-status]')).toHaveCount(0);
  await expect(row.getByText('Approvers · Waiting')).toHaveCount(0);
  await box.click({ force: true });
  await expect(box).toHaveText('Not checked yet');
  await expect(plan.locator('[data-plan-screen-progress="plan"]')).toContainText('0/2 OK');
  expect(network.world.tables.plan_item_reviews ?? []).toEqual([]);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_review')).toEqual([]);
  // The subtitle, the same for every viewer.
  await expect(plan.locator('[data-plan-page-subtitle]')).toHaveText(/ · Shared with approvers$/);

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
    await expect(sheet.getByRole('menuitem', { name })).toBeVisible();
  }
  // Spec B7: Delete post asks nothing; the post deletes behind the Undo strip,
  // and Undo sends nothing.
  await sheet.getByRole('menuitem', { name: /Delete post/ }).click();
  await expect(page.getByRole('dialog', { name: 'Delete post', exact: true })).toHaveCount(0);
  const strip = undoStrip(page, 'Post deleted');
  await expect(strip).toBeVisible();
  await strip.locator('[data-toast-action]').click();
  await expect(strip).toHaveCount(0);
  expectClean(network);
});

test('client: a long plan shows week headers, 44px empty days, and a draft with no PLAN line', async ({
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
  expect((await empty.boundingBox())?.height).toBeCloseTo(44, 2);
  const draft = plan.locator(`[data-plan-row="${DRAFT_ITEM_ID}"]`);
  await draft.scrollIntoViewIfNeeded();
  await expect(draft).toHaveAttribute('aria-disabled', 'true');
  const draftWrap = plan.locator(`[data-plan-row-wrap="${DRAFT_ITEM_ID}"]`);
  await expect(draftWrap).toHaveCount(1);
  await expect(draftWrap.locator('[data-plan-control]')).toHaveCount(0);
  await expect(draftWrap.locator('[data-plan-line]')).toHaveCount(0);
  await expect(draft.locator('[data-plan-slot]')).toHaveCount(0);
  // Today's tile: the weekday strip in the accent, an accent border.
  const today = plan.locator('[data-plan-today] [data-plan-day-weekday]');
  if ((await today.count()) > 0) {
    await expect(today).toHaveClass(/\bbg-accent\b/);
    await expect(today).toHaveClass(/\btext-accent-fg\b/);
    await expect(plan.locator('[data-plan-today]')).toHaveClass(/\bborder-accent\b/);
  }
  expectClean(network);
});

test('client: Undo after OK on a concept with changes asked keeps changes: the write never goes', async ({
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
  const wrap = plan.locator(`[data-plan-row-wrap="${concept.id}"]`);
  const box = wrap.locator('[data-plan-control]');
  await box.scrollIntoViewIfNeeded();
  // Changes asked: the Not OK pill.
  await expect(box).toHaveAttribute('data-plan-control', 'pill');
  await expect(box).toHaveAttribute('data-plan-slot-state', 'changes');
  await expect(box).toHaveText('Not OK');
  const status = () =>
    (network.world.tables.plan_item_reviews ?? []).find(
      (r) => r.item_id === concept.id && r.side === 'client',
    )?.status;
  expect(status()).toBe('changes');
  // Tapping the pill reopens the switch with Not OK pressed; OK from there.
  await box.click();
  await expect(box).toHaveAttribute('data-plan-control', 'switch');
  await expect(wrap.locator('[data-plan-not-ok]')).toHaveAttribute('aria-pressed', 'true');
  await wrap.locator('[data-plan-ok]').click();
  await expect(box).toHaveAttribute('data-plan-control', 'pill');
  await expect(box).toHaveAttribute('data-plan-slot-state', 'approved');
  // The OK waits behind the 4s Undo toast: the review is still "changes".
  expect(status()).toBe('changes');
  await page.locator('[data-toast-action]').click();
  await expect(box).toHaveAttribute('data-plan-slot-state', 'changes');
  await expect(box).toHaveText('Not OK');
  await page.waitForTimeout(500);
  expect(status()).toBe('changes');
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_review')).toEqual([]);
  // A client's row carries the PLAN and POST lines only: no status line.
  await expect(plan.locator(`[data-plan-row="${concept.id}"] [data-plan-row-status]`)).toHaveCount(
    0,
  );
  expectClean(network);
});

/** Rounded box of a locator (throws when it is not laid out). */
async function boxOf(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('no box');
  return box;
}

test('header: agency sees the 28px title, then boxed Add and Edit on line 2 (both work); a client sees no buttons', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: ME, fileVersionId: FILE_VERSION });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, PLAN_ID);
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('viewport');

  // Line 1: back then the title button (28px, chevron); nothing else.
  const line1 = plan.locator('[data-plan-header-line="1"]');
  const line2 = plan.locator('[data-plan-header-line="2"]');
  const title = line1.locator('[data-plan-title-menu] h2');
  await expect(title).toHaveCSS('font-size', '28px');
  await expect(title).toHaveCSS('font-weight', '600');
  await expect(line1.locator('[data-plan-add-header], [data-plan-edit]')).toHaveCount(0);
  const l1 = await boxOf(line1);
  const l2 = await boxOf(line2);
  expect(Math.round(l2.y - (l1.y + l1.height))).toBe(2);
  expect(Math.round(l2.height)).toBe(44);
  expect(Math.round(l2.x)).toBe(16);

  // Line 2: the subline, then Add, then Edit; the last box on the 16px edge.
  await expect(line2.locator('[data-plan-page-subtitle]')).toHaveText(/ · Shared with approvers$/);
  const add = line2.locator('[data-plan-add-header]');
  const edit = line2.locator('[data-plan-edit]');
  await expect(add).toHaveAccessibleName('Add to plan');
  await expect(add).toHaveText('Add');
  await expect(edit).toHaveText('Edit');
  const addBox = await boxOf(add.locator('[data-plan-header-box]'));
  const editBox = await boxOf(edit.locator('[data-plan-header-box]'));
  expect(Math.round(addBox.height)).toBe(34);
  expect(Math.round(editBox.height)).toBe(34);
  expect(Math.round(editBox.x - (addBox.x + addBox.width))).toBe(8);
  expect(Math.round(viewport.width - (editBox.x + editBox.width))).toBe(16);
  expectMinTouchTarget(await add.boundingBox());
  expectMinTouchTarget(await edit.boundingBox());

  // Add opens the add sheet, as the header "+" did.
  await add.click();
  await expect(page.locator('[data-plan-add-sheet]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-plan-add-sheet]')).toHaveCount(0);

  // Edit enters Edit mode with its own header; Cancel leaves it.
  await edit.click();
  await expect(plan.locator('[data-plan-edit-header]')).toBeVisible();
  await plan.locator('[data-plan-back-text]').click();
  await expect(plan.locator('[data-plan-edit-header]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-header-line="2"] [data-plan-edit]')).toBeVisible();
  expectClean(network);
});

test('header: a client sees the title and subline with no Add or Edit', async ({ page }) => {
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

  const title = plan.locator('[data-plan-header-line="1"] h2');
  await expect(title).toHaveText(PLAN_TITLE);
  await expect(title).toHaveCSS('font-size', '28px');
  const line2 = plan.locator('[data-plan-header-line="2"]');
  await expect(line2.locator('[data-plan-page-subtitle]')).toHaveText(/ · Shared with approvers$/);
  await expect(plan.locator('[data-plan-add-header], [data-plan-edit]')).toHaveCount(0);
  expect(Math.round((await boxOf(line2)).height)).toBe(44);
  expectClean(network);
});
