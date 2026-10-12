import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DATED_PLAN_ID,
  DATED_PLAN_ITEMS,
  DATED_PLAN_TITLE,
  DM_CHANNEL,
  ME,
  PEER,
  PEER_NAME,
  WORKSPACE_ID,
  seedDatedPlan,
} from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Draft / Open wave, screens: the Plan screen's title menu (Rename inline,
// Delete plan for its creator or an owner/admin), the deleted card, "Approved
// by" under a client-approved row, the "Also in" pill, the keep-approval sheet
// on a move, and the plan alerts as chat bell rows. Every new element is shot
// in both colour schemes (the dark and light projects) on the iPhone viewport.

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

async function openPlan(page: Page, planId: string): Promise<Locator> {
  const card = page.locator(`[data-plan-card="${planId}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-plan-open]').click();
  const plan = page.locator('[data-plan-page="plan"]');
  await expect(plan.locator('[data-plan-day]').first()).toBeVisible();
  return plan;
}

const dated = (title: string) => {
  const it = DATED_PLAN_ITEMS.find((i) => i.title === title);
  if (it === undefined) throw new Error(`fixture: ${title}`);
  return it;
};

const dayBlock = (plan: Locator, day: string): Locator => plan.locator(`[data-plan-day="${day}"]`);

/** Long-press a row and let go over the first row of `day`. */
async function dragToDay(page: Page, plan: Locator, row: Locator, day: string): Promise<void> {
  // Any sheet that just closed has finished sliding away.
  await page.waitForTimeout(500);
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await row.boundingBox();
  if (box === null) throw new Error('row box');
  const x = box.x + 80;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  // Re-aim until the target day is the hovered drop (the slot shifts rows).
  const over = plan.locator(`[data-plan-day="${day}"][data-plan-drop-over]`);
  for (let k = 0; k < 6 && (await over.count()) === 0; k += 1) {
    const target = await dayBlock(plan, day).boundingBox();
    if (target === null) throw new Error('target');
    await page.mouse.move(x, target.y + Math.min(30, target.height / 2), { steps: 4 });
    await page.waitForTimeout(150);
  }
  await expect(over).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
}

test('agency: title menu, inline rename, delete (Open plan copy), the card reads Plan deleted', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);

  // The title is a button with a chevron; the subtitle names the audience.
  const title = plan.locator('[data-plan-title-menu]');
  await expect(title).toContainText(DATED_PLAN_TITLE);
  expectMinTouchTarget(await title.boundingBox());
  await expect(plan.locator('[data-plan-page-subtitle]')).toHaveText(/ · Shared with client$/);
  await title.click();
  const menu = plan.locator('[data-plan-header-menu]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Delete plan']);
  await expect(menu.locator('[data-plan-menu-delete]')).toHaveClass(/text-bad/);
  for (const row of await menu.getByRole('menuitem').all()) {
    expectMinTouchTarget(await row.boundingBox());
  }
  // Anchored under the header.
  const header = await plan.locator('header').boundingBox();
  const menuBox = await menu.boundingBox();
  if (header === null || menuBox === null) throw new Error('boxes');
  expect(menuBox.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  await page.waitForTimeout(300);
  await shot(page, 'draft-open-01-title-menu');

  // Rename: the title turns into a field with Cancel (X) and Done.
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const field = plan.locator('[data-plan-rename-input]');
  await expect(field).toHaveValue(DATED_PLAN_TITLE);
  for (const sel of ['[data-plan-rename-cancel]', '[data-plan-rename-done]']) {
    expectMinTouchTarget(await plan.locator(sel).boundingBox());
  }
  await field.fill('   ');
  await expect(plan.locator('[data-plan-rename-done]')).toBeDisabled();
  await field.fill('  Festive fortnight v2  ');
  await page.waitForTimeout(300);
  await shot(page, 'draft-open-02-inline-rename');
  await plan.locator('[data-plan-rename-done]').click();
  await expect(page.getByText('Renamed', { exact: true })).toBeVisible();
  await expect(title).toContainText('Festive fortnight v2');
  const update = network.rpcCalls.find((c) => c.name === 'plan_update');
  expect(update?.args).toMatchObject({
    p_plan_id: DATED_PLAN_ID,
    p_title: 'Festive fortnight v2',
    p_starts_on: '2026-10-12',
    p_ends_on: '2026-10-18',
  });
  expect(typeof update?.args.p_trace_id).toBe('string');

  // Delete: the confirm, Open plan copy, then the card reads "Plan deleted".
  await title.click();
  await plan.locator('[data-plan-menu-delete]').click();
  const confirm = page.getByRole('dialog', { name: 'Delete this plan?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(
    'Cards already in chat will show Plan deleted. Client gets a notification. This cannot be undone.',
  );
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'draft-open-03-delete-confirm');
  await confirm.locator('[data-plan-confirm]').click();
  await expect(page.getByText('Plan deleted', { exact: true }).first()).toBeVisible();
  await expect(plan).toBeHidden();
  const card = page.locator('[data-plan-card="unavailable"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveText('Plan deleted');
  await page.waitForTimeout(300);
  await shot(page, 'draft-open-04-card-deleted');
  expectClean(network);
});

test('agency: not the creator nor an owner/admin: the menu has Rename only', async ({ page }) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: PEER });
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'agency';
  }
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  await plan.locator('[data-plan-title-menu]').click();
  await expect(plan.locator('[data-plan-header-menu]').getByRole('menuitem')).toHaveText([
    'Rename',
  ]);
  await page.keyboard.press('Escape');
  await expect(plan.locator('[data-plan-header-menu]')).toHaveCount(0);
  expectClean(network);
});

test('Open plan: Approved by under a client-approved row, Also in, and keep the approval on a move', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  const t = network.world.tables;
  const offer = dated('Opening offer');
  const offerItem = (t.plan_items ?? []).find((i) => i.id === offer.id);
  if (offerItem === undefined) throw new Error('fixture');
  // The client approved the slot (the name comes from the account).
  (t.plan_item_reviews ??= []).push({
    item_id: offer.id,
    workspace_id: WORKSPACE_ID,
    side: 'client',
    status: 'approved',
    reviewed_by: PEER,
    reviewed_at: '2026-10-09T13:15:00Z',
  });
  // The same post sits in another live plan the viewer can read.
  const otherId = '0190d700-0000-7000-8000-000000000099';
  (t.plans ??= []).push({
    ...(t.plans?.find((p) => p.id === DATED_PLAN_ID) ?? {}),
    id: otherId,
    title: 'Launch week',
  });
  (t.plan_items ??= []).push({
    ...offerItem,
    id: '0190d700-0000-7000-8000-0000000000a1',
    plan_id: otherId,
    workspace_id: WORKSPACE_ID,
  });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);

  const wrap = plan.locator(`[data-plan-row-wrap="${offer.id}"]`);
  await wrap.scrollIntoViewIfNeeded();
  const approved = wrap.locator('[data-plan-row-approved-by]');
  await expect(approved).toHaveText(`Approved by ${PEER_NAME} · 9 Oct, 1:15 pm`);
  await expect(approved).toHaveClass(/text-good/);
  const also = wrap.locator('[data-plan-row-also-in]');
  await expect(also).toHaveText('Also in Launch week');
  await expect(also).toHaveClass(/bg-warn-soft/);
  // The agency sees the client's tick, read-only.
  await expect(wrap.locator('[data-plan-slot="client"]')).toHaveAttribute('aria-checked', 'true');
  await expect(wrap.locator('[data-plan-slot="client"]')).toBeDisabled();
  await page.waitForTimeout(300);
  await shot(page, 'draft-open-05-approved-by-also-in');

  // Moving the approved slot to another day asks first; cancelling cancels.
  const row = plan.locator(`[data-plan-row="${offer.id}"]`);
  const moves = () => network.rpcCalls.filter((c) => c.name === 'plan_item_move');
  await dragToDay(page, plan, row, '2026-10-14');
  const keep = page.getByRole('dialog', { name: `Slot approved by ${PEER_NAME}` });
  await expect(keep).toBeVisible();
  await expect(keep).toContainText('Moving it to Wed 14 Oct. Keep the approval?');
  for (const sel of ['[data-plan-keep-yes]', '[data-plan-keep-no]']) {
    expectMinTouchTarget(await keep.locator(sel).boundingBox());
  }
  await page.waitForTimeout(300);
  await shot(page, 'draft-open-06-keep-approval-sheet');
  await page.keyboard.press('Escape');
  await expect(keep).toBeHidden();
  expect(moves()).toEqual([]);
  await expect(dayBlock(plan, '2026-10-12').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );

  // Yes, keep it: p_keep_reviews true, the approval stays.
  await dragToDay(page, plan, row, '2026-10-14');
  await expect(keep).toBeVisible();
  await keep.locator('[data-plan-keep-yes]').click();
  await expect(page.getByText(/^Moved to Wed 14 Oct\.$/)).toBeVisible();
  expect(moves().map((c) => c.args.p_keep_reviews)).toEqual([true]);
  await expect(dayBlock(plan, '2026-10-14').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );
  await expect(
    plan.locator(`[data-plan-row-wrap="${offer.id}"] [data-plan-slot="client"]`),
  ).toHaveAttribute('aria-checked', 'true');

  // No, ask again: p_keep_reviews false, the approval resets.
  await dragToDay(page, plan, row, '2026-10-15');
  await expect(keep).toBeVisible();
  await keep.locator('[data-plan-keep-no]').click();
  await expect(page.getByText('Moved to Thu 15 Oct. Its ticks were reset.')).toBeVisible();
  expect(moves().map((c) => c.args.p_keep_reviews)).toEqual([true, false]);
  await expect(
    plan.locator(`[data-plan-row-wrap="${offer.id}"] [data-plan-slot="client"]`),
  ).toHaveAttribute('aria-checked', 'false');
  expectClean(network);
});

test('the chat bell: plan alerts as bell rows; a deleted plan only toasts; a tap opens the plan', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  const row = (id: string, eventType: string, payload: Record<string, unknown>, agoMs: number) => ({
    id,
    user_id: ME,
    actor_user_id: PEER,
    workspace_id: WORKSPACE_ID,
    event_type: eventType,
    entity_type: 'plan',
    entity_id: DATED_PLAN_ID,
    scope: 'posts',
    scope_key: DATED_PLAN_ID,
    tier: 'active',
    payload: { plan_id: DATED_PLAN_ID, plan_title: DATED_PLAN_TITLE, ...payload },
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: new Date(Date.now() - agoMs).toISOString(),
  });
  const concept = dated('Lamp lighting reel');
  (network.world.tables.inbox_entries ??= []).push(
    row('0190d800-0000-7000-8000-000000000001', 'plan_opened', {}, 60_000),
    row('0190d800-0000-7000-8000-000000000002', 'plan_deleted', {}, 120_000),
    row(
      '0190d800-0000-7000-8000-000000000003',
      'plan_date_changed',
      { item_id: concept.id, from: '2026-10-18', to: '2026-10-16', left_plan: false },
      180_000,
    ),
    row(
      '0190d800-0000-7000-8000-000000000004',
      'plan_updated',
      { kind: 'renamed', from: 'Old name', to: DATED_PLAN_TITLE },
      240_000,
    ),
  );
  await page.goto('/chat');
  const bell = page.locator('[data-bell-button]');
  await bell.waitFor({ state: 'visible', timeout: 15_000 });
  await bell.click();
  await page.locator('[data-bell-skeleton]').waitFor({ state: 'detached' });
  const section = page.locator('[data-bell-section="plans"]');
  await expect(section).toBeVisible();
  await expect(section.locator('[data-bell-row="plan"]')).toHaveCount(4);
  const line = (event: string) => section.locator(`[data-bell-plan="${event}"]`);
  await expect(line('plan_opened')).toContainText(
    `${PEER_NAME} opened ${DATED_PLAN_TITLE} for client`,
  );
  await expect(line('plan_deleted')).toContainText(`${PEER_NAME} deleted ${DATED_PLAN_TITLE}`);
  await expect(line('plan_date_changed')).toContainText('Lamp lighting reel moved to Fri 16 Oct');
  await expect(line('plan_updated')).toContainText(
    `${PEER_NAME} renamed Old name to ${DATED_PLAN_TITLE}`,
  );
  for (const open of await section.locator('[data-bell-open]').all()) {
    expectMinTouchTarget(await open.boundingBox());
  }
  await page.waitForTimeout(300);
  await shot(page, 'draft-open-07-bell-plan-rows');

  // A deleted plan's row opens nothing: it toasts and is marked read.
  await line('plan_deleted').locator('[data-bell-open]').click();
  await expect(page.getByText('This plan was deleted')).toBeVisible();
  await expect(page).toHaveURL(/\/chat/);
  await expect(line('plan_deleted')).toHaveCount(0);

  // A date change opens the plan at the item.
  await line('plan_date_changed').locator('[data-bell-open]').click();
  await expect(page).toHaveURL(new RegExp(`/plans/${DATED_PLAN_ID}\\?item=${concept.id}$`));
  await expect(page.locator('[data-plan-page="item"]')).toBeVisible();
  expect(network.rpcCalls.filter((c) => c.name === 'inbox_mark_read')).toHaveLength(2);
  expectClean(network);
});

// ---------------------------------------------------------------------------
// Plan list: swipe left to remove (agency), the one-time peek, open at today
// ---------------------------------------------------------------------------

const PEEK_KEY = 'sorted:plan-swipe-peek-seen';

/** Drag a row's content left (or right) with the pointer, no long-press. */
async function swipeRow(page: Page, row: Locator, dx: number, dy = 0): Promise<void> {
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await row.boundingBox();
  if (box === null) throw new Error('row box');
  const x = dx < 0 ? box.x + box.width - 60 : box.x + 120;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

const removes = (network: HarnessNetwork) =>
  network.rpcCalls.filter((c) => c.name === 'plan_item_remove');

test('agency: swipe left to Remove, Undo restores with no request, expiry sends once; drag still reorders', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  const lantern = dated('Lantern workshop');
  const portraits = dated('Family portraits');
  const row = plan.locator(`[data-plan-row-swipe="${lantern.id}"]`);
  const action = plan.locator(`[data-plan-row-remove="${lantern.id}"]`);

  // A vertical drag never opens the row.
  await swipeRow(page, row, -12, 60);
  await expect(plan.locator('[data-plan-row-open]')).toHaveCount(0);
  // A short swipe springs back.
  await swipeRow(page, row, -30);
  await expect(plan.locator('[data-plan-row-open]')).toHaveCount(0);

  // Past half the action: it stays open, 88px wide, full row height, red.
  await swipeRow(page, row, -70);
  await expect(row).toHaveAttribute('data-plan-row-open', '');
  await expect(action).toBeVisible();
  const actionBox = await action.boundingBox();
  const rowBox = await row.boundingBox();
  if (actionBox === null || rowBox === null) throw new Error('boxes');
  expect(Math.round(actionBox.width)).toBe(88);
  expect(Math.abs(actionBox.height - rowBox.height)).toBeLessThan(1);
  expectMinTouchTarget(actionBox);
  await expect(action).toHaveClass(/bg-bad/);
  await expect(action).toHaveText('Remove');
  await shot(page, 'swipe-01-open-action');

  // Opening another row closes the first: one open row at a time.
  const other = plan.locator(`[data-plan-row-swipe="${portraits.id}"]`);
  await swipeRow(page, other, -70);
  await expect(other).toHaveAttribute('data-plan-row-open', '');
  await expect(plan.locator('[data-plan-row-open]')).toHaveCount(1);
  // A swipe right closes it; a tap elsewhere closes; a tap on the open row opens nothing.
  await swipeRow(page, other, 70);
  await expect(plan.locator('[data-plan-row-open]')).toHaveCount(0);
  await swipeRow(page, row, -70);
  await plan.locator('[data-plan-progress-block]').click({ force: true });
  await expect(plan.locator('[data-plan-row-open]')).toHaveCount(0);
  await swipeRow(page, row, -70);
  await row.locator(`[data-plan-row="${lantern.id}"]`).click();
  await expect(plan.locator('[data-plan-row-open]')).toHaveCount(0);
  await expect(page.locator('[data-plan-page="item"]')).toHaveCount(0);

  // Remove: the row collapses and is hidden at once; nothing is sent yet.
  await swipeRow(page, row, -70);
  await action.click();
  await expect(plan.locator(`[data-plan-row-wrap="${lantern.id}"]`)).toHaveCount(0);
  const toast = page.getByText('Removed from plan', { exact: true });
  await expect(toast).toBeVisible();
  expect(removes(network)).toEqual([]);
  // Undo: the row is back in place, no request ever.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(dayBlock(plan, '2026-10-14').locator(`[data-plan-row="${lantern.id}"]`)).toHaveCount(
    1,
  );
  await page.waitForTimeout(5_500);
  expect(removes(network)).toEqual([]);

  // Remove again and let the toast expire: exactly one plan_item_remove.
  await swipeRow(page, row, -70);
  await action.click();
  await expect(plan.locator(`[data-plan-row-wrap="${lantern.id}"]`)).toHaveCount(0);
  await expect.poll(() => removes(network).length, { timeout: 8_000 }).toBe(1);
  expect(removes(network)[0]?.args).toMatchObject({ p_item_id: lantern.id });
  expect(typeof removes(network)[0]?.args.p_trace_id).toBe('string');
  await page.waitForTimeout(1_000);
  // Never reappears after the re-read; never sent twice.
  await expect(plan.locator(`[data-plan-row-wrap="${lantern.id}"]`)).toHaveCount(0);
  expect(removes(network)).toHaveLength(1);

  // The long-press drag still reorders, with the full order minus the removed row.
  const moves = () => network.rpcCalls.filter((c) => c.name === 'plan_item_move');
  await dragToDay(page, plan, plan.locator(`[data-plan-row="${portraits.id}"]`), '2026-10-16');
  await expect(
    dayBlock(plan, '2026-10-16').locator(`[data-plan-row="${portraits.id}"]`),
  ).toHaveCount(1);
  expect(moves()).toHaveLength(1);
  const order = moves()[0]?.args.p_item_ids as string[];
  expect(order).toHaveLength(DATED_PLAN_ITEMS.length - 1);
  expect(order).not.toContain(lantern.id);
  expectClean(network);
});

test('agency: a removal waiting on Undo is sent at once when the screen closes', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  const lantern = dated('Lantern workshop');
  await swipeRow(page, plan.locator(`[data-plan-row-swipe="${lantern.id}"]`), -70);
  await plan.locator(`[data-plan-row-remove="${lantern.id}"]`).click();
  expect(removes(network)).toEqual([]);
  await plan.getByRole('button', { name: 'Back' }).first().click();
  await expect.poll(() => removes(network).length).toBe(1);
  await page.waitForTimeout(6_000);
  expect(removes(network)).toHaveLength(1);
  expectClean(network);
});

test('client: no swipe, no Remove on plan rows', async ({ page }) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page, { planSwipePeek: true });
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: PEER });
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
  }
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  await expect(plan.locator('[data-plan-row]').first()).toBeVisible();
  await expect(plan.locator('[data-plan-row-swipe]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-row-remove]')).toHaveCount(0);
  // No peek for clients either: the device stays unmarked.
  await page.waitForTimeout(2_000);
  expect(await page.evaluate((k) => window.localStorage.getItem(k), PEEK_KEY)).toBeNull();
  expectClean(network);
});

test('agency: the one-time peek slides the first visible row, once per device', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page, { planSwipePeek: true });
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  const peeking = plan.locator('[data-plan-row-swipe][style*="translateX(-72px)"]');
  await expect(peeking).toHaveCount(1, { timeout: 3_000 });
  await page.waitForTimeout(250);
  await shot(page, 'swipe-02-peek');
  // Back at rest, and the device is marked.
  await expect(peeking).toHaveCount(0, { timeout: 3_000 });
  await expect(
    plan.locator('[data-plan-row-swipe][style*="translateX(0px)"]').first(),
  ).toBeVisible();
  expect(await page.evaluate((k) => window.localStorage.getItem(k), PEEK_KEY)).toBe('1');
  // Close and reopen: never again.
  await plan.getByRole('button', { name: 'Back' }).first().click();
  await expect(plan).toBeHidden();
  await openPlan(page, DATED_PLAN_ID);
  await page.waitForTimeout(2_000);
  await expect(plan.locator('[data-plan-row-swipe]:not([style*="translateX(0px)"])')).toHaveCount(
    0,
  );
  expectClean(network);
});

test('agency, reduced motion: the tip toast instead of the peek, once', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const network = await installHarnessNetwork(page, { planSwipePeek: true });
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  await expect(page.getByText('Tip: swipe left on a slot to remove it')).toBeVisible({
    timeout: 3_000,
  });
  await expect(plan.locator('[data-plan-row-swipe]:not([style*="translateX(0px)"])')).toHaveCount(
    0,
  );
  expect(await page.evaluate((k) => window.localStorage.getItem(k), PEEK_KEY)).toBe('1');
  expectClean(network);
});

/** "YYYY-MM-DD" moved by `days` (UTC, the fixture workspace's zone). */
function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Move the dated plan (12 to 18 Oct), its items and its posts so that
 * `anchor` (a day of the fixture) falls on the real today: the session stays
 * valid (no fake clock) and the plan's "today" is known.
 */
function anchorDatedPlan(network: HarnessNetwork, anchor: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000,
  );
  const t = network.world.tables;
  for (const p of t.plans ?? []) {
    if (p.id !== DATED_PLAN_ID) continue;
    p.starts_on = shiftDay(String(p.starts_on), days);
    p.ends_on = shiftDay(String(p.ends_on), days);
  }
  for (const i of t.plan_items ?? []) {
    if (i.plan_id === DATED_PLAN_ID && typeof i.target_date === 'string') {
      i.target_date = shiftDay(i.target_date, days);
    }
  }
  const posts = new Set((t.plan_items ?? []).map((i) => i.post_id));
  for (const post of t.posts ?? []) {
    if (posts.has(post.id) && typeof post.target_date === 'string') {
      post.target_date = `${shiftDay(post.target_date.slice(0, 10), days)}T09:00:00Z`;
    }
  }
  return today;
}

test('a plan holding today opens with today at the top, no jump; earlier days above', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  // Today is the plan's fourth day (15 Oct in the fixture).
  const today = anchorDatedPlan(network, '2026-10-15');
  await openChat(page, PEER_NAME);
  // Every frame from the list's first paint: the scroll position never moves.
  await page.evaluate(() => {
    const samples: number[] = [];
    (window as unknown as { __planScroll: number[] }).__planScroll = samples;
    const tick = (): void => {
      const list = document.querySelector('[data-plan-page="plan"] [data-plan-list]');
      const body = list?.closest<HTMLElement>('.overflow-y-auto');
      if (body != null) samples.push(body.scrollTop);
      if (samples.length < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const plan = await openPlan(page, DATED_PLAN_ID);
  await expect(plan.locator('[data-plan-today]')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __planScroll: number[] }).__planScroll.length),
    )
    .toBeGreaterThanOrEqual(40);
  const samples = await page.evaluate(
    () => (window as unknown as { __planScroll: number[] }).__planScroll,
  );
  expect(samples[0]).toBeGreaterThan(0);
  expect(new Set(samples).size).toBe(1);
  const gap = await dayBlock(plan, today).evaluate((el) => {
    const body = el.closest<HTMLElement>('.overflow-y-auto');
    if (body === null) throw new Error('body');
    return el.getBoundingClientRect().top - body.getBoundingClientRect().top;
  });
  // Directly at the top (scrollTop is whole pixels; WebKit rounds layout to 1px).
  expect(Math.abs(gap)).toBeLessThanOrEqual(1);
  await expect(dayBlock(plan, today).locator('[data-plan-today]')).toHaveCount(1);
  await shot(page, 'today-01-open-at-today');
  // Earlier days are still there, above.
  const first = dayBlock(plan, shiftDay(today, -3));
  await expect(first).not.toBeInViewport();
  await first.scrollIntoViewIfNeeded();
  await expect(first).toBeVisible();
  expectClean(network);
});

test('today outside the plan: opens at the top', async ({ page }) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  // The plan ended a week ago.
  anchorDatedPlan(network, '2026-10-25');
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  await page.waitForTimeout(500);
  const top = await plan
    .locator('[data-plan-list]')
    .evaluate((el) => el.closest<HTMLElement>('.overflow-y-auto')?.scrollTop ?? -1);
  expect(top).toBe(0);
  expectClean(network);
});
