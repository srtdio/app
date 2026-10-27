import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  COLLEAGUE_A,
  DM_CHANNEL,
  GROUP_CHANNEL,
  GROUP_ID,
  GROUP_NAME,
  ME,
  MENTION_PREVIEW,
  PEER,
  PEER_NAME,
  WORKSPACE_ID,
} from '../fixtures/chat-data';
import { expectButtonsMeetSystem } from '../helpers/button-system';

// Back returns to where you came from: every open is one history step and
// every back (page.goBack, the iOS swipe and browser Back alike) pops exactly
// one. The real app tree runs against fixture data in both colour schemes;
// Linux WebKit approximates iOS WebKit, it is not iOS.

function expectClean(network: HarnessNetwork, allowed: readonly string[] = []): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  const unmatched = [...new Set(network.unmatched)].filter((r) => !allowed.includes(r));
  expect(unmatched, 'unrecognised fixture requests').toEqual([]);
}

/** The chat list is on screen (chat home), no thread. */
async function expectList(page: Page): Promise<void> {
  await expect(page.getByRole('searchbox', { name: 'Search chats' })).toBeVisible();
  await expect(page.locator('[data-msg-id]')).toHaveCount(0);
}

async function openFromList(page: Page, name: string): Promise<void> {
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
}

/** Header title of the open chat. */
function header(page: Page, name: string): ReturnType<Page['locator']> {
  return page.locator('[data-contact-open], [data-group-info-open]', { hasText: name }).first();
}

test(
  '1: Pipeline -> Chat tab -> open chat; back = list (/chat), back again = Pipeline',
  { tag: '@theme' },
  async ({ page }) => {
    await installHarnessNetwork(page);
    await page.goto('/pipeline');
    await page.getByRole('link', { name: 'Chat' }).first().click();
    await expect(page).toHaveURL(/\/chat$/);
    await openFromList(page, PEER_NAME);
    await page.goBack();
    await expect(page).toHaveURL(/\/chat$/);
    await expectList(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/pipeline$/);
  },
);

test('Pipeline: every button is 44 tall with an 8px radius or round', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/pipeline');
  await expect(page.getByText('Monday carousel', { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expectButtonsMeetSystem(page);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

test(
  'Pipeline tab bar: five 20px pill icons and the 22px Chat circle, the active one in accent',
  { tag: '@theme' },
  async ({ page }) => {
    await installHarnessNetwork(page);
    await page.goto('/pipeline');
    // The floating pill (Pipeline, Briefs, Assets, Plan, Activity), then Chat.
    const tabs = page.locator('nav[data-undo-anchor] a');
    await expect(tabs).toHaveCount(6);
    const icons = tabs.locator('svg').first();
    await expect(icons).toBeVisible();
    for (let i = 0; i < 6; i += 1) {
      const size = i === 5 ? 22 : 20;
      const box = await tabs.nth(i).locator('svg').first().boundingBox();
      expect(box?.width).toBeCloseTo(size, 0);
      expect(box?.height).toBeCloseTo(size, 0);
    }
    // The accent token's resolved colour, read from a probe in this theme.
    const accent = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.className = 'text-accent';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    const active = page.locator('nav[data-undo-anchor] a[aria-current="page"]');
    await expect(active).toHaveCount(1);
    expect(
      await active
        .locator('svg')
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe(accent);
  },
);

/** The computed type of one element: size, weight and case. */
function typeOf(locator: Locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { size: s.fontSize, weight: s.fontWeight, transform: s.textTransform };
  });
}

// Type roles on Pipeline (design rules, locked 24 Oct 2026). Pipeline has no
// page title or PageHead: its screen header is the Filter and sort sheet title
// (15px/600), the sheet's Due date label is a section label (12px/600,
// uppercase), a card title is 14px/500 and the search field renders 16px on
// the phone (iOS zoom).
test(
  'Pipeline type roles: sheet header 15px, section label 12px uppercase, card title 14px',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await page.goto('/pipeline');
    const cardTitle = page
      .locator('[data-post-card-title]', { hasText: 'Monday carousel' })
      .first();
    await expect(cardTitle).toBeVisible({ timeout: 15_000 });
    const cardType = await typeOf(cardTitle);
    expect(cardType.size).toBe('14px');
    expect(cardType.weight).toBe('500');

    expect((await typeOf(page.getByPlaceholder('Search posts'))).size).toBe('16px');

    await page.locator('[data-filter-control]').click();
    const sheet = page.getByRole('dialog', { name: 'Filter and sort' });
    await expect(sheet).toBeVisible();
    const header = sheet.getByRole('heading', { name: 'Filter and sort' });
    const headerType = await typeOf(header);
    expect(headerType.size).toBe('15px');
    expect(headerType.weight).toBe('600');

    const label = sheet.locator('[data-filter-body] > p', { hasText: 'Due date' });
    const labelType = await typeOf(label);
    expect(labelType.size).toBe('12px');
    expect(labelType.weight).toBe('600');
    expect(labelType.transform).toBe('uppercase');
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  },
);

test('2: a layer is one step: thread view, contact sheet, Starred close on back and stay in the chat', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/chat');
  await openFromList(page, PEER_NAME);
  const chatUrl = page.url();

  // Contact sheet.
  await page.locator('[data-contact-open]').click();
  const contactClose = page.getByRole('button', { name: 'Close contact info' });
  await expect(contactClose).toBeVisible();
  await page.goBack();
  await expect(contactClose).toHaveCount(0);
  expect(page.url()).toBe(chatUrl);
  await expect(page.locator('[data-msg-id]').first()).toBeVisible();

  // Starred.
  await page.getByRole('button', { name: 'Starred messages' }).click();
  await expect(page.locator('[data-starred-sheet]')).toBeVisible();
  await page.goBack();
  await expect(page.locator('[data-starred-sheet]')).toHaveCount(0);
  expect(page.url()).toBe(chatUrl);

  // Closing a layer by its own control leaves no step behind: the next back leaves the chat.
  await page.getByRole('button', { name: 'Starred messages' }).click();
  await page.locator('[data-starred-sheet]').getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('[data-starred-sheet]')).toHaveCount(0);
  await page.goBack();
  await expectList(page);
  // The Starred sheet's own read (stubbed only by chat-stars.spec): an empty list here.
  expectClean(network, ['rpc chat_message_starred_list']);
});

test('2b: the thread view closes on back (its fade) and stays in the chat', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/chat');
  await openFromList(page, 'Maya Chen');
  const chatUrl = page.url();
  await page.locator('[data-thread-open="replies"]', { hasText: '4 replies' }).click();
  const view = page.locator('[data-thread-view]');
  await expect(view).toHaveCSS('opacity', '1');
  await page.goBack();
  await expect(view).toHaveCount(0);
  expect(page.url()).toBe(chatUrl);
  await expect(page.locator('[data-msg-id]').first()).toBeVisible();
  await page.goBack();
  await expectList(page);
  expectClean(network);
});

test('3: Notifications -> chat mention -> back = Notifications', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/notifications');
  await page.waitForTimeout(600);
  // The page's own tap: an in-app push of the mention's deep link (navigate(href)).
  await page.evaluate(
    ({ channel, message }) => {
      const state = (window.history.state ?? {}) as { idx?: number };
      window.history.pushState(
        { usr: null, key: 'activity-tap', idx: (state.idx ?? 0) + 1 },
        '',
        `/chat?channel=${encodeURIComponent(channel)}&message=${encodeURIComponent(message)}`,
      );
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    },
    { channel: DM_CHANNEL, message: 'mention' },
  );
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.goBack();
  await expect(page).toHaveURL(/\/notifications$/);
});

test('4: Notifications -> chat mention card (marked read) -> back = Notifications', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/notifications');
  const mention = page.locator('[data-activity-event="mention"]', { hasText: MENTION_PREVIEW });
  await mention.locator('[data-activity-lead]').click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await expect(page).toHaveURL(/\/chat\?channel=/);
  await page.goBack();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(mention).toBeVisible();
  expect(network.rpcCalls.filter((c) => c.name === 'inbox_mark_read')).toHaveLength(1);
  expectClean(network);
});

test('5: chat A -> @mention tap -> DM B; back = chat A', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  // The group gains the DM peer and a message mentioning them (this test's world only).
  const tables = network.world.tables;
  (tables.group_members ??= []).push({
    group_id: GROUP_ID,
    user_id: PEER,
    workspace_id: WORKSPACE_ID,
    joined_at: '2026-01-03T00:00:00Z',
  });
  (tables.chat_messages ??= []).push({
    id: '0190b000-0000-7000-8900-000000000001',
    channel_id: GROUP_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: COLLEAGUE_A,
    body: `Loop in @[${PEER}] on this`,
    mentions: [PEER],
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  });
  // My DM with them already exists: the ensure answers its id.
  await page.route(/\/rest\/v1\/rpc\/dm_channel_ensure/, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify(`dm__${WORKSPACE_ID}__${ME}__${PEER}`),
    });
  });
  await page.goto('/chat');
  await openFromList(page, GROUP_NAME);
  const groupUrl = page.url();
  const mention = page.locator(`button[data-mention="${PEER}"]`).first();
  await mention.scrollIntoViewIfNeeded();
  await mention.click();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(DM_CHANNEL)));
  await expect(header(page, PEER_NAME)).toBeVisible();
  await page.goBack();
  expect(page.url()).toBe(groupUrl);
  await expect(header(page, GROUP_NAME)).toBeVisible();
});

test.describe('6: laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('chat A -> chat B -> back = chat A', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await page.goto('/chat');
    await openFromList(page, PEER_NAME);
    const aUrl = page.url();
    await page.getByText(GROUP_NAME, { exact: true }).first().click();
    await expect(header(page, GROUP_NAME)).toBeVisible();
    await page.goBack();
    expect(page.url()).toBe(aUrl);
    await expect(header(page, PEER_NAME)).toBeVisible();
    // Back once more: the chat closes on a laptop too.
    await page.goBack();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByText('Select a conversation')).toBeVisible();
    expectClean(network);
  });
});

test('7: cold load /chat?channel=X -> header arrow = chat list', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto(`/chat?channel=${encodeURIComponent(DM_CHANNEL)}`);
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expectList(page);
  expectClean(network);
});

test('8: a draft typed in a chat survives back and reopen', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/chat');
  await openFromList(page, PEER_NAME);
  const draft = 'Half a thought about the hook';
  await page.locator('form textarea').first().fill(draft);
  await page.goBack();
  await expectList(page);
  await openFromList(page, PEER_NAME);
  await expect(page.locator('form textarea').first()).toHaveValue(draft);
  expectClean(network);
});

test('F2: Pipeline -> Chat tab -> group -> Leave group: list at once, back = Pipeline', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  // Leaving is accepted (this test's world only): I drop out of the group.
  await page.route(/\/rest\/v1\/rpc\/group_leave/, async (route: Route) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const tables = network.world.tables;
    tables.group_members = (tables.group_members ?? []).filter(
      (m) => !(m.group_id === GROUP_ID && m.user_id === ME),
    );
    await route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: 'null',
    });
  });
  await page.goto('/pipeline');
  await page.getByRole('link', { name: 'Chat' }).first().click();
  await expect(page).toHaveURL(/\/chat$/);
  await openFromList(page, GROUP_NAME);
  await page.locator('[data-group-info-open]').first().click();
  await page.locator('[data-row="leave-group"]').click();
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expectList(page);
  // No duplicate list entry: one back leaves Chat.
  await page.goBack();
  await expect(page).toHaveURL(/\/pipeline$/);
});
