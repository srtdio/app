import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { SEO_ROUTES, prerenderDocument } from '../../src/components/home/seo-routes';

// "/" is served prerendered homepage markup (scripts/prerender.ts). The inline
// head script in index.html must keep a signed-in visitor from ever seeing it:
// not one frame, and no light canvas in dark mode. This serves the real
// index.html, filled the way the build fills it, with the app entry removed so
// only the inline scripts run. Every animation frame from before first paint
// records the DOM; screenshots stay off.

const HOME_CSS = '/__prerender-home.css';
// The rule from home.css that would turn the canvas white if .home stayed in the DOM.
const HOME_CSS_BODY = ':root{--srtd-home:1}html:has(.home){background:#ffffff}';
const MARKUP = '<div class="home"><main><h1 class="d">Social media teams</h1></main></div>';
const DARK = 'rgb(12, 13, 16)';
const LIGHT = 'rgb(247, 248, 249)';

interface Frame {
  home: boolean;
  rootChildren: number;
  bg: string;
}

function prerenderedHome(): string {
  const route = SEO_ROUTES.find((r) => r.path === '/');
  if (route === undefined) throw new Error('no "/" route');
  const shell = readFileSync('index.html', 'utf8').replace(
    /<script type="module"[^>]*><\/script>/,
    '',
  );
  return prerenderDocument({ template: shell, route, markup: MARKUP, stylesheets: [HOME_CSS] });
}

async function serve(page: Page): Promise<void> {
  const html = prerenderedHome();
  await page.route(
    (url) => url.pathname === '/',
    (route) => route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.route(
    (url) => url.pathname === HOME_CSS,
    (route) => route.fulfill({ contentType: 'text/css', body: HOME_CSS_BODY }),
  );
}

/** Records every frame from the first one, before anything paints. */
async function recordFrames(page: Page, storage: Record<string, string>): Promise<void> {
  await page.addInitScript((items: Record<string, string>) => {
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
    const frames: Frame[] = [];
    (window as unknown as { __frames: Frame[] }).__frames = frames;
    const tick = (): void => {
      frames.push({
        home: document.querySelector('.home') !== null,
        rootChildren: document.getElementById('root')?.childElementCount ?? -1,
        bg: getComputedStyle(document.documentElement).backgroundColor,
      });
      if (frames.length < 30) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, storage);
}

async function framesOf(page: Page): Promise<Frame[]> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames.length))
    .toBeGreaterThanOrEqual(30);
  return page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
}

test.describe('prerendered "/" first paint', () => {
  test('a signed-in dark-mode visitor never sees the homepage or a light frame', async ({
    page,
  }) => {
    await serve(page);
    await recordFrames(page, {
      'sb-e2e-auth-token': '{}',
      'sorted-theme': 'dark',
    });
    await page.goto('/');
    const frames = await framesOf(page);
    for (const frame of frames) {
      expect(frame.home).toBe(false);
      expect(frame.bg).toBe(DARK);
    }
    await expect(page.locator('#root')).toBeEmpty();
    await expect(page.locator('link[data-prerender-css]')).toHaveCount(0);
    expect(await page.locator('#root').getAttribute('data-prerender')).toBeNull();
  });

  test('a signed-in light-mode visitor never sees the homepage', async ({ page }) => {
    await serve(page);
    await recordFrames(page, { 'sb-e2e-auth-token': '{}' });
    await page.goto('/');
    for (const frame of await framesOf(page)) {
      expect(frame.home).toBe(false);
      expect(frame.bg).toBe(LIGHT);
    }
  });

  test('an auth callback on "/" never shows the homepage', async ({ page }) => {
    await serve(page);
    await recordFrames(page, {});
    await page.goto('/?code=abc');
    for (const frame of await framesOf(page)) expect(frame.home).toBe(false);
  });

  test('a guest sees the homepage from first paint, on a white canvas', async ({ page }) => {
    await serve(page);
    await recordFrames(page, { 'sorted-theme': 'dark' });
    await page.goto('/');
    // Any frame with markup in #root is the homepage; the canvas is white throughout.
    const frames = await framesOf(page);
    expect(frames.some((frame) => frame.home)).toBe(true);
    for (const frame of frames) {
      if (frame.rootChildren > 0) expect(frame.home).toBe(true);
      expect(frame.bg).toBe('rgb(255, 255, 255)');
    }
    await expect(page.getByRole('heading', { name: 'Social media teams' })).toBeVisible();
  });
});
