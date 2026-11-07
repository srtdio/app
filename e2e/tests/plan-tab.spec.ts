import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  ME,
  PEER,
  TAB_DRAFT_PLAN_ID,
  TAB_SHARED_PLAN_ID,
  TAB_SHARED_PLAN_TITLE,
  civilPlus,
  mondayOf,
  seedPlanTab,
} from '../fixtures/chat-data';
import { expectAllVisibleControlsTouchSized, expectMinTouchTarget } from '../helpers/touch-target';

// The Plan tab (/plan), phone and laptop alike (the laptop Month | Week
// calendar retired 7 Nov 2026): the chips (Bank, Upcoming, Past; decision D,
// 7 Nov 2026) over one ui/ListCard per plan in the list grid (one
// column on a phone, auto-fill columns on a laptop). A card: the plan's first
// cover (else the plan icon), its title, its dates and post count, then when
// it starts and one tag ("N of M OK", or "Draft"). A tap opens the plan's own
// screen. Load more ends the list while more plans remain. New plan is the
// top bar's "+"; an approver sees shared plans only and no "+". Screenshots in light and dark (the light
// ones run @theme). The fixture clock is the real one: the plans sit on this
// week and next (UTC, the workspace zone).

const NOW = Date.now();
const MONDAY = mondayOf(NOW);

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

async function openTab(page: Page): Promise<void> {
  await page.goto('/plan');
  await expect(page.locator('[data-plan-tab-list]')).toBeVisible({ timeout: 15_000 });
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

test('the Plan tab lists plans as ListCards in sections and a tap opens the plan @desktop @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: ME });
  await openTab(page);

  // The tab opens on the Upcoming chip (both widths): This week, Next week
  // and Later, each under its heading; no calendar, legend or Month | Week.
  // The retired chips are gone (This week, Next week, All).
  await expect(page.locator('[data-plan-tab-when="upcoming"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.locator(
      '[data-plan-tab-when="this"], [data-plan-tab-when="next"], [data-plan-tab-when="all"]',
    ),
  ).toHaveCount(0);
  await expect(page.locator('[data-plan-tab-month], [data-plan-tab-week]')).toHaveCount(0);
  await expect(page.locator('[data-plan-tab-view], [data-plan-tab-legend]')).toHaveCount(0);
  const list = page.locator('[data-plan-tab-list]');
  const thisWeek = list.locator('[data-plan-tab-section="this"]');
  await expect(thisWeek.locator('h2')).toHaveText('This week');

  // One ListCard per plan: title, dates and count, when it starts, one tag.
  const shared = thisWeek.locator(`[data-plan-tab-card="${TAB_SHARED_PLAN_ID}"]`);
  await expect(shared).toHaveAttribute('data-list-card', '');
  await expect(shared.locator('[data-list-card-title]')).toHaveText(TAB_SHARED_PLAN_TITLE);
  await expect(shared.locator('[data-plan-tab-dates]')).toContainText('3 posts');
  // When it starts, in words: a day up to the start, Live while it runs, the
  // end day once over (formatPlanStart; never "Starts" / "Started").
  await expect(shared.locator('[data-plan-tab-start]')).toHaveText(
    /^(Today|Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Live|\d{1,2} [A-Z][a-z]{2})$/,
  );
  await expect(shared.locator('[data-plan-tab-progress]')).toHaveText('1 of 3 OK');
  const draft = thisWeek.locator(`[data-plan-tab-card="${TAB_DRAFT_PLAN_ID}"]`);
  await expect(draft.locator('[data-plan-tab-draft]')).toHaveText('Draft');
  await expect(draft.locator('[data-plan-tab-dates]')).toContainText(
    '1 post · only your team sees this',
  );
  // Every card in the list is the same height (ListCard's 60).
  const heights = await list
    .locator('[data-list-card]')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  // Laptop: the grid lays the cards side by side (auto-fill columns).
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    const a = await shared.boundingBox();
    const b = await draft.boundingBox();
    if (a === null || b === null) throw new Error('card boxes');
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
  }
  // New plan is the top bar's filled "+" (icon only, named New plan).
  const add = page.locator('[data-topbar-slot="primary"] [data-topbar-plus]');
  await expect(add).toHaveAccessibleName('New plan');
  expectMinTouchTarget(await add.boundingBox());

  await shootBoth(page, 'plan-tab-list', async () => {
    await expect(page.locator('[data-plan-tab-list]')).toBeVisible({ timeout: 15_000 });
  });

  await page.locator(`[data-plan-tab-card="${TAB_SHARED_PLAN_ID}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/plan/${TAB_SHARED_PLAN_ID}$`));
  await expect(page.locator('[data-plan-page="plan"]')).toBeVisible();
  expectClean(network);
});

test('Load more ends the list while older plans remain, then appends them @desktop @theme', async ({
  page,
}) => {
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
  // Every chip reads every plan, a page at a time: Past paints from the one
  // read Upcoming made, with no request of its own. The first page holds this
  // week's two (Upcoming) and the 10 newest older ones (Past).
  await page.locator('[data-plan-tab-when="past"]').click();
  await expect(page.locator('[data-plan-tab-when="past"]')).toHaveAttribute('aria-pressed', 'true');

  const list = page.locator('[data-plan-tab-list]');
  const more = list.locator('[data-plan-tab-load-more]');
  await expect(list.locator('[data-plan-tab-card]')).toHaveCount(10);
  await expect(more).toHaveText('Load more');
  expectMinTouchTarget(await more.boundingBox());
  const allReads = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read');
  expect(allReads).toHaveLength(1);
  expect(allReads[0]?.args.p_range_start).toBeUndefined();
  expect(allReads[0]?.args.p_before_starts_on).toBeUndefined();

  await shootBoth(page, 'plan-tab-load-more', async () => {
    await expect(page.locator('[data-plan-tab-load-more]')).toBeVisible({ timeout: 15_000 });
  });

  const before = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read').length;
  await more.click();
  await expect(list.locator('[data-plan-tab-card]')).toHaveCount(14);
  // The last page: the control is gone.
  await expect(more).toHaveCount(0);
  const calls = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read');
  expect(calls).toHaveLength(before + 1);
  const page2 = calls[calls.length - 1]?.args;
  // The cursor is the first page's last plan: the 12th newest (this week's
  // two, then the 10 newest older ones).
  expect(page2?.p_before_starts_on).toBe(civilPlus(MONDAY, -7 * 10));
  expect(page2?.p_before_id).toBe(older[9]?.id);
  // Every past plan once (no duplicates by id).
  const ids = await list
    .locator('[data-plan-tab-card]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-plan-tab-card')));
  expect(new Set(ids).size).toBe(14);
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

test('an approver sees shared plans only and no New plan "+" @desktop', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedPlanTab(network.world, { sender: PEER });
  viewAsClient(network);
  await openTab(page);
  await expect(page.locator(`[data-plan-tab-card="${TAB_SHARED_PLAN_ID}"]`)).toBeVisible();
  await expect(page.locator(`[data-plan-tab-card="${TAB_DRAFT_PLAN_ID}"]`)).toHaveCount(0);
  await expect(page.locator('[data-topbar-plus]')).toHaveCount(0);
  await expect(page.locator('[data-topbar-slot="primary"]')).toBeVisible();
  expectClean(network);
});
