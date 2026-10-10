import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, solidPng, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  GROUP_CHANNEL,
  GROUP_NAME,
  ME,
  PEER_NAME,
  WORKSPACE_ID,
} from '../fixtures/chat-data';

// Scheduled send (S1 to S7): the tray's Schedule tile, the Schedule sheet and
// its Custom step, schedule mode, the scheduled strip in a DM and a group, the
// "Scheduled in this chat" sheet, the phone hold on Send and the laptop
// chevron menu. The real app tree runs against fixture data; Linux WebKit
// approximates iOS WebKit, it is not iOS.

function scheduledRow(id: string, channelId: string, body: string, sendAt: Date) {
  const now = new Date().toISOString();
  return {
    id,
    channel_id: channelId,
    workspace_id: WORKSPACE_ID,
    sender_user_id: ME,
    body,
    mentions: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    send_at: sendAt.toISOString(),
    status: 'scheduled',
    failure_reason: null,
    sent_at: null,
    created_at: now,
    updated_at: now,
  };
}

function tomorrowAt9(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0, 0, 0);
}

function inDays(days: number, hour: number, minute = 0): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour, minute, 0, 0);
}

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
}

function composer(page: Page) {
  return page.locator('form:has(textarea)').first();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

/**
 * The plus tray renders only where attaching works (an upload endpoint). The
 * harness env has none, so tray steps skip there and run wherever it is set.
 */
async function trayOrSkip(page: Page): Promise<void> {
  const plus = page.getByRole('button', { name: 'Add attachment' });
  test.skip((await plus.count()) === 0, 'no upload endpoint in this env: the plus tray is off');
  await plus.click();
}

/** Hold Send like a finger: pointerdown, 600ms, pointerup, then the trailing click. */
async function holdSend(page: Page): Promise<void> {
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const box = await send.boundingBox();
  if (box === null) throw new Error('send has no box');
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await send.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(600);
  await send.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
  await page.mouse.click(at.clientX, at.clientY);
}

test.describe('phone', () => {
  test('hold on Send: Schedule sheet, Custom step, schedule at once', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await openChat(page, PEER_NAME);
    const textarea = composer(page).locator('textarea');
    await textarea.fill('Can we move the shoot to Monday?');

    // No iOS selection or callout on the Send button.
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const select = await send.evaluate((el) => {
      const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitUserSelect?: string };
      return style.userSelect || style.webkitUserSelect || '';
    });
    expect(select).toBe('none');

    // S2: the hold opens the sheet (with the preview) and sends nothing.
    const before = await page.locator('[data-msg-id]').count();
    await holdSend(page);
    const sheet = page.getByRole('dialog', { name: 'Schedule message' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-schedule-preview]')).toHaveText(
      `To ${PEER_NAME}: Can we move the shoot to Monday?`,
    );
    await expect(sheet.locator('[data-schedule-zone]')).toContainText(
      'Times are in your time zone',
    );
    await page.waitForTimeout(500);
    expect(await page.locator('[data-msg-id]').count()).toBe(before);
    await expect(textarea).toHaveValue('Can we move the shoot to Monday?');
    await shot(page, 'scheduled-2-sheet');

    // S3: the Custom step.
    await sheet.locator('[data-schedule-row="custom"]').click();
    await expect(sheet.locator('[data-schedule-summary]')).toContainText('Sends ');
    await expect(sheet.getByText('Any time from 1 minute to 1 year ahead.')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Schedule', exact: true })).toBeEnabled();
    await shot(page, 'scheduled-3-custom');
    await sheet.getByRole('button', { name: 'Cancel' }).last().click();
    await expect(sheet).toBeHidden();

    // Hold again and pick Monday: scheduled at once, the draft clears.
    await holdSend(page);
    await sheet.locator('[data-schedule-row="monday"]').click();
    await expect(page.getByText(/^Scheduled for /)).toBeVisible();
    await expect(page.locator('[data-scheduled-strip]')).toContainText('1 scheduled message');
    await expect(textarea).toHaveValue('');
    expect(await page.locator('[data-msg-id]').count()).toBe(before);

    // A normal tap still sends instantly.
    await textarea.fill('Sent right now');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('[data-msg-id]', { hasText: 'Sent right now' })).toBeVisible();
    expectClean(network);
  });

  test('tray: Schedule tile and schedule mode from an empty draft', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await openChat(page, PEER_NAME);

    // S1: the tray shows Photos, File, Assets, Brief, Post, Draft, Plan, Schedule (no Camera).
    await trayOrSkip(page);
    const tiles = page.locator('[data-tray-tile]');
    await expect(tiles).toHaveCount(8);
    expect(
      await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-tray-tile'))),
    ).toEqual(['photos', 'file', 'assets', 'brief', 'post', 'draft', 'plan', 'schedule']);
    await page.waitForTimeout(250);
    await shot(page, 'scheduled-1-tray');

    // S4: an empty draft opens the sheet without a preview.
    await page.locator('[data-tray-tile="schedule"]').click();
    const sheet = page.getByRole('dialog', { name: 'Schedule message' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-schedule-preview]')).toHaveCount(0);
    await sheet.locator('[data-schedule-row="tomorrow"]').click();
    const mode = page.locator('[data-schedule-mode]');
    await expect(mode).toContainText('Sends tomorrow 9:00 AM');
    await composer(page).locator('textarea').fill('Weekly numbers are in the deck');
    await expect(page.getByRole('button', { name: 'Schedule message' })).toBeEnabled();
    await page.waitForTimeout(300);
    await shot(page, 'scheduled-4-schedule-mode');

    // Submitting schedules (not sends): the draft clears, the strip appears.
    const before = await page.locator('[data-msg-id]').count();
    await page.getByRole('button', { name: 'Schedule message' }).click();
    await expect(page.getByText('Scheduled for tomorrow 9:00 AM')).toBeVisible();
    await expect(composer(page).locator('textarea')).toHaveValue('');
    await expect(mode).toHaveCount(0);
    await expect(page.locator('[data-scheduled-strip]')).toContainText('1 scheduled message');
    expect(await page.locator('[data-msg-id]').count()).toBe(before);
    expectClean(network);
  });

  test('scheduled strip paints with the thread (DM and group) and the list sheet', async ({
    page,
  }) => {
    const network = await installHarnessNetwork(page);
    const rows = (network.world.tables.chat_scheduled_messages ??= []);
    rows.push(
      scheduledRow(
        '0190b000-0000-7000-8000-000000000101',
        DM_CHANNEL,
        'Reminder: brief due',
        tomorrowAt9(),
      ),
    );
    rows.push(
      scheduledRow(
        '0190b000-0000-7000-8000-000000000201',
        GROUP_CHANNEL,
        'Kickoff notes',
        inDays(4, 11, 30),
      ),
    );
    rows.push(
      scheduledRow(
        '0190b000-0000-7000-8000-000000000202',
        GROUP_CHANNEL,
        'Retro at 5',
        inDays(5, 9),
      ),
    );

    // First paint: while the history is held, no strip; with the messages, the strip.
    await page.goto('/chat');
    const dm = page.getByText(PEER_NAME, { exact: true }).first();
    await dm.waitFor({ state: 'visible' });
    const gate = network.holdHistory();
    await dm.click();
    await page.waitForTimeout(400);
    await expect(page.locator('[data-scheduled-strip]')).toHaveCount(0);
    // Record whether the strip ever shows after the first message (pop-in).
    await page.evaluate(() => {
      const w = window as unknown as { popIn: string };
      w.popIn = 'pending';
      const check = (): void => {
        const msg = document.querySelector('[data-msg-id]') !== null;
        const strip = document.querySelector('[data-scheduled-strip]') !== null;
        if (w.popIn !== 'pending') return;
        if (msg && strip) w.popIn = 'same-frame';
        else if (msg && !strip) w.popIn = 'messages-first';
        else if (strip && !msg) w.popIn = 'strip-first';
      };
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    });
    gate.release();
    await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
    expect(await page.evaluate(() => (window as unknown as { popIn: string }).popIn)).toBe(
      'same-frame',
    );
    const strip = page.locator('[data-scheduled-strip]');
    await expect(strip).toContainText('1 scheduled message');
    await expect(strip).toContainText('Tomorrow 9:00 AM');
    await page.waitForTimeout(300);
    await shot(page, 'scheduled-6-strip-dm');

    // S7: the list sheet.
    await strip.click();
    const list = page.getByRole('dialog', { name: 'Scheduled in this chat' });
    await expect(list.locator('[data-scheduled-card]')).toHaveCount(1);
    await page.waitForTimeout(400);
    await shot(page, 'scheduled-7-list-dm');

    // Send now: the row joins the thread, the strip goes.
    await list.getByRole('button', { name: 'Send now' }).click();
    await expect(page.locator('[data-msg-id]', { hasText: 'Reminder: brief due' })).toBeVisible();
    await expect(strip).toHaveCount(0);

    // Group: two rows, soonest first; Cancel asks first.
    await page.goBack().catch(() => undefined);
    await openChat(page, GROUP_NAME);
    await expect(strip).toContainText('2 scheduled messages');
    await page.waitForTimeout(300);
    await shot(page, 'scheduled-8-strip-group');
    await strip.click();
    await expect(list.locator('[data-scheduled-card]')).toHaveCount(2);
    await expect(list.locator('[data-scheduled-preview]').first()).toHaveText('Kickoff notes');
    await page.waitForTimeout(400);
    await shot(page, 'scheduled-9-list-group');
    await list.getByRole('button', { name: 'Cancel' }).first().click();
    const confirm = page.getByRole('dialog', { name: 'Cancel this scheduled message?' });
    await expect(confirm.getByRole('button', { name: 'Keep' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel message' }).click();
    await expect(strip).toContainText('1 scheduled message');
    expectClean(network);
  });
});

/** Pick a photo through the composer's Photos input (the tray's own picker). */
async function pickPhoto(page: Page, name: string): Promise<void> {
  const input = composer(page).locator('input[type="file"]').first();
  test.skip((await input.count()) === 0, 'no upload endpoint in this env: attaching is off');
  await input.setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: solidPng(64, 48, [200, 120, 60]),
  });
  await expect(composer(page).getByText(name)).toBeVisible();
}

test.describe('phone: photos and files (UI-3)', () => {
  test('pick a photo, hold Send, Tomorrow: the card shows its thumbnail; Edit is text only', async ({
    page,
  }) => {
    const network = await installHarnessNetwork(page);
    await openChat(page, PEER_NAME);
    const before = await page.locator('[data-msg-id]').count();
    await pickPhoto(page, 'moodboard.png');

    // S1: a photo alone can be scheduled; the preview names it.
    await holdSend(page);
    const sheet = page.getByRole('dialog', { name: 'Schedule message' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-schedule-preview]')).toHaveText(`To ${PEER_NAME}: 1 photo`);

    // S2: the upload runs first; the composer locks and Send reads "Scheduling...".
    const gate = network.holdUploads();
    await sheet.locator('[data-schedule-row="tomorrow"]').click();
    await expect(page.locator('[data-scheduling]')).toHaveText('Scheduling...');
    await expect(composer(page).locator('[data-schedule-upload-bar]')).toBeVisible();
    await page.waitForTimeout(200);
    await shot(page, 'ui3-1-uploading');
    gate.release();

    await expect(page.getByText('Scheduled for tomorrow 9:00 AM')).toBeVisible();
    await expect(composer(page).getByText('moodboard.png')).toHaveCount(0);
    expect(network.uploads).toEqual(['moodboard.png']);
    const stored = network.world.tables.chat_scheduled_messages ?? [];
    expect(stored).toHaveLength(1);
    const ids = stored[0]?.attachment_asset_ids as string[];
    expect(ids).toHaveLength(1);
    expect(stored[0]?.attachment_meta).toEqual({
      [ids[0] as string]: { mime: 'image/png', name: 'moodboard.png', size: expect.any(Number) },
    });
    expect(await page.locator('[data-msg-id]').count()).toBe(before);

    // S4: the strip and the card show the thumbnail.
    const strip = page.locator('[data-scheduled-strip]');
    await expect(strip.locator('[data-scheduled-thumb]')).toHaveCount(1);
    await page.waitForTimeout(300);
    await shot(page, 'ui3-2-strip-thumb');
    await strip.click();
    const list = page.getByRole('dialog', { name: 'Scheduled in this chat' });
    const card = list.locator('[data-scheduled-card]');
    await expect(card.locator('[data-scheduled-thumb] img')).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, 'ui3-3-card-thumb');

    // S5: Edit is text only; the files are read-only with the line.
    await card.getByRole('button', { name: 'Edit' }).click();
    const files = card.locator('[data-scheduled-files-readonly]');
    await expect(files).toContainText('To change files, cancel and schedule again.');
    await expect(files.locator('[data-scheduled-thumb]')).toHaveCount(1);
    await page.waitForTimeout(300);
    await shot(page, 'ui3-4-edit-files-readonly');
    expectClean(network);
  });

  test('a normal tap-send with photos is unchanged', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await openChat(page, PEER_NAME);
    await pickPhoto(page, 'final-cut.png');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('[data-album]').last()).toBeVisible();
    await expect(composer(page).getByText('final-cut.png')).toHaveCount(0);
    await expect.poll(() => network.uploads).toEqual(['final-cut.png']);
    expect(network.world.tables.chat_scheduled_messages ?? []).toEqual([]);
    await page.waitForTimeout(400);
    await shot(page, 'ui3-5-tap-send-photo');
    expectClean(network);
  });
});

test.describe('laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('chevron menu next to Send', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await openChat(page, PEER_NAME);
    const chevron = page.getByRole('button', { name: 'Schedule options' });
    await expect(chevron).toHaveCount(0);
    await composer(page).locator('textarea').fill('Draft for Monday');
    await expect(chevron).toBeVisible();
    const size = await chevron.boundingBox();
    expect(size?.width).toBeGreaterThanOrEqual(44);
    expect(size?.height).toBeGreaterThanOrEqual(44);
    await chevron.click();
    const menu = page.locator('[data-schedule-menu]');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-schedule-preview]')).toHaveText(
      `To ${PEER_NAME}: Draft for Monday`,
    );
    await page.waitForTimeout(250);
    await shot(page, 'scheduled-10-laptop-menu');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Enter still sends instantly.
    await composer(page).locator('textarea').press('Enter');
    await expect(page.locator('[data-msg-id]', { hasText: 'Draft for Monday' })).toBeVisible();
    expectClean(network);
  });
});
