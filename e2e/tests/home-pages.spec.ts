import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Homepage, /pricing and /demo (home bundle, light only). The harness keeps "/"
// as its smoke page, so "/" is served the homepage fixture (home.html) here.
// /pricing and /demo route to HomeEntry in the harness itself. Every project
// emulates its colour scheme; iphone-webkit is dark, so "stays light" is
// checked on a dark-mode device. Linux WebKit approximates iOS WebKit.

const FEATURE_KEYS = ['chat', 'plan', 'pipeline', 'assets', 'briefs'] as const;
const WHITE = 'rgb(255, 255, 255)';

/** Serve the homepage fixture for "/" (any hash), like the guest path boots it. */
async function serveHome(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const fixture = new URL('/home.html', route.request().url()).toString();
      const response = await route.fetch({ url: fixture });
      await route.fulfill({ response });
    },
  );
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
    await expect(hero.getByText('WhatsApp goes back to being WhatsApp.')).toBeVisible();
    await expect(hero.getByRole('heading', { level: 1 })).toHaveText(
      'Social media agencies hate WhatsApp.',
    );
    await expect(
      hero.getByText(
        'Approvals, feedback and files get buried in group chats that never switch off. Sorted gives each client one workspace where every approval stays on record.',
      ),
    ).toBeVisible();
    await expect(page.getByText('The three jobs WhatsApp was never built to do.')).toBeVisible();
    await expectLight(page);
    // No mailto left: every Book a demo is /demo.
    expect(await page.locator('a[href^="mailto:"]').count()).toBe(0);
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

  test('from /pricing a tile loads the homepage on that card', async ({ page }) => {
    await serveHome(page);
    for (const key of ['plan', 'briefs'] as const) {
      await page.goto('/pricing');
      await tapTile(page, key);
      await page.waitForURL(`**/#feature-${key}`);
      await expectCardInView(page, key);
    }
  });

  test('sidebar: Pricing and Book a demo rows, stories are not links', async ({ page }) => {
    await serveHome(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const menu = page.locator('#home-menu');
    const pricing = menu.getByRole('link', { name: /Pricing/ });
    await expect(pricing).toHaveAttribute('href', '/pricing');
    await expect(pricing).toContainText('from ₹499');
    await expect(menu.getByRole('link', { name: /Book a demo/ })).toHaveAttribute('href', '/demo');
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

  test('/pricing and /demo load directly and from links; Back to home', async ({ page }) => {
    await serveHome(page);
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'One price per client. Clients are free.',
    );
    await expectLight(page);
    await expect(page.locator('.plan')).toHaveCount(4);
    for (const cta of await page.locator('.plan .btn').all()) {
      expectMinTouchTarget(await cta.boundingBox());
    }

    // From the homepage menu to /pricing, then the Enterprise card to /demo.
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page
      .locator('#home-menu')
      .getByRole('link', { name: /Pricing/ })
      .click();
    await page.waitForURL('**/pricing');
    await page
      .locator('[data-plan="Enterprise"]')
      .getByRole('link', { name: 'Book a demo' })
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
          const heroParts = ['.top-line', 'h1', '.lede', '.cta', '.note'].map((s) =>
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
        expect(m.hero).toBeLessThanOrEqual(m.screen);
        expect(m.heroSection).toBeLessThanOrEqual(m.screen + 1);
        expect(m.cards).toHaveLength(5);
        for (const card of m.cards) {
          expect(card.h).toBeLessThanOrEqual(m.screen);
          // One card per screen: the rail card takes the full content width.
          expect(Math.abs(card.w - m.content)).toBeLessThanOrEqual(1);
        }
        for (const height of m.benefits) expect(height).toBeLessThanOrEqual(m.screen);
      });

      test('pricing: four equal cards in one row; demo fits beside its intro', async ({ page }) => {
        await page.goto('/pricing');
        await expect(page.locator('.plan')).toHaveCount(4);
        const boxes = await page.locator('.plan').evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), h: Math.round(r.height) };
          }),
        );
        expect(boxes).toHaveLength(4);
        expect(new Set(boxes.map((b) => b.top)).size).toBe(1);
        expect(new Set(boxes.map((b) => b.h)).size).toBe(1);
        await page.goto('/demo');
        await expect(page.locator('.demo-form')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
          viewport.width,
        );
      });
    });
  }
});
