import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, GROUP_NAME, ME, PEER_NAME, WORKSPACE_ID } from '../fixtures/chat-data';
import { installLinkPreviewStub } from '../fixtures/link-previews';
import { installMediaSearch, MEDIA_MSG } from '../fixtures/search-data';
import { undoStrip } from '../helpers/undo-strip';
import { stubVoiceRecorder } from '../helpers/voice-recorder';

// Delete for me: a message's Delete opens the delete sheet (Delete for
// everyone only for an own message inside 30 minutes; Delete for me always);
// Delete for me takes the message off this person's view at once behind the
// "Deleted for you" Undo strip, and chat_messages_hide records it (with the
// action's trace id) only when the window ends, so it stays hidden on a
// reload. A tombstone's one-row menu, the chat home's Photos chip select and
// the photo viewer's Delete take the same path. Plus an own voice note while
// it uploads: the ring in the play slot and the real bars at reduced emphasis.
// Tagged @theme and @desktop: runs on iphone-webkit, iphone-webkit-light and
// desktop-webkit. Linux WebKit approximates iOS WebKit; it is not iOS.

/** The Undo window (src/lib/undo.ts UNDO_MS) plus the record's round trip. */
const COMMIT_WAIT_MS = 4_000 + 8_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The own message seeded two minutes back (Delete for everyone still applies). */
const FRESH_OWN_BODY = 'Final cut is in the folder';
const FRESH_OWN_ID = '0190b000-0000-7000-8100-0000000009f1';

const isLaptop = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 768;

function hideCalls(network: HarnessNetwork): Array<Record<string, unknown>> {
  return network.rpcCalls.filter((c) => c.name === 'chat_messages_hide').map((c) => c.args);
}

function row(page: Page, messageId: string): Locator {
  return page.locator(`[data-msg-id="${messageId}"]`);
}

/** The DM's newest row: the peer's, an hour or more old. */
function newestPeerRow(network: HarnessNetwork): { id: string; body: string } {
  const last = network.world.dmMessages[network.world.dmMessages.length - 1];
  if (last === undefined) throw new Error('no DM rows');
  return { id: String(last.id), body: String(last.body) };
}

function seedFreshOwnMessage(network: HarnessNetwork): void {
  (network.world.tables.chat_messages ??= []).push({
    id: FRESH_OWN_ID,
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: ME,
    body: FRESH_OWN_BODY,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  });
}

async function openDm(page: Page, waitFor: Locator): Promise<void> {
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await waitFor.first().waitFor({ state: 'visible' });
}

/** Long-press on touch, right-click with a mouse: both open the menu `menu`. */
async function openMenu(page: Page, target: Locator, menu: Locator): Promise<void> {
  // The thread can still be settling its scroll right after it opens; a hold
  // that lands mid-move is cancelled like a finger that moved, so hold again.
  await expect(async () => {
    await target.scrollIntoViewIfNeeded();
    if (isLaptop(page)) {
      await target.click({ button: 'right' });
    } else {
      const box = await target.boundingBox();
      if (box === null) throw new Error('target has no box');
      const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
      await target.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
      await page.waitForTimeout(700);
      await target.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
    }
    await expect(menu).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 10_000 });
}

/** The message menu's Delete: the delete sheet. */
async function openDeleteSheet(page: Page, messageId: string): Promise<Locator> {
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await openMenu(page, row(page, messageId).locator('[data-bubble]').first(), menu);
  await menu.locator('[data-menu-item="delete"]').click();
  const sheet = page.getByTestId('delete-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

/** A tap near a tile's left edge, clear of the select check at its top right. */
const TILE_CORNER = { position: { x: 8, y: 36 } } as const;

test('Delete for me on a message: gone at once, Undo restores, recorded after the window @theme @desktop', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  const peer = newestPeerRow(network);
  await openDm(page, row(page, peer.id));

  // Someone else's message: Delete for me and Cancel, never Delete for everyone.
  let sheet = await openDeleteSheet(page, peer.id);
  await expect(sheet.locator('[data-delete-choice="everyone"]')).toHaveCount(0);
  await expect(sheet.locator('[data-delete-choice="me"]')).toHaveText('Delete for me');
  await expect(sheet.locator('[data-delete-choice="cancel"]')).toHaveText('Cancel');
  await sheet.locator('[data-delete-choice="me"]').click();

  // Gone at once, behind the Undo strip; nothing is written inside the window.
  await expect(row(page, peer.id)).toHaveCount(0);
  const strip = undoStrip(page, 'Deleted for you');
  await expect(strip).toBeVisible();
  expect(hideCalls(network)).toEqual([]);

  // Undo puts it back in place and never writes.
  await strip.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row(page, peer.id)).toBeVisible();
  await page.waitForTimeout(5_000);
  expect(hideCalls(network)).toEqual([]);

  // Again, and let the window end: one write, the message id and a trace id.
  sheet = await openDeleteSheet(page, peer.id);
  await sheet.locator('[data-delete-choice="me"]').click();
  await expect(row(page, peer.id)).toHaveCount(0);
  await expect.poll(() => hideCalls(network).length, { timeout: COMMIT_WAIT_MS }).toBe(1);
  const args = hideCalls(network)[0];
  expect(args?.p_message_ids).toEqual([peer.id]);
  expect(String(args?.p_trace_id)).toMatch(UUID_V7);
  expect(network.world.tables.chat_message_hides).toEqual([
    expect.objectContaining({ user_id: ME, message_id: peer.id, channel_id: DM_CHANNEL }),
  ]);

  // Hidden for this person on a fresh load (every device reads the same rows).
  await page.reload();
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await expect(page.locator('[data-msg-id]').first()).toBeVisible();
  await expect(row(page, peer.id)).toHaveCount(0);
  expect(network.blocked).toEqual([]);
});

test('an own message inside 30 minutes offers Delete for everyone too; Cancel keeps it @theme @desktop', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedFreshOwnMessage(network);
  await openDm(page, row(page, FRESH_OWN_ID));

  const sheet = await openDeleteSheet(page, FRESH_OWN_ID);
  await expect(sheet.locator('[data-delete-choice="everyone"]')).toHaveText('Delete for everyone');
  await expect(sheet.locator('[data-delete-choice="me"]')).toHaveText('Delete for me');
  await sheet.locator('[data-delete-choice="cancel"]').click();
  await expect(page.getByTestId('delete-sheet')).toHaveCount(0);
  await expect(row(page, FRESH_OWN_ID)).toBeVisible();
  await expect(undoStrip(page)).toHaveCount(0);
  expect(hideCalls(network)).toEqual([]);
});

test('a tombstone: its one-row menu hides it for me @theme @desktop', async ({ page }) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  const peer = newestPeerRow(network);
  const last = network.world.dmMessages[network.world.dmMessages.length - 1];
  if (last !== undefined) {
    Object.assign(last, { body: null, deleted_at: new Date(Date.now() - 60_000).toISOString() });
  }
  await openDm(page, row(page, peer.id));

  const tomb = row(page, peer.id).getByTestId('tombstone');
  await expect(tomb).toBeVisible();
  await expect(tomb).toHaveAttribute('tabindex', '0');
  await expect(tomb).toHaveAttribute('aria-haspopup', 'menu');
  const item = page.getByRole('menuitem', { name: 'Delete for me' });
  await openMenu(page, tomb, item);
  await item.click();

  await expect(row(page, peer.id)).toHaveCount(0);
  await expect(undoStrip(page, 'Deleted for you')).toBeVisible();
  await expect.poll(() => hideCalls(network).length, { timeout: COMMIT_WAIT_MS }).toBe(1);
  expect(hideCalls(network)[0]?.p_message_ids).toEqual([peer.id]);
  expect(network.blocked).toEqual([]);
});

test('a tombstone opens its menu from the keyboard (Shift+F10) @desktop', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  const peer = newestPeerRow(network);
  const last = network.world.dmMessages[network.world.dmMessages.length - 1];
  if (last !== undefined) {
    Object.assign(last, { body: null, deleted_at: new Date(Date.now() - 60_000).toISOString() });
  }
  await openDm(page, row(page, peer.id));
  const tomb = row(page, peer.id).getByTestId('tombstone');
  await tomb.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Delete for me' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, peer.id)).toBeVisible();
  expect(hideCalls(network)).toEqual([]);
});

/** The chat home with the Photos chip on and its tiles painted. */
async function openPhotos(page: Page): Promise<Locator> {
  await page.goto('/chat');
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
  await page.locator('[data-search-chip="photo"]').click();
  const results = page.locator('[data-media-results="photo"]');
  await expect(results.locator('[data-media-tile]').first()).toBeVisible();
  return results;
}

function albumTiles(results: Locator): Locator {
  return results.locator(`[data-media-tile^="${MEDIA_MSG.photoAlbum}:"]`);
}

test('Photos chip: select picks a whole message; Delete for me hides it behind Undo @theme @desktop', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  await installLinkPreviewStub(page);
  await installMediaSearch(page, network.world.tables);
  const results = await openPhotos(page);
  await expect(albumTiles(results)).toHaveCount(3);

  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  const bar = page.getByTestId('media-select-bar');
  await expect(bar).toBeVisible();
  // Nothing picked: Forward and Delete for me wait, disabled.
  await expect(bar.locator('[data-selection-delete]')).toBeDisabled();
  await expect(bar.locator('[data-selection-delete]')).toHaveText('Delete for me');
  await expect(bar.getByText('Hide', { exact: true })).toHaveCount(0);

  // One tap on one photo picks its message: every tile of the album is checked.
  await albumTiles(results).first().click(TILE_CORNER);
  for (let i = 0; i < 3; i += 1) {
    await expect(albumTiles(results).nth(i)).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(
    results.locator(`[data-media-select-item="${MEDIA_MSG.photoAlbum}"]`).first(),
  ).toBeVisible();
  await expect(bar.locator('[data-selection-forward]')).toBeEnabled();

  await bar.locator('[data-selection-delete]').click();
  await expect(bar).toHaveCount(0);
  await expect(albumTiles(results)).toHaveCount(0);
  const strip = undoStrip(page, 'Deleted for you');
  await expect(strip).toBeVisible();
  expect(hideCalls(network)).toEqual([]);

  // Undo brings the album back; nothing is written.
  await strip.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(albumTiles(results)).toHaveCount(3);

  // Again, and let the window end.
  await page.getByRole('button', { name: 'Select', exact: true }).first().click();
  await albumTiles(results).first().click(TILE_CORNER);
  await page.getByTestId('media-select-bar').locator('[data-selection-delete]').click();
  await expect(albumTiles(results)).toHaveCount(0);
  await expect.poll(() => hideCalls(network).length, { timeout: COMMIT_WAIT_MS }).toBe(1);
  expect(hideCalls(network)[0]?.p_message_ids).toEqual([MEDIA_MSG.photoAlbum]);
  expect(network.blocked).toEqual([]);
});

test('the photo viewer: Forward, Delete and Download; Delete for me moves to the next photo @theme @desktop', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  await installLinkPreviewStub(page);
  await installMediaSearch(page, network.world.tables);
  const results = await openPhotos(page);

  await albumTiles(results).first().click();
  const viewer = page.getByRole('dialog', { name: 'Image viewer' });
  await expect(viewer).toBeVisible();
  // Three album photos and the single photo: the counter reads 1 / 4.
  await expect(viewer).toContainText('1 / 4');
  const bar = page.getByTestId('viewer-bar');
  await expect(bar).toBeVisible();
  const labels = await bar
    .locator('button[aria-label]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(labels).toEqual(['Forward', 'Delete', 'Download']);
  for (const name of ['Forward', 'Delete']) {
    const box = await bar.getByRole('button', { name, exact: true }).boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(44);
    expect(Math.round(box?.height ?? 0)).toBe(44);
  }

  // Delete: the sheet (Delete for me here), the viewer steps aside.
  await bar.getByRole('button', { name: 'Delete', exact: true }).click();
  const sheet = page.getByTestId('delete-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-delete-choice="everyone"]')).toHaveCount(0);
  await sheet.locator('[data-delete-choice="me"]').click();

  // The album leaves; the viewer shows the next photo of another message.
  await expect(undoStrip(page, 'Deleted for you')).toBeVisible();
  await expect(albumTiles(results)).toHaveCount(0);
  await expect(viewer).toBeVisible();
  // Only the single photo is left: one image, so the viewer drops its counter.
  await expect(viewer).not.toContainText(' / 4');
  await expect(viewer).not.toContainText(' / 3');
  await expect.poll(() => hideCalls(network).length, { timeout: COMMIT_WAIT_MS }).toBe(1);
  expect(hideCalls(network)[0]?.p_message_ids).toEqual([MEDIA_MSG.photoAlbum]);
  expect(network.blocked).toEqual([]);
});

test('an own voice note uploading: the ring in the play slot, the real bars at reduced emphasis @theme @desktop', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const network = await installHarnessNetwork(page);
  await stubVoiceRecorder(page, { heldBytes: 4099, recordedBytes: 2048 });
  const held = network.holdUploads();
  await openDm(page, page.locator('[data-msg-id]'));

  await page.getByRole('button', { name: 'Record voice note', exact: true }).click();
  await expect(page.locator('[data-composer-state="recording"]')).toBeVisible();
  // Over MIN_VOICE_NOTE_MS, so the recording is sent and not dropped.
  await page.waitForTimeout(1_100);
  await page.getByRole('button', { name: 'Stop and send voice note', exact: true }).click();

  const note = page.getByTestId('voice-uploading');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('data-voice-side', 'own');
  // The ring sits inside the 44px play slot, in the bubble's inks.
  const slot = note.locator('[data-voice-play-slot="upload"]');
  await expect(slot).toBeVisible();
  const ring = slot.locator('[data-upload-ring]');
  await expect(ring).toBeVisible();
  await expect(ring.locator('[data-upload-disc]')).not.toHaveClass(/bg-overlay/);
  const slotBox = await slot.boundingBox();
  const discBox = await ring.locator('[data-upload-disc]').boundingBox();
  expect(slotBox).not.toBeNull();
  expect(discBox).not.toBeNull();
  if (slotBox !== null && discBox !== null) {
    expect(discBox.x).toBeGreaterThanOrEqual(slotBox.x - 0.5);
    expect(discBox.y).toBeGreaterThanOrEqual(slotBox.y - 0.5);
    expect(discBox.x + discBox.width).toBeLessThanOrEqual(slotBox.x + slotBox.width + 0.5);
    expect(discBox.y + discBox.height).toBeLessThanOrEqual(slotBox.y + slotBox.height + 0.5);
  }
  // The real bars, visible at reduced emphasis; no flat line.
  const bars = note.locator('[data-voice-bars]');
  await expect(bars).toBeVisible();
  await expect(bars).toHaveClass(/opacity-\[\.45\]/);
  await expect(note.locator('[data-voice-flat]')).toHaveCount(0);

  // The upload lands: the ring goes, play shows, the bars are at full emphasis.
  held.release();
  await expect(page.getByTestId('voice-uploading')).toHaveCount(0, { timeout: 20_000 });
  const sent = page.locator('[data-voice-side="own"]').last();
  await expect(sent.locator('[data-voice-bars]')).not.toHaveClass(/opacity-\[\.45\]/);
  expect(network.blocked).toEqual([]);
});
