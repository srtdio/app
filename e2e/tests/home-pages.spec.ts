import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Homepage and /demo (home bundle, light only). The harness keeps "/" as its
// smoke page, so "/" is served the homepage fixture (home.html) here. /demo
// routes to HomeEntry in the harness itself. Every project
// emulates its colour scheme; iphone-webkit is dark, so "stays light" is
// checked on a dark-mode device. Linux WebKit approximates iOS WebKit.

const FEATURE_KEYS = ['chat', 'plan', 'pipeline', 'assets', 'briefs'] as const;
const WHITE = 'rgb(255, 255, 255)';

/**
 * Serve the homepage fixture for "/" (any hash), like the guest path boots it.
 * Clip requests (the harness media base) get an empty 404, so the rail renders
 * its video elements without downloading anything.
 */
async function serveHome(page: Page): Promise<void> {
  await page.route('**/site-media/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const fixture = new URL('/home.html', route.request().url()).toString();
      const response = await route.fetch({ url: fixture });
      await route.fulfill({ response });
    },
  );
}

/**
 * The active rail card: the one at its snap position once scrolling settled,
 * the only one whose clip plays. Also checks it sits at the rail's snap edge.
 */
async function railIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rail = document.querySelector('.home .rail');
    if (rail === null) return -1;
    const cards = [...rail.querySelectorAll('.card')];
    const active = cards.findIndex((card) => card.hasAttribute('data-active'));
    if (active < 0) return -1;
    const pad = parseFloat(getComputedStyle(rail).scrollPaddingLeft) || 0;
    const left = rail.getBoundingClientRect().left + pad;
    const offset = Math.abs(cards[active]!.getBoundingClientRect().left - left);
    return offset <= 2 ? active : -2;
  });
}

/** End the clip on card `index`, as the browser would when it finishes. */
async function endClip(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => {
    const video = document.querySelectorAll('.home .rail .card video')[i];
    if (!video) throw new Error(`no clip on card ${i}`);
    video.dispatchEvent(new Event('ended'));
  }, index);
}

/** The rail moves on when a clip ends, and from the last card back to the first. */
async function expectAutoAdvance(page: Page): Promise<void> {
  await page.locator('.home .rail').scrollIntoViewIfNeeded();
  await expect.poll(() => railIndex(page)).toBe(0);
  for (let i = 0; i < FEATURE_KEYS.length; i += 1) {
    await endClip(page, i);
    await expect
      .poll(() => railIndex(page), { timeout: 5_000 })
      .toBe((i + 1) % FEATURE_KEYS.length);
  }
}

async function expectLight(page: Page): Promise<void> {
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(bg).toBe(WHITE);
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(body).toBe(WHITE);
}

/** Open the sidebar and tap a feature tile. */
async function tapTile(page: Page, key: string): Promise<void> {
  await page.getByRole('button', { name: 'Open menu' }).click();
  const tile = page.locator(`[data-feature-tile="${key}"]`);
  await expect(tile).toBeVisible();
  expectMinTouchTarget(await tile.boundingBox());
  await tile.click();
}

/** The card is fully on screen: inside the viewport, below the sticky header. */
async function expectCardInView(page: Page, key: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((k) => {
          const card = document.getElementById(`feature-${k}`);
          const header = document.querySelector('.home .top');
          if (card === null || header === null) return 'missing';
          const r = card.getBoundingClientRect();
          const top = header.getBoundingClientRect().bottom;
          const fits =
            r.left >= -1 &&
            r.right <= window.innerWidth + 1 &&
            r.top >= top - 1 &&
            r.bottom <= window.innerHeight + 1;
          return fits ? 'in view' : JSON.stringify(r);
        }, key),
      { timeout: 5_000 },
    )
    .toBe('in view');
}

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone flows');

  test('the homepage shows the new hero copy and stays light on a dark device', async ({
    page,
  }) => {
    await serveHome(page);
    await page.goto('/');
    const hero = page.locator('.home .hero');
    await expect(hero.locator('p')).toHaveCount(1);
    await expect(hero.getByRole('heading', { level: 1 })).toHaveText(
      'Social media teams hate WhatsApp.',
    );
    await expect(
      hero.getByText(
        'Approvals, feedback and files get buried in group chats that never switch off. Sorted gives each client one workspace, so WhatsApp goes back to being WhatsApp.',
      ),
    ).toBeVisible();
    await expect(page.getByText('The three jobs WhatsApp was never built to do.')).toBeVisible();
    await expectLight(page);
    // No mailto left: every Book a demo is /demo.
    expect(await page.locator('a[href^="mailto:"]').count()).toBe(0);
  });

  test('cards: the clip ending moves the rail on; 3 seconds on a card nudges once', async ({
    page,
  }) => {
    await serveHome(page);
    await page.goto('/');
    await expect(page.locator('.home .rail .card video')).toHaveCount(5);
    await page.locator('.home .rail').scrollIntoViewIfNeeded();
    // The nudge: once, within about a second of the 3s mark, then the class clears.
    await expect(page.locator('.home .rail.nudging')).toHaveCount(1, { timeout: 4_500 });
    await expect(page.locator('.home .rail.nudging')).toHaveCount(0, { timeout: 3_000 });
    expect(await railIndex(page)).toBe(0);
    await expectAutoAdvance(page);
    // Back on the first card after a full loop: it was nudged already, so no second nudge.
    await page.waitForTimeout(3_600);
    await expect(page.locator('.home .rail.nudging')).toHaveCount(0);
  });

  test('every sidebar tile lands on its own card', async ({ page }) => {
    await serveHome(page);
    await page.goto('/');
    for (const key of FEATURE_KEYS) {
      await tapTile(page, key);
      await expect(page.locator('#home-menu')).toHaveAttribute('aria-hidden', 'true');
      await expectCardInView(page, key);
      expect(new URL(page.url()).hash).toBe(`#feature-${key}`);
    }
  });

  test('from /demo a tile loads the homepage on that card', async ({ page }) => {
    await serveHome(page);
    for (const key of ['plan', 'briefs'] as const) {
      await page.goto('/demo');
      await tapTile(page, key);
      await page.waitForURL(`**/#feature-${key}`);
      await expectCardInView(page, key);
    }
  });

  test('sidebar: no section labels, tiles then rows then stories; stories are not links', async ({
    page,
  }) => {
    await serveHome(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const menu = page.locator('#home-menu');
    await expect(menu.getByRole('link', { name: /Pricing/ })).toHaveCount(0);
    await expect(page.locator('a[href="/pricing"]')).toHaveCount(0);
    await expect(menu.locator('.lbl')).toHaveCount(0);
    for (const word of ['Product', 'Company', 'Stories']) {
      await expect(menu.getByText(word, { exact: true })).toHaveCount(0);
    }
    await expect(menu.getByRole('link', { name: 'Why Sorted' })).toHaveAttribute('href', '#why');
    await expect(menu.getByRole('link', { name: /Book a demo/ })).toHaveAttribute('href', '/demo');
    // Order and rhythm: tiles, rows, stories, each group 24px below the last.
    const gaps = await page.evaluate(() => {
      const bottom = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().bottom;
      const top = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().top;
      return [
        Math.round(top('#home-menu .nav-main') - bottom('#home-menu .nav-feat')),
        Math.round(top('#home-menu .stories') - bottom('#home-menu .nav-main')),
      ];
    });
    expect(gaps).toEqual([24, 24]);
    const stories = menu.locator('.stories .story');
    await expect(stories).toHaveCount(3);
    await expect(stories.getByText('Coming soon')).toHaveCount(3);
    await expect(menu.locator('.stories a, .stories button, .stories [tabindex]')).toHaveCount(0);
    // Tab through the whole menu: focus never lands inside a story.
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab');
      const inStory = await page.evaluate(
        () => document.activeElement?.closest('.stories') !== null,
      );
      expect(inStory).toBe(false);
    }
  });

  test('/demo loads directly and from the menu; Back to home', async ({ page }) => {
    await serveHome(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page
      .locator('#home-menu')
      .getByRole('link', { name: /Book a demo/ })
      .click();
    await page.waitForURL('**/demo');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'See it with your own client work.',
    );
    await expectLight(page);

    const back = page.getByRole('link', { name: 'Back to home' });
    expectMinTouchTarget(await back.boundingBox());
    await back.click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.locator('.home .hero')).toBeVisible();

    await page.goto('/demo');
    await expect(page.getByRole('button', { name: 'Book my demo' })).toBeVisible();
  });

  test('demo: errors, then a valid booking sends nothing and shows the notice', async ({
    page,
  }) => {
    await page.goto('/demo');
    const submit = page.getByRole('button', { name: 'Book my demo' });
    await submit.click();
    await expect(page.getByText('Enter your name.')).toBeVisible();
    await expect(page.getByText('Enter an email like you@agency.com.')).toBeVisible();
    await expect(page.getByText('Enter a 10 digit mobile number.')).toBeVisible();
    await expect(page.getByText('Pick a day for the call.')).toBeVisible();
    await expect(page.locator('#demo-name')).toBeFocused();
    await expect(page.getByText('Choose a day first. Weekdays only.')).toBeVisible();

    await page.locator('#demo-name').fill('Asha');
    await page.locator('#demo-email').fill('you@agency.com');
    await page.locator('#demo-mobile').fill('9876543210');
    const day = page.locator('.cal-day:not(:disabled)').first();
    expectMinTouchTarget(await day.boundingBox());
    await day.click();
    const slot = page.getByRole('button', { name: '12:30 pm' });
    expectMinTouchTarget(await slot.boundingBox());
    await slot.click();
    await expect(page.locator('[data-demo-summary]')).toHaveText(
      /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, 12:30 pm IST · 30 min$/,
    );

    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    const stored = await page.evaluate(() => localStorage.length + sessionStorage.length);
    await submit.click();
    await expect(page.getByText('Demo booking opens soon. Nothing was sent.')).toBeVisible();
    await expect(page.locator('#demo-name')).toHaveValue('Asha');
    await page.waitForTimeout(300);
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(stored);
    await expect(page.getByText(/booked|see you/i)).toHaveCount(0);
  });
});

test.describe('320px phone', () => {
  test.use({ viewport: { width: 320, height: 640 } });
  test.skip(({ isMobile }) => !isMobile, 'phone flows');

  test('demo: every day, slot and arrow is 44x44 with no sideways scroll', async ({ page }) => {
    await page.goto('/demo');
    const days = page.locator('.cal-day');
    await expect(days.first()).toBeVisible();
    const boxes = await days.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, left: r.left, right: r.right };
      }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(28);
    for (const box of boxes) {
      expectMinTouchTarget(box);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(320);
    }
    for (const name of ['Previous month', 'Next month']) {
      expectMinTouchTarget(await page.getByRole('button', { name }).boundingBox());
    }
    await page.locator('.cal-day:not(:disabled)').first().click();
    for (const slot of await page.locator('.slot').all()) {
      expectMinTouchTarget(await slot.boundingBox());
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  });
});

test.describe('desktop: one thing per screen @desktop', () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    test.describe(`${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport });
      test.skip(({ isMobile }) => isMobile, 'desktop only');

      test('hero, cards and benefits each fit the screen; full-width blocks', async ({ page }) => {
        await serveHome(page);
        await page.goto('/');
        await page.evaluate(() => document.fonts.ready);
        const m = await page.evaluate(() => {
          const header = document.querySelector('.home .top')?.getBoundingClientRect().height ?? 0;
          const screen = window.innerHeight - header;
          const rect = (el: Element | null) => el?.getBoundingClientRect() ?? null;
          const wrap = rect(document.querySelector('.home .hero .wrap'));
          const pad = wrap
            ? parseFloat(getComputedStyle(document.querySelector('.home .hero .wrap')!).paddingLeft)
            : 0;
          const content = (wrap?.width ?? 0) - 2 * pad;
          const heroParts = ['h1', '.lede', '.cta', '.note'].map((s) =>
            rect(document.querySelector(`.home .hero ${s}`)),
          );
          const heroTop = Math.min(...heroParts.map((r) => r?.top ?? 0));
          const heroBottom = Math.max(...heroParts.map((r) => r?.bottom ?? 0));
          const cards = [...document.querySelectorAll('.home .rail .card')].map((c) => {
            const r = c.getBoundingClientRect();
            return { w: r.width, h: r.height };
          });
          const benefits = [...document.querySelectorAll('.home .sb')].map(
            (b) => b.getBoundingClientRect().height,
          );
          return {
            screen,
            content,
            hero: heroBottom - heroTop,
            heroSection: rect(document.querySelector('.home .hero'))?.height ?? 0,
            cards,
            benefits,
            scrollWidth: document.documentElement.scrollWidth,
            vw: window.innerWidth,
          };
        });
        expect(m.scrollWidth).toBe(m.vw);
        // The feature arrows (desktop only) are 44x44.
        for (const name of ['Previous feature', 'Next feature']) {
          const arrow = page.getByRole('button', { name });
          await expect(arrow).toBeVisible();
          expectMinTouchTarget(await arrow.boundingBox());
        }
        expect(m.hero).toBeLessThanOrEqual(m.screen);
        expect(m.heroSection).toBeLessThanOrEqual(m.screen);
        expect(m.cards).toHaveLength(5);
        for (const card of m.cards) {
          expect(card.h).toBeLessThanOrEqual(m.screen);
          // A card is 75% of the screen, so part of the next card shows.
          expect(Math.abs(card.w - m.vw * 0.75)).toBeLessThanOrEqual(1);
        }
        expect(m.content).toBeGreaterThan(m.vw * 0.75);
        const peek = await page.evaluate(() => {
          const cards = document.querySelectorAll('.home .rail .card');
          const first = cards[0]?.getBoundingClientRect();
          const second = cards[1]?.getBoundingClientRect();
          if (!first || !second) return null;
          return { firstRight: first.right, secondLeft: second.left };
        });
        expect(peek).not.toBeNull();
        expect(peek!.secondLeft).toBeLessThan(viewport.width - 100);
        // The clip fills its box: same edges, no gap on either side.
        const fit = await page.evaluate(() => {
          const box = document.querySelector('.home .rail .card .clipbox');
          const clip = box?.querySelector('video');
          if (!box || !clip) return null;
          const b = box.getBoundingClientRect();
          const c = clip.getBoundingClientRect();
          return Math.max(
            Math.abs(b.left - c.left),
            Math.abs(b.right - c.right),
            Math.abs(b.top - c.top),
            Math.abs(b.bottom - c.bottom),
          );
        });
        expect(fit).not.toBeNull();
        expect(fit!).toBeLessThanOrEqual(1);
        for (const height of m.benefits) expect(height).toBeLessThanOrEqual(m.screen);
        await expectAutoAdvance(page);
        // Desktop never nudges: the next card already shows.
        await page.waitForTimeout(3_600);
        await expect(page.locator('.home .rail.nudging')).toHaveCount(0);
      });

      test('demo fits beside its intro', async ({ page }) => {
        await page.goto('/demo');
        await expect(page.locator('.demo-form')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
          viewport.width,
        );
      });
    });
  }
});

// Zero flash on the REAL build. "/" ships prerendered homepage markup
// (scripts/prerender.ts); the inline head script in index.html must keep a
// signed-in visitor from ever seeing it: not one frame, and no light canvas in
// dark mode. This builds the app once (vite build + prerender, into its own
// folder) and serves that output the way Cloudflare Pages does (public/
// _redirects rewrites "/" to the prerendered page; files by path, then .html;
// anything else gets the empty shell). Every animation frame from before first
// paint records the DOM; screenshots stay off.

// Under node_modules/.cache so lint, format and git all skip it.
const BUILT = resolve('node_modules/.cache/srtd-first-paint-dist');
const ORIGIN = 'http://srtd.test';
const DARK = 'rgb(12, 13, 16)';
const LIGHT = 'rgb(247, 248, 249)';
const WHITE_CANVAS = 'rgb(255, 255, 255)';
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * A stored session the app accepts without a network call (Supabase reads it
 * from storage; it is not refreshed before expires_at), so the app routes the
 * visitor as signed in, the way production does.
 */
function signedIn(): Record<string, string> {
  const session = {
    access_token: 'e2e',
    refresh_token: 'e2e',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: '00000000-0000-0000-0000-000000000000', aud: 'authenticated' },
  };
  return { 'sb-e2e-auth-token': JSON.stringify(session) };
}

interface Frame {
  home: boolean;
  /** Prerendered homepage markup on screen (the app has not taken #root yet). */
  prerendered: boolean;
  rootChildren: number;
  bg: string;
}

/** The built file Pages would serve for a path (see public/_redirects). */
function builtFile(pathname: string): string {
  if (pathname === '/') return join(BUILT, 'prerender', 'home.html');
  const direct = join(BUILT, pathname);
  if (existsSync(direct) && extname(direct) !== '') return direct;
  if (existsSync(`${direct}.html`)) return `${direct}.html`;
  return join(BUILT, 'index.html');
}

async function serveBuild(page: Page): Promise<void> {
  // Only the built site answers; the app's own calls after boot go nowhere.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const file = builtFile(url.pathname);
    return route.fulfill({
      contentType: MIME[extname(file)] ?? 'application/octet-stream',
      body: readFileSync(file),
    });
  });
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
        prerendered: document.querySelector('#root[data-prerender="home"] .home') !== null,
        rootChildren: document.getElementById('root')?.childElementCount ?? -1,
        bg: getComputedStyle(document.documentElement).backgroundColor,
      });
      if (frames.length < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, storage);
}

async function framesOf(page: Page): Promise<Frame[]> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames.length))
    .toBeGreaterThanOrEqual(40);
  return page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
}

test.describe('prerendered "/" first paint, built output', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    test.setTimeout(300_000);
    // CI unset: the Sentry upload plugin is for the deploy build only.
    const env = {
      ...process.env,
      CI: '',
      VITE_SUPABASE_URL: 'https://e2e.supabase.test',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_000000000000',
    };
    const vite = resolve('node_modules/vite/bin/vite.js');
    execFileSync(
      process.execPath,
      [vite, 'build', '--outDir', BUILT, '--emptyOutDir', '--logLevel', 'warn'],
      {
        env,
        stdio: 'inherit',
      },
    );
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'scripts/prerender.ts', '--dist', BUILT],
      { env, stdio: 'inherit' },
    );
  });

  test('a signed-in dark-mode visitor never sees the homepage or a light frame', async ({
    page,
  }) => {
    await serveBuild(page);
    await recordFrames(page, { ...signedIn(), 'sorted-theme': 'dark' });
    await page.goto(`${ORIGIN}/`);
    for (const frame of await framesOf(page)) {
      expect(frame.home).toBe(false);
      expect(frame.bg).toBe(DARK);
    }
    await expect(page.locator('link[data-prerender-css]')).toHaveCount(0);
  });

  test('a signed-in light-mode visitor never sees the homepage', async ({ page }) => {
    await serveBuild(page);
    await recordFrames(page, signedIn());
    await page.goto(`${ORIGIN}/`);
    for (const frame of await framesOf(page)) {
      expect(frame.home).toBe(false);
      expect(frame.bg).toBe(LIGHT);
    }
  });

  test('an auth callback on "/" never shows the homepage', async ({ page }) => {
    await serveBuild(page);
    await recordFrames(page, {});
    await page.goto(`${ORIGIN}/?code=abc`);
    // The failed code exchange (no network here) leaves a guest, whom the app
    // itself then shows the homepage; the prerendered copy must never show.
    for (const frame of await framesOf(page)) expect(frame.prerendered).toBe(false);
  });

  test('a guest sees the homepage from first paint, on a white canvas', async ({ page }) => {
    await serveBuild(page);
    await recordFrames(page, { 'sorted-theme': 'dark' });
    await page.goto(`${ORIGIN}/`);
    // Any frame with markup in #root is the homepage; the canvas is white throughout.
    const frames = await framesOf(page);
    expect(frames.some((frame) => frame.home)).toBe(true);
    for (const frame of frames) {
      if (frame.rootChildren > 0) expect(frame.home).toBe(true);
      expect(frame.bg).toBe(WHITE_CANVAS);
    }
    await expect(page.getByRole('heading', { name: /Social media teams/ })).toBeVisible();
  });

  test('an app route gets the empty shell, dark from the first frame', async ({ page }) => {
    await serveBuild(page);
    await recordFrames(page, { ...signedIn(), 'sorted-theme': 'dark' });
    await page.goto(`${ORIGIN}/pipeline`);
    for (const frame of await framesOf(page)) {
      expect(frame.home).toBe(false);
      expect(frame.bg).toBe(DARK);
    }
  });
});
