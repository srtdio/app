import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';

// Whole-page scrolling (src/lib/scroll-mode.ts). On a phone every in-shell
// route but Chat scrolls the document, so mobile browser bars shrink on scroll
// and content runs under them; Chat stays the locked 100svh shell with <main>
// as its scroller. Laptop is the locked shell on every route. Tagged @theme
// for light and dark.

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
  await page.setViewportSize(
    phone(page) ? { width: 390, height: 480 } : { width: 1280, height: 800 },
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

test('Chat stays locked and Pipeline keeps its position across the trip @theme', async ({
  page,
}) => {
  test.skip(!phone(page), 'phone only');
  await page.setViewportSize({ width: 390, height: 480 });
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

  await page.evaluate(() => {
    window.history.pushState({}, '', '/chat');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect.poll(async () => (await scrollState(page)).pageClass).toBe(false);
  const chat = await scrollState(page);
  expect(chat.mainOverflowY).toBe('auto');
  expect(chat.docScrollable).toBe(false);

  await page.goBack();
  await expect.poll(async () => (await scrollState(page)).pageClass).toBe(true);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(kept);
  expect(network.blocked).toEqual([]);
});
