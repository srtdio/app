import { expect, test, type Page, type Route } from '@playwright/test';
import { installHarnessNetwork, solidPng, type HarnessNetwork } from '../fixtures/harness-routes';
import { ME, POST_IDS, WORKSPACE_ID } from '../fixtures/chat-data';

// Blink B1 (60fps iPhone recording): opening a post from the Pipeline painted
// the post page with an EMPTY media frame; the picture appeared 0.4 to 1.3 s
// later. The Pipeline card had already shown that post's small copy, so the
// post page's media frame now paints that same URL at once and swaps to the
// full image only after it has decoded.
//
// Warm data: the Monday carousel has one photo with a small copy; the card
// paints it first. The full image's bytes are held 1.5 s so the swap is
// visible. A rAF recorder samples the media frame on every frame from the tap
// to the swap: every frame that shows the post's media frame must show a
// loaded, visible picture (never an empty frame). Runs in dark and light
// (@theme).

const POST = POST_IDS[0] ?? '';
const ASSET_ID = '0190e600-0000-7000-8000-0000000000a1';
const VERSION_ID = '0190e600-0000-7000-8000-0000000000b1';
const AT = '2026-10-01T09:00:00Z';
const ASSET_READ_HOST = 'asset-read.harness.test';
const FULL_DELAY_MS = 1_500;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
};

const VERSION = {
  id: VERSION_ID,
  asset_id: ASSET_ID,
  kind: 'image',
  mime_type: 'image/png',
  size_bytes: 480_000,
  width: 800,
  height: 1000,
  duration_ms: null,
  page_count: null,
  external_url: null,
  r2_key: `${WORKSPACE_ID}/${ASSET_ID}/v1.png`,
  version_number: 1,
};

/** One photo on the Monday carousel (spec-local world edit). */
function seedPostPhoto(network: HarnessNetwork): void {
  const t = network.world.tables;
  (t.assets ??= []).push({
    id: ASSET_ID,
    workspace_id: WORKSPACE_ID,
    filename: 'linen.png',
    display_name: null,
    folder_path: '/',
    folder_id: null,
    tags: [],
    uploaded_at: AT,
    current_version_id: VERSION_ID,
    current_version: VERSION,
    deleted_at: null,
  });
  (t.asset_versions ??= []).push(VERSION);
  (t.asset_attachments ??= []).push({
    id: '0190e600-0000-7000-8000-0000000000c1',
    asset_id: ASSET_ID,
    asset_version_id: VERSION_ID,
    entity_type: 'post',
    entity_id: POST,
    workspace_id: WORKSPACE_ID,
    position: 0,
    attached_by: ME,
    attached_at: AT,
    deleted_at: null,
    asset_versions: VERSION,
    assets: { filename: 'linen.png' },
  });
}

/**
 * The asset-read stub for this photo: its small copy exists (the card's
 * cover), and the full image's bytes arrive FULL_DELAY_MS late. Everything
 * else falls through to the harness routes.
 */
async function routePhoto(page: Page): Promise<void> {
  const small = solidPng(80, 100, [200, 120, 80]);
  const full = solidPng(800, 1000, [80, 120, 200]);
  await page.route(`https://${ASSET_READ_HOST}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      if (body.asset_version_id === VERSION_ID && body.rendition === 'thumbnail') {
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify({
            url: `https://${ASSET_READ_HOST}/blob/thumb/${VERSION_ID}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        });
        return;
      }
    }
    if (request.method() === 'GET' && url.pathname === `/blob/thumb/${VERSION_ID}`) {
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'image/png', 'cache-control': 'max-age=3600' },
        body: small,
      });
      return;
    }
    if (request.method() === 'GET' && url.pathname === `/blob/image/${VERSION_ID}`) {
      await new Promise((resolve) => setTimeout(resolve, FULL_DELAY_MS));
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'image/png', 'cache-control': 'max-age=3600' },
        body: full,
      });
      return;
    }
    await route.fallback();
  });
}

interface MediaFrame {
  /** The media frame (first ribbon tile) is on screen. */
  tile: boolean;
  /** Some img in it has a src, is not hidden, and has decoded pixels. */
  picture: boolean;
  /** The small-copy cover is the one showing. */
  cover: boolean;
  /** The full image is showing. */
  full: boolean;
}

declare global {
  interface Window {
    __mediaFrames?: MediaFrame[];
    __mediaSampling?: boolean;
  }
}

/** Record the media frame on every animation frame while sampling is on. */
async function installRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames: MediaFrame[] = [];
    window.__mediaFrames = frames;
    window.__mediaSampling = false;
    const shown = (img: HTMLImageElement): boolean =>
      (img.getAttribute('src') ?? '') !== '' &&
      getComputedStyle(img).opacity !== '0' &&
      img.complete &&
      img.naturalWidth > 0;
    const tick = (): void => {
      if (window.__mediaSampling === true) {
        const tile = document.querySelector('[data-ribbon-tile]');
        if (tile === null) {
          frames.push({ tile: false, picture: false, cover: false, full: false });
        } else {
          const imgs = Array.from(tile.querySelectorAll('img'));
          const cover = imgs.find((img) => img.hasAttribute('data-gallery-cover'));
          const full = imgs.find((img) => img.hasAttribute('data-gallery-full'));
          frames.push({
            tile: true,
            picture: imgs.some(shown),
            cover: cover !== undefined && shown(cover),
            full: full !== undefined && shown(full),
          });
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test('opening a post from the Pipeline never paints an empty media frame @theme', async ({
  page,
}) => {
  await installRecorder(page);
  const network = await installHarnessNetwork(page);
  seedPostPhoto(network);
  await routePhoto(page);

  await page.goto('/pipeline');
  const card = page.getByRole('button', { name: 'Open post Monday carousel' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Warm: the card's small copy has painted (this is the cover the post reuses).
  const cardCover = page.locator(`img[data-thumb-small][src*="${VERSION_ID}"]`).first();
  await expect(cardCover).toBeVisible();
  await expect
    .poll(() => cardCover.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  await page.evaluate(() => {
    window.__mediaSampling = true;
  });
  await card.click();

  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  // The full image swaps in (after its held bytes land and decode).
  const tile = page.locator('[data-ribbon-tile]').first();
  await expect(tile.locator('img[data-gallery-full]')).toBeVisible({
    timeout: FULL_DELAY_MS + 10_000,
  });
  await expect(tile.locator('img[data-gallery-cover]')).toHaveCount(0);
  await expect
    .poll(() =>
      tile
        .locator('img[data-gallery-full]')
        .evaluate((img) => getComputedStyle(img).opacity === '1'),
    )
    .toBe(true);

  const frames = await page.evaluate(() => {
    window.__mediaSampling = false;
    return window.__mediaFrames ?? [];
  });
  const mediaFrames = frames.filter((f) => f.tile);
  expect(mediaFrames.length).toBeGreaterThan(0);
  // No empty-frame frames: from the first frame the media frame is on screen,
  // it shows a loaded picture.
  const empty = mediaFrames.filter((f) => !f.picture);
  expect(empty, `${empty.length} of ${mediaFrames.length} media frames were empty`).toEqual([]);
  // The very first media frame is the card's cover (the full image is held).
  expect(mediaFrames[0]?.cover).toBe(true);
  // The cover held the frame while the full image was on its way, then the
  // full image took over and stayed.
  expect(mediaFrames.some((f) => f.cover && !f.full)).toBe(true);
  const firstFull = mediaFrames.findIndex((f) => f.full);
  expect(firstFull).toBeGreaterThan(0);
  expect(mediaFrames.slice(firstFull).every((f) => f.full)).toBe(true);
  expect(network.blocked).toEqual([]);
});
