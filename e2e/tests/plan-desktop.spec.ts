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
// width, Escape ownership both ways, Edit mode's grip drag, day chip, right
// click menu and keyboard move with every change queued until Save changes
// (X3), pick-up cancel, removal focus, Activity kept mounted) and the phone (story E: a full page whose Edit
// mode shows the grip, day chip and remove per row; nothing written until Save).
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

type Box = { x: number; y: number; width: number; height: number };

// Sub-pixel layout rounding differs by engine (840.0003 on WebKit, 840.0146 on
// Chromium), so compare each edge within 1px, polling until the box settles.
async function expectBoxNear(locator: Locator, expected: Box, tolerance = 1): Promise<void> {
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        if (!box) return Number.POSITIVE_INFINITY;
        return Math.max(
          Math.abs(box.x - expected.x),
          Math.abs(box.y - expected.y),
          Math.abs(box.width - expected.width),
          Math.abs(box.height - expected.height),
        );
      },
      { message: `boundingBox within ${tolerance}px of ${JSON.stringify(expected)}` },
    )
    .toBeLessThanOrEqual(tolerance);
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

/** Edit mode (X3): the header's Edit button, then the edit header with its fields. */
async function enterEdit(panel: Locator): Promise<void> {
  await panel.locator('[data-plan-edit]').click();
  await expect(panel.locator('[data-plan-edit-header]')).toBeVisible();
}

/** Save changes: the toast, then view mode again. */
async function saveChanges(page: Page, panel: Locator): Promise<void> {
  await panel.locator('[data-plan-save]').click();
  await expect(page.getByText('Plan saved', { exact: true })).toBeVisible();
  await expect(panel.locator('[data-plan-edit-header]')).toHaveCount(0);
}

const saves = (network: HarnessNetwork) => network.rpcCalls.filter((c) => c.name === 'plan_save');
const opsOf = (call: { args: Record<string, unknown> } | undefined) =>
  (call?.args.p_ops ?? []) as Array<Record<string, unknown>>;
const removes = (network: HarnessNetwork) =>
  network.rpcCalls.filter((c) => c.name === 'plan_item_remove');

test('A: the panel docks at full size, opens on today, chat scrolls beside it; in Edit a mouse drag moves a post Tue to Thu, Save writes it, and Pipeline shows Thu @desktop', async ({
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
    // On the plan's last days the list cannot scroll today to the top: it ends first.
    const atEnd = await body.evaluate(
      (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
    );
    if (!atEnd) expect(Math.abs(day.y - top.y)).toBeLessThanOrEqual(2);
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

  // Edit, then drag "Thank you note" (a post) from Tue 13 to Thu 15 by its
  // grip: painted at once, queued; nothing is written until Save changes.
  const post = dated('Thank you note');
  expect(await titlesOn(panel, '2026-10-13')).toContain('Thank you note');
  await expect(panel.locator('[data-plan-grip]')).toHaveCount(0);
  await enterEdit(panel);
  await gripDrag(page, panel, post.id, async () => {
    const first = await dayBlock(panel, '2026-10-15')
      .locator('[data-plan-row-wrap]')
      .first()
      .boundingBox();
    if (first === null) throw new Error('target');
    return first.y + first.height / 4; // upper quarter: above its middle at any line height
  });
  await expect.poll(() => titlesOn(panel, '2026-10-15')).toContain('Thank you note');
  expect(saves(network)).toEqual([]);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toEqual([]);
  await saveChanges(page, panel);
  expect(saves(network)).toHaveLength(1);
  expect(opsOf(saves(network)[0])).toEqual([
    expect.objectContaining({ op: 'move', item_id: post.id, target_date: '2026-10-15' }),
  ]);
  await expect.poll(() => titlesOn(panel, '2026-10-15')).toContain('Thank you note');

  // F15: closing hands focus back to the card's Open plan.
  await panel.locator('[data-plan-close]').click();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Pipeline shows the post on Thu 15 Oct.
  await page.goto('/pipeline');
  const title = page.getByText('Thank you note', { exact: true }).first();
  await expect(title).toBeVisible({ timeout: 15_000 });
  await expect(title.locator('xpath=..')).toContainText('15 Oct');
  expectClean(network);
});

test('B: Edit: reorder inside Wed by the grip, the day chip moves one to Fri, remove hides one; Discard restores it all; Save writes the queue once @desktop', async ({
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
  const lantern = dated('Lantern workshop');
  const prayers = dated('Morning prayers');
  const lanternRow = panel.locator(`[data-plan-row="${lantern.id}"]`);
  const prayersRow = panel.locator(`[data-plan-row="${prayers.id}"]`);
  await enterEdit(panel);

  const reorder = async (): Promise<void> => {
    await gripDrag(page, panel, prayers.id, async () => {
      const first = await dayBlock(panel, '2026-10-14')
        .locator('[data-plan-row-wrap]')
        .first()
        .boundingBox();
      if (first === null) throw new Error('target');
      return first.y + first.height / 4; // upper quarter: above its middle at any line height
    });
    await expect
      .poll(() => titlesOn(panel, '2026-10-14'))
      .toEqual(['Morning prayers', 'Lantern workshop']);
  };
  await reorder();

  // The day chip (44px) and the remove (44x44) sit on the row's bottom line,
  // the chip left and the remove right, under the title; the chip opens the
  // day picker with the plan's days, their counts and the current day marked.
  // Picking Fri moves the row at once (queued).
  const lanternWrap = panel.locator(`[data-plan-row-wrap="${lantern.id}"]`);
  const chip = lanternWrap.locator('[data-plan-row-day-chip]');
  const remove = lanternWrap.locator('[data-plan-row-remove-edit]');
  const chipBox = await chip.boundingBox();
  expectMinTouchTarget(chipBox);
  const removeBox = await remove.boundingBox();
  expect(removeBox?.width).toBe(44);
  expect(removeBox?.height).toBe(44);
  const titleBox = await lanternWrap.locator('[data-plan-row-title]').boundingBox();
  expect((chipBox?.x ?? 0) + (chipBox?.width ?? 0)).toBeLessThanOrEqual(removeBox?.x ?? 0);
  expect(Math.round(chipBox?.y ?? 0)).toBe(Math.round(removeBox?.y ?? 0));
  expect(chipBox?.y ?? 0).toBeGreaterThan((titleBox?.y ?? 0) + (titleBox?.height ?? 0));
  await expect(chip).toHaveText(/Wed 14/);
  const moveToFri = async (): Promise<void> => {
    await chip.click();
    const picker = page.locator('[data-plan-day-picker]');
    await expect(picker).toBeVisible();
    await expect(picker.locator('[data-plan-day-tile="2026-10-14"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(picker.locator('[data-plan-day-tile="2026-10-14"]')).toContainText('2 items');
    await picker.locator('[data-plan-day-tile="2026-10-16"]').click();
    await expect(picker).toBeHidden();
    await expect
      .poll(() => titlesOn(panel, '2026-10-16'))
      .toEqual(['Rangoli timelapse', 'Lantern workshop']);
    await expect(chip).toHaveText(/Fri 16/);
  };
  await moveToFri();
  expect(saves(network)).toEqual([]);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toEqual([]);

  // Remove: hidden at once, nothing sent; F8: focus moves to a row, never the page.
  const pw = panel.locator(`[data-plan-row-wrap="${prayers.id}"]`);
  await pw.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await pw.locator('[data-plan-row-remove-edit]').click();
  await expect(prayersRow).toHaveCount(0);
  await expect(page.getByText('Removed from plan')).toHaveCount(0);
  await expect.poll(() => focusedIs(page, 'button[data-plan-row]')).toBe(true);
  expect(removes(network)).toEqual([]);

  // Right-click: the same days plus Remove from plan (danger); Esc closes
  // only the menu; its Remove queues too.
  await lanternRow.click({ button: 'right' });
  const menu = page.locator('[data-plan-day-popover="menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-plan-popover-day="2026-10-16"]')).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(menu.locator('[data-plan-popover-remove]')).toHaveText('Remove from plan');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-plan-edit-header]')).toBeVisible();
  await lanternRow.click({ button: 'right' });
  await menu.locator('[data-plan-popover-remove]').click();
  await expect(lanternRow).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);

  // Cancel asks; Discard puts everything back as it was; nothing was sent.
  await panel.locator('[data-plan-back-text]').click();
  const discard = page.getByRole('alertdialog', { name: 'Discard changes?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(discard).toBeHidden();
  await expect(panel.locator('[data-plan-edit-header]')).toHaveCount(0);
  expect(await titlesOn(panel, '2026-10-14')).toEqual(['Lantern workshop', 'Morning prayers']);
  expect(await titlesOn(panel, '2026-10-16')).toEqual(['Rangoli timelapse']);
  await page.waitForTimeout(400);
  expect(saves(network)).toEqual([]);
  expect(removes(network)).toEqual([]);

  // The same three edits, then Save: one plan_save with the ops in order.
  await enterEdit(panel);
  await reorder();
  await moveToFri();
  await pw.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await pw.locator('[data-plan-row-remove-edit]').click();
  await expect(prayersRow).toHaveCount(0);
  await saveChanges(page, panel);
  expect(saves(network)).toHaveLength(1);
  const ops = opsOf(saves(network)[0]);
  expect(ops.map((op) => op.op)).toEqual(['move', 'move', 'remove']);
  expect(ops[0]).toMatchObject({ item_id: prayers.id, target_date: '2026-10-14' });
  expect(ops[1]).toMatchObject({ item_id: lantern.id, target_date: '2026-10-16' });
  expect(ops[2]).toMatchObject({ item_id: prayers.id });
  await expect
    .poll(() => titlesOn(panel, '2026-10-16'))
    .toEqual(['Rangoli timelapse', 'Lantern workshop']);
  expect(await titlesOn(panel, '2026-10-14')).toEqual([]);
  expect(removes(network)).toEqual([]);
  // Persisted: the same list after a reload.
  await page.reload();
  await openChat(page);
  const { panel: reopened } = await openPanel(page);
  expect(await titlesOn(reopened, '2026-10-16')).toEqual(['Rangoli timelapse', 'Lantern workshop']);
  expect(await titlesOn(reopened, '2026-10-14')).toEqual([]);
  expect(saves(network)).toHaveLength(1);
  expectClean(network);
});

test('C: keyboard only (Edit): Space picks up, Down x3 crosses into the next day, Space drops; Delete hides; Save writes both @desktop', async ({
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
  // The keyboard move is Edit mode's: no hints and no pick-up in view mode.
  await expect(panel.locator('[data-plan-key-hints]')).toHaveCount(0);
  await enterEdit(panel);
  await expect(panel.locator('[data-plan-key-hints]')).toHaveText(
    'Drag handle to move · Space pick up, arrows move, Space drop · Del remove',
  );

  const row = panel.locator(`button[data-plan-row="${lantern.id}"]`);
  await row.focus();
  await expect(row).toBeFocused();
  await expect(panel.locator(`[data-plan-row-wrap="${lantern.id}"] [data-plan-grip]`)).toHaveCSS(
    'opacity',
    '1',
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
  expect(saves(network)).toEqual([]);
  await page.keyboard.press('Space');
  await expect(live).toHaveText('Dropped');
  await expect
    .poll(() => titlesOn(panel, '2026-10-15'))
    .toEqual(['Sweets flatlay', 'Morning prayers', 'Lantern workshop']);
  // Queued, not written: no toast, no request.
  await expect(page.getByText(/^Moved to/)).toHaveCount(0);
  expect(saves(network)).toEqual([]);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_item_move')).toEqual([]);
  await expect(row).toBeFocused();

  // Escape mid pick-up restores, and the panel stays in Edit.
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(live).toHaveText('Move cancelled');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-plan-edit-header]')).toBeVisible();
  expect(await titlesOn(panel, '2026-10-15')).toEqual([
    'Sweets flatlay',
    'Morning prayers',
    'Lantern workshop',
  ]);

  // Delete on another row: hidden at once, focus moves to the next row; nothing sent.
  const sweets = dated('Sweets flatlay');
  const prayers = dated('Morning prayers');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(panel.locator(`button[data-plan-row="${sweets.id}"]`)).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(panel.locator(`[data-plan-row="${sweets.id}"]`)).toHaveCount(0);
  await expect(page.getByText('Removed from plan')).toHaveCount(0);
  await expect(panel.locator(`button[data-plan-row="${prayers.id}"]`)).toBeFocused();
  expect(removes(network)).toEqual([]);

  // Save: one plan_save with the move and the remove, in order.
  await saveChanges(page, panel);
  expect(saves(network)).toHaveLength(1);
  const ops = opsOf(saves(network)[0]);
  expect(ops.map((op) => op.op)).toEqual(['move', 'remove']);
  expect(ops[0]).toMatchObject({ item_id: lantern.id, target_date: '2026-10-15' });
  expect(ops[1]).toMatchObject({ item_id: sweets.id });
  expect(removes(network)).toEqual([]);
  await expect
    .poll(() => titlesOn(panel, '2026-10-15'))
    .toEqual(['Morning prayers', 'Lantern workshop']);

  // View mode again: Enter opens the focused row's item in the same panel;
  // Escape steps back to the list with its scroll and focus kept.
  const prayersRow = panel.locator(`button[data-plan-row="${prayers.id}"]`);
  await prayersRow.focus();
  const scroll = listBody(panel);
  const at = await scroll.evaluate((el) => el.scrollTop);
  await page.keyboard.press('Enter');
  const item = page.locator('[data-plan-page="item"]');
  await expect(item).toBeVisible();
  await expectBoxNear(item, { x: 840, y: 0, width: 440, height: 800 });
  await page.keyboard.press('Escape');
  await expect(item).toHaveCount(0);
  await expect(panel).toBeVisible();
  expect(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - at)).toBeLessThanOrEqual(1);
  await expect(prayersRow).toBeFocused();
  // Persisted: the same list after a reload.
  await page.reload();
  await openChat(page);
  const { panel: reopened } = await openPanel(page);
  expect(await titlesOn(reopened, '2026-10-15')).toEqual(['Morning prayers', 'Lantern workshop']);
  await expect(reopened.locator(`[data-plan-row="${sweets.id}"]`)).toHaveCount(0);
  expect(saves(network)).toHaveLength(1);
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
  await enterEdit(panel);
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
  expect(saves(network)).toEqual([]);
  expectClean(network);
});

test('F4: a move that resets ticks is queued by the day chip and written by Save; the ticks reset then @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  // Sweets flatlay (a post) carries a team tick: moving it resets it on Save.
  const sweets = dated('Sweets flatlay');
  const reviews = () =>
    (network.world.tables.plan_item_reviews ?? []).filter((r) => r.item_id === sweets.id);
  expect(reviews().some((r) => r.status === 'approved')).toBe(true);
  await enterEdit(panel);
  await panel.locator(`[data-plan-row-wrap="${sweets.id}"] [data-plan-row-day-chip]`).click();
  const picker = page.locator('[data-plan-day-picker]');
  await expect(picker).toBeVisible();
  await picker.locator('[data-plan-day-tile="2026-10-16"]').click();
  await expect(picker).toBeHidden();
  await expect.poll(() => titlesOn(panel, '2026-10-16')).toContain('Sweets flatlay');
  // Nothing written, no toast, the tick still stored.
  await expect(page.getByText(/^Moved to/)).toHaveCount(0);
  expect(saves(network)).toEqual([]);
  expect(reviews().some((r) => r.status === 'approved')).toBe(true);
  await saveChanges(page, panel);
  expect(opsOf(saves(network)[0])).toEqual([
    expect.objectContaining({
      op: 'move',
      item_id: sweets.id,
      target_date: '2026-10-16',
      keep_reviews: false,
    }),
  ]);
  expect(reviews().every((r) => r.status === 'waiting')).toBe(true);
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
  // Edit mode: a row's day picker: Escape closes it only; the next Escape
  // is Cancel (nothing changed: straight back to view mode), the panel stays.
  await enterEdit(panel);
  await panel.locator('[data-plan-row-day-chip]').first().click();
  await expect(page.locator('[data-plan-day-picker]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-plan-day-picker]')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  await panel.locator('button[data-plan-row]').first().focus();
  await page.keyboard.press('Escape');
  await expect(panel.locator('[data-plan-edit-header]')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  // A row in view mode: Escape closes the panel, and still not the drawer.
  await panel.locator('button[data-plan-row]').first().focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  expectClean(network);
});

test('D: a client at 1280 sees no Edit, grip, day chip, remove, menu or hints; OK shows its toast @desktop', async ({
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
      '[data-plan-grip], [data-plan-edit], [data-plan-row-day-chip], [data-plan-row-remove-edit], [data-plan-key-hints], [data-plan-add], [data-plan-add-header]',
    ),
  ).toHaveCount(0);
  const concept = dated('Rangoli timelapse');
  await panel.locator(`[data-plan-row="${concept.id}"]`).click({ button: 'right' });
  await expect(page.locator('[data-plan-day-popover]')).toHaveCount(0);
  const wrap = panel.locator(`[data-plan-row-wrap="${concept.id}"]`);
  await expect(wrap.locator('[data-plan-control]')).toHaveAttribute('data-plan-control', 'switch');
  await wrap.locator('[data-plan-ok]').click();
  const pill = wrap.locator('[data-plan-control]');
  await expect(pill).toHaveAttribute('data-plan-control', 'pill');
  await expect(pill).toHaveText('OK');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  expectClean(network);
});

for (const size of [
  // From 1440px all three panes show; 1180 to 1439px the thread takes the list's place.
  { width: 1440, height: 900, panel: 440, list: 'clear' },
  { width: 1280, height: 800, panel: 440, list: 'hidden' },
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
    // Rows fit: the PLAN line and the thumbnail inside the panel in view mode;
    // in Edit the day chip and the 44x44 remove fit on the bottom line, the
    // hints line never scrolls, and the title clamps to two lines.
    const wrap = panel.locator('[data-plan-row-wrap]').first();
    const tick = await wrap.locator('[data-plan-control]').boundingBox();
    expect((tick?.x ?? 0) + (tick?.width ?? 0)).toBeLessThanOrEqual(size.width);
    const thumb = await wrap.locator('[data-plan-row-tile]').boundingBox();
    expect((thumb?.x ?? 0) + (thumb?.width ?? 0)).toBeLessThanOrEqual(size.width);
    await enterEdit(panel);
    const remove = await wrap.locator('[data-plan-row-remove-edit]').boundingBox();
    expect(remove?.width).toBe(44);
    expect(remove?.height).toBe(44);
    expect(remove?.x).toBeGreaterThanOrEqual(size.width - size.panel);
    expect((remove?.x ?? 0) + (remove?.width ?? 0)).toBeLessThanOrEqual(size.width);
    const chip = await wrap.locator('[data-plan-row-day-chip]').boundingBox();
    expect(chip?.x).toBeGreaterThanOrEqual(size.width - size.panel);
    const hints = panel.locator('[data-plan-key-hints]');
    expect(await hints.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const t of await panel.locator('[data-plan-row-title]').all()) {
      expect(
        await t.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-line-clamp')),
      ).toBe('2');
    }
    // Cancel with nothing changed: straight back to view mode.
    await panel.locator('[data-plan-back-text]').click();
    await expect(panel.locator('[data-plan-edit-header]')).toHaveCount(0);
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

test('F7: Notifications stays mounted while a plan opens and closes beside it @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await page.goto('/notifications');
  const beside = page.locator('[data-plan-beside]');
  await expect(beside).toBeAttached();
  await page.waitForTimeout(1500);
  // Mark the Notifications node and remember its scroll.
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
  // Close: back on Notifications, the same node.
  await panel.locator('[data-plan-close]').click();
  await expect(panel).toHaveCount(0);
  await expect(page).toHaveURL(/\/notifications$/);
  expect(
    await beside.evaluate(
      (el) => (el.firstElementChild as HTMLElement & { __mark?: number }).__mark,
    ),
  ).toBe(7);
  expect(activityReads).toEqual([]);
  expectClean(network);
});

test('E: phone (iPhone 13): full page; view mode has no edit controls; Edit shows the grip, day chip and remove per row; a grip drag lifts and Escape puts it back; a remove is discarded with no write', async ({
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
  // Full page once its open settles (the enter motion can still be on its
  // last sub-pixel when the first day row shows).
  await expect.poll(async () => (await plan.boundingBox())?.width).toBe(vp?.width);
  await expect.poll(async () => (await plan.boundingBox())?.height).toBe(vp?.height);
  // View mode (X3): no grip, no day chip, no remove, no swipe; no laptop hints or close.
  await expect(
    plan.locator(
      '[data-plan-grip], [data-plan-row-day-chip], [data-plan-row-remove-edit], [data-plan-row-swipe], [data-plan-key-hints], [data-plan-close]',
    ),
  ).toHaveCount(0);

  // Edit: every row gets its grip, day chip and remove; still no laptop extras.
  await plan.locator('[data-plan-edit]').click();
  await expect(plan.locator('[data-plan-edit-header]')).toBeVisible();
  await expect(plan.locator('[data-plan-key-hints], [data-plan-close]')).toHaveCount(0);
  const offer = dated('Opening offer');
  const wrap = plan.locator(`[data-plan-row-wrap="${offer.id}"]`);
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(wrap.locator('[data-plan-grip]')).toBeVisible();
  await expect(wrap.locator('[data-plan-row-day-chip]')).toHaveText(/Mon 12/);
  await expect(wrap.locator('[data-plan-row-remove-edit]')).toBeVisible();

  // The grip lifts the row after 4px of travel; Escape puts it back; nothing written.
  const grip = await wrap.locator('[data-plan-grip]').boundingBox();
  if (grip === null) throw new Error('grip box');
  const gx = grip.x + grip.width / 2;
  const gy = grip.y + grip.height / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx, gy + 6);
  await expect(page.locator('[data-plan-drag-card]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-plan-drag-card]')).toHaveCount(0);
  await expect(dayBlock(plan, '2026-10-12').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );

  // Remove hides the row at once; Cancel asks; Discard puts it back; no request.
  await wrap.locator('[data-plan-row-remove-edit]').click();
  await expect(wrap).toHaveCount(0);
  await plan.locator('[data-plan-back-text]').click();
  const discard = page.getByRole('alertdialog', { name: 'Discard changes?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(discard).toBeHidden();
  await expect(plan.locator('[data-plan-edit-header]')).toHaveCount(0);
  await expect(dayBlock(plan, '2026-10-12').locator(`[data-plan-row="${offer.id}"]`)).toHaveCount(
    1,
  );
  expect(
    network.rpcCalls.filter((c) =>
      ['plan_save', 'plan_item_remove', 'plan_item_move'].includes(c.name),
    ),
  ).toEqual([]);
  expectClean(network);
});

test('H: the panel header keeps the phone layout: 28px title on line 1, boxed Add then Edit on line 2 on the 16px edge, at 440 and 360 @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  const line1 = panel.locator('[data-plan-header-line="1"]');
  const line2 = panel.locator('[data-plan-header-line="2"]');
  await expect(line1.locator('[data-plan-title-menu] h2')).toHaveCSS('font-size', '28px');
  await expect(line1.locator('[data-plan-add-header], [data-plan-edit]')).toHaveCount(0);
  for (const width of [1280, 950]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await panel.boundingBox();
    const add = await line2.locator('[data-plan-add-header] [data-plan-header-box]').boundingBox();
    const edit = await line2.locator('[data-plan-edit] [data-plan-header-box]').boundingBox();
    if (box === null || add === null || edit === null) throw new Error('boxes');
    expect(add.x + add.width).toBeLessThan(edit.x);
    expect(Math.round(box.x + box.width - (edit.x + edit.width))).toBe(16);
    expect(Math.round(edit.height)).toBe(34);
  }
  await line2.locator('[data-plan-edit]').click();
  await expect(panel.locator('[data-plan-edit-header]')).toBeVisible();
  expectClean(network);
});
