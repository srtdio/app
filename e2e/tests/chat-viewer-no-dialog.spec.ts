import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';
import {
  ALBUM_BODY,
  installRemoveFilesRoutes,
  seedRemovableFiles,
} from '../fixtures/remove-files';

// D2 regression: opening and leaving the photo viewer from a chat bubble never
// leaves the viewer (or its arrows) behind at the bubble's size. The open grow
// moves only the image; the dialog fills the viewport from its first frame,
// leaves with "<" (Back, never an X) and is gone after. Arrows show only in a
// viewer holding more than one photo, and never inside the thread. Tagged
// @theme and @desktop: runs on iphone-webkit, iphone-webkit-light and
// desktop-webkit. Linux WebKit approximates iOS WebKit; it is not iOS.

const PEER_BODY = 'My moodboard for reference';

function bubble(page: Page, text: string): Locator {
  return page.locator('[data-bubble]', { hasText: text }).last();
}

async function openDm(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  seedRemovableFiles(network.world);
  await installRemoveFilesRoutes(page, network.world);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await bubble(page, ALBUM_BODY).waitFor({ state: 'visible' });
}

/** The viewer fills the viewport (never a bubble-sized box), with "<" and no X. */
async function expectFullViewer(page: Page, viewer: Locator): Promise<void> {
  await expect(viewer).toBeVisible();
  // Any grow has ended (a tap would finish it; this waits it out instead).
  await page.waitForTimeout(400);
  const box = await viewer.boundingBox();
  const size = page.viewportSize();
  if (box === null || size === null) throw new Error('no viewer box');
  expect(Math.round(box.width)).toBe(size.width);
  expect(Math.round(box.height)).toBe(size.height);
  await expect(viewer.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Close viewer' })).toHaveCount(0);
}

async function leave(page: Page, viewer: Locator): Promise<void> {
  await viewer.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  // Nothing of the viewer is left in the thread: no arrows, no counter.
  await expect(page.locator('[data-bubble] button[aria-label="Previous image"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous image' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next image' })).toHaveCount(0);
}

test('a single photo opens full screen without arrows and leaves no dialog @theme @desktop', async ({
  page,
}) => {
  await openDm(page);
  const photo = bubble(page, PEER_BODY).getByRole('button', { name: 'Open photo 1 of 1' });
  await photo.scrollIntoViewIfNeeded();
  await photo.click();
  const viewer = page.getByRole('dialog', { name: 'Image viewer' });
  await expectFullViewer(page, viewer);
  // One photo: no arrows and no counter anywhere.
  await expect(viewer.getByRole('button', { name: 'Previous image' })).toHaveCount(0);
  await expect(viewer.locator('[data-lightbox-counter]')).toHaveCount(0);
  await leave(page, viewer);

  // Twice in a row: the second open is as clean as the first.
  await photo.click();
  await expectFullViewer(page, viewer);
  await leave(page, viewer);
});

test('a two-photo album shows arrows only in the viewer and leaves no dialog @theme @desktop', async ({
  page,
}) => {
  await openDm(page);
  const album = bubble(page, ALBUM_BODY);
  // In the thread: two tiles, never an arrow.
  await expect(album.getByRole('button', { name: /Open photo \d of 2/ })).toHaveCount(2);
  await expect(album.getByRole('button', { name: 'Previous image' })).toHaveCount(0);

  const second = album.getByRole('button', { name: 'Open photo 2 of 2' });
  await second.scrollIntoViewIfNeeded();
  await second.click();
  const viewer = page.getByRole('dialog', { name: 'Image viewer' });
  await expectFullViewer(page, viewer);
  await expect(viewer.locator('[data-lightbox-counter]')).toHaveText('2 / 2');
  await expect(viewer.getByRole('button', { name: 'Previous image' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Next image' })).toBeVisible();
  await leave(page, viewer);

  await album.getByRole('button', { name: 'Open photo 1 of 2' }).click();
  await expectFullViewer(page, viewer);
  await leave(page, viewer);
});
