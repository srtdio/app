import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// The chat list scrolls the document on a phone (src/lib/scroll-mode.ts:
// /chat with no ?channel= is page mode), so mobile browser bars shrink on
// scroll and the rows run under them. The list header (search, chips) pins
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

  const search = page.getByRole('searchbox', { name: 'Search chats' });
  const topbarBottom = await page
    .locator('header')
    .first()
    .evaluate((el) => el.getBoundingClientRect().bottom);
  const searchTopBefore = await search.evaluate((el) => el.getBoundingClientRect().top);

  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // The Topbar stays at the top; the search row stays where it was, pinned
  // below it (same offset as at rest: no jump, no gap).
  const topbarTop = await page
    .locator('header')
    .first()
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(topbarTop)).toBeLessThanOrEqual(1);
  const searchTopAfter = await search.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(searchTopAfter - searchTopBefore)).toBeLessThanOrEqual(1);
  // The pinned header box starts right at the Topbar's bottom edge.
  const headerTop = await search.evaluate((el) => {
    let node: HTMLElement | null = el;
    while (node !== null && getComputedStyle(node).position !== 'sticky') node = node.parentElement;
    return node === null ? Number.NaN : node.getBoundingClientRect().top;
  });
  expect(Math.abs(headerTop - topbarBottom)).toBeLessThanOrEqual(1);
  // Light and dark: the pinned header paints the page canvas (no new surface).
  const colors = await search.evaluate((el) => {
    let node: HTMLElement | null = el;
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

  // Back: the list in page mode again, from its top.
  await page.goBack();
  await expect(search).toBeVisible();
  await expect.poll(async () => (await listState(page)).pageClass).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(network.blocked).toEqual([]);
});

test('phone: an open keyboard on the list search leaves no gap when it closes', async ({
  page,
}) => {
  test.skip(!phone(page), 'phone only');
  await page.setViewportSize({ width: 390, height: 320 });
  await installHarnessNetwork(page);
  await openList(page);
  const search = page.getByRole('searchbox', { name: 'Search chats' });
  await search.focus();
  await search.blur();
  const state = await listState(page);
  expect(state.pageClass).toBe(true);
  expect(state.scrollY).toBe(0);
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
