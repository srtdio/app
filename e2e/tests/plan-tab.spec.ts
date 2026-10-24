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
// an approver sees no Draft, no New plan and no menu. Screenshots in light
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
