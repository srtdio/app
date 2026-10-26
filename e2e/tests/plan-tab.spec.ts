import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  ME,
  PEER,
  TAB_DRAFT_ITEM_TITLE,
  TAB_DRAFT_PLAN_ID,
  TAB_DRAFT_PLAN_TITLE,
  TAB_MOVE_ITEM_ID,
  TAB_MOVE_ITEM_TITLE,
  TAB_OK_ITEM_TITLE,
  TAB_SHARED_PLAN_ID,
  TAB_SHARED_PLAN_TITLE,
  civilPlus,
  mondayOf,
  seedPlanTab,
} from '../fixtures/chat-data';
import { expectAllVisibleControlsTouchSized, expectMinTouchTarget } from '../helpers/touch-target';

// The Plan tab (/plan). Phone: the plans as cards in sections, a tap opens
// the plan's own screen full page. Laptop (@desktop, desktop-webkit): the
// Month view with the plans' chips and the legend, then Week, a chip filter,
// a mouse drag of one item to another day (plan_item_move after the Undo
// toast), and the empty-day menu listing only the plans that cover that day;
// an approver sees no Draft, no New plan and no menu; Load more under the
// calendar while more than a page (12) of plans overlaps the month. Screenshots in light
// and dark for each (the light ones run @theme). The fixture clock is the
// real one: the plans sit on this week and next (UTC, the workspace zone).

const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const MONDAY = mondayOf(NOW);
/** A day of this week other than today (the drag's target). */
const OTHER_DAY = TODAY === MONDAY ? civilPlus(TODAY, 1) : civilPlus(TODAY, -1);

function laptopOnly(page: Page): void {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'laptop only');
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

const day = (page: Page, d: string): Locator => page.locator(`[data-plan-tab-day="${d}"]`);
const entry = (page: Page, id: string): Locator =>
  page.locator(`[data-plan-tab-entry="item:${id}"]`);

async function openTab(page: Page): Promise<void> {
  await page.goto('/plan');
  await expect(
    page.locator('[data-plan-tab-chip="all"], [data-plan-tab-list]').first(),
  ).toBeVisible({
    timeout: 15_000,
  });
}

/** A full-page screenshot in the current scheme, then in the other one, then back. */
async function shootBoth(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  const info = test.info();
  const light = info.project.use.colorScheme === 'light' || info.project.use.colorScheme == null;
  const isDark = (): Promise<boolean> =>
    page.evaluate(() => document.documentElement.classList.contains('dark'));
  const switchTo = async (scheme: 'light' | 'dark'): Promise<void> => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await ready();
    await expect.poll(isDark).toBe(scheme === 'dark');
  };
  await page.screenshot({ path: info.outputPath(`${name}-${light ? 'light' : 'dark'}.png`) });
  await switchTo(light ? 'dark' : 'light');
  await page.screenshot({ path: info.outputPath(`${name}-${light ? 'dark' : 'light'}.png`) });
  await switchTo(light ? 'light' : 'dark');
}

test('phone: the Plan tab lists plans in sections and a tap opens the plan @theme', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'phone only');
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: ME });
  await openTab(page);

  const list = page.locator('[data-plan-tab-list]');
  const thisWeek = list.locator('[data-plan-tab-section="this"]');
  await expect(thisWeek).toContainText('This week');
  await expect(thisWeek.locator(`[data-plan-tab-card="${TAB_SHARED_PLAN_ID}"]`)).toContainText(
    TAB_SHARED_PLAN_TITLE,
  );
  await expect(thisWeek.locator(`[data-plan-tab-card="${TAB_SHARED_PLAN_ID}"]`)).toContainText(
    '1 of 3 OK',
  );
  const draft = thisWeek.locator(`[data-plan-tab-card="${TAB_DRAFT_PLAN_ID}"]`);
  await expect(draft.locator('[data-plan-tab-draft]')).toHaveText('Draft');
  await expect(draft).toContainText('1 item · only your team sees this');
  const add = page.locator('[data-plan-tab-new]');
  await expect(add).toHaveText('New plan');
  expectMinTouchTarget(await add.boundingBox(), { dimension: 'height' });

  await shootBoth(page, 'plan-tab-phone', async () => {
    await expect(page.locator('[data-plan-tab-list]')).toBeVisible({ timeout: 15_000 });
  });

  await page.locator(`[data-plan-tab-card="${TAB_SHARED_PLAN_ID}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/plan/${TAB_SHARED_PLAN_ID}$`));
  await expect(page.locator('[data-plan-page="plan"]')).toBeVisible();
  await expect(page.locator('[data-plan-tab-list]')).toHaveCount(0);
  expectClean(network);
});

test('phone: Load more ends the list while older plans remain, then appends them @theme', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'phone only');
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: ME });
  // 14 older shared plans, a week apart: with the two of this week that is 16,
  // so the first page (12, newest starts_on first) leaves 4 for Load more.
  const template = (network.world.tables.plans ?? []).find((p) => p.id === TAB_SHARED_PLAN_ID);
  const older = Array.from({ length: 14 }, (_, k) => {
    const starts = civilPlus(MONDAY, -7 * (k + 1));
    return {
      ...template,
      id: `0190fa00-0000-7000-8000-${String(k).padStart(12, '0')}`,
      title: `Older plan ${k + 1}`,
      starts_on: starts,
      ends_on: civilPlus(starts, 6),
    };
  });
  (network.world.tables.plans ??= []).push(...older);
  await openTab(page);

  const list = page.locator('[data-plan-tab-list]');
  const more = list.locator('[data-plan-tab-load-more]');
  await expect(list.locator('[data-plan-tab-card]')).toHaveCount(12);
  await expect(more).toHaveText('Load more');
  expectMinTouchTarget(await more.boundingBox());
  const firstCall = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read');
  expect(firstCall).toHaveLength(1);
  expect(firstCall[0]?.args.p_before_starts_on).toBeUndefined();

  await shootBoth(page, 'plan-tab-phone-load-more', async () => {
    await expect(page.locator('[data-plan-tab-load-more]')).toBeVisible({ timeout: 15_000 });
  });

  const before = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read').length;
  await more.click();
  await expect(list.locator('[data-plan-tab-card]')).toHaveCount(16);
  // The last page: the control is gone.
  await expect(more).toHaveCount(0);
  const calls = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read');
  expect(calls).toHaveLength(before + 1);
  const page2 = calls[calls.length - 1]?.args;
  // The cursor is the first page's last plan: the 12th newest (this week's
  // two, then the 10 newest older ones).
  expect(page2?.p_before_starts_on).toBe(civilPlus(MONDAY, -7 * 10));
  expect(page2?.p_before_id).toBe(older[9]?.id);
  // Every plan once (no duplicates by id).
  const ids = await list
    .locator('[data-plan-tab-card]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-plan-tab-card')));
  expect(new Set(ids).size).toBe(16);
  expectClean(network);
});

test('laptop: 13 plans in the month show 12 and Load more under the calendar; a tap reads the 13th @desktop @theme', async ({
  page,
}) => {
  laptopOnly(page);
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: ME });
  // 11 more shared plans over this week: with the two of this week that is 13
  // in the month's range, so the first page (12, newest starts_on first, then
  // id) leaves one for Load more. No items, so the grid is unchanged.
  const template = (network.world.tables.plans ?? []).find((p) => p.id === TAB_SHARED_PLAN_ID);
  const extra = Array.from({ length: 11 }, (_, k) => ({
    ...template,
    id: `0190fb00-0000-7000-8000-${String(k).padStart(12, '0')}`,
    title: `Week plan ${k + 1}`,
    starts_on: MONDAY,
    ends_on: civilPlus(MONDAY, 6),
  }));
  (network.world.tables.plans ??= []).push(...extra);
  await openTab(page);

  const chips = page.locator('[data-plan-tab-chip]:not([data-plan-tab-chip="all"])');
  const more = page.locator('[data-plan-tab-load-more]');
  await expect(chips).toHaveCount(12);
  await expect(more).toHaveText('Load more');
  expectMinTouchTarget(await more.boundingBox());
  // At the end of the laptop view: under the month grid.
  const grid = await page.locator('[data-plan-tab-month]').boundingBox();
  const moreBox = await more.boundingBox();
  if (grid === null || moreBox === null) throw new Error('grid or Load more box');
  expect(moreBox.y).toBeGreaterThanOrEqual(grid.y + grid.height - 1);
  // One request for one page: no loop of pages.
  const firstCalls = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read');
  expect(firstCalls).toHaveLength(1);
  expect(firstCalls[0]?.args.p_before_starts_on).toBeUndefined();

  await shootBoth(page, 'plan-tab-month-load-more', async () => {
    await expect(page.locator('[data-plan-tab-load-more]')).toBeVisible({ timeout: 15_000 });
  });

  const before = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read').length;
  await more.click();
  await expect(chips).toHaveCount(13);
  await expect(more).toHaveCount(0);
  const calls = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read');
  expect(calls).toHaveLength(before + 1);
  const page2 = calls[calls.length - 1]?.args;
  expect(page2?.p_before_starts_on).toBe(MONDAY);
  expect(page2?.p_range_start).toBe(firstCalls[0]?.args.p_range_start);
  expect(page2?.p_range_end).toBe(firstCalls[0]?.args.p_range_end);
  const ids = await chips.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-plan-tab-chip')),
  );
  expect(new Set(ids).size).toBe(13);
  // Today still shows the seeded plans' items.
  await expect(day(page, TODAY)).toContainText(TAB_OK_ITEM_TITLE);
  expectClean(network);
});

test('the Plan tab: every visible button is at least a 44x44 touch target @desktop', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: ME });
  await openTab(page);
  const checked = await expectAllVisibleControlsTouchSized(page);
  expect(checked, 'buttons measured on the Plan tab').toBeGreaterThan(0);
  expectClean(network);
});

test('phone: an approver sees shared plans only and no New plan', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'phone only');
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: PEER });
  viewAsClient(network);
  await openTab(page);
  await expect(page.locator(`[data-plan-tab-card="${TAB_SHARED_PLAN_ID}"]`)).toBeVisible();
  await expect(page.locator(`[data-plan-tab-card="${TAB_DRAFT_PLAN_ID}"]`)).toHaveCount(0);
  await expect(page.locator('[data-plan-tab-new]')).toHaveCount(0);
  expectClean(network);
});

test('laptop: Month, Week, a chip filter, a drag to another day and the empty-day menu @desktop @theme', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: ME });
  await openTab(page);

  // Month: today's number in the accent circle, the plans' items on today.
  await expect(page.locator('[data-plan-tab-month]')).toBeVisible();
  await expect(page.locator('[data-plan-tab-view="month"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const today = day(page, TODAY);
  await expect(today.locator('[data-plan-tab-today]')).toBeVisible();
  await expect(today).toContainText(TAB_OK_ITEM_TITLE);
  await expect(today).toContainText(TAB_DRAFT_ITEM_TITLE);
  await expect(page.locator(`[data-plan-tab-chip="${TAB_DRAFT_PLAN_ID}"]`)).toContainText('Draft');
  await expect(page.getByText("Plan item, in its plan's colour")).toBeVisible();
  await expect(page.getByText('Post not in a plan')).toBeVisible();
  for (const sel of ['[data-plan-tab-prev]', '[data-plan-tab-next]', '[data-plan-tab-go-today]']) {
    expectMinTouchTarget(await page.locator(sel).first().boundingBox());
  }
  expectMinTouchTarget(await page.locator('[data-plan-tab-chip="all"]').boundingBox(), {
    dimension: 'height',
  });
  await shootBoth(page, 'plan-tab-month', async () => {
    await expect(day(page, TODAY)).toContainText(TAB_OK_ITEM_TITLE, { timeout: 15_000 });
  });

  // Week: the cards with their Plan pill and post line.
  await page.locator('[data-plan-tab-view="week"]').click();
  await expect(page.locator('[data-plan-tab-week]')).toBeVisible();
  const okCard = page.locator('[data-plan-tab-entry]').filter({ hasText: TAB_OK_ITEM_TITLE });
  await expect(okCard.locator('[data-plan-tab-pill="good"]')).toHaveText('Plan OK');
  await expect(okCard).toContainText('No post yet');
  await expect(
    page.locator('[data-plan-tab-entry]').filter({ hasText: TAB_MOVE_ITEM_TITLE }),
  ).toContainText('Plan: not decided');

  // A chip: only that plan's items (no Draft item, no posts in no plan).
  await page.locator(`[data-plan-tab-chip="${TAB_SHARED_PLAN_ID}"]`).click();
  await expect(page.locator(`[data-plan-tab-chip="${TAB_SHARED_PLAN_ID}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText(TAB_DRAFT_ITEM_TITLE)).toHaveCount(0);
  await expect(page.locator('[data-plan-tab-entry^="post:"]')).toHaveCount(0);
  await page.locator('[data-plan-tab-chip="all"]').click();
  await expect(page.getByText(TAB_DRAFT_ITEM_TITLE)).toBeVisible();
  await shootBoth(page, 'plan-tab-week', async () => {
    await page.locator('[data-plan-tab-view="week"]').click();
    await expect(page.locator('[data-plan-tab-week]')).toBeVisible({ timeout: 15_000 });
    await expect(day(page, TODAY)).toContainText(TAB_OK_ITEM_TITLE);
  });

  // Drag "Market stall story" to another day of this week: lifted card, the
  // dashed drop day, painted there at once; written after the Undo toast.
  const card = entry(page, TAB_MOVE_ITEM_ID);
  const box = await card.boundingBox();
  if (box === null) throw new Error('card box');
  const target = await day(page, OTHER_DAY).boundingBox();
  if (target === null) throw new Error('target box');
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 18);
  await expect(page.locator('[data-plan-tab-drag-card]')).toBeVisible();
  await page.mouse.move(target.x + target.width / 2, target.y + Math.min(target.height - 20, 200), {
    steps: 8,
  });
  await expect(day(page, OTHER_DAY)).toHaveAttribute('data-plan-tab-drop', '');
  await page.mouse.up();
  await expect(page.locator('[data-plan-tab-drag-card]')).toHaveCount(0);
  await expect(day(page, OTHER_DAY)).toContainText(TAB_MOVE_ITEM_TITLE);
  await expect(page).toHaveURL(/\/plan$/);
  await expect
    .poll(() => network.rpcCalls.filter((c) => c.name === 'plan_item_move').length, {
      timeout: 10_000,
    })
    .toBe(1);
  expect(network.rpcCalls.find((c) => c.name === 'plan_item_move')?.args).toEqual(
    expect.objectContaining({
      p_item_id: TAB_MOVE_ITEM_ID,
      p_target_date: OTHER_DAY,
      p_keep_reviews: false,
    }),
  );

  // The empty-day menu on next Monday: only the shared plan covers it.
  await page.locator('[data-plan-tab-next]').click();
  const nextMonday = civilPlus(MONDAY, 7);
  const cell = day(page, nextMonday);
  await expect(cell).toBeVisible();
  const cellBox = await cell.boundingBox();
  if (cellBox === null) throw new Error('cell box');
  await cell.click({ position: { x: cellBox.width / 2, y: cellBox.height - 20 } });
  const menu = page.locator(`[data-plan-tab-day-menu="${nextMonday}"]`);
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-plan-tab-menu-plan]')).toHaveCount(1);
  await expect(menu.locator(`[data-plan-tab-menu-plan="${TAB_SHARED_PLAN_ID}"]`)).toBeVisible();
  await expect(menu.locator('[data-plan-tab-menu-new]')).toHaveText('+ New plan');
  const menuBox = await menu.boundingBox();
  if (menuBox === null) throw new Error('menu box');
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1280);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(cell).toBeFocused();

  // This week's Monday: both plans cover it, the Draft tagged.
  await page.locator('[data-plan-tab-prev]').click();
  const monday = day(page, MONDAY);
  const mondayBox = await monday.boundingBox();
  if (mondayBox === null) throw new Error('monday box');
  await monday.click({ position: { x: mondayBox.width / 2, y: mondayBox.height - 20 } });
  const both = page.locator(`[data-plan-tab-day-menu="${MONDAY}"]`);
  await expect(both.locator('[data-plan-tab-menu-plan]')).toHaveCount(2);
  await expect(both.locator(`[data-plan-tab-menu-plan="${TAB_DRAFT_PLAN_ID}"]`)).toContainText(
    TAB_DRAFT_PLAN_TITLE,
  );
  await page.keyboard.press('Escape');
  expectClean(network);
});

test('laptop: an approver sees no Draft, no New plan, no drag and no day menu @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: PEER });
  viewAsClient(network);
  await openTab(page);
  await expect(day(page, TODAY)).toContainText(TAB_OK_ITEM_TITLE);
  await expect(page.getByText(TAB_DRAFT_ITEM_TITLE)).toHaveCount(0);
  await expect(page.locator(`[data-plan-tab-chip="${TAB_DRAFT_PLAN_ID}"]`)).toHaveCount(0);
  await expect(page.locator('[data-plan-tab-new]')).toHaveCount(0);
  await expect(page.locator('[data-plan-tab-draggable]')).toHaveCount(0);
  await expect(page.locator('[data-plan-tab-addable]')).toHaveCount(0);
  const cell = day(page, TODAY);
  const box = await cell.boundingBox();
  if (box === null) throw new Error('cell box');
  await cell.click({ position: { x: box.width / 2, y: box.height - 8 } });
  await expect(page.locator('[data-plan-tab-day-menu]')).toHaveCount(0);
  expectClean(network);
});
