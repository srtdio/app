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

// The Plan panel on a laptop (the panel widths by window width, Escape
// ownership both ways, the creators' row ⋯ menu whose Move and Remove save
// themselves behind Undo, Activity kept mounted) and the phone (story E: a
// full page with the same row menu; no Edit mode anywhere).
// @desktop tests run on desktop-webkit (1280x800, others set their own size)
// and skip below md; the untagged phone test runs on the iPhone projects.
// Fixture names are fictional.

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

/** The chat's channel list column (md:w-72). */
const channelColumn = (page: Page): Locator =>
  page
    .getByText(PEER_NAME, { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@class,"md:w-72")][1]');

const dayBlock = (panel: Locator, day: string): Locator =>
  panel.locator(`[data-plan-day="${day}"]`);

async function titlesOn(panel: Locator, day: string): Promise<string[]> {
  return dayBlock(panel, day).locator('[data-plan-row-title]').allInnerTexts();
}

/** A creator's row ⋯ menu: open it and pick an item (popover on laptop, sheet on phone). */
async function rowMenu(page: Page, panel: Locator, id: string, label: string): Promise<void> {
  const wrap = panel.locator(`[data-plan-row-wrap="${id}"]`);
  await wrap.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await wrap.getByRole('button', { name: 'More actions' }).click();
  await page.locator('[role="menu"]').getByText(label, { exact: true }).click();
}

const saves = (network: HarnessNetwork) => network.rpcCalls.filter((c) => c.name === 'plan_save');
const opsOf = (call: { args: Record<string, unknown> } | undefined) =>
  (call?.args.p_ops ?? []) as Array<Record<string, unknown>>;
const removes = (network: HarnessNetwork) =>
  network.rpcCalls.filter((c) => c.name === 'plan_item_remove');

test('F4: the row menu moves at once; the write waits for its Undo strip, then resets the ticks @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  // Sweets flatlay (a post) carries a team tick: moving it resets it once written.
  const sweets = dated('Sweets flatlay');
  const reviews = () =>
    (network.world.tables.plan_item_reviews ?? []).filter((r) => r.item_id === sweets.id);
  expect(reviews().some((r) => r.status === 'approved')).toBe(true);
  await rowMenu(page, panel, sweets.id, 'Move to another day');
  const picker = page.locator('[data-plan-day-picker]');
  await expect(picker).toBeVisible();
  await picker.locator('[data-plan-day-tile="2026-10-16"]').click();
  await expect(picker).toBeHidden();
  // Painted at once, the Undo strip up, nothing written yet.
  await expect.poll(() => titlesOn(panel, '2026-10-16')).toContain('Sweets flatlay');
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  expect(saves(network)).toEqual([]);
  // The strip ends: one plan_save with the one move op.
  await expect.poll(() => saves(network).length, { timeout: 10_000 }).toBe(1);
  expect(opsOf(saves(network)[0])).toEqual([
    expect.objectContaining({
      op: 'move',
      item_id: sweets.id,
      target_date: '2026-10-16',
      keep_reviews: false,
    }),
  ]);
  await expect.poll(() => reviews().every((r) => r.status === 'waiting')).toBe(true);
  expectClean(network);
});

test('F5: Remove from plan hides the row at once; Undo brings it back and nothing is written @desktop', async ({
  page,
}) => {
  laptopOnly(page);
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page);
  const { panel } = await openPanel(page);
  const offer = dated('Opening offer');
  await rowMenu(page, panel, offer.id, 'Remove from plan');
  await expect(panel.locator(`[data-plan-row-wrap="${offer.id}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(panel.locator(`[data-plan-row-wrap="${offer.id}"]`)).toHaveCount(1);
  await page.waitForTimeout(5_000);
  expect(saves(network)).toEqual([]);
  expect(removes(network)).toEqual([]);
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
  // A row's ⋯ menu: Escape closes the menu only; the panel stays.
  await panel.getByRole('button', { name: 'More actions' }).first().click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  // A focused row: Escape closes the panel, and still not the drawer.
  await panel.locator('button[data-plan-row]').first().focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(bar).toHaveAttribute('aria-expanded', 'true');
  expectClean(network);
});

test('D: a client at 1280 sees no row menu, Add or Edit; a right-click opens nothing; OK shows its toast @desktop', async ({
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
    panel.locator('button[aria-label="More actions"], [data-plan-add], [data-plan-add-header]'),
  ).toHaveCount(0);
  const concept = dated('Rangoli timelapse');
  await panel.locator(`[data-plan-row="${concept.id}"]`).click({ button: 'right' });
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
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
    // The overlay light (lit-overlay: its long falling shadow) while it sits
    // over the chat; none from 1180px, where it sits beside the list.
    const shadow = await panel.evaluate((el) => getComputedStyle(el).boxShadow);
    if (size.width >= 1180) expect(shadow).toBe('none');
    else expect(shadow).toMatch(/0px (24px 56px -12px|28px 64px -8px)/);
    if (size.list === 'clear') {
      await expect(column).toBeVisible();
      const cb = await column.boundingBox();
      expect((cb?.x ?? 0) + (cb?.width ?? 0)).toBeLessThanOrEqual(size.width - size.panel);
    } else {
      await expect(column).toBeHidden();
      // The thread stays beside the panel.
      await expect(page.locator('[data-msg-id]').first()).toBeAttached();
    }
    // Rows fit: the PLAN line, the thumbnail and the 44px ⋯ menu inside the
    // panel, and the title clamps to two lines.
    const wrap = panel.locator('[data-plan-row-wrap]').first();
    const tick = await wrap.locator('[data-plan-control]').boundingBox();
    expect((tick?.x ?? 0) + (tick?.width ?? 0)).toBeLessThanOrEqual(size.width);
    const thumb = await wrap.locator('[data-plan-row-tile]').boundingBox();
    expect((thumb?.x ?? 0) + (thumb?.width ?? 0)).toBeLessThanOrEqual(size.width);
    const more = await wrap.getByRole('button', { name: 'More actions' }).boundingBox();
    expect(more?.height).toBe(44);
    expect(more?.x).toBeGreaterThanOrEqual(size.width - size.panel);
    expect((more?.x ?? 0) + (more?.width ?? 0)).toBeLessThanOrEqual(size.width);
    for (const t of await panel.locator('[data-plan-row-title]').all()) {
      expect(
        await t.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-line-clamp')),
      ).toBe('2');
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

test('E: phone (iPhone 13): full page; no Edit mode; the row menu removes behind Undo with no write until the strip ends', async ({
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
  // No Edit mode, no swipe, no laptop close.
  await expect(
    plan.locator('[data-plan-edit], [data-plan-row-swipe], [data-plan-close]'),
  ).toHaveCount(0);
  const offer = dated('Opening offer');
  const wrap = plan.locator(`[data-plan-row-wrap="${offer.id}"]`);
  await rowMenu(page, plan, offer.id, 'Remove from plan');
  await expect(wrap).toHaveCount(0);
  expect(saves(network)).toEqual([]);
  await expect.poll(() => saves(network).length, { timeout: 10_000 }).toBe(1);
  expect(opsOf(saves(network)[0])).toEqual([{ op: 'remove', item_id: offer.id }]);
  expectClean(network);
});

test('H: the panel header keeps the phone layout: 28px title on line 1, boxed Add on line 2 on the 16px edge, at 440 and 360 @desktop', async ({
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
    if (box === null || add === null) throw new Error('boxes');
    expect(Math.round(box.x + box.width - (add.x + add.width))).toBe(16);
    expect(Math.round(add.height)).toBe(34);
  }
  await expect(line2.locator('[data-plan-edit]')).toHaveCount(0);
  expectClean(network);
});
