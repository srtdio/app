import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_PDF_PAGES, installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// Files open inside chat: a PDF message opens the in-app viewer (pdf.js page 1
// and "1 / N"), a swipe down closes it, and a docx shows "Preview not
// available yet" with Download. Nothing opens a new tab or window. One spec,
// tagged @theme so it runs in light and dark. Linux WebKit approximates iOS
// WebKit; it is not iOS.

const PDF_ID = '0190f200-0000-7000-8000-000000000001';
const DOCX_ID = '0190f200-0000-7000-8000-000000000002';
const LONG_DOCX =
  'Brand guidelines - client review round two - final final - approved by Priya v12.docx';

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
  // The DM's last two messages (the peer's) carry a PDF and a long-named docx.
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
    attachment_asset_ids: [DOCX_ID],
    attachment_meta: {
      [DOCX_ID]: {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        name: LONG_DOCX,
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
  // Width is the text bubble max, not the name: the long docx name is no wider.
  const docxBox = await docxBubble.boundingBox();
  expect(Math.round(docxBox?.width ?? 0)).toBe(Math.round(after?.width ?? -1));
  // The long name keeps its extension after a middle cut.
  await expect(docxBubble.locator('[data-file-name]')).toHaveText(/….*\.docx$/);

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

  // docx: "Preview not available yet" with Download, then the X closes.
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
