import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';
import {
  ALBUM_BODY,
  ALBUM_PHOTOS,
  PEER_PHOTO,
  SINGLE_FILE,
  SINGLE_FILE_BODY,
  installRemoveFilesRoutes,
  seedRemovableFiles,
  type RemoveFilesRecorder,
} from '../fixtures/remove-files';
import { undoStrip } from '../helpers/undo-strip';

// Chat: remove files, keep the message. Contact info -> Media -> Select ticks
// own photos only (a peer's tile has no check), Remove puts them behind the
// Undo strip ("2 photos removed"); after the window chat_message_remove_files
// records it, POST /purge-chat frees the storage, and the bubble keeps its
// text with a "removed" line. The viewer's bin reads "Remove photo" on own
// photos only; More -> "Remove file" on an own single-file message reads "File
// removed"; Esc leaves select mode first. Tagged @theme and @desktop: runs on
// iphone-webkit, iphone-webkit-light and desktop-webkit. Linux WebKit
// approximates iOS WebKit; it is not iOS.

/** The Undo window (src/lib/undo.ts UNDO_MS) plus the record's round trip. */
const COMMIT_WAIT_MS = 4_000 + 8_000;

const isLaptop = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 768;

async function setup(
  page: Page,
): Promise<{ network: HarnessNetwork; recorder: RemoveFilesRecorder }> {
  const network = await installHarnessNetwork(page);
  seedRemovableFiles(network.world);
  const recorder = await installRemoveFilesRoutes(page, network.world);
  return { network, recorder };
}

function bubble(page: Page, text: string): Locator {
  return page.locator('[data-bubble]', { hasText: text }).last();
}

async function openDm(page: Page): Promise<void> {
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await bubble(page, ALBUM_BODY).waitFor({ state: 'visible' });
}

async function openContactMedia(page: Page): Promise<void> {
  await page.locator('[data-contact-open]').first().click();
  await expect(page.getByRole('button', { name: 'Close contact info' })).toBeVisible();
  await page.getByRole('tablist').getByRole('button', { name: 'Media', exact: true }).click();
  await expect(page.locator('[data-contact-tab="media"]')).toBeVisible();
}

function tile(page: Page, name: string): Locator {
  return page.locator('[data-contact-tab="media"]').getByRole('button', { name, exact: true });
}

/** Long-press on touch, right-click with a mouse: both open the message menu. */
async function openMessageMenu(page: Page, text: string): Promise<Locator> {
  const target = bubble(page, text);
  const menu = page.getByRole('menu', { name: 'Message actions' });
  // The thread can still be settling its scroll right after it opens; a hold
  // that lands mid-move is cancelled like a finger that moved, so hold again.
  await expect(async () => {
    await target.scrollIntoViewIfNeeded();
    if (isLaptop(page)) {
      await target.click({ button: 'right' });
    } else {
      const box = await target.boundingBox();
      if (box === null) throw new Error('bubble has no box');
      const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
      await target.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
      await page.waitForTimeout(700);
      await target.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
    }
    await expect(menu).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 10_000 });
  return menu;
}

test('Media Select ticks own photos; Remove commits after the Undo window @theme @desktop', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { network, recorder } = await setup(page);
  const albumId = String(network.world.dmMessages[33]?.id);
  await openDm(page);
  await openContactMedia(page);

  const select = page.getByTestId('info-select');
  await expect(select).toHaveAttribute('aria-label', 'Select');
  await select.click();
  await expect(page.getByTestId('info-select-bar')).toBeVisible();

  // Own photos carry a check; the peer's photo has none and a tap does nothing.
  const own = ALBUM_PHOTOS.map((p) => tile(page, p.name));
  for (const t of own) await expect(t).toHaveAttribute('aria-pressed', 'false');
  const peer = tile(page, PEER_PHOTO.name);
  await expect(peer).not.toHaveAttribute('aria-pressed');
  await peer.click();
  await expect(page.getByRole('dialog', { name: 'Image viewer' })).toHaveCount(0);

  for (const t of own) await t.click();
  for (const t of own) await expect(t).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('info-remove').click();
  await expect(undoStrip(page, '2 photos removed')).toBeVisible();
  // Remove leaves select mode; the photos leave the tab at once.
  await expect(page.getByTestId('info-select-bar')).toHaveCount(0);
  for (const t of own) await expect(t).toHaveCount(0);
  // Nothing is recorded inside the Undo window.
  expect(recorder.order).toEqual([]);

  await expect
    .poll(() => recorder.order, { timeout: COMMIT_WAIT_MS })
    .toContain('rpc:chat_message_remove_files');
  const args = recorder.removeArgs[0];
  expect(args?.p_message_ids).toEqual([albumId]);
  expect([...((args?.p_asset_ids as string[] | undefined) ?? [])].sort()).toEqual(
    ALBUM_PHOTOS.map((p) => p.id).sort(),
  );
  expect(typeof args?.p_trace_id).toBe('string');
  await expect.poll(() => recorder.order).toEqual(['rpc:chat_message_remove_files', 'purge-chat']);
  expect(recorder.purgeBodies[0]).toMatchObject({ asset_ids: expect.any(Array) });

  // The bubble keeps its text and shows the removed line.
  await page.getByRole('button', { name: 'Close contact info' }).click();
  const album = bubble(page, ALBUM_BODY);
  await album.scrollIntoViewIfNeeded();
  await expect(album.getByTestId('files-removed-line')).toHaveText('2 photos removed');
  expect(network.blocked).toEqual([]);
});

test('the viewer bin reads "Remove photo" on own photos only @theme @desktop', async ({ page }) => {
  const { network } = await setup(page);
  await openDm(page);
  await openContactMedia(page);

  const viewer = page.getByRole('dialog', { name: 'Image viewer' });
  // A peer's photo: no bin.
  await tile(page, PEER_PHOTO.name).click();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Download' }).first()).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Remove photo' })).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Close viewer' }).click();
  await expect(viewer).toHaveCount(0);

  // An own photo: the bin, then the Undo strip.
  const first = ALBUM_PHOTOS[0];
  await tile(page, first.name).click();
  await expect(viewer).toBeVisible();
  const bin = viewer.getByRole('button', { name: 'Remove photo' });
  await expect(bin).toBeVisible();
  await bin.click();
  await expect(undoStrip(page, '1 photo removed')).toBeVisible();
  expect(network.blocked).toEqual([]);
});

test('More -> Remove file on an own single file keeps the text @theme @desktop', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { network, recorder } = await setup(page);
  const fileMessageId = String(network.world.dmMessages[35]?.id);
  await openDm(page);

  // An album of two offers no "Remove file" (the viewer bin or Select does).
  let menu = await openMessageMenu(page, ALBUM_BODY);
  await menu.locator('[data-menu-item="more"]').click();
  await expect(menu.locator('[data-menu-item="back"]')).toBeVisible();
  await expect(menu.locator('[data-menu-item="remove-file"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  menu = await openMessageMenu(page, SINGLE_FILE_BODY);
  await menu.locator('[data-menu-item="more"]').click();
  const remove = menu.locator('[data-menu-item="remove-file"]');
  await expect(remove).toHaveText('Remove file');
  await remove.click();
  await expect(undoStrip(page, 'File removed')).toBeVisible();

  await expect
    .poll(() => recorder.order, { timeout: COMMIT_WAIT_MS })
    .toContain('rpc:chat_message_remove_files');
  expect(recorder.removeArgs[0]?.p_message_ids).toEqual([fileMessageId]);
  expect(recorder.removeArgs[0]?.p_asset_ids).toEqual([SINGLE_FILE.id]);

  const kept = bubble(page, SINGLE_FILE_BODY);
  await expect(kept).toBeVisible();
  await expect(kept.getByTestId('files-removed-line')).toHaveText('File removed');
  await expect(kept.locator('[data-file-bubble]')).toHaveCount(0);
  expect(network.blocked).toEqual([]);
});

test('Esc leaves select mode before it closes contact info @theme @desktop', async ({ page }) => {
  const { recorder } = await setup(page);
  await openDm(page);
  await openContactMedia(page);

  await page.getByTestId('info-select').click();
  await expect(page.getByTestId('info-select-bar')).toBeVisible();
  await tile(page, ALBUM_PHOTOS[0].name).click();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('info-select-bar')).toHaveCount(0);
  await expect(page.getByTestId('info-select')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close contact info' })).toBeVisible();
  // Leaving select mode removes nothing.
  await expect(undoStrip(page)).toHaveCount(0);
  await expect(tile(page, ALBUM_PHOTOS[0].name)).not.toHaveAttribute('aria-pressed');

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Close contact info' })).toHaveCount(0);
  expect(recorder.order).toEqual([]);
});
