import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// The chat list scrolls the document on a phone (src/lib/scroll-mode.ts:
// /chat with no ?channel= is page mode), so mobile browser bars shrink on
// scroll and the rows run under them. The list header (the chip row) pins
// below the sticky Topbar, with no gap above it. Opening a chat puts the
// shell back in the locked mode the thread has always had. Laptop is the
// locked shell, unchanged. Tagged @theme for light and dark.

const phone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 768;

interface ListState {
  pageClass: boolean;
  mainOverflowY: string;
  docScrollable: boolean;
  scrollY: number;
  /** The list's own scroll box, if any element inside main scrolls the rows. */
  innerScrollers: number;
}

async function listState(page: Page): Promise<ListState> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const doc = document.scrollingElement ?? document.documentElement;
    const inner =
      main === null
        ? []
        : Array.from(main.querySelectorAll<HTMLElement>('*')).filter((el) => {
            const y = getComputedStyle(el).overflowY;
            return (y === 'auto' || y === 'scroll') && el.scrollHeight > el.clientHeight + 1;
          });
    return {
      pageClass: document.documentElement.classList.contains('scroll-page'),
      mainOverflowY: main === null ? '' : getComputedStyle(main).overflowY,
      docScrollable: doc.scrollHeight > doc.clientHeight + 1,
      scrollY: window.scrollY,
      innerScrollers: inner.length,
    };
  });
}

async function openList(page: Page): Promise<void> {
  await page.goto('/chat');
  await expect(page.getByText(PEER_NAME, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
}

test('phone: the chat list scrolls the document under a pinned header @theme', async ({ page }) => {
  test.skip(!phone(page), 'phone only');
  // Short enough that the rows overflow the screen.
  await page.setViewportSize({ width: 390, height: 320 });
  const network = await installHarnessNetwork(page);
  await openList(page);

  const state = await listState(page);
  expect(state.pageClass).toBe(true);
  expect(state.mainOverflowY).toBe('visible');
  expect(state.docScrollable).toBe(true);
  expect(state.innerScrollers).toBe(0);
  expect(state.scrollY).toBe(0);

  // The chip row (search lives only in the top bar's palette).
  const chipRow = page.locator('[data-chip-row]').first();
  const topbarBottom = await page
    .locator('header')
    .first()
    .evaluate((el) => el.getBoundingClientRect().bottom);
  const rowTopBefore = await chipRow.evaluate((el) => el.getBoundingClientRect().top);
  // Chat catch up (13 Nov 2026) sits above the chips while there is unread:
  // it scrolls away with the page, so the pinned chips end up its height higher.
  const strip = page.locator('main [data-shell="catch-up"]');
  const stripHeight =
    (await strip.count()) > 0
      ? await strip.first().evaluate((el) => el.getBoundingClientRect().height)
      : 0;

  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // The Topbar stays at the top; the chip row pins below it (where it was at
  // rest, less the catch-up strip that scrolled away: no jump, no gap).
  const topbarTop = await page
    .locator('header')
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(topbarTop)).toBeLessThanOrEqual(1);
  const rowTopAfter = await chipRow.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(rowTopAfter - (rowTopBefore - stripHeight))).toBeLessThanOrEqual(1);
  // The pinned header box starts right at the Topbar's bottom edge.
  const headerTop = await chipRow.evaluate((el) => {
    let node: Element | null = el;
    while (node !== null && getComputedStyle(node).position !== 'sticky') node = node.parentElement;
    return node === null ? Number.NaN : node.getBoundingClientRect().top;
  });
  expect(Math.abs(headerTop - topbarBottom)).toBeLessThanOrEqual(1);
  // Light and dark: the pinned header paints the page canvas (no new surface).
  const colors = await chipRow.evaluate((el) => {
    let node: Element | null = el;
    while (node !== null && getComputedStyle(node).position !== 'sticky') node = node.parentElement;
    return {
      header: node === null ? '' : getComputedStyle(node).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(colors.header).toBe(colors.body);

  // Opening a chat: the thread's locked shell, at its own scroller.
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('form textarea').first().waitFor({ state: 'visible' });
  await expect.poll(async () => (await listState(page)).pageClass).toBe(false);
  const thread = await listState(page);
  expect(thread.mainOverflowY).toBe('auto');
  expect(thread.docScrollable).toBe(false);

  // Back: the list in page mode again. The browser's own history scroll
  // restoration puts the list back where it was (as on every page-mode route),
  // and the header is pinned there below the Topbar.
  await page.goBack();
  await expect(chipRow).toBeVisible();
  await expect.poll(async () => (await listState(page)).pageClass).toBe(true);
  const back = await listState(page);
  expect(back.mainOverflowY).toBe('visible');
  expect(back.innerScrollers).toBe(0);
  // Opening the chat read it, so the Chat catch up strip above the chips may
  // have changed or gone and the restored scroll lands on a different spot:
  // the header is never under the Topbar and the chips keep their place in it.
  const backBox = await chipRow.evaluate((el) => {
    let node: Element | null = el;
    while (node !== null && getComputedStyle(node).position !== 'sticky') node = node.parentElement;
    return {
      row: el.getBoundingClientRect().top,
      header: node === null ? Number.NaN : node.getBoundingClientRect().top,
    };
  });
  expect(backBox.header).toBeGreaterThanOrEqual(topbarBottom - 1);
  expect(Math.abs(backBox.row - backBox.header - (rowTopAfter - headerTop))).toBeLessThanOrEqual(1);
  expect(network.blocked).toEqual([]);
});

test('laptop: the chat list is the locked shell, unchanged', async ({ page }) => {
  test.skip(phone(page), 'laptop only');
  await page.setViewportSize({ width: 1280, height: 800 });
  const network = await installHarnessNetwork(page);
  await openList(page);
  const state = await listState(page);
  expect(state.mainOverflowY).toBe('auto');
  expect(state.docScrollable).toBe(false);
  expect(network.blocked).toEqual([]);
});
