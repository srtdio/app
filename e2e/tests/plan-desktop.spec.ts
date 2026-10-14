import { expect, test, type Locator, type Page } from '@playwright/test';
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
import { expectMinTouchTarget } from '../helpers/touch-target';

// The Plan panel on a laptop (stories A to F) and the phone kept as it was
// (story E). @desktop tests run on desktop-webkit (1280x800) and skip below
// md; the untagged phone test runs on the iPhone projects. Fixture names are
// fictional. The fixture session is minted on the real clock, so "today" is
// the real UTC day (the workspace zone): inside the plan (12 to 18 Oct) its
// group opens at the top, otherwise the list opens at its top.

const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_IN_PLAN = TODAY >= '2026-10-12' && TODAY <= '2026-10-18';

function laptopOnly(page: Page): void {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'laptop only');
}

async function openChat(page: Page): Promise<void> {
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
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

const dated = (title: string) => {
  const it = DATED_PLAN_ITEMS.find((i) => i.title === title);
  if (it === undefined) throw new Error(`fixture: ${title}`);
  return it;
};

/** Put a dated item on another day before the page loads (a post by its post's date). */
function setDay(network: HarnessNetwork, title: string, day: string): void {
  const it = dated(title);
  const t = network.world.tables;
  const row = (t.plan_items ?? []).find((i) => i.id === it.id);
  if (row === undefined) throw new Error('fixture');
  row.target_date = day;
  const post = (t.posts ?? []).find((p) => p.id === row.post_id);
  if (post !== undefined) post.target_date = `${day}T09:00:00Z`;
}

/** Open the plan card and record the panel's box every frame until it rests. */
async function openPanel(page: Page): Promise<{ panel: Locator; boxes: string[] }> {
  await page.evaluate(() => {
    const w = window as unknown as { __boxes: string[] };
    w.__boxes = [];
    const tick = (): void => {
      const el = document.querySelector('[data-plan-page="plan"]');
      if (el !== null) {
        const r = el.getBoundingClientRect();
        w.__boxes.push(`${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      if (w.__boxes.length < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const card = page.locator(`[data-plan-card="${DATED_PLAN_ID}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-plan-open]').click();
  const panel = page.locator('[data-plan-page="plan"]');
  await expect(panel.locator('[data-plan-day]').first()).toBeVisible();
  await page.waitForTimeout(600);
  const boxes = await page.evaluate(() => (window as unknown as { __boxes: string[] }).__boxes);
  return { panel, boxes };
}

/** The Undo of the toast that says `text`. */
const undoOf = (page: Page, text: string): Locator =>
  page
    .getByText(text, { exact: true })
    .locator('xpath=ancestor::div[.//*[@data-toast-action]][1]')
    .locator('[data-toast-action]');

const dayBlock = (panel: Locator, day: string): Locator =>
  panel.locator(`[data-plan-day="${day}"]`);

async function titlesOn(panel: Locator, day: string): Promise<string[]> {
  return dayBlock(panel, day).locator('[data-plan-row-title]').allInnerTexts();
}

/** Mouse drag by the grip: press, 4px+ of travel lifts at once, carry, drop. */
async function gripDrag(page: Page, panel: Locator, id: string, target: () => Promise<number>) {
  const wrap = panel.locator(`[data-plan-row-wrap="${id}"]`);
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await wrap.hover();
  const grip = wrap.locator('[data-plan-grip]');
  await expect(grip).toHaveCSS('opacity', '1');
  const box = await grip.boundingBox();
  if (box === null) throw new Error('grip box');
  const x = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  await page.mouse.move(x, y0 + 6);
  // No long-press wait: the row is up after 4px.
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  const y1 = await target();
  await page.mouse.move(x, (y0 + y1) / 2, { steps: 6 });
  await page.mouse.move(x, y1, { steps: 6 });
  await page.waitForTimeout(100);
  await page.mouse.move(x, await target(), { steps: 2 });
  await expect(page.locator('[data-plan-drop-slot]')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
}

test('A: the panel docks at full size, opens on today, chat scrolls beside it; a mouse drag moves a post Tue to Thu @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  setDay(network, 'Thank you note', '2026-10-13');
  await openChat(page);
  const { panel, boxes } = await openPanel(page);

  // 440 wide, full height, from the first frame to rest: never another size.
  expect(new Set(boxes)).toEqual(new Set(['440x800']));
  await expect(panel).toHaveAttribute('role', 'complementary');
  await expect(panel).not.toHaveAttribute('aria-modal', 'true');
  const box = await panel.boundingBox();
  expect(box).toEqual({ x: 840, y: 0, width: 440, height: 800 });
  expectMinTouchTarget(await panel.locator('[data-plan-close]').boundingBox());

  // Today at the top of the list on the first paint, past days above it.
  const body = panel.locator('[data-plan-list]').locator('xpath=..');
  if (TODAY_IN_PLAN) {
    const day = await dayBlock(panel, TODAY).boundingBox();
    const top = await body.boundingBox();
    if (day === null || top === null) throw new Error('boxes');
    expect(Math.abs(day.y - top.y)).toBeLessThanOrEqual(2);
    if (TODAY > '2026-10-12') expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  } else {
    expect(await body.evaluate((el) => el.scrollTop)).toBe(0);
  }

  // From 1180px the thread narrows: nothing of it sits under the panel, and it scrolls.
  const thread = page.locator('[data-msg-id]').first();
  const scroller = thread.locator(
    'xpath=ancestor::*[contains(@class,"overflow-y-auto") or contains(@class,"overflow-auto")][1]',
  );
  const tb = await scroller.boundingBox();
  if (tb === null) throw new Error('thread box');
  expect(tb.x + tb.width).toBeLessThanOrEqual(840 + 1);
  const before = await scroller.evaluate((el) => el.scrollTop);
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).not.toBe(before);

  // Drag "Thank you note" (a post) from Tue 13 to Thu 15 by its grip.
  const post = dated('Thank you note');
  expect(await titlesOn(panel, '2026-10-13')).toContain('Thank you note');
  await gripDrag(page, panel, post.id, async () => {
    const first = await dayBlock(panel, '2026-10-15')
      .locator('[data-plan-row-wrap]')
      .first()
      .boundingBox();
    if (first === null) throw new Error('target');
    return first.y + 4;
  });
  await expect(page.getByText('Moved to Thu 15 Oct. Pipeline date updated.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect.poll(() => titlesOn(panel, '2026-10-15')).toContain('Thank you note');
  // The post's own (Pipeline) date is Thu, one plan_item_move.
  const stored = (network.world.tables.plan_items ?? []).find((i) => i.id === post.id);
  const row = (network.world.tables.posts ?? []).find((p) => p.id === stored?.post_id);
  expect(row?.target_date).toBe('2026-10-15T12:00:00Z');
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toHaveLength(1);
  expectClean(network);
});

test('B: reorder inside Wed by mouse, the calendar moves one to Fri, the dustbin removes one and Undo restores it @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  setDay(network, 'Morning prayers', '2026-10-14');
  await openChat(page);
  const { panel } = await openPanel(page);
  expect(await titlesOn(panel, '2026-10-14')).toEqual(['Lantern workshop', 'Morning prayers']);

  // Reorder: Morning prayers above Lantern workshop.
  await gripDrag(page, panel, dated('Morning prayers').id, async () => {
    const first = await dayBlock(panel, '2026-10-14')
      .locator('[data-plan-row-wrap]')
      .first()
      .boundingBox();
    if (first === null) throw new Error('target');
    return first.y + 4;
  });
  await expect
    .poll(() => titlesOn(panel, '2026-10-14'))
    .toEqual(['Morning prayers', 'Lantern workshop']);

  // Calendar: an anchored popover (not a sheet) of the plan's days, counts, current marked.
  const lantern = panel.locator(`[data-plan-row-wrap="${dated('Lantern workshop').id}"]`);
  const calendar = lantern.locator('[data-plan-row-calendar]');
  const bin = lantern.locator('[data-plan-row-bin]');
  for (const b of [calendar, bin]) {
    const r = await b.boundingBox();
    expect(r?.width).toBe(36);
    expect(r?.height).toBe(44);
  }
  await calendar.click();
  const pop = page.locator('[data-plan-day-popover="days"]');
  await expect(pop).toBeVisible();
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
  await expect(pop.locator('[data-plan-popover-day="2026-10-14"]')).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(pop.locator('[data-plan-popover-day="2026-10-14"]')).toContainText('2');
  await expect(pop.locator('[data-plan-popover-remove]')).toHaveCount(0);
  await pop.locator('[data-plan-popover-day="2026-10-16"]').click();
  await expect(pop).toHaveCount(0);
  await expect(page.getByText(/^Moved to Fri 16 Oct\./)).toBeVisible();
  // moveToEnd: the end of Fri.
  await expect
    .poll(() => titlesOn(panel, '2026-10-16'))
    .toEqual(['Rangoli timelapse', 'Lantern workshop']);

  // Dustbin: hidden at once, the write waits for the toast; Undo puts it back, no request.
  const prayers = dated('Morning prayers');
  await panel.locator(`[data-plan-row-wrap="${prayers.id}"] [data-plan-row-bin]`).click();
  await expect(page.getByText('Removed from plan')).toBeVisible();
  await expect(panel.locator(`[data-plan-row="${prayers.id}"]`)).toHaveCount(0);
  await undoOf(page, 'Removed from plan').click();
  await expect(panel.locator(`[data-plan-row="${prayers.id}"]`)).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_remove')).toEqual([]);

  // Right-click: the same days plus Remove from plan (danger).
  await panel.locator(`[data-plan-row="${prayers.id}"]`).click({ button: 'right' });
  const menu = page.locator('[data-plan-day-popover="menu"]');
  await expect(menu.locator('[data-plan-popover-remove]')).toHaveText('Remove from plan');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  // Esc closed the menu only; the panel stays.
  await expect(panel).toBeVisible();
  expectClean(network);
});

test('C: keyboard only: Space picks up, Down x3 crosses into the next day, Space drops; Delete then Undo @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  const lantern = dated('Lantern workshop');
  const live = panel.locator('[data-plan-live]');

  // Tab from Tue's Add to Wed's row (the grip is no tab stop).
  await panel.locator('[data-plan-add="2026-10-13"]').focus();
  await page.keyboard.press('Tab');
  const row = panel.locator(`button[data-plan-row="${lantern.id}"]`);
  await expect(row).toBeFocused();
  await expect(panel.locator(`[data-plan-row-wrap="${lantern.id}"] [data-plan-grip]`)).toHaveCSS(
    'opacity',
    '1',
  );
  await expect(panel.locator('[data-plan-key-hints]')).toHaveText(
    'Drag handle to move · Space pick up, arrows move, Space drop · Del remove',
  );

  await page.keyboard.press('Space');
  await expect(live).toHaveText('Picked up');
  await expect(panel.locator('[data-plan-row-picked]')).toHaveCount(1);
  // Space never opens the item.
  await expect(page.locator('[data-plan-page="item"]')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Thu 15 Oct, position 1');
  await page.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Thu 15 Oct, position 2');
  await page.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Thu 15 Oct, position 3');
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toEqual([]);
  // Esc during a pick-up belongs to the pick-up, never the panel.
  await page.keyboard.press('Space');
  await expect(live).toHaveText('Dropped');
  await expect
    .poll(() => titlesOn(panel, '2026-10-15'))
    .toEqual(['Sweets flatlay', 'Morning prayers', 'Lantern workshop']);
  await expect(page.getByText('Moved to Thu 15 Oct.')).toBeVisible();
  await expect
    .poll(() => network.rpcCalls.filter((c) => c.name === 'plan_item_move').length)
    .toBe(1);
  await expect(row).toBeFocused();

  // Escape mid pick-up restores, no write, and the panel stays.
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(live).toHaveText('Move cancelled');
  await expect(panel).toBeVisible();
  expect(await titlesOn(panel, '2026-10-15')).toEqual([
    'Sweets flatlay',
    'Morning prayers',
    'Lantern workshop',
  ]);

  // Delete on another row: gone with Undo; Undo restores it, nothing sent.
  const sweets = dated('Sweets flatlay');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(panel.locator(`button[data-plan-row="${sweets.id}"]`)).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(page.getByText('Removed from plan')).toBeVisible();
  await expect(panel.locator(`[data-plan-row="${sweets.id}"]`)).toHaveCount(0);
  await undoOf(page, 'Removed from plan').click();
  await expect(panel.locator(`[data-plan-row="${sweets.id}"]`)).toHaveCount(1);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_remove')).toEqual([]);

  // Enter opens the focused row's item, in the same panel; Back returns to the list.
  const scroll = panel.locator('[data-plan-list]').locator('xpath=..');
  const at = await scroll.evaluate((el) => el.scrollTop);
  await panel.locator(`button[data-plan-row="${sweets.id}"]`).focus();
  await page.keyboard.press('Enter');
  const item = page.locator('[data-plan-page="item"]');
  await expect(item).toBeVisible();
  const ib = await item.boundingBox();
  expect(ib).toEqual({ x: 840, y: 0, width: 440, height: 800 });
  await page.keyboard.press('Escape');
  await expect(item).toHaveCount(0);
  expect(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - at)).toBeLessThanOrEqual(1);
  expectClean(network);
});

test('D: a client at 1280 sees no grip, calendar, dustbin, menu or hints; a tick shows its toast @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: PEER });
  await openChat(page);
  const { panel } = await openPanel(page);
  await expect(
    panel.locator(
      '[data-plan-grip], [data-plan-row-calendar], [data-plan-row-bin], [data-plan-key-hints], [data-plan-add], [data-plan-add-header]',
    ),
  ).toHaveCount(0);
  const concept = dated('Rangoli timelapse');
  await panel.locator(`[data-plan-row="${concept.id}"]`).click({ button: 'right' });
  await expect(page.locator('[data-plan-day-popover]')).toHaveCount(0);
  const tick = panel.locator(`[data-plan-row-wrap="${concept.id}"] [data-plan-slot]`);
  await tick.click();
  await expect(tick).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  expectClean(network);
});

test('F: at 1024x768 the panel overlays the thread with a shadow, the channel list stays clear, Esc closes it @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1024, height: 768 });
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel, boxes } = await openPanel(page);
  expect(new Set(boxes)).toEqual(new Set(['440x768']));
  expect(await panel.boundingBox()).toEqual({ x: 584, y: 0, width: 440, height: 768 });
  expect(await panel.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  // The channel list (md:w-72) ends left of the panel.
  const list = page.getByText(PEER_NAME, { exact: true }).first();
  const lb = await list.evaluate((el) => {
    const col = el.closest('.md\\:w-72');
    const r = (col ?? el).getBoundingClientRect();
    return r.right;
  });
  expect(lb).toBeLessThanOrEqual(584);
  // Esc closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expectClean(network);
});

test('E: phone (iPhone 13) is unchanged: full page, long-press drag, swipe rows, no laptop controls', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'phone only');
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const card = page.locator(`[data-plan-card="${DATED_PLAN_ID}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-plan-open]').click();
  const plan = page.locator('[data-plan-page="plan"]');
  await expect(plan.locator('[data-plan-day]').first()).toBeVisible();
  await expect(plan).toHaveAttribute('role', 'dialog');
  await expect(plan).toHaveAttribute('aria-modal', 'true');
  const vp = page.viewportSize();
  const box = await plan.boundingBox();
  expect(box?.width).toBe(vp?.width);
  expect(box?.height).toBe(vp?.height);
  await expect(
    plan.locator(
      '[data-plan-grip], [data-plan-row-calendar], [data-plan-row-bin], [data-plan-key-hints], [data-plan-close]',
    ),
  ).toHaveCount(0);
  // Swipe rows (with their hidden Remove) as before.
  await expect(plan.locator('[data-plan-row-swipe]').first()).toBeAttached();
  await expect(plan.locator('[data-plan-row-remove]').first()).toBeAttached();
  // Long-press lifts a row.
  const row = plan.locator(`[data-plan-row="${dated('Opening offer').id}"]`);
  await row.scrollIntoViewIfNeeded();
  const rb = await row.boundingBox();
  if (rb === null) throw new Error('row box');
  await page.mouse.move(rb.x + 80, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
  expectClean(network);
});
