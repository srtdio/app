import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { BUCKET_ID, DM_CHANNEL, ME, PEER, PEER_NAME, WORKSPACE_ID } from '../fixtures/chat-data';
import type { Row } from '../fixtures/postgrest';

// The chat status ticker under the thread header and its drop-down drawer:
// open by a tap on an item (scrolled to its section), open by dragging the bar
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

/** Two open plans shared into the DM (the bar shows the one ending soonest, "+1"). */
function seedPlans(network: HarnessNetwork): void {
  const t = network.world.tables;
  const plans: Array<{ id: string; title: string; ends: number; items: number }> = [
    { id: uuid('0190d900', 1), title: 'Week ahead', ends: 3, items: 5 },
    { id: uuid('0190d900', 2), title: 'Festive fortnight', ends: 12, items: 3 },
  ];
  for (const [p, plan] of plans.entries()) {
    (t.plans ??= []).push({
      id: plan.id,
      workspace_id: WORKSPACE_ID,
      title: plan.title,
      starts_on: isoDay(-1),
      ends_on: isoDay(plan.ends),
      audience: 'client',
      shared_with_client_at: '2026-10-09T09:00:00Z',
      shared_with_client_by: ME,
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
    (t.chat_messages ??= []).push({
      id: uuid('0190d920', p + 1),
      channel_id: DM_CHANNEL,
      workspace_id: WORKSPACE_ID,
      sender_user_id: ME,
      body: null,
      mentions: null,
      attachment_asset_ids: null,
      shared_post_ids: null,
      shared_brief_ids: null,
      shared_plan_ids: [plan.id],
      reply_to_message_id: null,
      forwarded_from_message_id: null,
      attachment_meta: null,
      agora_event_id: null,
      created_at: new Date(Date.now() - (90 + p) * 60_000).toISOString(),
      edited_at: null,
      deleted_at: null,
      thread_root_message_id: null,
    });
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

async function openDm(page: Page): Promise<Locator> {
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  const bar = page.locator('[data-loops-strip="open"]');
  await bar.waitFor({ state: 'visible', timeout: 8000 });
  return bar;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
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
    expect(keys).toEqual(['plan', 'posts', 'briefs', 'commitments', 'decisions', 'pending']);
    const barBox = await bar.boundingBox();
    expect(barBox?.height).toBe(36);
    await shot(page, 'ticker-bar');

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
    await shot(page, 'drawer-pending');

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
    await shot(page, 'drawer-dragged');
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

  test('compact at 360px with all six items over 99: no overflow, chevron visible', async ({
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
    expect(numbers.slice(1)).toEqual(['99+', '99+', '99+', '99+', '99+']);
    await expect(bar.locator('[data-status-item] [data-status-word]')).toHaveCount(0);
    await expect(bar.locator('[data-status-item] [data-status-more]')).toHaveCount(0);
    await expect(
      bar.locator('[data-status-item="plan"]').getByText('Plan', { exact: true }),
    ).toBeVisible();

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
    await shot(page, 'ticker-compact-360');
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
    await shot(page, 'post-sheet');
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
    await expect(page.getByText("Couldn't open this post")).toBeVisible({ timeout: 9000 });
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
    await shot(page, 'drawer-restored');
  });

  test('brief tap, another tab, then Chat again: the drawer starts closed', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedBriefs(network, 2);
    const bar = await openDm(page);
    await bar.locator('[data-status-item="briefs"]').click();
    await drawerOpen(page);
    await page.locator('[data-status-brief]').first().click();
    await expect(page).toHaveURL(/\/briefs\//);
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
      await shot(page, `stamp-${s.type}-done`);
    });

    test(`${s.type} stamp refused: "Could not update" and the row stays`, async ({ page }) => {
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

      await expect(page.getByText('Could not update')).toBeVisible();
      await expect(page.locator(`[data-status-mark="${messageId}"]`)).toHaveCount(1);
      await expect(number).toHaveText('2');
      await expect(
        page.locator(`[data-status-mark="${messageId}"] [data-mark-action]`),
      ).toBeEnabled();
      expect(network.rpcCalls.filter((c) => c.name === 'chat_mark_resolve')).toHaveLength(1);
    });
  }
});
