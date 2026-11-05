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
// on a move (the row ⋯ menu: a move or a remove paints at once and is written
// as one plan_save when its Undo strip ends; no Edit mode), and the plan
// alerts as chat bell rows, on the
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

/** A creator's row ⋯ menu: open it and pick an item. */
async function rowMenu(page: Page, plan: Locator, id: string, label: string): Promise<void> {
  const wrap = plan.locator(`[data-plan-row-wrap="${id}"]`);
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await wrap.getByRole('button', { name: 'More actions' }).click();
  await page.locator('[role="menu"]').getByText(label, { exact: true }).click();
}
const saves = (network: HarnessNetwork) => network.rpcCalls.filter((c) => c.name === 'plan_save');
const opsOf = (call: { args: Record<string, unknown> } | undefined) =>
  (call?.args.p_ops ?? []) as Array<Record<string, unknown>>;

/** The row ⋯ menu: Move to another day, then the day tile. */
async function moveToDay(page: Page, plan: Locator, id: string, day: string): Promise<void> {
  await rowMenu(page, plan, id, 'Move to another day');
  const picker = page.locator('[data-plan-day-picker]');
  await expect(picker).toBeVisible();
  await picker.locator(`[data-plan-day-tile="${day}"]`).click();
}
/** The Undo strip ends: wait for the written plan_save calls. */
async function waitForSaves(network: HarnessNetwork, n: number): Promise<void> {
  await expect.poll(() => saves(network).length, { timeout: 10_000 }).toBe(n);
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

  // Delete: at once, no confirm; the Undo strip, then the card reads "Plan deleted".
  await title.click();
  await plan.locator('[data-plan-menu-delete]').click();
  await expect(page.getByRole('dialog', { name: 'Delete this plan?' })).toHaveCount(0);
  await expect(plan).toBeHidden();
  await expect(page.getByText('Plan deleted', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect
    .poll(() => network.rpcCalls.some((c) => c.name === 'plan_delete'), { timeout: 10_000 })
    .toBe(true);
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

  // Moving the approved slot to another day (the row menu) asks first;
  // cancelling cancels and nothing is written.
  const moves = () => network.rpcCalls.filter((c) => c.name === 'plan_item_move');
  await moveToDay(page, plan, offer.id, '2026-10-14');
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

  // Yes, keep it: painted at once; when the Undo strip ends one plan_save
  // writes it with keep_reviews true; the approval stays.
  await moveToDay(page, plan, offer.id, '2026-10-14');
  await expect(keep).toBeVisible();
  await keep.locator('[data-plan-keep-yes]').click();
  await expect(keep).toBeHidden();
  await expect(dayBlock(plan, '2026-10-14').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );
  await waitForSaves(network, 1);
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

  // No, ask again: keep_reviews false; once written the approval resets.
  await moveToDay(page, plan, offer.id, '2026-10-15');
  await expect(keep).toBeVisible();
  await keep.locator('[data-plan-keep-no]').click();
  await expect(keep).toBeHidden();
  await waitForSaves(network, 2);
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

test('Notifications: plan alerts under Plans; a deleted plan only toasts; a tap opens the plan', async ({
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
  await page.goto('/notifications');
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  const line = (event: string) => page.locator(`[data-activity-event="${event}"]`);
  await expect(line('plan_opened')).toContainText(
    `${PEER_NAME} opened ${DATED_PLAN_TITLE} for approvers`,
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-activity-alert-icon="plan"]')).toHaveCount(4);
  await expect(line('plan_deleted')).toContainText(`${PEER_NAME} deleted ${DATED_PLAN_TITLE}`);
  await expect(line('plan_date_changed')).toContainText('Lamp lighting reel moved to Fri 16 Oct');
  await expect(line('plan_updated')).toContainText(
    `${PEER_NAME} renamed Old name to ${DATED_PLAN_TITLE}`,
  );
  for (const lead of await page.locator('[data-activity-lead]').all()) {
    expectMinTouchTarget(await lead.boundingBox());
  }

  // A deleted plan's card opens nothing: it toasts and is marked read.
  await line('plan_deleted').locator('[data-activity-lead]').click();
  await expect(page.getByText('This plan was deleted')).toBeVisible();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(line('plan_deleted').locator('[aria-label="Unread"]')).toHaveCount(0);

  // A date change opens the plan at the item.
  await line('plan_date_changed').locator('[data-activity-lead]').click();
  await expect(page).toHaveURL(new RegExp(`/plan/${DATED_PLAN_ID}\\?item=${concept.id}$`));
  await expect(page.locator('[data-plan-page="item"]')).toBeVisible();
  expect(network.rpcCalls.filter((c) => c.name === 'inbox_mark_read')).toHaveLength(2);
  expectClean(network);
});

// ---------------------------------------------------------------------------
// Plan list: the row menu remove (agency), written once its Undo strip ends; open at today
// ---------------------------------------------------------------------------

const PEEK_KEY = 'sorted:plan-swipe-peek-seen';

const removes = (network: HarnessNetwork) =>
  network.rpcCalls.filter((c) => c.name === 'plan_item_remove');

test('agency: Remove from plan (row menu) hides the row at once, Undo restores it with no request, the strip ending sends one plan_save; a move still names the full order', async ({
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

  // No Edit mode, no grip, no swipe; one 44px ⋯ per row.
  await expect(
    plan.locator('[data-plan-edit], [data-plan-grip], [data-plan-row-swipe]'),
  ).toHaveCount(0);
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  expectMinTouchTarget(await wrap.getByRole('button', { name: 'More actions' }).boundingBox());

  // Remove: hidden at once, nothing sent; Undo brings it back, still nothing sent.
  await rowMenu(page, plan, lantern.id, 'Remove from plan');
  await expect(wrap).toHaveCount(0);
  expect(saves(network)).toEqual([]);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(dayBlock(plan, '2026-10-14').locator(`[data-plan-row="${lantern.id}"]`)).toHaveCount(
    1,
  );
  await page.waitForTimeout(5_000);
  expect(saves(network)).toEqual([]);
  expect(removes(network)).toEqual([]);

  // Remove again and let the strip end: exactly one plan_save with the one
  // remove op; the row never comes back after the re-read.
  await rowMenu(page, plan, lantern.id, 'Remove from plan');
  await expect(wrap).toHaveCount(0);
  await waitForSaves(network, 1);
  expect(saves(network)[0]?.args).toMatchObject({
    p_plan_id: DATED_PLAN_ID,
    p_ops: [{ op: 'remove', item_id: lantern.id }],
  });
  expect(typeof saves(network)[0]?.args.p_trace_id).toBe('string');
  await page.waitForTimeout(1_000);
  await expect(wrap).toHaveCount(0);
  expect(removes(network)).toEqual([]);
  expect((network.world.tables.plan_items ?? []).some((i) => i.id === lantern.id)).toBe(false);

  // A move: one move op with the full order minus the removed row.
  await moveToDay(page, plan, portraits.id, '2026-10-16');
  await expect(
    dayBlock(plan, '2026-10-16').locator(`[data-plan-row="${portraits.id}"]`),
  ).toHaveCount(1);
  await waitForSaves(network, 2);
  const move = opsOf(saves(network)[1])[0];
  expect(move).toMatchObject({ op: 'move', item_id: portraits.id, target_date: '2026-10-16' });
  const order = move?.item_ids as string[];
  expect(order).toHaveLength(DATED_PLAN_ITEMS.length - 1);
  expect(order).not.toContain(lantern.id);
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
  'agency, 120+ character titles: no sideways page, titles clamp, PLAN on screen; the row menu fits too',
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
    /** At rest: the layout, every row with its PLAN control, no edit control. */
    const expectAtRest = async (): Promise<void> => {
      await expectInside();
      await expect(
        plan.locator('[data-plan-edit], [data-plan-row-day-chip], [data-plan-grip]'),
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

    // The 44px ⋯ menu fits beside a long title; nothing sideways.
    for (const id of [long.concept, long.post]) {
      const wrap = plan.locator(`[data-plan-row-wrap="${id}"]`);
      await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const moreBox = await wrap.getByRole('button', { name: 'More actions' }).boundingBox();
      if (moreBox === null) throw new Error('menu box');
      expectMinTouchTarget(moreBox);
      expect(moreBox.x).toBeGreaterThanOrEqual(0);
      expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(vw + 0.5);
    }

    // The row menu moves a long row (the post's approval is its stage, not a
    // client review row, so nothing asks); one plan_save once the strip ends.
    await moveToDay(page, plan, long.post, '2026-10-16');
    await expect(page.getByRole('dialog', { name: /^Slot approved by/ })).toHaveCount(0);
    await expect(
      dayBlock(plan, '2026-10-16').locator(`[data-plan-row="${long.post}"]`),
    ).toHaveCount(1);
    await expectInside();
    await waitForSaves(network, 1);
    expect(opsOf(saves(network)[0])).toEqual([
      expect.objectContaining({ op: 'move', item_id: long.post, target_date: '2026-10-16' }),
    ]);
    await expectAtRest();
    expectClean(network);
  },
);

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
  await expect(plan.locator('[data-plan-row-remove]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-edit], [data-plan-grip]')).toHaveCount(0);
  await expect(plan.getByRole('button', { name: 'More actions' })).toHaveCount(0);
  // No peek for clients either: the device stays unmarked.
  await page.waitForTimeout(2_000);
  expect(await page.evaluate((k) => window.localStorage.getItem(k), PEEK_KEY)).toBeNull();
  expectClean(network);
});

test('agency: no Edit mode and no peek; one ⋯ per row; the title menu offers Rename and Change dates', async ({
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
    plan.locator('[data-plan-row-swipe], [data-plan-grip], [data-plan-edit], [data-plan-save]'),
  ).toHaveCount(0);
  expect(await page.evaluate((k) => window.localStorage.getItem(k), PEEK_KEY)).toBeNull();
  // Every row in the plan's days has its ⋯ and its PLAN control.
  const rows = plan.locator('[data-plan-row-wrap]');
  expect(await rows.count()).toBeGreaterThan(0);
  expect(await plan.getByRole('button', { name: 'More actions' }).count()).toBeGreaterThan(0);
  await expect(plan.locator('[data-plan-slot]').first()).toBeVisible();
  // The title menu: Rename and Change dates (and Delete for the creator).
  await plan.locator('[data-plan-title-menu]').click();
  await expect(plan.locator('[data-plan-menu-rename]')).toBeVisible();
  await expect(plan.locator('[data-plan-menu-dates]')).toBeVisible();
  await plan.locator('[data-plan-menu-dates]').click();
  await expect(page.locator('[data-plan-dates-save]')).toBeVisible();
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
  // Today: the solid accent tile, the "Today" pill under it, the marked band.
  await expect(dayBlock(plan, today).locator('[data-plan-today]')).toHaveClass(/\bbg-accent\b/);
  const pill = dayBlock(plan, today).locator('[data-plan-today-pill]');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText('Today');
  await expect(dayBlock(plan, today)).toHaveAttribute('data-plan-day-today', '');
  await expect(plan.locator('[data-plan-day-today]')).toHaveCount(1);
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
