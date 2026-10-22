import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
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
// mention, Plans the plan alerts), a reminder card that opens the chat at its
// message, a failed scheduled send with Retry, and Remind me from a held
// message. The real app tree runs against fixture data in both colour schemes;
// Linux WebKit approximates iOS WebKit, it is not iOS.

const PLAN_ALERT_ID = '0190f200-0000-7000-8000-0000000000a1';
const PLAN_ALERT_PLAN = '0190f200-0000-7000-8000-0000000000a2';
const PLAN_ALERT_TITLE = 'Diwali week';
const FAILED_ENTRY_ID = '0190f200-0000-7000-8000-0000000000b1';
const FAILED_SCHEDULED_ID = '0190f200-0000-7000-8000-0000000000b2';
const FAILED_BODY = 'Sending the final cut tonight';
const REMINDER_ENTRY_ID = '0190f100-0000-7000-8000-0000000000f1';
const REMINDER_ID = '0190e000-0000-7000-8000-000000000001';

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

/** A plan alert (plan_opened by the DM peer) and a failed scheduled send. */
function seedAlerts(world: ChatWorld): void {
  const now = new Date().toISOString();
  (world.tables.chat_scheduled_messages ??= []).push({
    id: FAILED_SCHEDULED_ID,
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: ME,
    body: FAILED_BODY,
    mentions: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    send_at: new Date(Date.now() - 60_000).toISOString(),
    status: 'failed',
    failure_reason: 'not a member of this chat',
    sent_at: null,
    created_at: now,
    updated_at: now,
  });
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
    inboxRow(
      FAILED_ENTRY_ID,
      'scheduled_failed',
      { tier: 'urgent', payload: { scheduled_id: FAILED_SCHEDULED_ID } },
      60_000,
    ),
  );
}

/** The Notifications card of one event type. */
const card = (page: Page, eventType: string) =>
  page.locator(`[data-activity-event="${eventType}"]`);

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
  'the top bar button and merged badge open Notifications; the chips; light and dark',
  { tag: '@theme' },
  async ({ page }, testInfo) => {
    const network = await installHarnessNetwork(page);
    seedAlerts(network.world);

    // The button sits in the top bar; its badge counts every unread row: the
    // seeded chat mention, the plan alert and the failed send.
    await page.goto('/chat');
    const button = page.locator('header [data-notifications-button]');
    await button.waitFor({ state: 'visible', timeout: 15_000 });
    await expect(button).toHaveCount(1);
    expectMinTouchTarget(await button.boundingBox());
    await expect(button).toHaveText('3');
    await expect(button).toHaveAttribute('aria-label', 'Notifications, 3 unread');
    await expect(page.locator('[data-bell-button]')).toHaveCount(0);

    await button.click();
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await expect(button).toHaveAttribute('aria-current', 'page');

    // All: the chat mention, the plan alert and the failed send, as cards.
    await expect(card(page, 'mention')).toContainText(`${PEER_NAME} mentioned you`);
    await expect(card(page, 'mention')).toContainText(MENTION_PREVIEW);
    await expect(card(page, 'plan_opened')).toBeVisible();
    await expect(card(page, 'scheduled_failed')).toBeVisible();

    // The chips (their order is a unit check): the counted ones carry their counts.
    for (const name of ['All', 'Unread 3', 'Mentions 1', 'Briefs', 'Plans', 'Snoozed']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }

    // Mentions: the chat mention, nothing else.
    await page.getByRole('button', { name: 'Mentions 1', exact: true }).click();
    await expect(card(page, 'mention')).toContainText(`${PEER_NAME} mentioned you`);
    await expect(card(page, 'plan_opened')).toHaveCount(0);
    await expect(card(page, 'scheduled_failed')).toHaveCount(0);

    // Plans: the plan alert, in the bell's words.
    await page.getByRole('button', { name: 'Plans', exact: true }).click();
    await expect(card(page, 'plan_opened')).toContainText(
      `${PEER_NAME} opened ${PLAN_ALERT_TITLE} for approvers`,
    );
    await expect(card(page, 'mention')).toHaveCount(0);
    await expect(card(page, 'scheduled_failed')).toHaveCount(0);

    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(card(page, 'scheduled_failed')).toBeVisible();
    const scheme = testInfo.project.use.colorScheme ?? 'dark';
    await page.screenshot({ path: testInfo.outputPath(`notifications-${scheme}.png`) });
    expectClean(network);
  },
);

test('a failed scheduled send: "Not sent" with the reason, and Retry sends it now', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedAlerts(network.world);
  await page.goto('/notifications');
  const failed = card(page, 'scheduled_failed');
  await expect(failed).toContainText("Not sent · You're no longer in this chat", {
    timeout: 15_000,
  });
  await expect(failed).toContainText(FAILED_BODY);
  const retry = failed.locator('[data-activity-action="retry"]');
  const edit = failed.locator('[data-activity-action="edit"]');
  await expect(retry).toHaveText('Retry');
  await expect(edit).toHaveText('Edit');
  expectMinTouchTarget(await retry.boundingBox());
  expectMinTouchTarget(await edit.boundingBox());

  await retry.click();
  await expect
    .poll(() => network.rpcCalls.filter((c) => c.name === 'chat_scheduled_send_now'))
    .toHaveLength(1);
  const call = network.rpcCalls.find((c) => c.name === 'chat_scheduled_send_now');
  expect(call?.args.p_id).toBe(FAILED_SCHEDULED_ID);
  expect(typeof call?.args.p_trace_id).toBe('string');
  // The proc cleared the failed entry: the reloaded card is read.
  await expect(failed.locator('[aria-label="Unread"]')).toHaveCount(0);
  expectClean(network);
});

test('Remind me from a held message', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(400);

  await holdBubble(page, MENTION_PREVIEW);
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  // Remind me and Mark as sit under More.
  await menu.locator('[data-menu-item="more"]').click();
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
  // Remind me sits under More.
  const more = menu.locator('[data-menu-item="more"]');

  // Set one from "Remind me".
  await holdBubble(page, MENTION_PREVIEW);
  await more.click();
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
  await more.click();
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
  await more.click();
  await expect(remind).toHaveText('Remind me');
  expectClean(network);
});

test('a reminder fires while the app is open: toast; its card opens the chat at the message, still unread', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  const start = new Date();
  start.setSeconds(0, 0);
  await page.clock.install({ time: start });
  const dm = network.world.dmMessages[10];
  if (dm === undefined) throw new Error('fixture message');
  const remindAt = new Date(start.getTime() + 2 * 60_000);
  (network.world.tables.chat_message_reminders ??= []).push({
    id: REMINDER_ID,
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
  await page.locator('header [data-notifications-button]').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  await page.clock.fastForward(2 * 60_000);
  await expect(page.getByText(`Reminder: ${String(dm.body)}`)).toBeVisible();

  // The cron's side: the reminder fired and its inbox row landed.
  const pending = network.world.tables.chat_message_reminders?.[0];
  if (pending) pending.fired_at = remindAt.toISOString();
  network.world.tables.inbox_entries?.push({
    ...inboxRow(
      REMINDER_ENTRY_ID,
      'reminder',
      { tier: 'urgent', payload: { message_id: dm.id, reminder_id: REMINDER_ID } },
      0,
    ),
    created_at: remindAt.toISOString(),
  });

  await page.locator('header [data-notifications-button]').click();
  await expect(page).toHaveURL(/\/notifications$/);
  const reminder = card(page, 'reminder');
  await expect(reminder).toContainText(String(dm.body));
  await expect(reminder.locator('[data-activity-menu]')).toBeVisible();
  expectMinTouchTarget(await reminder.locator('[data-activity-lead]').boundingBox());

  // The tap opens the chat at that message (the chat consumes and drops the
  // ?message= jump at once, so the landed message is the proof) and never
  // marks the reminder read.
  await reminder.locator('[data-activity-lead]').click();
  await expect(page).toHaveURL(new RegExp(`/chat\\?channel=${encodeURIComponent(DM_CHANNEL)}`));
  await expect(page.locator(`[data-msg-id="${String(dm.id)}"]`)).toBeVisible({ timeout: 8000 });
  expect(network.rpcCalls.filter((c) => c.name === 'inbox_mark_read')).toEqual([]);
  expectClean(network);
});
