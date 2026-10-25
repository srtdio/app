import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  BUCKET_ID,
  DM_CHANNEL,
  GROUP_NAME,
  ME,
  PEER,
  PEER_NAME,
  WORKSPACE_ID,
} from '../fixtures/chat-data';
import type { Row } from '../fixtures/postgrest';
import { noEntityCodesCases } from '../helpers/no-entity-codes-cases';

// The chat status ticker under the thread header and its drop-down drawer:
// the workspace's current shared plans in a chat that never shared them (one
// item per plan, a draft and a future plan never shown, the drawer lists them
// and a tap opens that plan), open by a tap on an item (scrolled to its
// section), open by dragging the bar
// down, close by dragging the handle up, compact mode on a 360px phone with
// every count over 99 (no overflow, chevron visible), and no text selection
// or callout on a long-press of the bar. Runs in both colour schemes (the dark
// and light projects). Linux WebKit approximates iOS WebKit; it is not iOS.

const DAY = 24 * 60 * 60 * 1000;

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

function uuid(prefix: string, n: number): string {
  return `${prefix}-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

/** The current shared plans the bar shows, ending soonest first. */
const CURRENT_PLANS = [
  { id: uuid('0190d900', 1), title: 'Week ahead', approved: 1, items: 5 },
  { id: uuid('0190d900', 2), title: 'Festive fortnight', approved: 1, items: 3 },
] as const;

/** Workspace plans that never reach the bar: a draft and one not started yet. */
const HIDDEN_PLANS = [
  { id: uuid('0190d900', 3), title: 'Draft for the team' },
  { id: uuid('0190d900', 4), title: 'Next month' },
] as const;

/**
 * The workspace's plans, none shared in any chat (no chat_messages row names
 * them): two current shared plans (ending in 3 and 12 days), a current draft
 * (team audience) and a shared plan that starts in 5 days.
 */
function seedPlans(network: HarnessNetwork): void {
  const t = network.world.tables;
  const plans: Array<{
    id: string;
    title: string;
    starts: number;
    ends: number;
    items: number;
    audience: 'client' | 'team';
  }> = [
    { ...CURRENT_PLANS[1], starts: -1, ends: 12, audience: 'client' },
    { ...HIDDEN_PLANS[0], starts: -1, ends: 2, items: 2, audience: 'team' },
    { ...CURRENT_PLANS[0], starts: -1, ends: 3, audience: 'client' },
    { ...HIDDEN_PLANS[1], starts: 5, ends: 30, items: 2, audience: 'client' },
  ];
  for (const [p, plan] of plans.entries()) {
    (t.plans ??= []).push({
      id: plan.id,
      workspace_id: WORKSPACE_ID,
      title: plan.title,
      starts_on: isoDay(plan.starts),
      ends_on: isoDay(plan.ends),
      audience: plan.audience,
      shared_with_client_at: plan.audience === 'client' ? '2026-10-09T09:00:00Z' : null,
      shared_with_client_by: plan.audience === 'client' ? ME : null,
      created_by: ME,
      created_at: '2026-10-09T09:00:00Z',
      updated_at: '2026-10-09T09:00:00Z',
      deleted_at: null,
    });
    for (let i = 0; i < plan.items; i += 1) {
      const itemId = uuid(`0190d91${p}`, i + 1);
      (t.plan_items ??= []).push({
        id: itemId,
        workspace_id: WORKSPACE_ID,
        plan_id: plan.id,
        kind: 'concept',
        position: i,
        title: `Concept ${i + 1}`,
        description: null,
        post_id: null,
        target_date: isoDay(i),
        created_by: ME,
        created_at: '2026-10-09T09:00:00Z',
        updated_at: '2026-10-09T09:00:00Z',
        deleted_at: null,
      });
      if (i === 0) {
        (t.plan_item_reviews ??= []).push({
          item_id: itemId,
          workspace_id: WORKSPACE_ID,
          side: 'client',
          status: 'approved',
        });
      }
    }
  }
}

/** Open briefs in the workspace. */
function seedBriefs(network: HarnessNetwork, count: number): void {
  const t = network.world.tables;
  for (let i = 0; i < count; i += 1) {
    (t.briefs ??= []).push({
      id: uuid('0190da00', i + 1),
      number: 300 + i,
      workspace_id: WORKSPACE_ID,
      title: `Brief ${i + 1}`,
      objective: 'Fixture objective',
      format_requested: null,
      brand_requirements: null,
      target_date: null,
      reference_links: null,
      status: 'open',
      closed_at: null,
      closed_by: null,
      created_by: PEER,
      legacy_author_name: null,
      created_via: 'app',
      row_version: 1,
      updated_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      created_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      deleted_at: null,
    });
  }
}

/** More posts in review (the harness already has three). */
function seedPosts(network: HarnessNetwork, count: number): void {
  const t = network.world.tables;
  for (let i = 0; i < count; i += 1) {
    (t.posts ??= []).push({
      id: uuid('0190db00', i + 1),
      number: 500 + i,
      workspace_id: WORKSPACE_ID,
      title: `Review post ${i + 1}`,
      caption: 'Fixture caption',
      bucket_id: BUCKET_ID,
      owner_user_id: ME,
      platform: 'instagram',
      format: 'single_image',
      stage: 'review',
      stage_entered_at: new Date(Date.now() - (i + 10) * DAY).toISOString(),
      approved_by: null,
      approved_at: null,
      target_date: null,
      origin: 'manual',
      brief_id: null,
      row_version: 1,
      created_by: ME,
      legacy_author_name: null,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
      deleted_at: null,
      post_versions: [],
      post_annotations: [],
    });
  }
}

/** Open marks on the DM's own loaded messages (cycling through them). */
function seedMarks(
  network: HarnessNetwork,
  perType: { commitment: number; decision: number; pending: number },
): void {
  const t = network.world.tables;
  const messages = network.world.dmMessages;
  let n = 0;
  for (const type of ['commitment', 'decision', 'pending'] as const) {
    for (let i = 0; i < perType[type]; i += 1) {
      const message: Row | undefined = messages[n % messages.length];
      n += 1;
      // One mark per message: past the loaded rows, marks name synthetic ids.
      const messageId =
        n <= messages.length && message !== undefined ? String(message.id) : uuid('0190dc00', n);
      (t.chat_message_marks ??= []).push({
        message_id: messageId,
        channel_id: DM_CHANNEL,
        workspace_id: WORKSPACE_ID,
        mark_type: type,
        priority: type === 'pending' && i === 0 ? 1 : null,
        marked_by: PEER,
        marked_at: new Date(Date.now() - n * 60_000).toISOString(),
        resolved_by: null,
        resolved_at: null,
      });
    }
  }
}

async function openDm(page: Page, name: string = PEER_NAME): Promise<Locator> {
  await page.goto('/chat');
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  const bar = page.locator('[data-loops-strip="open"]');
  await bar.waitFor({ state: 'visible', timeout: 8000 });
  return bar;
}

/** A finger drag: pointerdown, moves in steps, pointerup (all on one element). */
async function drag(page: Page, target: Locator, dy: number, ms = 400): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('drag target has no box');
  const x = box.x + box.width / 2;
  const y0 = box.y + box.height / 2;
  const base = { pointerType: 'touch', isPrimary: true, pointerId: 7, clientX: x };
  await target.dispatchEvent('pointerdown', { ...base, clientY: y0 });
  const steps = 10;
  for (let i = 1; i <= steps; i += 1) {
    await page.waitForTimeout(ms / steps);
    await target.dispatchEvent('pointermove', { ...base, clientY: y0 + (dy * i) / steps });
  }
  await target.dispatchEvent('pointerup', { ...base, clientY: y0 + dy });
}

async function drawerOpen(page: Page): Promise<void> {
  const panel = page.locator('[data-status-panel]');
  await expect(page.locator('[data-status-drawer="open"]')).toHaveCount(1);
  await expect
    .poll(async () => panel.evaluate((el) => getComputedStyle(el).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
}

async function drawerClosed(page: Page): Promise<void> {
  await expect(page.locator('[data-status-panel]')).toHaveCount(0, { timeout: 3000 });
}

test.describe('chat status ticker', () => {
  for (const chat of [PEER_NAME, GROUP_NAME]) {
    test(`${chat}: the workspace's current shared plans show though never shared here`, async ({
      page,
    }) => {
      const network = await installHarnessNetwork(page);
      seedPlans(network);
      const planIds = [...CURRENT_PLANS, ...HIDDEN_PLANS].map((p) => p.id);
      const shared = (network.world.tables.chat_messages ?? []).filter((m) =>
        ((m.shared_plan_ids as string[] | null) ?? []).some((id) => planIds.includes(id)),
      );
      expect(shared).toEqual([]);
      const bar = await openDm(page, chat);

      // One item per current shared plan, soonest end first, title then A/N.
      const items = bar.locator('[data-status-items] > [data-status-item="plan"]');
      await expect(items).toHaveCount(2);
      for (const [i, plan] of CURRENT_PLANS.entries()) {
        await expect(items.nth(i)).toHaveAttribute(
          'aria-label',
          `${plan.title} ${plan.approved} of ${plan.items} approved`,
        );
        await expect(items.nth(i).locator('[data-status-number]')).toHaveText(
          `${plan.approved}/${plan.items}`,
        );
      }
      await expect(items.first()).toContainText(CURRENT_PLANS[0].title);
      await expect(bar.locator('[data-status-more]')).toHaveCount(0);
      for (const hidden of HIDDEN_PLANS) await expect(bar).not.toContainText(hidden.title);

      // The drawer lists the same plans in the same order; a tap opens that plan.
      await items.first().click();
      await drawerOpen(page);
      const blocks = await page
        .locator('[data-plan-block]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-plan-block')));
      expect(blocks).toEqual(CURRENT_PLANS.map((p) => p.id));
      await page.locator(`[data-plan-block="${CURRENT_PLANS[1].id}"] [data-plan-open]`).click();
      const screen = page.locator('[data-plan-page="plan"]');
      await expect(screen).toBeVisible();
      await expect(screen).toContainText(CURRENT_PLANS[1].title);
      expect(network.blocked).toEqual([]);
    });
  }

  test('open by a tap on an item lands on its section; a tap on the bar closes', async ({
    page,
  }) => {
    const network = await installHarnessNetwork(page);
    seedPlans(network);
    seedBriefs(network, 2);
    seedMarks(network, { commitment: 6, decision: 2, pending: 2 });
    const bar = await openDm(page);

    const keys = await bar
      .locator('[data-status-item]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-status-item')));
    expect(keys).toEqual([
      'plan',
      'plan',
      'posts',
      'briefs',
      'commitments',
      'decisions',
      'pending',
    ]);
    const barBox = await bar.boundingBox();
    expect(barBox?.height).toBe(36);

    await bar.locator('[data-status-item="pending"]').click();
    await drawerOpen(page);
    const list = page.locator('[data-status-list]');
    const section = page.locator('[data-status-section="pending"]');
    const listBox = await list.boundingBox();
    const sectionBox = await section.boundingBox();
    expect(listBox).not.toBeNull();
    expect(sectionBox).not.toBeNull();
    // Opened already scrolled: the section heads the list (or the list ends there).
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(Math.abs((sectionBox?.y ?? 0) - (listBox?.y ?? 0))).toBeLessThan(
      (listBox?.height ?? 0) - 40,
    );
    await expect(page.locator('[data-status-chevron]')).toHaveAttribute('aria-expanded', 'true');

    await bar.click({ position: { x: 300, y: 18 } });
    await drawerClosed(page);
  });

  test('open by dragging the bar down', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedMarks(network, { commitment: 2, decision: 1, pending: 1 });
    const bar = await openDm(page);
    await drag(page, bar, 320);
    await drawerOpen(page);
    expect(await page.locator('[data-status-list]').evaluate((el) => el.scrollTop)).toBe(0);
  });

  test('close by dragging the handle up', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedMarks(network, { commitment: 2, decision: 1, pending: 1 });
    const bar = await openDm(page);
    await bar.locator('[data-status-item="commitments"]').click();
    await drawerOpen(page);
    await drag(page, page.locator('[data-status-handle]'), -320);
    await drawerClosed(page);
  });

  test('compact at 360px with two plans and every count over 99: no overflow, chevron visible', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const network = await installHarnessNetwork(page);
    seedPlans(network);
    seedPosts(network, 120);
    seedBriefs(network, 120);
    seedMarks(network, { commitment: 120, decision: 120, pending: 120 });
    const bar = await openDm(page);
    await expect(bar).toHaveAttribute('data-status-ticker', 'compact');
    const numbers = await bar.locator('[data-status-item] [data-status-number]').allTextContents();
    expect(numbers.slice(2)).toEqual(['99+', '99+', '99+', '99+', '99+']);
    await expect(bar.locator('[data-status-item] [data-status-word]')).toHaveCount(0);
    await expect(bar.locator('[data-status-item] [data-status-more]')).toHaveCount(0);
    // Compact keeps both plan items (their titles may drop trailing words).
    const plans = bar.locator('[data-status-items] > [data-status-item="plan"]');
    await expect(plans).toHaveCount(2);
    await expect(plans.first()).toBeVisible();
    await expect(plans.nth(1)).toBeVisible();

    const chevron = page.locator('[data-status-chevron]');
    await expect(chevron).toBeVisible();
    const chevronBox = await chevron.boundingBox();
    const last = bar.locator('[data-status-item]').last();
    const lastBox = await last.boundingBox();
    expect(chevronBox).not.toBeNull();
    expect(lastBox).not.toBeNull();
    expect((lastBox?.x ?? 0) + (lastBox?.width ?? 0)).toBeLessThanOrEqual(chevronBox?.x ?? 0);
    expect((chevronBox?.x ?? 0) + (chevronBox?.width ?? 0)).toBeLessThanOrEqual(360);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(360);
  });

  test('a long-press on the bar selects no text and shows no callout', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedMarks(network, { commitment: 2, decision: 0, pending: 0 });
    const bar = await openDm(page);
    const style = await bar.evaluate((el) => {
      const s = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string };
      return {
        user: s.userSelect || s.webkitUserSelect,
        callout: s.webkitTouchCallout ?? 'none',
        touch: s.touchAction,
      };
    });
    expect(style.user).toBe('none');
    expect(style.callout).toBe('none');
    expect(style.touch).toBe('none');
    const box = await bar.boundingBox();
    if (box === null) throw new Error('bar has no box');
    const at = { clientX: box.x + 60, clientY: box.y + box.height / 2 };
    const base = { pointerType: 'touch', isPrimary: true, pointerId: 9 };
    await bar.dispatchEvent('pointerdown', { ...base, ...at });
    await page.waitForTimeout(800);
    await bar.dispatchEvent('pointerup', { ...base, ...at });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    expect(network.blocked).toEqual([]);
  });

  test('a post row tap opens the post sheet', async ({ page }) => {
    await installHarnessNetwork(page);
    const bar = await openDm(page);
    await bar.locator('[data-status-item="posts"]').click();
    await drawerOpen(page);
    await page.locator('[data-status-post]').first().click();
    await expect(page.locator('[data-sheet-title]')).toBeVisible();
  });

  test('a post still loading shows its row busy, then opens', async ({ page }) => {
    await installHarnessNetwork(page);
    // The card read (posts by id) lands 2s late; the review list is untouched.
    await page.route(/\/rest\/v1\/posts\?.*id=in\./, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fallback();
    });
    const bar = await openDm(page);
    await bar.locator('[data-status-item="posts"]').click();
    await drawerOpen(page);
    const row = page.locator('[data-status-post]').first();
    const before = await row.boundingBox();
    await row.click();
    await expect(row).toHaveAttribute('aria-busy', 'true');
    const during = await row.boundingBox();
    expect(during?.height).toBe(before?.height);
    await expect(page.locator('[data-sheet-title]')).toBeVisible({ timeout: 6000 });
    await expect(row).toHaveAttribute('aria-busy', 'false');
  });

  test('a post read that fails clears busy and says so', async ({ page }) => {
    await installHarnessNetwork(page);
    await page.route(/\/rest\/v1\/posts\?.*id=in\./, async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 500,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'XX000', message: 'boom', details: null, hint: null }),
      });
    });
    const bar = await openDm(page);
    await bar.locator('[data-status-item="posts"]').click();
    await drawerOpen(page);
    const row = page.locator('[data-status-post]').first();
    await row.click();
    await expect(row).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText("Couldn't open this post. Try again.")).toBeVisible({
      timeout: 9000,
    });
    await expect(row).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('[data-sheet-title]')).toHaveCount(0);
  });

  test('brief tap then Back restores the drawer as it was left', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedBriefs(network, 2);
    const bar = await openDm(page);
    await bar.locator('[data-status-item="briefs"]').click();
    await drawerOpen(page);
    await page.locator('[data-status-brief]').first().click();
    await expect(page).toHaveURL(/\/briefs\//);
    await page.goBack();
    await expect(page.locator('[data-status-drawer="open"]')).toHaveCount(1, { timeout: 8000 });
    await expect(page.locator('[data-status-section="briefs"]')).toBeVisible();
  });

  test('brief tap, another tab, then Chat again: the drawer starts closed', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedBriefs(network, 2);
    const bar = await openDm(page);
    await bar.locator('[data-status-item="briefs"]').click();
    await drawerOpen(page);
    await page.locator('[data-status-brief]').first().click();
    await expect(page).toHaveURL(/\/briefs\//);
    // Brief detail has no bottom tabs on a phone: Back to the chat, its header
    // arrow to the list, then another tab.
    await page.goBack();
    await expect(page.locator('[data-status-drawer="open"]')).toHaveCount(1, { timeout: 8000 });
    await page.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await page.getByRole('link', { name: 'Pipeline' }).first().click();
    await expect(page).toHaveURL(/\/pipeline/);
    await page.getByRole('link', { name: 'Chat' }).first().click();
    const row = page.getByText(PEER_NAME, { exact: true }).first();
    await row.waitFor({ state: 'visible' });
    await row.click();
    await page.locator('[data-loops-strip="open"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(500);
    await expect(page.locator('[data-status-panel]')).toHaveCount(0);
  });

  const STAMPS = [
    {
      type: 'commitment',
      section: 'commitments',
      stamp: 'Delivered',
      copy: 'Mark this commitment as delivered?',
    },
    {
      type: 'decision',
      section: 'decisions',
      stamp: 'Closed',
      copy: 'Mark this decision as closed?',
    },
    {
      type: 'pending',
      section: 'pending',
      stamp: 'Completed',
      copy: 'Mark this priority as completed?',
    },
  ] as const;

  for (const s of STAMPS) {
    test(`${s.type} stamp: tap, confirm, one chat_mark_resolve; the row leaves, the count drops`, async ({
      page,
    }) => {
      const network = await installHarnessNetwork(page);
      seedMarks(network, {
        commitment: s.type === 'commitment' ? 2 : 0,
        decision: s.type === 'decision' ? 2 : 0,
        pending: s.type === 'pending' ? 2 : 0,
      });
      const bar = await openDm(page);
      const number = bar.locator(`[data-status-item="${s.section}"] [data-status-number]`);
      await expect(number).toHaveText('2');
      await bar.locator(`[data-status-item="${s.section}"]`).tap();
      await drawerOpen(page);
      const section = page.locator(`[data-status-section="${s.section}"]`);
      const row = section.locator('[data-status-mark]').first();
      const messageId = await row.getAttribute('data-status-mark');
      expect(messageId).not.toBeNull();
      await row.locator('[data-mark-action="resolve"]').tap();
      const confirm = row.locator('[data-mark-confirm="resolve"]');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(s.copy);
      await confirm.getByRole('button', { name: s.stamp, exact: true }).tap();

      await expect(page.locator(`[data-status-mark="${messageId}"]`)).toHaveCount(0);
      await expect(number).toHaveText('1');
      await expect(section.locator('[data-status-mark]')).toHaveCount(1);
      const calls = network.rpcCalls.filter((c) => c.name === 'chat_mark_resolve');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args.p_message_id).toBe(messageId);
      expect(calls[0]?.args.p_channel_id).toBe(DM_CHANNEL);
      expect(network.rpcCalls.filter((c) => c.name === 'chat_mark_reopen')).toHaveLength(0);
    });

    test(`${s.type} stamp refused: "Couldn't update. Try again." and the row stays`, async ({
      page,
    }) => {
      const network = await installHarnessNetwork(page);
      network.refuseRpc.add('chat_mark_resolve');
      seedMarks(network, {
        commitment: s.type === 'commitment' ? 2 : 0,
        decision: s.type === 'decision' ? 2 : 0,
        pending: s.type === 'pending' ? 2 : 0,
      });
      const bar = await openDm(page);
      const number = bar.locator(`[data-status-item="${s.section}"] [data-status-number]`);
      await bar.locator(`[data-status-item="${s.section}"]`).tap();
      await drawerOpen(page);
      const row = page.locator(`[data-status-section="${s.section}"] [data-status-mark]`).first();
      const messageId = await row.getAttribute('data-status-mark');
      await row.locator('[data-mark-action="resolve"]').tap();
      await row
        .locator('[data-mark-confirm="resolve"]')
        .getByRole('button', { name: s.stamp, exact: true })
        .tap();

      await expect(page.getByText("Couldn't update. Try again.")).toBeVisible();
      await expect(page.locator(`[data-status-mark="${messageId}"]`)).toHaveCount(1);
      await expect(number).toHaveText('2');
      await expect(
        page.locator(`[data-status-mark="${messageId}"] [data-mark-action]`),
      ).toBeEnabled();
      expect(network.rpcCalls.filter((c) => c.name === 'chat_mark_resolve')).toHaveLength(1);
    });
  }
});

noEntityCodesCases();
