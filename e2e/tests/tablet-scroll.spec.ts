import { devices, expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';

// Whole-page scrolling on touch tablets (src/lib/scroll-mode.ts,
// TOUCH_TABLET_QUERY: md width and up, hover none, pointer coarse). Every
// in-shell route but Chat scrolls the document, as on a phone, so the browser
// bars shrink on scroll and content runs under them; the Sidebar stays pinned.
// Chat stays the locked 100svh shell. Untagged, so it runs once in the iPhone
// project (dark) with this file's own iPad viewport (as ipad-layout.spec.ts).

const TOUCH_TABLET_QUERY = '(min-width: 768px) and (hover: none) and (pointer: coarse)';

test.use({
  viewport: { width: 820, height: 1180 },
  userAgent: devices['iPad (gen 7)'].userAgent,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

interface ScrollState {
  tablet: boolean;
  pageClass: boolean;
  mainOverflowY: string;
  docScrollable: boolean;
}

async function scrollState(page: Page): Promise<ScrollState> {
  return page.evaluate((query) => {
    const main = document.querySelector('main');
    const doc = document.scrollingElement ?? document.documentElement;
    return {
      tablet: window.matchMedia(query).matches,
      pageClass: document.documentElement.classList.contains('scroll-page'),
      mainOverflowY: main === null ? '' : getComputedStyle(main).overflowY,
      docScrollable: doc.scrollHeight > doc.clientHeight + 1,
    };
  }, TOUCH_TABLET_QUERY);
}

/**
 * More Pipeline posts, so the list overflows the screen whatever the card
 * layout: the harness has only a few posts, and since Pipeline lays its list
 * cards in laptop columns (LIST_CARD_GRID) they no longer fill an iPad height.
 * Clones of the harness's first post under new ids and titles, listed last.
 */
function seedScrollPosts(network: HarnessNetwork, count = 24): void {
  const posts = (network.world.tables.posts ??= []);
  const base = posts[0];
  if (base === undefined) return;
  for (let i = 0; i < count; i += 1) {
    posts.push({
      ...base,
      id: `0190dc00-0000-7000-8c00-${String(i + 1).padStart(12, '0')}`,
      number: 800 + i,
      title: `Scroll filler ${i + 1}`,
      // Older than every harness post, so the fixture posts keep the top.
      created_at: new Date(Date.UTC(2026, 0, 1) - i * 60_000).toISOString(),
    });
  }
}

async function openPipeline(page: Page): Promise<void> {
  await page.goto('/pipeline?stage=all');
  // Any Pipeline card: the seeded filler posts can sort ahead of the fixture
  // posts, so the wait is for the list itself, not one named card.
  await expect(page.locator('[data-list-card]').first()).toBeVisible({ timeout: 15_000 });
}

for (const size of [
  // Short heights plus seedScrollPosts, so Pipeline always overflows and the
  // document has something to scroll.
  { name: 'portrait', width: 820, height: 600 },
  { name: 'landscape', width: 1180, height: 560 },
]) {
  test(`iPad ${size.name}: Pipeline scrolls the document; Topbar and Sidebar stay put`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const network = await installHarnessNetwork(page);
    seedScrollPosts(network);
    await openPipeline(page);

    const state = await scrollState(page);
    expect(state.tablet, 'touch tablet emulated').toBe(true);
    expect(state.pageClass).toBe(true);
    expect(state.mainOverflowY).toBe('visible');
    expect(state.docScrollable).toBe(true);

    await page.evaluate(() => window.scrollTo(0, 200));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const header = await page
      .locator('header')
      .first()
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.abs(header)).toBeLessThanOrEqual(1);
    const aside = await page
      .locator('aside')
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, height: r.height, inner: window.innerHeight };
      });
    expect(Math.abs(aside.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(aside.height - aside.inner)).toBeLessThanOrEqual(1);
    expect(network.blocked).toEqual([]);
  });
}

test('iPad: Chat stays locked; Pipeline keeps its position across the trip', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedScrollPosts(network);
  await page.setViewportSize({ width: 820, height: 600 });
  await openPipeline(page);
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

test('iPad: an open overlay holds the page still and closing never jumps', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedScrollPosts(network);
  await page.setViewportSize({ width: 820, height: 600 });
  await openPipeline(page);
  await page.evaluate(() => window.scrollTo(0, 180));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const before = await page.evaluate(() => window.scrollY);

  await page.getByRole('button', { name: /^Search( ⌘K)?$/ }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  expect(network.blocked).toEqual([]);
});
