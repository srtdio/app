import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_PDF_PAGES, installHarnessNetwork, solidPng } from '../fixtures/harness-routes';
import { ME, PEER_NAME, POST_IDS, WORKSPACE_ID } from '../fixtures/chat-data';

// A PDF opens with no spinner and no black frame, from Assets, a post and
// chat: from the first frame the viewer shows the first-page preview or a
// page-shaped placeholder on the theme surface, and the real page draws in
// the same box. The PDF bytes are held back 800 ms so the 0, 100 and 300 ms
// frames are the opening state. Tagged @theme: light and dark.

const PDF_ASSET = '0190ea00-0000-7000-8000-0000000000a1';
const PDF_VERSION = '0190ea00-0000-7000-8000-0000000000b1';
const PDF_NAME = 'Season lookbook.pdf';
const CHAT_PDF = '0190ea00-0000-7000-8000-0000000000c9';
const AT = '2026-10-01T09:00:00Z';
const ASSET_READ = /^https:\/\/asset-read\.harness\.test\/?$/;

interface Frame {
  t: number;
  spinner: boolean;
  backdrop: string | null;
  surface: string;
  tone: string | null;
  page1: { w: number; h: number } | null;
  shows: boolean;
}

/**
 * Records every animation frame for 450 ms from the moment the PDF viewer is
 * inserted (the MutationObserver callback runs before that frame paints).
 */
function recordFrames(): void {
  const w = window as unknown as { __pdfFrames: Frame[] };
  w.__pdfFrames = [];
  let start = -1;
  const probe = (): string => {
    const el = document.createElement('div');
    el.className = 'bg-panel-2';
    document.body.appendChild(el);
    const color = getComputedStyle(el).backgroundColor;
    el.remove();
    return color;
  };
  const sample = (): void => {
    const viewer = document.querySelector('[data-file-viewer="pdf"]');
    if (viewer === null) return;
    const backdrop = viewer.querySelector('[data-viewer-backdrop]');
    const page = viewer.querySelector('[data-pdf-page="1"]');
    const r = page?.getBoundingClientRect();
    w.__pdfFrames.push({
      t: performance.now() - start,
      spinner: viewer.querySelector('[aria-label="Loading"], .animate-spin') !== null,
      backdrop: backdrop === null ? null : getComputedStyle(backdrop).backgroundColor,
      surface: probe(),
      tone: viewer.getAttribute('data-viewer-tone'),
      page1: r === undefined ? null : { w: Math.round(r.width), h: Math.round(r.height) },
      shows:
        page?.querySelector('[data-pdf-placeholder], [data-pdf-preview], canvas') !== null &&
        page !== null,
    });
  };
  const loop = (): void => {
    sample();
    if (performance.now() - start < 450) requestAnimationFrame(loop);
    else start = -1;
  };
  new MutationObserver(() => {
    if (start >= 0 || document.querySelector('[data-file-viewer="pdf"]') === null) return;
    w.__pdfFrames = [];
    start = performance.now();
    sample();
    requestAnimationFrame(loop);
  }).observe(document, { childList: true, subtree: true });
}

async function holdPdfBytes(page: Page): Promise<void> {
  await page.route(ASSET_READ, async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (body.stream === true) await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fallback();
  });
  // The chat PDF's stored thumbnail: page 1 at the page's own shape (Letter).
  const thumb = solidPng(580, 751, [240, 240, 244]);
  await page.route(`https://asset-read.harness.test/blob/image/${CHAT_PDF}`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' },
      body: thumb,
    }),
  );
}

/** The frames at 0, ~100 and ~300 ms: never a spinner, never the overlay. */
async function expectNoSpinnerNoBlack(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __pdfFrames: Frame[] }).__pdfFrames.at(-1)?.t ?? 0,
      ),
    )
    .toBeGreaterThan(300);
  const frames = await page.evaluate(
    () => (window as unknown as { __pdfFrames: Frame[] }).__pdfFrames,
  );
  const at = (ms: number): Frame => {
    const frame = frames.find((f) => f.t >= ms) ?? frames[frames.length - 1];
    if (frame === undefined) throw new Error('no frames recorded');
    return frame;
  };
  const first = at(0);
  for (const ms of [0, 100, 300]) {
    const frame = at(ms);
    expect(frame.spinner, `${ms} ms spinner`).toBe(false);
    expect(frame.tone, `${ms} ms tone`).toBe('surface');
    expect(frame.backdrop, `${ms} ms backdrop`).toBe(frame.surface);
    expect(frame.shows, `${ms} ms page 1 shows`).toBe(true);
    expect(frame.page1?.h ?? 0, `${ms} ms page 1 height`).toBeGreaterThan(0);
    // The same box from the first frame: no layout shift.
    expect(frame.page1, `${ms} ms page 1 box`).toEqual(first.page1);
  }
  // Then the real page draws in that box (a Letter page: the same size).
  const viewer = page.locator('[data-file-viewer="pdf"]');
  await expect(viewer.locator('[data-pdf-page="1"] canvas')).toBeVisible({ timeout: 15_000 });
  const drawn = await viewer.locator('[data-pdf-page="1"]').boundingBox();
  expect(Math.abs((drawn?.height ?? 0) - (first.page1?.h ?? -10))).toBeLessThanOrEqual(1);
  expect(Math.abs((drawn?.width ?? 0) - (first.page1?.w ?? -10))).toBeLessThanOrEqual(1);
  await expect(viewer.locator('[data-page-counter]')).toHaveText(`1 / ${FIXTURE_PDF_PAGES}`);
  await expect(viewer.locator('[aria-label="Loading"]')).toHaveCount(0);
}

async function closeViewer(page: Page): Promise<void> {
  await page.locator('[data-file-viewer="pdf"]').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('[data-file-viewer]')).toHaveCount(0);
}

test('a PDF opens with no spinner and no black frame in assets, posts and chat @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  const t = network.world.tables;
  const version = {
    id: PDF_VERSION,
    asset_id: PDF_ASSET,
    kind: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 240_000,
    width: null,
    height: null,
    duration_ms: null,
    page_count: FIXTURE_PDF_PAGES,
    external_url: null,
    r2_key: `${WORKSPACE_ID}/${PDF_ASSET}/v1.pdf`,
    version_number: 1,
  };
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
    current_version: version,
    deleted_at: null,
  });
  (t.asset_attachments ??= []).push({
    id: '0190ea00-0000-7000-8000-0000000000d1',
    asset_id: PDF_ASSET,
    asset_version_id: PDF_VERSION,
    entity_type: 'post',
    entity_id: String(POST_IDS[0]),
    workspace_id: WORKSPACE_ID,
    position: 0,
    attached_by: ME,
    attached_at: AT,
    deleted_at: null,
    asset_versions: version,
    assets: { filename: PDF_NAME },
  });
  const dm = network.world.dmMessages;
  const last = dm[dm.length - 1];
  if (last === undefined) throw new Error('fixture DM empty');
  Object.assign(last, {
    body: null,
    attachment_asset_ids: [CHAT_PDF],
    attachment_meta: {
      [CHAT_PDF]: {
        mime: 'application/pdf',
        name: 'Q4 plan.pdf',
        size: 240_000,
        page_count: FIXTURE_PDF_PAGES,
        thumb_w: 580,
        thumb_h: 751,
      },
    },
  });
  await holdPdfBytes(page);
  await page.addInitScript(recordFrames);

  // Assets.
  await page.goto('/assets');
  const card = page.getByRole('button', { name: `View ${PDF_NAME}` }).first();
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  await card.click();
  await expectNoSpinnerNoBlack(page);
  await closeViewer(page);

  // A post.
  await page.goto(`/posts/${POST_IDS[0]}`);
  const slide = page.getByRole('button', { name: 'View image 1' }).first();
  await slide.waitFor({ state: 'visible', timeout: 15_000 });
  await slide.click();
  await expectNoSpinnerNoBlack(page);
  await closeViewer(page);

  // Chat: the stored thumbnail paints as the first-page preview.
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  const bubble = page.locator('[data-file-bubble="pdf"]').first();
  await bubble.scrollIntoViewIfNeeded();
  await expect(bubble.locator('img')).toHaveJSProperty('complete', true);
  await bubble.click();
  await expectNoSpinnerNoBlack(page);
  await expect(
    page.locator('[data-file-viewer="pdf"] [data-pdf-page="1"] [data-pdf-preview]'),
  ).toHaveCount(1);
  await closeViewer(page);

  expect(network.blocked).toEqual([]);
});
