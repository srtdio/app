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
  lengthenDatedTitles,
  seedDatedPlan,
} from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Draft / Open wave, screens: the Plan screen's title menu (Rename inline,
// Delete plan for its creator or an owner/admin), the deleted card, "Approved
// by" under a client-approved row, the "Also in" pill, the keep-approval sheet
// on a move (Edit mode, X3: moves and removes are queued and written by Save
// changes as one plan_save), and the plan alerts as chat bell rows, on the
// iPhone viewport. The 120+ character titles test is the plan family's @theme
// test (light too).

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

/** Cancel (the edit header's back) with queued changes: the Discard confirm. */
async function cancelEdit(page: Page, plan: Locator): Promise<Locator> {
  await plan.locator('[data-plan-back-text]').click();
  const discard = page.getByRole('alertdialog', { name: 'Discard changes?' });
  await expect(discard).toBeVisible();
  await expect(discard).toContainText('Your edits to this plan will be lost.');
  return discard;
}

const saves = (network: HarnessNetwork) => network.rpcCalls.filter((c) => c.name === 'plan_save');
const opsOf = (call: { args: Record<string, unknown> } | undefined) =>
  (call?.args.p_ops ?? []) as Array<Record<string, unknown>>;

/** Edit mode: lift a row by its grip (4px, no long-press) and let go over `day`. */
async function dragToDay(page: Page, plan: Locator, id: string, day: string): Promise<void> {
  // Any sheet that just closed has finished sliding away.
  await page.waitForTimeout(500);
  const wrap = plan.locator(`[data-plan-row-wrap="${id}"]`);
  // The source row sits near the top of the list (every move here goes to a
  // later day), clear of the auto-scroll edge band, so the target day is on
  // screen below it.
  await wrap.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    el.closest<HTMLElement>('.overflow-y-auto')?.scrollBy(0, -90);
  });
  await page.waitForTimeout(100);
  const grip = await wrap.locator('[data-plan-grip]').boundingBox();
  if (grip === null) throw new Error('grip box');
  const x = grip.x + grip.width / 2;
  const y0 = grip.y + grip.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 + 6);
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  // Re-aim until the target day is the hovered drop (the slot shifts rows).
  // The pointer stays out of the list's auto-scroll bands (56px at each
  // edge): a target beyond them is brought into reach by scrolling the list.
  const over = plan.locator(`[data-plan-day="${day}"][data-plan-drop-over]`);
  const list = plan.locator('[data-plan-list]');
  for (let k = 0; k < 10 && (await over.count()) === 0; k += 1) {
    const target = await dayBlock(plan, day).boundingBox();
    if (target === null) throw new Error('target');
    const band = await list.evaluate((el) => {
      const box = el.closest<HTMLElement>('.overflow-y-auto')?.getBoundingClientRect();
      if (box === undefined) throw new Error('list body');
      return { top: box.top + 72, bottom: box.bottom - 72 };
    });
    const y = target.y + Math.min(30, target.height / 2);
    if (y > band.bottom || y < band.top) {
      const delta = y > band.bottom ? y - band.bottom : y - band.top;
      await list.evaluate(
        (el, d) => el.closest<HTMLElement>('.overflow-y-auto')?.scrollBy(0, d),
        delta,
      );
      await page.waitForTimeout(120);
      continue;
    }
    await page.mouse.move(x, y, { steps: 4 });
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
  await expect(plan.locator('[data-plan-page-subtitle]')).toHaveText(/ · Shared with approvers$/);
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
    'Cards already in chat will show Plan deleted. Approvers get a notification. This cannot be undone.',
  );
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await confirm.locator('[data-plan-confirm]').click();
  await expect(page.getByText('Plan deleted', { exact: true }).first()).toBeVisible();
  await expect(plan).toBeHidden();
  const card = page.locator('[data-plan-card="unavailable"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveText('Plan deleted');
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

test('Open plan: the client OK on a client-approved row, Also in, and keep the approval on a move', async ({
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
  // No Approved by line on the row any more: the PLAN line reads OK.
  await expect(wrap.locator('[data-plan-row-approved-by]')).toHaveCount(0);
  const also = wrap.locator('[data-plan-row-also-in]');
  await expect(also).toHaveText('Also in Launch week');
  await expect(also).toHaveClass(/bg-warn-soft/);
  // The agency sees the client's answer as read-only text.
  const clientPlan = wrap.locator('[data-plan-slot="client"]');
  await expect(clientPlan).toHaveAttribute('data-plan-control', 'text');
  await expect(clientPlan).toHaveAttribute('data-plan-slot-state', 'approved');
  await expect(clientPlan).toHaveText('OK');
  await expect(clientPlan).toHaveClass(/text-good/);

  // Moving the approved slot to another day (Edit mode) asks first; cancelling
  // cancels. Nothing is written until Save changes.
  const moves = () => network.rpcCalls.filter((c) => c.name === 'plan_item_move');
  await enterEdit(plan);
  // The edit row keeps PLAN as text.
  await expect(clientPlan).toHaveText('OK');
  await expect(wrap.locator('[data-plan-row-edit-line]')).toBeVisible();
  await dragToDay(page, plan, offer.id, '2026-10-14');
  const keep = page.getByRole('dialog', { name: `Slot approved by ${PEER_NAME}` });
  await expect(keep).toBeVisible();
  await expect(keep).toContainText('Moving it to Wed 14 Oct. Keep the approval?');
  for (const sel of ['[data-plan-keep-yes]', '[data-plan-keep-no]']) {
    expectMinTouchTarget(await keep.locator(sel).boundingBox());
  }
  await page.keyboard.press('Escape');
  await expect(keep).toBeHidden();
  expect(saves(network)).toEqual([]);
  expect(moves()).toEqual([]);
  await expect(dayBlock(plan, '2026-10-12').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );

  // Yes, keep it: the move is queued with keep_reviews true and painted; Save
  // writes it as one plan_save; the approval stays.
  await dragToDay(page, plan, offer.id, '2026-10-14');
  await expect(keep).toBeVisible();
  await keep.locator('[data-plan-keep-yes]').click();
  await expect(keep).toBeHidden();
  await expect(dayBlock(plan, '2026-10-14').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );
  expect(saves(network)).toEqual([]);
  await saveChanges(page, plan);
  expect(saves(network)).toHaveLength(1);
  expect(opsOf(saves(network)[0])).toEqual([
    expect.objectContaining({
      op: 'move',
      item_id: offer.id,
      target_date: '2026-10-14',
      keep_reviews: true,
    }),
  ]);
  expect(moves()).toEqual([]);
  await expect(dayBlock(plan, '2026-10-14').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );
  await expect(clientPlan).toHaveAttribute('data-plan-slot-state', 'approved');
  await expect(clientPlan).toHaveText('OK');

  // No, ask again: keep_reviews false; after Save the approval resets.
  await enterEdit(plan);
  await dragToDay(page, plan, offer.id, '2026-10-15');
  await expect(keep).toBeVisible();
  await keep.locator('[data-plan-keep-no]').click();
  await expect(keep).toBeHidden();
  await saveChanges(page, plan);
  expect(saves(network)).toHaveLength(2);
  expect(opsOf(saves(network)[1])).toEqual([
    expect.objectContaining({
      op: 'move',
      item_id: offer.id,
      target_date: '2026-10-15',
      keep_reviews: false,
    }),
  ]);
  await expect(dayBlock(plan, '2026-10-15').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );
  await expect(clientPlan).toHaveAttribute('data-plan-slot-state', 'pending');
  await expect(clientPlan).toHaveText('Not checked yet');
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
    `${PEER_NAME} opened ${DATED_PLAN_TITLE} for approvers`,
  );
  await expect(line('plan_deleted')).toContainText(`${PEER_NAME} deleted ${DATED_PLAN_TITLE}`);
  await expect(line('plan_date_changed')).toContainText('Lamp lighting reel moved to Fri 16 Oct');
  await expect(line('plan_updated')).toContainText(
    `${PEER_NAME} renamed Old name to ${DATED_PLAN_TITLE}`,
  );
  for (const open of await section.locator('[data-bell-open]').all()) {
    expectMinTouchTarget(await open.boundingBox());
  }

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
// Plan list: Edit mode remove (agency), queued until Save changes; open at today
// ---------------------------------------------------------------------------

const PEEK_KEY = 'sorted:plan-swipe-peek-seen';

const removes = (network: HarnessNetwork) =>
  network.rpcCalls.filter((c) => c.name === 'plan_item_remove');

test('agency: Edit mode remove hides the row at once, Discard restores it with no request, Save sends it once; a grip drag still reorders', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  const lantern = dated('Lantern workshop');
  const portraits = dated('Family portraits');
  const wrap = plan.locator(`[data-plan-row-wrap="${lantern.id}"]`);

  // View mode: no remove control, no grip, no swipe.
  await expect(
    plan.locator('[data-plan-row-remove-edit], [data-plan-grip], [data-plan-row-swipe]'),
  ).toHaveCount(0);
  await enterEdit(plan);

  // The remove icon: a 44x44 target in the bad colour on the row's bottom
  // line, at its right edge; a tap on the row itself opens nothing while editing.
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const remove = wrap.locator('[data-plan-row-remove-edit]');
  await expect(remove).toBeVisible();
  const removeBox = await remove.boundingBox();
  const rowBox = await wrap.locator(`[data-plan-row="${lantern.id}"]`).boundingBox();
  if (removeBox === null || rowBox === null) throw new Error('boxes');
  expectMinTouchTarget(removeBox);
  expect(removeBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
  expect(removeBox.x + removeBox.width).toBeGreaterThanOrEqual(rowBox.x + rowBox.width - 1);
  await expect(remove).toHaveClass(/text-bad/);
  await expect(remove).toHaveAttribute('aria-label', 'Remove from plan: Lantern workshop');
  await wrap.locator(`[data-plan-row="${lantern.id}"]`).click();
  await expect(page.locator('[data-plan-page="item"]')).toHaveCount(0);

  // Remove: the row is hidden at once; nothing is sent.
  await remove.click();
  await expect(wrap).toHaveCount(0);
  expect(saves(network)).toEqual([]);
  expect(removes(network)).toEqual([]);

  // Cancel asks; Keep editing keeps the queued removal.
  let discard = await cancelEdit(page, plan);
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(discard).toBeHidden();
  await expect(plan.locator('[data-plan-edit-header]')).toBeVisible();
  await expect(wrap).toHaveCount(0);

  // Discard: the row is back in place, no request ever.
  discard = await cancelEdit(page, plan);
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(discard).toBeHidden();
  await expect(plan.locator('[data-plan-edit-header]')).toHaveCount(0);
  await expect(dayBlock(plan, '2026-10-14').locator(`[data-plan-row="${lantern.id}"]`)).toHaveCount(
    1,
  );
  await page.waitForTimeout(500);
  expect(saves(network)).toEqual([]);
  expect(removes(network)).toEqual([]);

  // Remove again and Save: exactly one plan_save with the one remove op; the
  // row never comes back after the re-read; no direct plan_item_remove.
  await enterEdit(plan);
  await wrap.locator('[data-plan-row-remove-edit]').click();
  await expect(wrap).toHaveCount(0);
  await saveChanges(page, plan);
  expect(saves(network)).toHaveLength(1);
  expect(saves(network)[0]?.args).toMatchObject({
    p_plan_id: DATED_PLAN_ID,
    p_ops: [{ op: 'remove', item_id: lantern.id }],
  });
  expect(typeof saves(network)[0]?.args.p_trace_id).toBe('string');
  await page.waitForTimeout(1_000);
  await expect(wrap).toHaveCount(0);
  expect(saves(network)).toHaveLength(1);
  expect(removes(network)).toEqual([]);
  expect((network.world.tables.plan_items ?? []).some((i) => i.id === lantern.id)).toBe(false);

  // The grip drag still moves a row: one move op with the full order minus the removed row.
  await enterEdit(plan);
  await dragToDay(page, plan, portraits.id, '2026-10-16');
  await expect(
    dayBlock(plan, '2026-10-16').locator(`[data-plan-row="${portraits.id}"]`),
  ).toHaveCount(1);
  await saveChanges(page, plan);
  expect(saves(network)).toHaveLength(2);
  const move = opsOf(saves(network)[1])[0];
  expect(move).toMatchObject({ op: 'move', item_id: portraits.id, target_date: '2026-10-16' });
  const order = move?.item_ids as string[];
  expect(order).toHaveLength(DATED_PLAN_ITEMS.length - 1);
  expect(order).not.toContain(lantern.id);
  await expect(
    dayBlock(plan, '2026-10-16').locator(`[data-plan-row="${portraits.id}"]`),
  ).toHaveCount(1);
  expectClean(network);
});

/** Layout of the plan screen at rest: no sideways page, rows inside the column. */
async function planLayout(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement;
    const list = document.querySelector('[data-plan-page="plan"] [data-plan-list]');
    const body = list?.closest<HTMLElement>('.overflow-y-auto') ?? null;
    const vw = window.innerWidth;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-plan-row-wrap]')].map((wrap) => {
      const box = wrap.getBoundingClientRect();
      const title = wrap.querySelector<HTMLElement>('[data-plan-row-title]');
      const control = wrap.querySelector<HTMLElement>('[data-plan-control]');
      const tick = control?.getBoundingClientRect();
      const t = title?.getBoundingClientRect();
      return {
        id: wrap.getAttribute('data-plan-row-wrap') ?? '',
        left: box.left,
        right: box.right,
        titleRight: t?.right ?? 0,
        // Titles clamp to two lines.
        titleClipped:
          title !== null &&
          (title.scrollHeight > title.clientHeight || title.scrollWidth > title.clientWidth),
        titleEllipsis:
          title !== null && getComputedStyle(title).getPropertyValue('-webkit-line-clamp') === '2',
        tick:
          tick === undefined
            ? null
            : {
                left: tick.left,
                right: tick.right,
                width: tick.width,
                kind: control?.getAttribute('data-plan-control') ?? '',
              },
      };
    });
    return {
      vw,
      rootScroll: root === null ? -1 : root.scrollWidth - root.clientWidth,
      bodyScroll: body === null ? -1 : body.scrollWidth - body.clientWidth,
      scrollX: window.scrollX,
      bodyLeft: body?.scrollLeft ?? -1,
      rows,
    };
  });
}

test(
  'agency, 120+ character titles: no sideways page, titles clamp, PLAN on screen; the edit controls fit too',
  {
    tag: '@theme',
  },
  async ({ page }) => {
    test.setTimeout(120_000);
    const network = await installHarnessNetwork(page);
    seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
    const long = lengthenDatedTitles(network.world);
    await openChat(page, PEER_NAME);
    const plan = await openPlan(page, DATED_PLAN_ID);
    for (const id of [long.concept, long.post]) {
      await expect(plan.locator(`[data-plan-row="${id}"] [data-plan-row-title]`)).toHaveText(
        /.{120,}/,
      );
    }
    const vw = page.viewportSize()?.width ?? 0;

    /** Both modes: nothing sideways, every row and title inside the column. */
    const expectInside = async (): Promise<void> => {
      const layout = await planLayout(page);
      // The page never scrolls sideways: the document and the plan body fit the viewport.
      expect(layout.rootScroll).toBeLessThanOrEqual(0);
      expect(layout.bodyScroll).toBeLessThanOrEqual(0);
      expect(layout.scrollX).toBe(0);
      expect(layout.bodyLeft).toBe(0);
      for (const row of layout.rows) {
        expect(row.right, `row ${row.id} inside the viewport`).toBeLessThanOrEqual(layout.vw + 0.5);
        expect(row.titleRight, `title ${row.id} inside its row`).toBeLessThanOrEqual(row.right);
        expect(row.titleEllipsis).toBe(true);
        if (row.tick !== null) {
          expect(row.tick.left, `tick ${row.id}`).toBeGreaterThanOrEqual(0);
          expect(row.tick.right, `tick ${row.id}`).toBeLessThanOrEqual(layout.vw + 0.5);
          // A switch or a pill is a target; read-only text is not.
          if (row.tick.kind !== 'text') {
            expect(Math.round(row.tick.width)).toBeGreaterThanOrEqual(44);
          }
        }
      }
      for (const id of [long.concept, long.post]) {
        expect(layout.rows.find((r) => r.id === id)?.titleClipped, `title ${id} truncated`).toBe(
          true,
        );
      }
    };
    /** View mode at rest: the layout, every row with its PLAN control, no edit control. */
    const expectAtRest = async (): Promise<void> => {
      await expectInside();
      await expect(
        plan.locator('[data-plan-row-remove-edit], [data-plan-row-day-chip], [data-plan-grip]'),
      ).toHaveCount(0);
      expect((await planLayout(page)).rows.every((r) => r.tick !== null)).toBe(true);
    };
    await expectAtRest();

    // The list scrolls on Y; neither it nor the page can be moved on X (WebKit has
    // no touch scroll in Playwright, so the scroller is driven directly).
    const scrolled = await plan.locator('[data-plan-list]').evaluate((el) => {
      const body = el.closest<HTMLElement>('.overflow-y-auto');
      const root = document.scrollingElement;
      if (body === null || root === null) throw new Error('scrollers');
      const top = body.scrollTop;
      body.scrollBy(0, 200);
      body.scrollBy(300, 0);
      root.scrollBy(300, 0);
      return { dy: body.scrollTop - top, bodyX: body.scrollLeft, rootX: root.scrollLeft };
    });
    expect(scrolled.dy).toBeGreaterThan(0);
    expect(scrolled.bodyX).toBe(0);
    expect(scrolled.rootX).toBe(0);
    await expectAtRest();

    // Edit mode: the grip, the day chip and the 44px remove fit beside a long
    // title; nothing sideways.
    await enterEdit(plan);
    await expectInside();
    for (const id of [long.concept, long.post]) {
      const wrap = plan.locator(`[data-plan-row-wrap="${id}"]`);
      await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await expect(wrap.locator('[data-plan-grip]')).toBeVisible();
      await expect(wrap.locator('[data-plan-row-day-chip]')).toBeVisible();
      const removeBox = await wrap.locator('[data-plan-row-remove-edit]').boundingBox();
      if (removeBox === null) throw new Error('remove box');
      expectMinTouchTarget(removeBox);
      expect(removeBox.x).toBeGreaterThanOrEqual(0);
      expect(removeBox.x + removeBox.width).toBeLessThanOrEqual(vw + 0.5);
    }

    // Remove the long concept, then Discard: the row is back, nothing sent.
    await plan
      .locator(`[data-plan-row-wrap="${long.concept}"] [data-plan-row-remove-edit]`)
      .click();
    await expect(plan.locator(`[data-plan-row-wrap="${long.concept}"]`)).toHaveCount(0);
    const discard = await cancelEdit(page, plan);
    await discard.getByRole('button', { name: 'Discard' }).click();
    await expect(discard).toBeHidden();
    await expect(
      dayBlock(plan, '2026-10-14').locator(`[data-plan-row="${long.concept}"]`),
    ).toHaveCount(1);
    expect(saves(network)).toEqual([]);
    expect(removes(network)).toEqual([]);
    await page.waitForTimeout(400);
    await expectAtRest();

    // The grip drag still moves a long row (the post's approval is its stage,
    // not a client review row, so nothing asks); Save writes one plan_save.
    await enterEdit(plan);
    await dragToDay(page, plan, long.post, '2026-10-16');
    await expect(page.getByRole('dialog', { name: /^Slot approved by/ })).toHaveCount(0);
    await expect(
      dayBlock(plan, '2026-10-16').locator(`[data-plan-row="${long.post}"]`),
    ).toHaveCount(1);
    await expectInside();
    await saveChanges(page, plan);
    expect(saves(network)).toHaveLength(1);
    expect(opsOf(saves(network)[0])).toEqual([
      expect.objectContaining({ op: 'move', item_id: long.post, target_date: '2026-10-16' }),
    ]);
    await expect(
      dayBlock(plan, '2026-10-16').locator(`[data-plan-row="${long.post}"]`),
    ).toHaveCount(1);
    await expectAtRest();
    expectClean(network);
  },
);

test('agency: a queued removal is never sent on close: Cancel and system Back ask, Keep editing holds it, Save sends it once', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  const lantern = dated('Lantern workshop');
  const wrap = plan.locator(`[data-plan-row-wrap="${lantern.id}"]`);
  await enterEdit(plan);
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await wrap.locator('[data-plan-row-remove-edit]').click();
  await expect(wrap).toHaveCount(0);
  expect(saves(network)).toEqual([]);
  expect(removes(network)).toEqual([]);

  // Cancel asks; Keep editing keeps the queued removal and the screen.
  const discard = await cancelEdit(page, plan);
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(discard).toBeHidden();
  await expect(plan.locator('[data-plan-edit-header]')).toBeVisible();
  await expect(wrap).toHaveCount(0);

  // System Back asks the same (the Back guard); Keep editing stays.
  await page.goBack();
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(discard).toBeHidden();
  await expect(plan).toBeVisible();
  await expect(plan.locator('[data-plan-edit-header]')).toBeVisible();
  await expect(wrap).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(saves(network)).toEqual([]);
  expect(removes(network)).toEqual([]);

  // Save: one plan_save; then Back closes the screen with nothing more sent.
  await saveChanges(page, plan);
  expect(saves(network)).toHaveLength(1);
  expect(opsOf(saves(network)[0])).toEqual([{ op: 'remove', item_id: lantern.id }]);
  await plan.getByRole('button', { name: 'Back' }).first().click();
  await expect(plan).toBeHidden();
  await page.waitForTimeout(1_500);
  expect(saves(network)).toHaveLength(1);
  expect(removes(network)).toEqual([]);
  expectClean(network);
});

test('client: no swipe, no Edit, no Remove on plan rows', async ({ page }) => {
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
  await expect(plan.locator('[data-plan-row-remove], [data-plan-row-remove-edit]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-edit], [data-plan-grip]')).toHaveCount(0);
  // No peek for clients either: the device stays unmarked.
  await page.waitForTimeout(2_000);
  expect(await page.evaluate((k) => window.localStorage.getItem(k), PEEK_KEY)).toBeNull();
  expectClean(network);
});

test('agency: view mode has no edit controls and no peek; Edit shows the fields and a chip and remove per row; Cancel with nothing changed leaves at once', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page, { planSwipePeek: true });
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const plan = await openPlan(page, DATED_PLAN_ID);
  // No peek, no tip toast, no swipe row, and the device is never marked.
  await page.waitForTimeout(1_500);
  await expect(
    plan.locator(
      '[data-plan-row-swipe], [data-plan-grip], [data-plan-row-day-chip], [data-plan-row-remove-edit]',
    ),
  ).toHaveCount(0);
  await expect(page.getByText('Tip: swipe left on a slot to remove it')).toHaveCount(0);
  expect(await page.evaluate((k) => window.localStorage.getItem(k), PEEK_KEY)).toBeNull();

  // Edit: a 44px text button; the header turns into Cancel / Editing plan / Save changes.
  const edit = plan.locator('[data-plan-edit]');
  await expect(edit).toHaveText('Edit');
  expectMinTouchTarget(await edit.boundingBox());
  await edit.click();
  await expect(plan.locator('[data-plan-edit-header]')).toBeVisible();
  await expect(plan.locator('[data-plan-editing-title]')).toHaveText('Editing plan');
  await expect(plan.locator('[data-plan-back-text]')).toHaveText('Cancel');
  await expect(plan.locator('[data-plan-save]')).toHaveText('Save changes');
  for (const sel of ['[data-plan-back-text]', '[data-plan-save]']) {
    expectMinTouchTarget(await plan.locator(sel).boundingBox());
  }
  await expect(plan.locator('[data-plan-edit-title]')).toHaveValue(DATED_PLAN_TITLE);
  await expect(plan.locator('[data-plan-edit-date="startsOn"]')).toHaveValue('2026-10-12');
  await expect(plan.locator('[data-plan-edit-date="endsOn"]')).toHaveValue('2026-10-18');
  // Every row: a day chip and a remove; PLAN as read-only text and no footer while editing.
  const rows = plan.locator('[data-plan-row-wrap]');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  await expect(plan.locator('[data-plan-row-wrap] [data-plan-row-day-chip]')).toHaveCount(count);
  await expect(plan.locator('[data-plan-row-wrap] [data-plan-row-remove-edit]')).toHaveCount(count);
  expect(await plan.locator('[data-plan-grip]').count()).toBeGreaterThan(0);
  await expect(plan.locator('[data-plan-row-wrap] [data-plan-row-edit-line]')).toHaveCount(count);
  await expect(plan.locator('[data-plan-row-wrap] [data-plan-control="text"]')).toHaveCount(count);
  await expect(
    plan.locator(
      '[data-plan-control="switch"], [data-plan-control="pill"], [data-plan-ok], [data-plan-footer]',
    ),
  ).toHaveCount(0);

  // Cancel with nothing changed: straight back to view mode, no dialog, nothing written.
  await plan.locator('[data-plan-back-text]').click();
  await expect(plan.locator('[data-plan-edit-header]')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(plan.locator('[data-plan-slot]').first()).toBeVisible();
  expect(saves(network)).toEqual([]);
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
