import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, PEER_NAME } from '../fixtures/chat-data';

// Whole-page scrolling (src/lib/scroll-mode.ts). On a phone every in-shell
// route but a chat thread scrolls the document (the chat list included), so
// mobile browser bars shrink on scroll and content runs under them; a chat
// thread (/chat?channel=) stays the locked 100svh shell with <main> as its
// scroller. Laptop is the locked shell on every route. Tagged @theme for
// light and dark.

const phone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 768;

interface ScrollState {
  pageClass: boolean;
  mainOverflowY: string;
  docScrollable: boolean;
  rootHeight: string;
}

async function scrollState(page: Page): Promise<ScrollState> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const doc = document.scrollingElement ?? document.documentElement;
    return {
      pageClass: document.documentElement.classList.contains('scroll-page'),
      mainOverflowY: main === null ? '' : getComputedStyle(main).overflowY,
      docScrollable: doc.scrollHeight > doc.clientHeight + 1,
      rootHeight: getComputedStyle(document.documentElement).height,
    };
  });
}

test('Pipeline scrolls the document on a phone and <main> on laptop @theme', async ({ page }) => {
  // Short enough that the three-card list overflows now the screen search row is gone.
  await page.setViewportSize(
    phone(page) ? { width: 390, height: 360 } : { width: 1280, height: 800 },
  );
  const network = await installHarnessNetwork(page);
  await page.goto('/pipeline?stage=all');
  await expect(page.getByRole('button', { name: 'Open post Monday carousel' })).toBeVisible({
    timeout: 15_000,
  });

  const state = await scrollState(page);
  expect(state.pageClass).toBe(true);
  if (phone(page)) {
    expect(state.mainOverflowY).toBe('visible');
    expect(state.docScrollable).toBe(true);

    // The Topbar stays pinned to the top of the window while the page scrolls.
    await page.evaluate(() => window.scrollTo(0, 200));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const top = await page
      .locator('header')
      .first()
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.abs(top)).toBeLessThanOrEqual(1);
  } else {
    // Laptop: exactly the old shell, main scrolls and the document never does.
    expect(state.mainOverflowY).toBe('auto');
    expect(state.docScrollable).toBe(false);
  }
  expect(network.blocked).toEqual([]);
});

test('Chat list scrolls the page, a thread stays locked, Pipeline keeps its position @theme', async ({
  page,
}) => {
  test.skip(!phone(page), 'phone only');
  await page.setViewportSize({ width: 390, height: 360 });
  const network = await installHarnessNetwork(page);
  await page.goto('/pipeline?stage=all');
  await expect(page.getByRole('button', { name: 'Open post Monday carousel' })).toBeVisible({
    timeout: 15_000,
  });
  const kept = await page.evaluate(() => {
    const doc = document.scrollingElement;
    if (doc === null) return 0;
    doc.scrollTop = 240;
    window.dispatchEvent(new Event('scroll'));
    return doc.scrollTop;
  });
  expect(kept).toBeGreaterThan(0);

  // The chat list: page mode, and it opens at its top (never at Pipeline's offset).
  await page.evaluate(() => {
    window.history.pushState({}, '', '/chat');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByText(PEER_NAME, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  const list = await scrollState(page);
  expect(list.pageClass).toBe(true);
  expect(list.mainOverflowY).toBe('visible');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // A chat thread: locked, <main> scrolls, the document never does.
  await page.evaluate((channel) => {
    window.history.pushState({}, '', `/chat?channel=${encodeURIComponent(channel)}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, DM_CHANNEL);
  await page.locator('form textarea').first().waitFor({ state: 'visible', timeout: 15_000 });
  await expect.poll(async () => (await scrollState(page)).pageClass).toBe(false);
  const thread = await scrollState(page);
  expect(thread.mainOverflowY).toBe('auto');
  expect(thread.docScrollable).toBe(false);

  await page.goBack();
  await expect.poll(async () => (await scrollState(page)).pageClass).toBe(true);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Open post Monday carousel' })).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(async () => (await scrollState(page)).pageClass).toBe(true);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(kept);
  expect(network.blocked).toEqual([]);
});
