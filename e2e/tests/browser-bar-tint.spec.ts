import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, POST_IDS } from '../fixtures/chat-data';

// The browser's own bar colour (src/lib/bar-tint.ts). Android Chrome, Samsung
// Internet and installed apps read theme-color: every meta carries the --panel
// token on Topbar screens and a chat thread, and the canvas (--bg) on a phone
// Post detail page. iOS Safari samples the top edge: a phone chat thread adds
// a solid strip the status bar inset tall (0px here: Playwright has no inset).
// Tagged @theme for light and dark.

const POST = POST_IDS[0] ?? '';

async function metaContents(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('meta[name="theme-color"]')].map(
      (m) => m.getAttribute('content') ?? '',
    ),
  );
}

async function token(page: Page, name: '--panel' | '--bg'): Promise<string> {
  return page.evaluate(
    (n) =>
      n === '--panel'
        ? getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()
        : getComputedStyle(document.documentElement).backgroundColor,
    name,
  );
}

async function expectTint(page: Page, name: '--panel' | '--bg'): Promise<void> {
  const want = await token(page, name);
  expect(want).not.toBe('');
  await expect
    .poll(async () => {
      const all = await metaContents(page);
      return all.length > 0 && all.every((c) => c === want);
    })
    .toBe(true);
}

async function go(page: Page, url: string): Promise<void> {
  await page.evaluate((u) => {
    window.history.pushState({}, '', u);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

test('theme-color follows the top surface: Pipeline, chat list, thread, post detail @theme', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const network = await installHarnessNetwork(page);
  await page.goto('/pipeline?stage=all');
  await expect(page.getByRole('button', { name: 'Open post Monday carousel' })).toBeVisible({
    timeout: 15_000,
  });
  await expectTint(page, '--panel');
  await expect(page.locator('[data-thread-top-strip]')).toHaveCount(0);

  await go(page, '/chat');
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/chat');
  await expectTint(page, '--panel');
  await expect(page.locator('[data-thread-top-strip]')).toHaveCount(0);

  await go(page, `/chat?channel=${encodeURIComponent(DM_CHANNEL)}`);
  await page.locator('form textarea').first().waitFor({ state: 'visible', timeout: 15_000 });
  await expectTint(page, '--panel');
  const strip = page.locator('[data-thread-top-strip]');
  await expect(strip).toHaveCount(1);
  const s = await strip.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      position: cs.position,
      top: cs.top,
      pointer: cs.pointerEvents,
      bg: cs.backgroundColor,
      blur: cs.getPropertyValue('backdrop-filter'),
      opacity: cs.opacity,
      height: el.getBoundingClientRect().height,
    };
  });
  expect(s.position).toBe('fixed');
  expect(s.top).toBe('0px');
  expect(s.pointer).toBe('none');
  expect(s.opacity).toBe('1');
  expect(['', 'none']).toContain(s.blur);
  // No safe-area inset in Playwright: the strip takes no pixels, so nothing in the page moves.
  expect(s.height).toBe(0);

  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expectTint(page, '--bg');
  await expect(page.locator('[data-thread-top-strip]')).toHaveCount(0);
  expect(network.blocked).toEqual([]);
});

test('theme-color is --panel on every route on laptop; no thread strip there @desktop', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expectTint(page, '--panel');
  await go(page, `/chat?channel=${encodeURIComponent(DM_CHANNEL)}`);
  await page.locator('form textarea').first().waitFor({ state: 'visible', timeout: 15_000 });
  await expectTint(page, '--panel');
  await expect(page.locator('[data-thread-top-strip]')).toHaveCount(0);
  expect(network.blocked).toEqual([]);
});
