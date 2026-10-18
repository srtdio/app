import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, ME, MENTION_PREVIEW, PEER_NAME, WORKSPACE_ID } from '../fixtures/chat-data';

// The bell (UI-2, W8): the bell in the top bar on every screen, Remind me from a held
// message, Upcoming, a reminder that fires while the app is open, and chat
// mentions living in the bell instead of Activity. The real app tree runs
// against fixture data in both colour schemes; Linux WebKit approximates iOS
// WebKit, it is not iOS.

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

async function openBell(page: Page): Promise<void> {
  const bell = page.locator('[data-bell-button]');
  await bell.waitFor({ state: 'visible' });
  await bell.click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  await page.locator('[data-bell-skeleton]').waitFor({ state: 'detached' });
}

/** Hold a bubble like a finger: pointerdown, 700ms still, pointerup. */
async function holdBubble(page: Page, text: string): Promise<void> {
  const bubble = page.locator('[data-bubble]', { hasText: text }).first();
  await bubble.scrollIntoViewIfNeeded();
  const box = await bubble.boundingBox();
  if (box === null) throw new Error('bubble has no box');
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await bubble.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(700);
  await bubble.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
}

test(
  'bell: in the top bar on every screen, chat mention in Now, Activity shows no chat mention',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);

    // Activity is posts only: the seeded chat mention is not there. The bell
    // still sits in the top bar here.
    await page.goto('/activity');
    await page.waitForTimeout(1200);
    await expect(page.getByText(MENTION_PREVIEW, { exact: false })).toHaveCount(0);
    await expect(page.locator('header [data-bell-button]')).toBeVisible();

    await page.goto('/chat');
    const bell = page.locator('[data-bell-button]');
    await bell.waitFor({ state: 'visible' });
    // One bell, in the top bar: the Chat home search row no longer has its own.
    await expect(bell).toHaveCount(1);
    await expect(page.locator('header [data-bell-button]')).toHaveCount(1);
    const size = await bell.boundingBox();
    expectMinTouchTarget(size);
    await expect(page.locator('[data-bell-badge]')).toHaveText('1');

    await openBell(page);
    const mention = page.locator('[data-bell-row="mention"]');
    await expect(mention).toContainText(`${PEER_NAME} mentioned you`);
    await expect(mention).toContainText(MENTION_PREVIEW);

    // Tap: marks it read and opens the chat at that message.
    await mention.locator('[data-bell-open]').click();
    await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
    await expect(page).toHaveURL(/\/chat/);
    expectClean(network);
  },
);

test('Remind me from a held message, then Upcoming', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);

  await holdBubble(page, MENTION_PREVIEW);
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  const rows = await menu
    .locator('[data-menu-item],[data-menu-note]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-menu-item') ?? el.getAttribute('data-menu-note')),
    );
  // Remind me sits directly before Mark as.
  const markAt = rows.findIndex((r) => r === 'mark' || r === 'marked');
  expect(rows[markAt - 1]).toBe('remind');

  await menu.locator('[data-menu-item="remind"]').click();
  const sheet = page.getByRole('dialog', { name: 'Remind me' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-reminder-preview]')).toContainText(MENTION_PREVIEW);
  await sheet.locator('[data-reminder-row="1h"]').click();
  await expect(page.getByText(/^Reminder set for /)).toBeVisible();
  const stored = network.world.tables.chat_message_reminders ?? [];
  expect(stored).toHaveLength(1);
  expect(stored[0]?.channel_id).toBe(DM_CHANNEL);

  // Back to the Chat home, open the bell, Upcoming lists it.
  await page.getByRole('button', { name: /back/i }).first().click();
  await openBell(page);
  await page.locator('[data-bell-tab="upcoming"]').click();
  const row = page.locator('[data-bell-row="upcoming-reminder"]');
  await expect(row).toContainText(MENTION_PREVIEW);
  await expect(row.locator('[data-bell-action="change-time"]')).toBeVisible();
  expectClean(network);
});

test('reminder state lives in the long-press menu: set, change, cancel', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);
  const menu = page.getByRole('menu', { name: 'Message actions' });
  const remind = menu.locator('[data-menu-item="remind"]');

  // Set one from "Remind me".
  await holdBubble(page, MENTION_PREVIEW);
  await expect(remind).toHaveText('Remind me');
  await remind.click();
  await page
    .getByRole('dialog', { name: 'Remind me' })
    .locator('[data-reminder-row="tomorrow"]')
    .click();
  await expect(page.getByText(/^Reminder set for /)).toBeVisible();

  // No reminder icon on any bubble.
  await expect(page.locator('[data-bubble] [data-reminder-badge]')).toHaveCount(0);

  // The same slot now reads "Reminder · <time>", the time in mono.
  await holdBubble(page, MENTION_PREVIEW);
  await expect(remind).toContainText('Reminder · ');
  await expect(remind.locator('[data-menu-mono]')).toHaveText('Tomorrow 9:00 AM');

  // Change mode: "Reminder", the presets, then "Cancel reminder".
  await remind.click();
  const sheet = page.getByRole('dialog', { name: 'Reminder' });
  await expect(sheet.locator('[data-reminder-row="1h"]')).toBeVisible();
  await expect(sheet.locator('[data-reminder-row="cancel"]')).toHaveText('Cancel reminder');
  await sheet.locator('[data-reminder-row="cancel"]').click();
  await expect(page.getByText('Reminder cancelled')).toBeVisible();
  const stored = network.world.tables.chat_message_reminders ?? [];
  expect(stored.every((r) => r.cancelled_at !== null)).toBe(true);

  // Back to "Remind me".
  await holdBubble(page, MENTION_PREVIEW);
  await expect(remind).toHaveText('Remind me');
  expectClean(network);
});

test('a reminder fires while the app is open: toast, then it shows in Now', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  const start = new Date();
  start.setSeconds(0, 0);
  await page.clock.install({ time: start });
  const dm = network.world.dmMessages[10];
  if (dm === undefined) throw new Error('fixture message');
  const remindAt = new Date(start.getTime() + 2 * 60_000);
  (network.world.tables.chat_message_reminders ??= []).push({
    id: '0190e000-0000-7000-8000-000000000001',
    user_id: ME,
    message_id: dm.id,
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    remind_at: remindAt.toISOString(),
    fired_at: null,
    cancelled_at: null,
    created_at: start.toISOString(),
  });

  await page.goto('/chat');
  await page.locator('[data-bell-button]').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.clock.fastForward(2 * 60_000);
  const toast = page.getByText(`Reminder: ${String(dm.body)}`);
  await expect(toast).toBeVisible();

  // The cron's side: the reminder fired and its inbox row landed.
  const pending = network.world.tables.chat_message_reminders?.[0];
  if (pending) pending.fired_at = remindAt.toISOString();
  network.world.tables.inbox_entries?.push({
    id: '0190f100-0000-7000-8000-0000000000f1',
    user_id: ME,
    actor_user_id: null,
    workspace_id: WORKSPACE_ID,
    event_type: 'reminder',
    entity_type: 'chat_channel',
    entity_id: DM_CHANNEL,
    scope: 'people',
    scope_key: DM_CHANNEL,
    tier: 'urgent',
    payload: { message_id: dm.id, reminder_id: '0190e000-0000-7000-8000-000000000001' },
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: remindAt.toISOString(),
  });

  await openBell(page);
  const row = page.locator('[data-bell-row="reminder"]');
  await expect(row).toContainText(String(dm.body));
  await expect(row.locator('[data-bell-action="snooze"]')).toBeVisible();
  await expect(row.locator('[data-bell-action="done"]')).toBeVisible();
  expectClean(network);
});
