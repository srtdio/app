import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_NAME } from '../fixtures/chat-data';
import { installLinkPreviewStub } from '../fixtures/link-previews';
import {
  installMediaSearch,
  MEDIA_ALBUM_BODY,
  MEDIA_MSG,
  MEDIA_VERSION,
  SEARCH_CHIP_ORDER,
} from '../fixtures/search-data';

// The chat home's media chips (Photos, Videos, Links, Files, Voice notes):
// their order, a chip's own Clear, Photos alone listing photo tiles, the
// viewer and Show in chat. Message search by words lives only in the top
// bar's palette (command-palette.spec.ts); the chat home and the open thread
// have no search field of their own. Linux WebKit approximates iOS WebKit; it
// is not iOS.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The media chips: their order (Photos, Videos, Links, Files, Voice
 * notes), then Photos alone (empty query, p_kind photo) lists photo tiles
 * newest first; the first tile opens the viewer with its details on top, and
 * Show in chat opens the thread at that message.
 */
async function runMediaFlow(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  await installLinkPreviewStub(page);
  const calls = await installMediaSearch(page, network.world.tables);
  await page.goto('/chat');
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });

  const chips = await page
    .locator('[data-search-chip]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-search-chip')));
  expect(chips).toEqual([...SEARCH_CHIP_ORDER]);

  const photo = page.locator('[data-search-chip="photo"]');
  // The picked chip carries its own Clear (44 tall, "Clear Photos filter"): it
  // clears the filter and the chat list is back. No All chip.
  await expect(page.locator('[data-chip-clear]')).toHaveCount(0);
  await photo.click();
  const clear = page.getByRole('button', { name: 'Clear Photos filter' });
  await expect(clear).toBeVisible();
  await expect(page.locator('[data-chip-clear]')).toHaveCount(1);
  const box = await clear.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box?.height ?? 0)).toBe(44);
  await clear.click();
  await expect(photo).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-media-results]')).toHaveCount(0);
  await expect(page.locator('[data-chip-clear]')).toHaveCount(0);
  await expect(page.getByText(GROUP_NAME, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveCount(0);

  await photo.click();
  await expect(photo).toHaveAttribute('aria-pressed', 'true');
  const results = page.locator('[data-media-results="photo"]');
  await expect(results).toBeVisible();

  // Newest first: the 3-photo album's first photo leads, under a month header.
  // (The results root shows its boxes at once; the read goes out after the
  // search debounce, so the call is checked once the tiles landed.)
  await expect(results.locator('[data-media-month]').first()).toBeVisible();
  const tile = results.locator('[data-media-tile]').first();
  await expect(tile).toBeVisible();
  const last = calls[calls.length - 1] ?? {};
  expect(last.p_kind).toBe('photo');
  expect(last.p_query).toBe('');
  expect(String(last.p_trace_id)).toMatch(UUID_V7);
  for (const key of Object.keys(last)) expect(key.startsWith('p_')).toBe(true);
  await expect(tile).toHaveAttribute(
    'data-media-tile',
    `${MEDIA_MSG.photoAlbum}:${MEDIA_VERSION.album1}`,
  );
  // Every photo of both photo messages has its own tile.
  await expect(results.locator(`[data-media-tile^="${MEDIA_MSG.photoAlbum}:"]`)).toHaveCount(3);
  await expect(results.locator(`[data-media-tile^="${MEDIA_MSG.photoOne}:"]`)).toHaveCount(1);

  // The viewer opens with its "<" back bar (sender · time title) and Show in chat.
  await tile.click();
  await expect(page.locator('[data-lightbox-back-bar] [data-lightbox-title]')).toBeVisible();
  const show = page.locator('[data-show-in-chat]');
  await expect(show).toBeVisible();
  await show.click();

  // The thread shows the message. The arrival glow is a 2s tint: checked first.
  const landed = page.locator(`[data-msg-id="${MEDIA_MSG.photoAlbum}"]`);
  await expect(
    page.locator(`[data-msg-id="${MEDIA_MSG.photoAlbum}"][data-jump-glow]`).first(),
  ).toBeVisible();
  await expect(page.locator('[data-lightbox-back-bar]')).toHaveCount(0);
  await expect(landed.first()).toContainText(MEDIA_ALBUM_BODY);
  await expect(landed.first()).toBeInViewport();

  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

test('chat search: media chips, photo tile, Show in chat (phone)', async ({ page }) => {
  await runMediaFlow(page);
});

test('chat search: no search field on the chat home or in a thread', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await page.getByText(GROUP_NAME, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible' });
  await expect(page.getByRole('button', { name: 'Search this chat' })).toHaveCount(0);
  await expect(page.locator('[data-chat-search-bar]')).toHaveCount(0);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

test.describe('laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('chat search: media chips, photo tile, Show in chat (laptop)', async ({ page }) => {
    await runMediaFlow(page);
  });
});
