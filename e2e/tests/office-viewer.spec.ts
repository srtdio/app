import { expect, test, type Page, type Request } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';
import {
  DOCX_MIME,
  PPTX_MIME,
  TRACKER_HOST,
  XLSX_MIME,
  docxFixture,
  xlsxFixture,
} from '../fixtures/office-files';

// Word and Excel open inside Sorted (decisions 150-154): an xlsx opens in the
// grid and switches sheet tabs, a docx shows page 1 inside its sandboxed
// iframe with zero requests leaving it (its external picture and link are
// never fetched), a pptx keeps "Preview not available yet" with Download, and
// a just-sent docx bubble shows the thumbnail drawn on this device. One spec,
// tagged @theme so it runs in light and dark. Linux WebKit approximates iOS
// WebKit; it is not iOS.

const XLSX_ID = '0190f300-0000-7000-8000-000000000001';
const DOCX_ID = '0190f300-0000-7000-8000-000000000002';
const PPTX_ID = '0190f300-0000-7000-8000-000000000003';
const ASSET_READ = /^https?:\/\/asset-read\.harness\.test\//;

/** asset-read's stream mode for this spec's versions; anything else falls through. */
async function routeOfficeStreams(page: Page): Promise<void> {
  const docx = docxFixture();
  const xlsx = xlsxFixture();
  await page.route(ASSET_READ, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const body = (request.postDataJSON() ?? {}) as { asset_version_id?: string; stream?: boolean };
    if (body.stream !== true) return route.fallback();
    const cors = { 'access-control-allow-origin': '*' };
    const stream = (type: string, bytes: Buffer) =>
      route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': type, 'x-content-type-options': 'nosniff' },
        body: bytes,
      });
    if (body.asset_version_id === DOCX_ID) return stream(DOCX_MIME, docx);
    if (body.asset_version_id === XLSX_ID) return stream(XLSX_MIME, xlsx);
    if (body.asset_version_id === PPTX_ID) {
      // The real Worker has no stream for PowerPoint: a 400.
      return route.fulfill({
        status: 400,
        headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({ error: { code: 'bad_request' } }),
      });
    }
    return route.fallback();
  });
}

test('Word and Excel open inside Sorted @theme', async ({ page, context }) => {
  const harness = await installHarnessNetwork(page);
  await routeOfficeStreams(page);
  const dm = harness.world.dmMessages;
  const rows = dm.slice(-3);
  const files: Array<[string, string, string]> = [
    [XLSX_ID, XLSX_MIME, 'November content calendar v3.xlsx'],
    [DOCX_ID, DOCX_MIME, 'Diwali campaign brief.docx'],
    [PPTX_ID, PPTX_MIME, 'Q3 review deck.pptx'],
  ];
  rows.forEach((row, i) => {
    const file = files[i];
    if (file === undefined) return;
    const [id, mime, name] = file;
    Object.assign(row, {
      body: null,
      attachment_asset_ids: [id],
      attachment_meta: { [id]: { mime, name, size: 48_000 } },
    });
  });
  const popups: string[] = [];
  context.on('page', (p) => popups.push(p.url()));

  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  const bubbles = page.locator('[data-file-bubble="office"]');
  await expect(bubbles).toHaveCount(3);

  // Excel: the grid, the title line, sticky letters, and a tab switch.
  await bubbles.nth(0).scrollIntoViewIfNeeded();
  await bubbles.nth(0).click();
  const viewer = page.locator('[data-file-viewer="office"]');
  const sheet = viewer.locator('[data-sheet-viewer]');
  // The first open compiles the Worker in the dev server: allow for it.
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.locator('[data-sheet-title]')).toHaveText('Calendar · 4 rows');
  await expect(sheet.getByRole('tab')).toHaveText(['Calendar', 'Budget']);
  await expect(sheet.locator('td[data-merged]').first()).toHaveText(
    'November 2026 content calendar',
  );
  // A formula with no saved value shows its text; numbers are right-aligned.
  await expect(sheet.getByText('=1+1', { exact: true })).toBeVisible();
  await expect(sheet.locator('td', { hasText: /^5000$/ })).toHaveCSS('text-align', 'right');
  // The page never scrolls sideways: only the grid does.
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(sideways).toBe(false);
  await sheet.getByRole('tab', { name: 'Budget' }).click();
  await expect(sheet.locator('[data-sheet-title]')).toHaveText('Budget · 2 rows');
  await expect(sheet.getByRole('tab', { name: 'Budget' })).toHaveAttribute('aria-selected', 'true');
  await expect(sheet.getByText('Instagram reels')).toBeVisible();
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toHaveCount(0);

  // Word: page 1 inside the sandboxed iframe; not one request leaves it.
  const frameRequests: string[] = [];
  const onRequest = (request: Request): void => {
    if (request.frame() !== page.mainFrame() || request.url().includes(TRACKER_HOST)) {
      frameRequests.push(request.url());
    }
  };
  page.on('request', onRequest);
  await bubbles.nth(1).scrollIntoViewIfNeeded();
  await bubbles.nth(1).click();
  const frame = viewer.locator('iframe[data-word-frame]');
  await expect(frame).toBeVisible({ timeout: 15_000 });
  await expect(frame).toHaveAttribute('sandbox', '');
  const doc = page.frameLocator('iframe[data-word-frame]');
  await expect(doc.locator('.page').first()).toBeVisible();
  await expect(doc.locator('.page').first()).toContainText('Diwali campaign brief');
  // The embedded picture shows (inline data); the link is plain text.
  await expect(doc.locator('img')).toHaveCount(1);
  await expect(doc.locator('a')).toHaveCount(0);
  await expect(doc.getByText('Open the board')).toBeVisible();
  const csp = await frame.evaluate((el) => (el as HTMLIFrameElement).srcdoc);
  expect(csp).toContain("default-src 'none'");
  await page.waitForTimeout(300);
  page.off('request', onRequest);
  expect(frameRequests).toEqual([]);
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toHaveCount(0);

  // PowerPoint: the fallback with Download.
  await bubbles.nth(2).scrollIntoViewIfNeeded();
  await bubbles.nth(2).click();
  await expect(viewer.getByText('Preview not available yet')).toBeVisible();
  await expect(
    viewer.locator('[data-viewer-unavailable]').getByRole('button', { name: 'Download' }),
  ).toBeVisible();
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toHaveCount(0);

  // A just-sent docx: its bubble shows the thumbnail drawn on this device.
  const composer = page.locator('form:has(textarea)').first();
  const input = composer.locator('input[type="file"]').nth(1);
  test.skip((await input.count()) === 0, 'no upload endpoint in this env: attaching is off');
  await input.setInputFiles({
    name: 'Sent brief.docx',
    mimeType: DOCX_MIME,
    buffer: docxFixture(),
  });
  // The original goes up alone; the thumbnail the device drew (a JPEG within
  // the caps) follows on its own POST /thumbnail for the stored version.
  const isUpload = (r: { method: () => string; url: () => string }, path: string): boolean => {
    if (r.method() !== 'POST') return false;
    const url = new URL(r.url());
    return url.hostname === 'asset-upload.harness.test' && url.pathname === path;
  };
  const upload = page.waitForRequest((r) => isUpload(r, '/'));
  const thumbnailPost = page.waitForRequest((r) => isUpload(r, '/thumbnail'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // WebKit does not expose file bytes of a multipart body: check the part's
  // headers here and the JPEG bytes from the bubble's own blob below.
  const body = (await upload).postDataBuffer()?.toString('latin1') ?? '';
  expect(body).toMatch(/name="file"; filename="Sent brief\.docx"/);
  expect(body).not.toMatch(/name="thumbnail"/);
  const thumbBody = (await thumbnailPost).postDataBuffer()?.toString('latin1') ?? '';
  expect(thumbBody).toMatch(
    /name="thumbnail"; filename="thumbnail\.jpg"\r\nContent-Type: image\/jpeg/,
  );
  expect(thumbBody).toMatch(/name="asset_version_id"\r\n\r\n0190f100-0000-7000-8000-\d{12}/);
  expect(thumbBody).not.toMatch(/name="file"/);
  await expect
    .poll(() => harness.thumbnails.map((t) => t.assetVersionId))
    .toEqual([expect.stringMatching(/^0190f100-0000-7000-8000-\d{12}$/)]);

  const sent = page.locator('[data-file-bubble="office"]').last();
  await sent.scrollIntoViewIfNeeded();
  const thumb = sent.locator('[data-file-thumb] img');
  await expect(thumb).toBeVisible();
  const info = await thumb.evaluate(async (img) => {
    const el = img as HTMLImageElement;
    await el.decode();
    // A same-document blob: read back through XHR (no network involved).
    const blob = await new Promise<Blob>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', el.src);
      xhr.responseType = 'blob';
      xhr.onload = () => resolve(xhr.response as Blob);
      xhr.onerror = () => reject(new Error('blob read failed'));
      xhr.send();
    });
    const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    return { width: el.naturalWidth, height: el.naturalHeight, bytes: blob.size, head: [...head] };
  });
  expect(info.head).toEqual([0xff, 0xd8, 0xff]);
  expect(info.width).toBeGreaterThan(0);
  expect(info.width).toBeLessThanOrEqual(580);
  expect(info.height).toBeLessThanOrEqual(1160);
  expect(info.bytes).toBeLessThanOrEqual(300 * 1024);

  // Nothing left the tab, and no request escaped the fixtures.
  expect(popups).toEqual([]);
  expect(harness.blocked).toEqual([]);
});
