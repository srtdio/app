import { expect, test, type Page } from '@playwright/test';
import {
  FIXTURE_PDF_PAGES,
  installHarnessNetwork,
  type HarnessNetwork,
} from '../fixtures/harness-routes';
import { ME, POST_IDS, WORKSPACE_ID } from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// PDFs open in the in-app FileViewer from a brief, a post and Assets: pdf.js
// page 1 and "1 / N", closable, and nothing opens a new tab or window. The page
// behind stays put. Tagged @theme so it runs in light and dark on the iPhone 13
// profile. Linux WebKit approximates iOS WebKit; it is not iOS.

const BRIEF_ID = '0190e500-0000-7000-8000-000000000001';
const PDF_ASSET = '0190e500-0000-7000-8000-0000000000a1';
const PDF_VERSION = '0190e500-0000-7000-8000-0000000000b1';
const PDF_NAME = 'Q3 launch brief.pdf';
const AT = '2026-10-01T09:00:00Z';

const VERSION = {
  id: PDF_VERSION,
  asset_id: PDF_ASSET,
  kind: 'file',
  mime_type: 'application/pdf',
  size_bytes: 240_000,
  width: null,
  height: null,
  duration_ms: null,
  external_url: null,
  r2_key: `${WORKSPACE_ID}/${PDF_ASSET}/v1.pdf`,
  version_number: 1,
};

/** One stored PDF, attached to a post and a brief (spec-local world edit). */
function seedPdf(network: HarnessNetwork): void {
  const t = network.world.tables;
  (t.assets ??= []).push({
    id: PDF_ASSET,
    workspace_id: WORKSPACE_ID,
    filename: PDF_NAME,
    display_name: null,
    folder_path: '/',
    folder_id: null,
    tags: [],
    uploaded_at: AT,
    current_version_id: PDF_VERSION,
    current_version: VERSION,
    deleted_at: null,
  });
  const attachment = (id: string, entityType: string, entityId: string) => ({
    id,
    asset_id: PDF_ASSET,
    asset_version_id: PDF_VERSION,
    entity_type: entityType,
    entity_id: entityId,
    workspace_id: WORKSPACE_ID,
    position: 0,
    attached_by: ME,
    attached_at: AT,
    deleted_at: null,
    asset_versions: VERSION,
    assets: { filename: PDF_NAME },
  });
  (t.asset_attachments ??= []).push(
    attachment('0190e500-0000-7000-8000-0000000000c1', 'post', String(POST_IDS[0])),
    attachment('0190e500-0000-7000-8000-0000000000c2', 'brief', BRIEF_ID),
  );
  (t.briefs ??= []).push({
    id: BRIEF_ID,
    workspace_id: WORKSPACE_ID,
    number: 7,
    title: 'Q3 launch',
    objective: 'Launch the Q3 range.',
    brand_requirements: null,
    format_requested: null,
    reference_links: null,
    mentions: null,
    status: 'open',
    target_date: null,
    created_via: 'app',
    created_by: ME,
    closed_at: null,
    closed_by: null,
    legacy_author_name: null,
    row_version: 1,
    created_at: AT,
    updated_at: AT,
    deleted_at: null,
  });
}

/** The PDF viewer is up with page 1 painted and the "1 / N" counter. */
async function expectPdfOpen(page: Page): Promise<void> {
  const viewer = page.locator('[data-file-viewer="pdf"]');
  await expect(viewer).toBeVisible({ timeout: 15_000 });
  const canvas = viewer.locator('[data-pdf-page="1"] canvas');
  await expect(canvas).toBeVisible();
  await expect(viewer.locator('[data-page-counter]')).toHaveText(`1 / ${FIXTURE_PDF_PAGES}`);
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).width > 0)).toBe(true);
  await expect(viewer.getByText("Couldn't open. Try again.")).toHaveCount(0);
  expectMinTouchTarget(await viewer.getByRole('button', { name: 'Close' }).boundingBox());
}

/** Close the viewer with its X; the page behind is still there. */
async function closeViewer(page: Page): Promise<void> {
  await page.locator('[data-file-viewer="pdf"]').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('[data-file-viewer]')).toHaveCount(0);
}

const ASSET_READ = /^https:\/\/asset-read\.harness\.test\/?$/;

/**
 * Serve a stored thumbnail for every PDF version (the harness answers
 * renditions only for chat files) and record each thumbnail request.
 */
async function serveThumbnails(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route(ASSET_READ, async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (body.rendition !== 'thumbnail') {
      await route.fallback();
      return;
    }
    const id = String(body.asset_version_id ?? '');
    asked.push(id);
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `https://asset-read.harness.test/blob/image/${id}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
  });
  return asked;
}

/** A PDF file tile with its stored thumbnail painted, its name and kind. */
async function expectPdfTile(page: Page): Promise<void> {
  const tile = page.locator('[data-file-tile="pdf"]').first();
  await expect(tile).toBeVisible({ timeout: 15_000 });
  const thumb = tile.locator('[data-file-tile-thumb]');
  await expect(thumb).toBeVisible();
  await expect(thumb).toHaveJSProperty('complete', true);
  expect(await thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await expect(tile.locator('[data-file-name]')).toHaveText(PDF_NAME);
  await expect(tile.locator('[data-file-meta]')).toContainText('PDF');
}

/** The app's theme follows the emulated colour scheme in each project. */
async function expectTheme(page: Page, dark: boolean): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(dark);
}

test('PDFs open in the in-app viewer from a brief, a post and Assets @theme', async ({
  page,
  context,
}, testInfo) => {
  const dark = testInfo.project.use.colorScheme !== 'light';
  const network = await installHarnessNetwork(page);
  seedPdf(network);
  const thumbs = await serveThumbnails(page);
  const popups: string[] = [];
  context.on('page', (p) => popups.push(p.url()));

  // Brief: the reference tile opens the viewer straight away.
  await page.goto(`/briefs/${BRIEF_ID}`);
  await expect(page.getByText('Launch the Q3 range.')).toBeVisible({ timeout: 15_000 });
  await expectTheme(page, dark);
  await expectPdfTile(page);
  await page.getByRole('button', { name: 'View image 1' }).first().click();
  await expectPdfOpen(page);
  await closeViewer(page);
  // Back on the in-place viewer: the slide offers Open, which reads it again.
  const briefOpen = page.locator('[data-file-slide]').getByRole('button', { name: 'Open' });
  await expect(briefOpen).toBeVisible();
  // Focus comes back to the slide's Open, not the page body.
  await expect(briefOpen).toBeFocused();
  expectMinTouchTarget(await briefOpen.boundingBox());
  await expect(page.getByText('Preview unavailable.')).toHaveCount(0);
  // A double-tap on the file slide zooms nothing, so Open still answers.
  await page.locator('[data-file-slide]').dblclick({ position: { x: 4, y: 4 } });
  await briefOpen.click();
  await expectPdfOpen(page);
  await closeViewer(page);
  await expect(page.getByText('Launch the Q3 range.')).toBeVisible();

  // Post: the gallery slide opens the viewer.
  await page.goto(`/posts/${POST_IDS[0]}`);
  const postTile = page.getByRole('button', { name: 'View image 1' }).first();
  await postTile.waitFor({ state: 'visible', timeout: 15_000 });
  await expectTheme(page, dark);
  await expectPdfTile(page);
  await postTile.click();
  await expectPdfOpen(page);
  await closeViewer(page);
  await expect(page.locator('[data-file-slide]')).toBeVisible();
  await expect(
    page.locator('[data-file-slide]').getByRole('button', { name: 'Open' }),
  ).toBeFocused();
  await expect(page.getByText('Preview unavailable.')).toHaveCount(0);

  // Assets: the card opens the viewer over the lightbox.
  const thumbsBefore = thumbs.length;
  await page.goto('/assets');
  const card = page.getByRole('button', { name: `View ${PDF_NAME}` }).first();
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  await expectTheme(page, dark);
  await expectPdfTile(page);
  await card.click();
  await expectPdfOpen(page);
  await closeViewer(page);
  const assetCard = page.locator('[data-file-card]');
  await expect(assetCard).toBeVisible();
  await expect(page.getByText('Download to view')).toHaveCount(0);
  const assetOpen = assetCard.getByRole('button', { name: 'Open' });
  await expect(assetOpen).toBeFocused();
  expectMinTouchTarget(await assetOpen.boundingBox());
  await assetOpen.click();
  await expectPdfOpen(page);
  await closeViewer(page);
  await expect(page.getByRole('dialog', { name: `Viewing ${PDF_NAME}` })).toBeVisible();
  // Closing the lightbox gives the page its scroll back (no lock left behind).
  await page.getByRole('button', { name: 'Close viewer' }).click();
  await expect(page.getByRole('dialog', { name: `Viewing ${PDF_NAME}` })).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  // One thumbnail request per version for this page load (cached after: the
  // lightbox and viewer round trip asked for none).
  expect(thumbs.slice(thumbsBefore)).toEqual([PDF_VERSION]);

  // Nothing left the tab, and no request escaped the fixtures.
  expect(popups).toEqual([]);
  expect(network.blocked).toEqual([]);
});

test('a 50-file Assets page asks for thumbnails only near the viewport, once each', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  const t = network.world.tables;
  const ids: string[] = [];
  for (let n = 0; n < 50; n += 1) {
    const suffix = String(n).padStart(12, '0');
    const asset = `0190e600-0000-7000-8000-${suffix}`;
    const version = `0190e700-0000-7000-8000-${suffix}`;
    ids.push(version);
    (t.assets ??= []).push({
      id: asset,
      workspace_id: WORKSPACE_ID,
      filename: `Brief ${n}.pdf`,
      display_name: null,
      folder_path: '/',
      folder_id: null,
      tags: [],
      // Newest first: n = 0 is at the top.
      uploaded_at: new Date(Date.parse(AT) - n * 60_000).toISOString(),
      current_version_id: version,
      current_version: { ...VERSION, id: version, asset_id: asset },
      deleted_at: null,
    });
  }
  const thumbs = await serveThumbnails(page);
  await page.goto('/assets');
  await expect(page.locator('[data-file-tile="pdf"]').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-file-tile-thumb]').first()).toBeVisible();
  // Let any further requests land, then count: only tiles near the viewport asked.
  await page.waitForLoadState('networkidle');
  const atLoad = thumbs.length;
  expect(atLoad).toBeGreaterThan(0);
  expect(atLoad).toBeLessThan(50);
  expect(new Set(thumbs).size).toBe(thumbs.length);
  // Scrolling through the grid asks for the rest, once each.
  const tiles = page.locator('[data-file-tile="pdf"]');
  for (let n = 0; n < 50; n += 2) {
    await tiles.nth(n).scrollIntoViewIfNeeded();
  }
  await expect(tiles.last().locator('[data-file-tile-thumb]')).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  expect(new Set(thumbs)).toEqual(new Set(ids));
  expect(thumbs.length).toBe(50);
  testInfoLog(
    `thumbnail requests for 50 PDFs: ${atLoad} at load, ${thumbs.length} after a full scroll`,
  );
  expect(network.blocked).toEqual([]);
});

/** Surface a number in the run output (the PR reports it). */
function testInfoLog(line: string): void {
  test.info().annotations.push({ type: 'count', description: line });
  process.stdout.write(`${line}\n`);
}
