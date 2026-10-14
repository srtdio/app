import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_PDF_PAGES, fixturePdf, installHarnessNetwork } from '../fixtures/harness-routes';
import { ME, PEER_NAME } from '../fixtures/chat-data';

// Files open inside chat: a PDF message opens the in-app viewer (pdf.js page 1
// and "1 / N"), a swipe down closes it, and a pptx shows "Preview not
// available yet" with Download. Nothing opens a new tab or window. One spec,
// tagged @theme so it runs in light and dark. Linux WebKit approximates iOS
// WebKit; it is not iOS.

const PDF_ID = '0190f200-0000-7000-8000-000000000001';
const PPTX_ID = '0190f200-0000-7000-8000-000000000002';
const LONG_PPTX =
  'Brand guidelines - client review round two - final final - approved by Priya v12.pptx';

/** A downward one-finger drag on the viewer's top bar, as touch events. */
async function swipeDown(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bar = document.querySelector('[data-viewer-bar]');
    if (!(bar instanceof HTMLElement)) throw new Error('no viewer bar');
    const rect = bar.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    // WebKit has no Touch constructor: plain events carrying the touch lists
    // the sheet reads (touches[0].clientX / clientY).
    const fire = (type: string, y: number, ended = false): void => {
      const point = { identifier: 1, target: bar, clientX: x, clientY: y };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: ended ? [] : [point] },
        targetTouches: { value: ended ? [] : [point] },
        changedTouches: { value: [point] },
      });
      bar.dispatchEvent(event);
    };
    const start = rect.top + 20;
    fire('touchstart', start);
    for (let dy = 20; dy <= 220; dy += 20) {
      fire('touchmove', start + dy);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    fire('touchend', start + 220, true);
  });
}

test('chat files open in the in-app viewer @theme', async ({ page, context }) => {
  const harness = await installHarnessNetwork(page);
  // The DM's last two messages (the peer's) carry a PDF and a long-named pptx.
  const dm = harness.world.dmMessages;
  const pdfRow = dm[dm.length - 2];
  const docxRow = dm[dm.length - 1];
  if (pdfRow === undefined || docxRow === undefined) throw new Error('fixture DM too short');
  Object.assign(pdfRow, {
    body: null,
    attachment_asset_ids: [PDF_ID],
    attachment_meta: {
      [PDF_ID]: {
        mime: 'application/pdf',
        name: 'Q3 launch brief.pdf',
        size: 240_000,
        page_count: FIXTURE_PDF_PAGES,
        thumb_w: 580,
        thumb_h: 751,
      },
    },
  });
  Object.assign(docxRow, {
    body: null,
    attachment_asset_ids: [PPTX_ID],
    attachment_meta: {
      [PPTX_ID]: {
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        name: LONG_PPTX,
        size: 48_000,
      },
    },
  });
  const popups: string[] = [];
  context.on('page', (p) => popups.push(p.url()));

  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();

  const pdfBubble = page.locator('[data-file-bubble="pdf"]').first();
  const docxBubble = page.locator('[data-file-bubble="office"]').first();
  await pdfBubble.scrollIntoViewIfNeeded();
  await expect(pdfBubble).toBeVisible();

  // Height is final on first paint: the thumbnail box is reserved from meta.
  const before = await pdfBubble.boundingBox();
  await expect(pdfBubble.locator('img')).toHaveJSProperty('complete', true);
  const after = await pdfBubble.boundingBox();
  expect(after?.height).toBe(before?.height);
  // Width is the text bubble max, not the name: the long pptx name is no wider.
  const docxBox = await docxBubble.boundingBox();
  expect(Math.round(docxBox?.width ?? 0)).toBe(Math.round(after?.width ?? -1));
  // The long name keeps its extension after a middle cut.
  await expect(docxBubble.locator('[data-file-name]')).toHaveText(/….*\.pptx$/);

  // PDF: page 1 renders, the counter reads "1 / N".
  await pdfBubble.click();
  const viewer = page.locator('[data-file-viewer="pdf"]');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('[data-pdf-page="1"] canvas')).toBeVisible();
  await expect(viewer.locator('[data-page-counter]')).toHaveText(`1 / ${FIXTURE_PDF_PAGES}`);
  const painted = await viewer
    .locator('[data-pdf-page="1"] canvas')
    .evaluate((canvas) => (canvas as HTMLCanvasElement).width > 0);
  expect(painted).toBe(true);

  // Swipe down closes (translateY only).
  await swipeDown(page);
  await expect(viewer).toHaveCount(0);

  // pptx: "Preview not available yet" with Download, then the X closes.
  await docxBubble.scrollIntoViewIfNeeded();
  await docxBubble.click();
  const office = page.locator('[data-file-viewer="office"]');
  await expect(office.getByText('Preview not available yet')).toBeVisible();
  await expect(office.getByRole('button', { name: 'Download' }).first()).toBeVisible();
  await office.getByRole('button', { name: 'Close' }).click();
  await expect(office).toHaveCount(0);

  // Nothing left the tab, and no request escaped the fixtures.
  expect(popups).toEqual([]);
  expect(harness.blocked).toEqual([]);
});

// Width rule (#523 T9): a sent file bubble is the text bubble's max, never
// wider than the message column or the screen, whatever its thumbnail or name.
const SENT_PDF = '0190f200-0000-7000-8000-000000000003';
const SENT_VIDEO = '0190f200-0000-7000-8000-000000000004';
const LONG = (ext: string): string =>
  `${'Quarterly campaign review deck '.repeat(3).slice(0, 76)}.${ext}`;

/** Every file bubble sits inside the viewport and its message column, at the column's max. */
async function bubblesFit(page: Page, count: number): Promise<void> {
  const boxes = await page.locator('[data-file-bubble]').evaluateAll((els) =>
    els.map((el) => {
      const bubble = el.closest('[data-bubble]');
      const column = bubble?.parentElement;
      if (bubble == null || column == null) throw new Error('file bubble outside a message');
      const b = el.getBoundingClientRect();
      const c = column.getBoundingClientRect();
      const m = bubble.getBoundingClientRect();
      return { bl: b.left, br: b.right, cl: c.left, cr: c.right, mw: m.width, vw: innerWidth };
    }),
  );
  expect(boxes.length).toBeGreaterThanOrEqual(count);
  for (const { bl, br, cl, cr, mw, vw } of boxes) {
    expect(bl).toBeGreaterThanOrEqual(Math.max(0, cl) - 0.5);
    expect(br).toBeLessThanOrEqual(Math.min(vw, cr) + 0.5);
    // The text bubble max: the message bubble fills its column, whatever the name.
    expect(mw).toBeGreaterThanOrEqual(cr - cl - 1);
  }
}

test('sent file bubbles fit the screen and the message column @theme', async ({ page }) => {
  const harness = await installHarnessNetwork(page);
  const dm = harness.world.dmMessages;
  const rows = [dm[dm.length - 2], dm[dm.length - 1]];
  const metas = [
    [
      SENT_PDF,
      { mime: 'application/pdf', name: LONG('pdf'), size: 240_000, thumb_w: 580, thumb_h: 751 },
    ],
    [
      SENT_VIDEO,
      { mime: 'video/mp4', name: LONG('mp4'), size: 3_400_000, thumb_w: 580, thumb_h: 326 },
    ],
  ] as const;
  rows.forEach((row, i) => {
    const [id, meta] = metas[i] ?? metas[0];
    if (row === undefined) throw new Error('fixture DM too short');
    Object.assign(row, {
      sender_user_id: ME,
      body: null,
      attachment_asset_ids: [id],
      attachment_meta: { [id]: meta },
    });
  });

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/chat');
    await page.getByText(PEER_NAME, { exact: true }).first().click();
    const video = page.locator('[data-file-bubble="video"]').first();
    await video.scrollIntoViewIfNeeded();
    await expect(video.locator('img')).toHaveJSProperty('complete', true);
    await bubblesFit(page, 2);
  }

  // Sending: a picked PDF and video reserve their thumbnail box and still fit.
  await page.setViewportSize({ width: 390, height: 844 });
  const input = page.locator('form:has(textarea)').first().locator('input[type="file"]').nth(1);
  test.skip((await input.count()) === 0, 'no upload endpoint in this env: attaching is off');
  await input.setInputFiles([
    { name: LONG('pdf'), mimeType: 'application/pdf', buffer: fixturePdf(2) },
    { name: LONG('mp4'), mimeType: 'video/mp4', buffer: Buffer.alloc(2048) },
  ]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-file-bubble]')).toHaveCount(4);
  await bubblesFit(page, 4);
  expect(harness.blocked).toEqual([]);
});
