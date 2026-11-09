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
  // The chat home's chip row (search lives only in the top bar's palette).
  await expect(page.locator('[data-chip-row]').first()).toBeVisible();
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
  'Pipeline tab bar: five 20px pill icons and the 22px Chat circle, the active one the flat panel-3 fill',
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
    // Flat look (7 Nov 2026): the picked pill tab is the panel-3 fill in fg ink
    // (no ink fill, no lit-pill), read from probes in this theme.
    const probe = (cls: string, prop: 'color' | 'backgroundColor') =>
      page.evaluate(
        ([c, p]) => {
          const el = document.createElement('span');
          el.className = c;
          document.body.appendChild(el);
          const value = getComputedStyle(el)[p];
          el.remove();
          return value;
        },
        [cls, prop] as const,
      );
    const ink = await probe('text-fg', 'color');
    const fill = await probe('bg-panel-3', 'backgroundColor');
    const active = page.locator('nav[data-undo-anchor] a[aria-current="page"]');
    await expect(active).toHaveCount(1);
    expect(
      await active
        .locator('svg')
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    ).toBe(ink);
    expect(await active.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(fill);
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
// uppercase) and a list card title is 15px/600 (heading). Pipeline has no
// search field of its own (search is the top bar's palette).
test(
  'Pipeline type roles: sheet header 15px, section label 12px uppercase, card title 15px',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await page.goto('/pipeline');
    const cardTitle = page
      .locator('[data-list-card-title]', { hasText: 'Monday carousel' })
      .first();
    await expect(cardTitle).toBeVisible({ timeout: 15_000 });
    const cardType = await typeOf(cardTitle);
    expect(cardType.size).toBe('15px');
    // Flat look (7 Nov 2026): a read row's title is regular; only unread rows are bold.
    expect(cardType.weight).toBe('400');

    await expect(page.locator('input[type="search"]')).toHaveCount(0);

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

test('2: a layer is one step: thread view and contact sheet close on back and stay in the chat', async ({
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

  // Closing a layer by its own control leaves no step behind: the next back leaves the chat.
  await page.locator('[data-contact-open]').click();
  await contactClose.click();
  await expect(contactClose).toHaveCount(0);
  await page.goBack();
  await expectList(page);
  expectClean(network);
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

test('4: Notifications -> chat mention card opens the chat at the message; back = Notifications', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/notifications');
  const mention = page.locator('[data-activity-event="mention"]', { hasText: MENTION_PREVIEW });
  await mention.locator('[data-activity-lead]').click();
  // 9 Nov 2026: a row tap opens the real place (the chat at that message) and
  // marks the row read; catch-up cards live only in Catch up.
  await expect(page).toHaveURL(/\/chat\?channel=/);
  await expect
    .poll(() => network.rpcCalls.filter((c) => c.name === 'inbox_mark_read').length)
    .toBe(1);
  await page.goBack();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.locator('[data-catch-up]')).toHaveCount(0);
  await expect(mention).toBeVisible();
  expectClean(network);
});

test('5: chat A -> @mention tap -> card send -> toast Open chat -> DM B; back = chat A', async ({
  page,
}) => {
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
  // The mention opens the person card; a quick reaction sends to the DM
  // (the card closes, no navigation) and the toast's Open chat opens it.
  await page.locator('[data-person-reaction]').first().click();
  await page.getByRole('button', { name: 'Open chat', exact: true }).click();
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
