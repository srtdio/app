import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { expectButtonsMeetSystem } from '../helpers/button-system';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  ME,
  MENTION_PREVIEW,
  PEER,
  PEER_NAME,
  WORKSPACE_ID,
  type ChatWorld,
} from '../fixtures/chat-data';

// Notifications (the bell merged into Activity): the top bar's Notifications
// button and its merged badge, the page and its chips (Mentions takes the chat
// mention, Plans the plan alerts). The real app tree runs against fixture data
// in both colour schemes; Linux WebKit approximates iOS WebKit, it is not iOS.

const PLAN_ALERT_ID = '0190f200-0000-7000-8000-0000000000a1';
const PLAN_ALERT_PLAN = '0190f200-0000-7000-8000-0000000000a2';
const PLAN_ALERT_TITLE = 'Diwali week';
const BRIEF_ENTRY_ID = '0190f200-0000-7000-8000-0000000000d1';
const BRIEF_ID = '0190f200-0000-7000-8000-0000000000d2';
const BRIEF_TITLE = 'Festive drop launch brief';
const FILES_ENTRY_ID = '0190f200-0000-7000-8000-0000000000e1';
const FILES_FIRST = 'launch-deck.pdf';

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

/** One unread inbox row for the viewer (ME), created `agoMs` ago. */
function inboxRow(
  id: string,
  eventType: string,
  over: Record<string, unknown>,
  agoMs: number,
): Record<string, unknown> {
  return {
    id,
    user_id: ME,
    actor_user_id: null,
    workspace_id: WORKSPACE_ID,
    event_type: eventType,
    entity_type: 'chat_channel',
    entity_id: DM_CHANNEL,
    scope: 'people',
    scope_key: DM_CHANNEL,
    tier: 'active',
    payload: {},
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: new Date(Date.now() - agoMs).toISOString(),
    ...over,
  };
}

/** A plan alert (plan_opened by the DM peer). */
function seedAlerts(world: ChatWorld): void {
  (world.tables.inbox_entries ??= []).push(
    inboxRow(
      PLAN_ALERT_ID,
      'plan_opened',
      {
        actor_user_id: PEER,
        entity_type: 'plan',
        entity_id: PLAN_ALERT_PLAN,
        scope: 'posts',
        scope_key: PLAN_ALERT_PLAN,
        payload: { plan_id: PLAN_ALERT_PLAN, plan_title: PLAN_ALERT_TITLE },
      },
      120_000,
    ),
  );
}

/** The Notifications card of one event type. */
const card = (page: Page, eventType: string) =>
  page.locator(`[data-activity-event="${eventType}"]`);

test(
  'the phone tab bar Activity tab and merged badge open Notifications; the chips; light and dark',
  { tag: '@theme' },
  async ({ page }, testInfo) => {
    const network = await installHarnessNetwork(page);
    seedAlerts(network.world);

    // On phone Activity is the last tab in the floating pill (the top bar's
    // button is laptop only); its badge counts every unread row: the seeded
    // chat mention and the plan alert.
    await page.goto('/chat');
    const button = page.locator('nav [data-activity-tab]');
    await button.waitFor({ state: 'visible', timeout: 15_000 });
    await expect(button).toHaveCount(1);
    await expect(page.locator('header [data-notifications-button]')).toBeHidden();
    expectMinTouchTarget(await button.boundingBox());
    await expect(button).toHaveText('2');
    await expect(button).toHaveAttribute('aria-label', 'Activity, 2 unread');
    await expect(page.locator('[data-bell-button]')).toHaveCount(0);

    await button.click();
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeAttached();
    await expect(button).toHaveAttribute('aria-current', 'page');

    // All: the chat mention and the plan alert, as cards.
    await expect(card(page, 'mention')).toContainText(`${PEER_NAME} mentioned you`);
    await expect(card(page, 'mention')).toContainText(MENTION_PREVIEW);
    await expect(card(page, 'plan_opened')).toBeVisible();

    // The chips (their order is a unit check): All, Unread, Mentions, the
    // counted ones carrying their counts. Briefs and Plans are gone.
    const chipRow = page.locator('[data-activity-chips]');
    for (const name of ['All', 'Unread 2', 'Mentions 1']) {
      await expect(chipRow.getByRole('button', { name, exact: true })).toBeVisible();
    }
    for (const name of ['Briefs', 'Plans']) {
      await expect(chipRow.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    // Mark all read is the top bar's primary (2 unread on All).
    await expect(
      page.locator('[data-topbar-slot="primary"] [data-activity-mark-all]'),
    ).toBeVisible();
    // Snooze is gone: no Snoozed chip.
    await expect(page.getByRole('button', { name: /^Snoozed/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Upcoming', exact: true })).toHaveCount(0);

    // Mentions: the chat mention, nothing else.
    await page.getByRole('button', { name: 'Mentions 1', exact: true }).click();
    await expect(card(page, 'mention')).toContainText(`${PEER_NAME} mentioned you`);
    await expect(card(page, 'plan_opened')).toHaveCount(0);

    // All: the plan alert, in the bell's words.
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(card(page, 'plan_opened')).toContainText(
      `${PEER_NAME} opened ${PLAN_ALERT_TITLE} for approvers`,
    );
    const scheme = testInfo.project.use.colorScheme ?? 'dark';
    await page.screenshot({ path: testInfo.outputPath(`notifications-${scheme}.png`) });
    expectClean(network);
  },
);

/** A brief_created row (its brief seeded) and an assets_deleted row naming three files. */
function seedTiles(world: ChatWorld): void {
  const now = new Date().toISOString();
  (world.tables.briefs ??= []).push({
    id: BRIEF_ID,
    workspace_id: WORKSPACE_ID,
    number: 4,
    title: BRIEF_TITLE,
    status: 'open',
    created_by: PEER,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  });
  (world.tables.inbox_entries ??= []).push(
    inboxRow(
      BRIEF_ENTRY_ID,
      'brief_created',
      {
        actor_user_id: PEER,
        entity_type: 'brief',
        entity_id: BRIEF_ID,
        scope: 'briefs',
        scope_key: BRIEF_ID,
        payload: { title: BRIEF_TITLE },
      },
      90_000,
    ),
    inboxRow(
      FILES_ENTRY_ID,
      'assets_deleted',
      {
        actor_user_id: PEER,
        entity_type: 'workspace',
        entity_id: WORKSPACE_ID,
        scope: 'everything',
        scope_key: WORKSPACE_ID,
        payload: {
          count: 3,
          actor_role: 'agency',
          // The first file has no version left to preview: its tile is the text tile.
          files: [
            { asset_version_id: null, filename: FILES_FIRST, mime_type: 'application/pdf' },
            { asset_version_id: null, filename: 'hero.png', mime_type: 'image/png' },
            { asset_version_id: null, filename: 'teaser.mov', mime_type: 'video/quicktime' },
          ],
        },
      },
      30_000,
    ),
  );
}

test('fix 3: at 390px the chip row ends with a full gutter after Mentions and no fade', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const network = await installHarnessNetwork(page);
  await page.goto('/notifications');
  const row = page.locator('[data-activity-chips]');
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  const maskOf = () =>
    row.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-mask-image'));

  // While chips remain past the right edge the row fades there.
  const overflows = await row.evaluate((el) => el.scrollWidth - el.clientWidth > 2);
  if (overflows) await expect.poll(maskOf).not.toBe('none');

  // Scroll to the end inside the poll: the chip counts can land after the
  // first scroll and widen the row, so each try scrolls to the new end.
  await expect
    .poll(async () => {
      await row.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      return maskOf();
    })
    .toBe('none');

  // Mentions is the last chip (Snoozed, Briefs and Plans are gone).
  const last = row.getByRole('button', { name: /^Mentions\b/ });
  await expect(last).toBeVisible();
  const box = await last.boundingBox();
  if (box === null) throw new Error('Mentions chip has no box');
  // The trailing spacer plus the chip gap: a 16px right gutter, like the left one.
  expect(Math.floor(box.x + box.width)).toBeLessThanOrEqual(390 - 16);
  expectClean(network);
});

test('fix 6 and 30 on ui/ListCard: a brief row shows the brief icon picture; deleted files name the files', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTiles(network.world);
  await page.goto('/notifications');

  const brief = card(page, 'brief_created');
  await expect(brief).toBeVisible({ timeout: 15_000 });
  await expect(brief).toContainText(BRIEF_TITLE);
  const briefPicture = brief.locator('[data-list-card-picture="icon"]');
  await expect(briefPicture).toBeVisible();
  const briefBox = await briefPicture.boundingBox();
  if (briefBox === null) throw new Error('brief picture has no box');
  expect(Math.round(briefBox.width)).toBe(48);
  expect(Math.round(briefBox.height)).toBe(48);
  await expect(brief.locator('[data-activity-scope-tag]')).toHaveText('Brief');

  const files = card(page, 'assets_deleted');
  await expect(files).toContainText(`${PEER_NAME} deleted 3 files`);
  await expect(files).toContainText(FILES_FIRST);
  await expect(files).toContainText('Also hero.png and teaser.mov');
  await expect(files.locator('[data-list-card-picture]')).toBeVisible();
  expectClean(network);
});

test('Notifications: every button is 44 tall with an 8px radius or round', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedAlerts(network.world);
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeAttached({
    timeout: 15_000,
  });
  await expect(card(page, 'plan_opened')).toBeVisible();
  await expectButtonsMeetSystem(page);
  expectClean(network);
});

// Type roles on Notifications (design rules, locked 24 Oct 2026): no visible
// title bar (the h1 is sr-only, as Pipeline, Briefs, Assets and Plan show none), a day bucket
// label is a section label (12px/600, uppercase), a card's preview line is
// the secondary role at 13px (ui/ListCard) and its time is meta at 12px.
test(
  'Notifications type roles: no visible title, section label 12px uppercase, preview 13px, meta 12px',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedAlerts(network.world);
    await page.goto('/notifications');
    const typeOf = (locator: ReturnType<Page['locator']>) =>
      locator.evaluate((el) => {
        const s = getComputedStyle(el);
        return { size: s.fontSize, weight: s.fontWeight, transform: s.textTransform };
      });

    const header = page.getByRole('heading', { level: 1, name: 'Activity' });
    await expect(header).toBeAttached({ timeout: 15_000 });
    const headerBox = await header.boundingBox();
    expect(headerBox === null || headerBox.height <= 1).toBe(true);

    const mention = card(page, 'mention');
    await expect(mention).toContainText(MENTION_PREVIEW);
    const label = page.locator('section', { has: mention }).locator('h2').first();
    const labelType = await typeOf(label);
    expect(labelType.size).toBe('12px');
    expect(labelType.weight).toBe('600');
    expect(labelType.transform).toBe('uppercase');

    // ui/ListCard: the preview is the secondary role (13/18).
    const body = mention.locator('[data-list-card-preview]').first();
    await expect(body).toContainText(MENTION_PREVIEW);
    expect((await typeOf(body)).size).toBe('13px');

    const meta = mention.locator('[data-activity-time]').first();
    expect((await typeOf(meta)).size).toBe('12px');
    expectClean(network);
  },
);

test(
  'Activity: floating tab bar on phone, top bar on laptop @desktop',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedAlerts(network.world);
    await page.goto('/pipeline');
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('no viewport');
    const header = page.locator('header [data-notifications-button]');
    const tab = page.locator('nav [data-activity-tab]');
    if (viewport.width >= 768) {
      await expect(header).toBeVisible({ timeout: 15_000 });
      await expect(tab).toBeHidden();
      await expect(page.locator('[data-tab-pill]')).toBeHidden();
      expectClean(network);
      return;
    }
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await expect(header).toBeHidden();
    // Search | sort | "+" | avatar, packed once Activity is out of the top bar.
    const search = await page
      .locator('header')
      .getByRole('button', { name: 'Search' })
      .boundingBox();
    const sort = await page.locator('[data-topbar-slot="sort"]').boundingBox();
    const primary = await page.locator('[data-topbar-slot="primary"]').boundingBox();
    const avatar = await page.getByRole('button', { name: 'Account menu' }).boundingBox();
    if (search === null || sort === null || primary === null || avatar === null) {
      throw new Error('top bar not laid out');
    }
    expect(sort.x - (search.x + search.width)).toBeLessThanOrEqual(8);
    expect(avatar.x - (primary.x + primary.width)).toBeLessThanOrEqual(8);

    // The row floats 12px from both sides and the bottom (no home indicator inset here).
    const row = await page.locator('nav[data-undo-anchor]').boundingBox();
    const pill = await page.locator('[data-tab-pill]').boundingBox();
    const chat = await page.locator('[data-chat-tab]').boundingBox();
    if (row === null || pill === null || chat === null) throw new Error('tab bar not laid out');
    expect(row.x).toBeCloseTo(12, 0);
    expect(viewport.width - (row.x + row.width)).toBeCloseTo(12, 0);
    expect(viewport.height - (row.y + row.height)).toBeCloseTo(12, 0);
    expect(pill.height).toBeCloseTo(60, 0);
    expect(chat.width).toBeCloseTo(60, 0);
    expect(chat.height).toBeCloseTo(60, 0);
    expect(chat.x - (pill.x + pill.width)).toBeCloseTo(8, 0);
    for (const link of await page.locator('[data-tab-pill] a').all()) {
      expectMinTouchTarget(await link.boundingBox());
    }
    // Only the active tab (Pipeline) shows its label, on one line.
    const active = page.locator('[data-tab-pill] a[aria-current="page"]');
    await expect(active).toHaveText('Pipeline');
    expect((await active.boundingBox())?.height).toBeCloseTo(44, 0);

    // The tab opens Activity and takes the label.
    await tab.click();
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(tab).toHaveAttribute('aria-current', 'page');
    await expect(tab).toContainText('Activity');
    await expect(page.locator('[data-tab-pill] a', { hasText: 'Pipeline' })).toHaveCount(0);

    // Chat: the circle opens the normal chat page.
    await page.locator('[data-chat-tab]').click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('[data-chat-tab]')).toHaveAttribute('aria-current', 'page');
    expectClean(network);
  },
);
