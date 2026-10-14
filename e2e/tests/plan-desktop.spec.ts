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

// The Plan panel on a laptop (stories A to F, the panel widths by window
// width, Escape ownership both ways, pick-up cancel, removal focus, the toast
// rules, Activity kept mounted) and the phone kept as it was (story E).
// @desktop tests run on desktop-webkit (1280x800, others set their own size)
// and skip below md; the untagged phone test runs on the iPhone projects. Fixture names are
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

/** The toast that says `text`, and its Undo. */
const toastOf = (page: Page, text: string): Locator =>
  page
    .getByText(text, { exact: true })
    .locator('xpath=ancestor::div[.//button[@aria-label="Dismiss notification"]][1]');
const undoOf = (page: Page, text: string): Locator =>
  toastOf(page, text).locator('[data-toast-action]');

/** The scroll box of the panel's list. */
const listBody = (panel: Locator): Locator => panel.locator('[data-plan-list]').locator('xpath=..');

/** The chat's channel list column (md:w-72). */
const channelColumn = (page: Page): Locator =>
  page
    .getByText(PEER_NAME, { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@class,"md:w-72")][1]');

/** Whether the focused element matches `selector`. */
const focusedIs = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((sel) => document.activeElement?.matches(sel) === true, selector);

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

test('A: the panel docks at full size, opens on today, chat scrolls beside it; a mouse drag moves a post Tue to Thu, and Pipeline shows Thu @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  setDay(network, 'Thank you note', '2026-10-13');
  await openChat(page);
  const opener = page.locator(`[data-plan-card="${DATED_PLAN_ID}"] [data-plan-open]`);
  const { panel, boxes } = await openPanel(page);

  // 440 wide, full height, from the first frame to rest: never another size.
  expect(new Set(boxes)).toEqual(new Set(['440x800']));
  await expect(panel).toHaveAttribute('role', 'complementary');
  await expect(panel).not.toHaveAttribute('aria-modal', 'true');
  expect(await panel.boundingBox()).toEqual({ x: 840, y: 0, width: 440, height: 800 });
  expectMinTouchTarget(await panel.locator('[data-plan-close]').boundingBox());
  // F15: focus is on the panel heading.
  expect(await focusedIs(page, '[data-plan-page="plan"] [data-plan-heading]')).toBe(true);

  // Today at the top of the list on the first paint, past days above it.
  const body = listBody(panel);
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
  const scroller = page
    .locator('[data-msg-id]')
    .first()
    .locator(
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
  // D2: a post names the Pipeline date; nothing was reset, so Undo.
  await expect(undoOf(page, 'Moved to Thu 15 Oct. Pipeline date updated.')).toHaveText('Undo');
  await expect.poll(() => titlesOn(panel, '2026-10-15')).toContain('Thank you note');
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toHaveLength(1);

  // F15: closing hands focus back to the card's Open plan.
  await panel.locator('[data-plan-close]').click();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Pipeline shows the post on Thu 15 Oct.
  await page.goto('/pipeline');
  const title = page.getByText('Thank you note', { exact: true }).first();
  await expect(title).toBeVisible({ timeout: 15_000 });
  await expect(title.locator('xpath=..')).toContainText('Oct 15, 2026');
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
  // F9: it follows its row on scroll (it stays against its button, below or above).
  const adjacent = async (): Promise<boolean> => {
    const c = await calendar.boundingBox();
    const p = await pop.boundingBox();
    if (c === null || p === null) return false;
    const below = Math.abs(p.y - (c.y + c.height + 4)) <= 1;
    const above = Math.abs(p.y + p.height - (c.y - 4)) <= 1;
    // Capped at the viewport's 8px edge above it: still clear of its button.
    const capped = Math.abs(p.y - 8) <= 1 && p.y + p.height <= c.y - 3;
    return below || above || capped;
  };
  expect(await adjacent()).toBe(true);
  await listBody(panel).evaluate((el) => {
    el.scrollTop += 40;
  });
  await expect.poll(adjacent).toBe(true);
  await pop.locator('[data-plan-popover-day="2026-10-16"]').click();
  await expect(pop).toHaveCount(0);
  // D2: a concept, no Pipeline mention, Undo.
  await expect(undoOf(page, 'Moved to Fri 16 Oct.')).toHaveText('Undo');
  await expect
    .poll(() => titlesOn(panel, '2026-10-16'))
    .toEqual(['Rangoli timelapse', 'Lantern workshop']);

  // Popover closes when its row scrolls out of the list's view.
  await calendar.click();
  await expect(pop).toBeVisible();
  await listBody(panel).evaluate((el) => {
    el.scrollTop = 0;
  });
  await listBody(panel).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(pop).toHaveCount(0);

  // Dustbin: hidden at once, the write waits for the toast; focus moves on; Undo puts it back.
  const prayers = dated('Morning prayers');
  const pw = panel.locator(`[data-plan-row-wrap="${prayers.id}"]`);
  await pw.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await pw.locator('[data-plan-row-bin]').click();
  await expect(page.getByText('Removed from plan')).toBeVisible();
  await expect(panel.locator(`[data-plan-row="${prayers.id}"]`)).toHaveCount(0);
  // F8: Wed is now empty: focus is on Wed's Add.
  await expect
    .poll(() => focusedIs(page, '[data-plan-day="2026-10-14"] [data-plan-add]'))
    .toBe(true);
  await undoOf(page, 'Removed from plan').click();
  await expect(panel.locator(`[data-plan-row="${prayers.id}"]`)).toHaveCount(1);
  // F8: on Undo focus returns to the restored row.
  await expect.poll(() => focusedIs(page, `button[data-plan-row="${prayers.id}"]`)).toBe(true);
  await page.waitForTimeout(400);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_remove')).toEqual([]);

  // Right-click: the same days plus Remove from plan (danger); Esc closes only the menu.
  await panel.locator(`[data-plan-row="${prayers.id}"]`).click({ button: 'right' });
  const menu = page.locator('[data-plan-day-popover="menu"]');
  await expect(menu.locator('[data-plan-popover-remove]')).toHaveText('Remove from plan');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(panel).toBeVisible();
  // Menu Remove: focus goes to the next row (Wed is empty after it: its Add).
  await panel.locator(`[data-plan-row="${prayers.id}"]`).click({ button: 'right' });
  await menu.locator('[data-plan-popover-remove]').click();
  await expect
    .poll(() => focusedIs(page, '[data-plan-day="2026-10-14"] [data-plan-add]'))
    .toBe(true);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
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
  await expect(page.locator('[data-plan-page="item"]')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Thu 15 Oct, position 1');
  await page.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Thu 15 Oct, position 2');
  await page.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Thu 15 Oct, position 3');
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toEqual([]);
  await page.keyboard.press('Space');
  await expect(live).toHaveText('Dropped');
  await expect
    .poll(() => titlesOn(panel, '2026-10-15'))
    .toEqual(['Sweets flatlay', 'Morning prayers', 'Lantern workshop']);
  await expect(undoOf(page, 'Moved to Thu 15 Oct.')).toHaveText('Undo');
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

  // Delete on another row: focus moves to the next row; Undo restores it, nothing sent.
  const sweets = dated('Sweets flatlay');
  const prayers = dated('Morning prayers');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(panel.locator(`button[data-plan-row="${sweets.id}"]`)).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(page.getByText('Removed from plan')).toBeVisible();
  await expect(panel.locator(`[data-plan-row="${sweets.id}"]`)).toHaveCount(0);
  await expect(panel.locator(`button[data-plan-row="${prayers.id}"]`)).toBeFocused();
  await undoOf(page, 'Removed from plan').click();
  await expect(panel.locator(`[data-plan-row="${sweets.id}"]`)).toHaveCount(1);
  await expect(panel.locator(`button[data-plan-row="${sweets.id}"]`)).toBeFocused();
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_remove')).toEqual([]);

  // Enter opens the focused row's item in the same panel; Escape steps back to the list.
  const scroll = listBody(panel);
  const at = await scroll.evaluate((el) => el.scrollTop);
  await page.keyboard.press('Enter');
  const item = page.locator('[data-plan-page="item"]');
  await expect(item).toBeVisible();
  expect(await item.boundingBox()).toEqual({ x: 840, y: 0, width: 440, height: 800 });
  await page.keyboard.press('Escape');
  await expect(item).toHaveCount(0);
  await expect(panel).toBeVisible();
  expect(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - at)).toBeLessThanOrEqual(1);
  // Focus is back on the row that opened it.
  await expect(panel.locator(`button[data-plan-row="${sweets.id}"]`)).toBeFocused();
  expectClean(network);
});

test('F3: a pick-up cancels when focus leaves its row (Tab, a click in the chat, Space on another row) @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  const live = panel.locator('[data-plan-live]');
  const lantern = panel.locator(`button[data-plan-row="${dated('Lantern workshop').id}"]`);
  const thu = () => titlesOn(panel, '2026-10-15');
  const before = await thu();

  // Tab away.
  await lantern.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await expect(live).toHaveText('Thu 15 Oct, position 1');
  await page.keyboard.press('Tab');
  await expect(live).toHaveText('Move cancelled');
  await expect(panel.locator('[data-plan-row-picked]')).toHaveCount(0);
  expect(await thu()).toEqual(before);

  // A click in the chat.
  await lantern.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await expect(panel.locator('[data-plan-row-picked]')).toHaveCount(1);
  await page
    .locator('[data-msg-id]')
    .last()
    .click({ position: { x: 4, y: 4 } });
  await expect(panel.locator('[data-plan-row-picked]')).toHaveCount(0);
  expect(await thu()).toEqual(before);

  // Another row: reaching it puts the first back; Space there picks up that row only.
  await lantern.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  const sweets = panel.locator(`button[data-plan-row="${dated('Sweets flatlay').id}"]`);
  await sweets.focus();
  await expect(live).toHaveText('Move cancelled');
  await expect(panel.locator('[data-plan-row-picked]')).toHaveCount(0);
  expect(await thu()).toEqual(before);
  await page.keyboard.press('Space');
  await expect(panel.locator('[data-plan-row-picked]')).toHaveCount(1);
  await expect(sweets).toHaveAttribute('data-plan-row-picked', '');
  await page.keyboard.press('Escape');
  await expect(panel.locator('[data-plan-row-picked]')).toHaveCount(0);
  expect(await thu()).toEqual(before);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toEqual([]);
  expectClean(network);
});

test('F4: a move that resets ticks says so and has no Undo @desktop', async ({ page }) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  // Sweets flatlay (a post) carries a team tick: moving it resets it.
  const sweets = dated('Sweets flatlay');
  await panel.locator(`[data-plan-row-wrap="${sweets.id}"] [data-plan-row-calendar]`).click();
  await page.locator('[data-plan-popover-day="2026-10-16"]').click();
  const text = 'Moved to Fri 16 Oct. Pipeline date updated. Its ticks were reset.';
  await expect(toastOf(page, text)).toBeVisible();
  await expect(undoOf(page, text)).toHaveCount(0);
  expectClean(network);
});

test('F1: Escape in the chat beside the panel never closes it @desktop', async ({ page }) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  // The composer.
  const composer = page.locator('textarea').first();
  await composer.click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeVisible();
  // The status drawer: Escape closes the drawer only.
  const bar = page.locator('button[aria-expanded]').filter({ hasText: /Plan/ }).first();
  if ((await bar.count()) > 0) {
    await bar.click();
    await expect(bar).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(bar).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeVisible();
  }
  // A chat surface with role dialog (the reply thread or a sheet): Escape is its own.
  await page.locator('body').evaluate((el) => (el as HTMLElement).focus());
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // Nothing else open and focus on the page: Escape closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expectClean(network);
});

test('F2: Escape inside the panel never reaches the chat (status drawer stays open) @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const bar = page.locator('button[aria-expanded]').filter({ hasText: /Plan/ }).first();
  test.skip((await bar.count()) === 0, 'no status ticker in this chat');
  await bar.click();
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  const { panel } = await openPanel(page);
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  // Rename field: Escape cancels the rename only.
  await panel.locator('[data-plan-title-menu]').click();
  await panel.locator('[data-plan-menu-rename]').click();
  await expect(panel.locator('[data-plan-rename-input]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel.locator('[data-plan-rename-input]')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  // A row's popover: Escape closes it only.
  await panel.locator('[data-plan-row-calendar]').first().click();
  await expect(page.locator('[data-plan-day-popover]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-plan-day-popover]')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  // A row: Escape closes the panel, and still not the drawer.
  await panel.locator('button[data-plan-row]').first().focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
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

for (const size of [
  { width: 1280, height: 800, panel: 440, list: 'clear' },
  { width: 1024, height: 768, panel: 440, list: 'clear' },
  { width: 900, height: 768, panel: 360, list: 'clear' },
  { width: 800, height: 768, panel: 360, list: 'hidden' },
] as const) {
  test(`D1: at ${size.width}px the panel is ${size.panel}px; channel list ${size.list}; nothing clips @desktop`, async ({
    page,
  }) => {
    laptopOnly(page);
    test.setTimeout(120_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    const network = await installHarnessNetwork(page);
    seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
    await openChat(page);
    // The channel list's own scroll, kept across open and close.
    const column = channelColumn(page);
    const listScroller = column.locator('xpath=.//*[contains(@class,"overflow-y-auto")][1]');
    const hasScroller = (await listScroller.count()) > 0;
    if (hasScroller) await listScroller.evaluate((el) => (el.scrollTop = 30));
    const listTop = hasScroller ? await listScroller.evaluate((el) => el.scrollTop) : 0;
    const { panel, boxes } = await openPanel(page);
    expect(new Set(boxes)).toEqual(new Set([`${size.panel}x${size.height}`]));
    const pb = await panel.boundingBox();
    expect(pb).toEqual({
      x: size.width - size.panel,
      y: 0,
      width: size.panel,
      height: size.height,
    });
    // Shadow on the left edge while it overlays; none from 1180px.
    const shadow = await panel.evaluate((el) => getComputedStyle(el).boxShadow);
    if (size.width >= 1180) expect(shadow).toBe('none');
    else expect(shadow).toMatch(/-12px 0px 24px -12px/);
    // Left edge only: a negative x offset and a spread that hides the other sides.
    if (size.width < 1180) expect(shadow).not.toMatch(/ 0px 0px 0px 0px/);
    if (size.list === 'clear') {
      await expect(column).toBeVisible();
      const cb = await column.boundingBox();
      expect((cb?.x ?? 0) + (cb?.width ?? 0)).toBeLessThanOrEqual(size.width - size.panel);
    } else {
      await expect(column).toBeHidden();
      // The thread stays beside the panel.
      await expect(page.locator('[data-msg-id]').first()).toBeAttached();
    }
    // Rows, row actions and hints fit: actions keep 36x44 inside the panel; the title truncates.
    const wrap = panel.locator('[data-plan-row-wrap]').first();
    const bin = await wrap.locator('[data-plan-row-bin]').boundingBox();
    const tick = await wrap.locator('[data-plan-slot]').boundingBox();
    expect(bin?.width).toBe(36);
    expect(bin?.height).toBe(44);
    expect((tick?.x ?? 0) + (tick?.width ?? 0)).toBeLessThanOrEqual(size.width);
    const hints = panel.locator('[data-plan-key-hints]');
    expect(await hints.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const t of await panel.locator('[data-plan-row-title]').all()) {
      expect(await t.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    }
    // Close: the list returns with its scroll.
    await panel.locator('[data-plan-close]').click();
    await expect(panel).toHaveCount(0);
    await expect(column).toBeVisible();
    if (hasScroller) expect(await listScroller.evaluate((el) => el.scrollTop)).toBe(listTop);
    expectClean(network);
  });
}

test('D1: resizing across 972px switches 440 and 360 at once, no motion @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1000, height: 768 });
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  expect((await panel.boundingBox())?.width).toBe(440);
  await page.setViewportSize({ width: 950, height: 768 });
  expect((await panel.boundingBox())?.width).toBe(360);
  expect(await panel.evaluate((el) => getComputedStyle(el).transitionProperty)).not.toContain(
    'width',
  );
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
  const cb = await channelColumn(page).boundingBox();
  expect((cb?.x ?? 0) + (cb?.width ?? 0)).toBeLessThanOrEqual(584);
  // Focus is on the panel heading: Escape closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expectClean(network);
});

test('F7: Activity stays mounted while a plan opens and closes beside it @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await page.goto('/activity');
  const beside = page.locator('[data-activity-beside]');
  await expect(beside).toBeAttached();
  await page.waitForTimeout(1500);
  // Mark Activity's node and remember its scroll.
  await beside.evaluate((el) => {
    (el.firstElementChild as HTMLElement & { __mark?: number }).__mark = 7;
  });
  // Activity's own reads: none again while the plan opens and closes (no refetch).
  const activityReads: string[] = [];
  page.on('request', (r) => {
    if (/activity/i.test(new URL(r.url()).pathname)) activityReads.push(r.url());
  });
  // Open the plan in place (the router moves, nothing reloads).
  await page.evaluate((id) => {
    window.history.pushState(null, '', `/plans/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, DATED_PLAN_ID);
  const panel = page.locator('[data-plan-page="plan"]');
  await expect(panel.locator('[data-plan-day]').first()).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'complementary');
  expect(
    await beside.evaluate(
      (el) => (el.firstElementChild as HTMLElement & { __mark?: number }).__mark,
    ),
  ).toBe(7);
  // Close: back on Activity, the same node.
  await panel.locator('[data-plan-close]').click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/\/activity$/);
  expect(
    await beside.evaluate(
      (el) => (el.firstElementChild as HTMLElement & { __mark?: number }).__mark,
    ),
  ).toBe(7);
  expect(activityReads).toEqual([]);
  expectClean(network);
});

test('E: phone (iPhone 13) is unchanged: full page, the one-time peek, a real swipe-left Remove, long-press drag', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'phone only');
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page, { planSwipePeek: true });
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

  // The one-time peek on the first open: a row slides left, then back; seen once.
  const peeking = plan.locator('[data-plan-row-swipe][style*="translateX(-72px)"]');
  await expect(peeking).toHaveCount(1, { timeout: 3_000 });
  await expect(peeking).toHaveCount(0, { timeout: 3_000 });
  expect(
    await page.evaluate(() => window.localStorage.getItem('sorted:plan-swipe-peek-seen')),
  ).toBe('1');

  // A real swipe left reveals Remove.
  const offer = dated('Opening offer');
  const swipeRow = plan.locator(`[data-plan-row-swipe="${offer.id}"]`);
  await swipeRow.scrollIntoViewIfNeeded();
  const sb = await swipeRow.boundingBox();
  if (sb === null) throw new Error('row box');
  const y = sb.y + sb.height / 2;
  await page.mouse.move(sb.x + sb.width - 30, y);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width - 80, y, { steps: 4 });
  await page.mouse.move(sb.x + sb.width - 160, y, { steps: 6 });
  await page.mouse.up();
  await expect(swipeRow).toHaveAttribute('data-plan-row-open', '');
  await expect(plan.locator(`[data-plan-row-remove="${offer.id}"]`)).toBeVisible();
  // A tap elsewhere closes it again.
  await plan.locator('[data-plan-progress-block]').click();
  await expect(swipeRow).not.toHaveAttribute('data-plan-row-open', '');

  // Long-press lifts a row; Escape puts it back.
  await page.waitForTimeout(400);
  const row = plan.locator(`[data-plan-row="${dated('Countdown story').id}"]`);
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
