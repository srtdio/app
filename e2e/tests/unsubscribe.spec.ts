import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { HARNESS_SUPABASE_URL } from '../harness/stubs/env';
import { expectMinTouchTarget } from '../helpers/touch-target';

// The public /unsubscribe page a catch-up email links to. It reads the person's
// catch-up subscription with GET ?u&t and changes it only on a tap (POST). The
// edge function is mocked here; nothing reaches a real host. Runs on the iPhone
// 13 viewport (dark); the main state tests are tagged @theme so they also run
// in light, and one @desktop test checks the laptop layout.

const FN_GLOB = '**/functions/v1/catchup-unsubscribe**';
const U = '0192f7a4-3c1e-7b2a-9d4e-5f6a7b8c9d0e';
const T = 'tok_harness_unsubscribe_abc123';
const PAGE_URL = `/unsubscribe?u=${U}&t=${T}`;
// The first visit in a worker compiles the whole app in the harness Vite server
// (about 18s cold), so the first resolved state gets extra headroom.
const READY_TIMEOUT = 30_000;

const COPY = {
  subscribedHeading: 'Stop catch-up emails?',
  subscribedBody:
    "You won't get catch-ups from any of your Sorted workspaces. Everything stays in Sorted; you'll just check it yourself.",
  subscribedSafety:
    'Invites, login links and password resets still arrive, so you never get locked out.',
  unsubscribeButton: 'Unsubscribe',
  keepLink: 'Keep getting catch-ups',
  noLogin: 'No login needed.',
  unsubscribedHeading: "You're unsubscribed",
  unsubscribedBody: 'No more catch-up emails from any Sorted workspace, starting now.',
  unsubscribedLater:
    "Changed your mind later? Tap Unsubscribe in any old catch-up email and you'll land here to turn them back on.",
  resubscribeButton: 'Turn catch-ups back on',
  unsubscribedSafety: 'Invites, login links and password resets still arrive.',
  invalid: "This link isn't valid.",
} as const;

type PostBody = { u?: unknown; t?: unknown; action?: unknown };

interface FnMock {
  gets: URL[];
  posts: PostBody[];
}

interface FnOptions {
  /** The subscription state GET reports; null answers 404 (bad token). */
  subscribed: boolean | null;
  /** Hold the GET response this long (ms). */
  getDelayMs?: number;
}

function corsHeaders(request: Request): Record<string, string> {
  const headers = request.headers();
  return {
    'access-control-allow-origin': headers['origin'] ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers':
      headers['access-control-request-headers'] ??
      'authorization, x-client-info, apikey, content-type, x-trace-id',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(route.request()),
    body: JSON.stringify(body),
  });
}

/**
 * Mock the catch-up unsubscribe edge function. Any other request to the stub
 * Supabase host gets an empty 404, so nothing leaves the browser.
 */
async function mockFunction(page: Page, opts: FnOptions): Promise<FnMock> {
  const mock: FnMock = { gets: [], posts: [] };
  let subscribed = opts.subscribed;

  await page.route(`${HARNESS_SUPABASE_URL}/**`, (route) =>
    route.fulfill({ status: 404, headers: corsHeaders(route.request()), body: '' }),
  );
  await page.route(FN_GLOB, async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders(request), body: '' });
      return;
    }
    if (method === 'GET') {
      mock.gets.push(new URL(request.url()));
      if (opts.getDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, opts.getDelayMs));
      }
      if (subscribed === null) {
        await fulfillJson(route, 404, { error: 'not_found' });
        return;
      }
      await fulfillJson(route, 200, { subscribed });
      return;
    }
    if (method === 'POST') {
      const body = (request.postDataJSON() ?? {}) as PostBody;
      mock.posts.push(body);
      if (body.action === 'unsubscribe') subscribed = false;
      else if (body.action === 'resubscribe') subscribed = true;
      await fulfillJson(route, 200, { subscribed });
      return;
    }
    await fulfillJson(route, 405, { error: 'method_not_allowed' });
  });
  return mock;
}

function root(page: Page) {
  return page.getByTestId('unsubscribe-page');
}

async function expectSubscribedCopy(page: Page): Promise<void> {
  await expect(root(page)).toHaveAttribute('data-state', 'subscribed', { timeout: READY_TIMEOUT });
  await expect(
    page.getByRole('heading', { name: COPY.subscribedHeading, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(COPY.subscribedBody, { exact: true })).toBeVisible();
  await expect(page.getByText(COPY.subscribedSafety, { exact: true })).toBeVisible();
  await expect(page.getByText(COPY.noLogin, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: COPY.unsubscribeButton, exact: true }),
  ).toBeVisible();
  const keep = page.getByRole('link', { name: COPY.keepLink, exact: true });
  await expect(keep).toBeVisible();
  await expect(keep).toHaveAttribute('href', '/');
}

async function expectUnsubscribedCopy(page: Page): Promise<void> {
  await expect(root(page)).toHaveAttribute('data-state', 'unsubscribed', {
    timeout: READY_TIMEOUT,
  });
  await expect(
    page.getByRole('heading', { name: COPY.unsubscribedHeading, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(COPY.unsubscribedBody, { exact: true })).toBeVisible();
  await expect(page.getByText(COPY.unsubscribedLater, { exact: true })).toBeVisible();
  await expect(page.getByText(COPY.unsubscribedSafety, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: COPY.resubscribeButton, exact: true }),
  ).toBeVisible();
}

/** Heading text colour differs from the page background, and the theme class matches the project. */
async function expectThemeReadable(page: Page, headingName: string): Promise<void> {
  const dark = await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);

  const colors = await page
    .getByRole('heading', { name: headingName, exact: true })
    .evaluate((heading) => {
      const opaque = (c: string): boolean =>
        c !== '' && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)';
      let el: Element | null = heading;
      let bg = '';
      while (el !== null) {
        const c = getComputedStyle(el).backgroundColor;
        if (opaque(c)) {
          bg = c;
          break;
        }
        el = el.parentElement;
      }
      if (bg === '') bg = getComputedStyle(document.body).backgroundColor;
      return { fg: getComputedStyle(heading).color, bg };
    });
  expect(colors.fg).not.toBe(colors.bg);
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(dims.scrollWidth).toBeLessThanOrEqual(dims.clientWidth);
  expect(dims.bodyScrollWidth).toBeLessThanOrEqual(dims.clientWidth);
}

test('subscribed: opening the page only reads; tapping Unsubscribe posts and shows the unsubscribed state @theme', async ({
  page,
}) => {
  const mock = await mockFunction(page, { subscribed: true });
  await page.goto(PAGE_URL);

  await expectSubscribedCopy(page);
  expect(mock.gets.length).toBeGreaterThanOrEqual(1);
  const get = mock.gets[0]!;
  expect(get.searchParams.get('u')).toBe(U);
  expect(get.searchParams.get('t')).toBe(T);
  // Opening the link never unsubscribes by itself (mail scanners prefetch it).
  await page.waitForLoadState('networkidle');
  expect(mock.posts).toEqual([]);

  await expectThemeReadable(page, COPY.subscribedHeading);
  await noHorizontalScroll(page);

  await page.getByRole('button', { name: COPY.unsubscribeButton, exact: true }).click();
  await expectUnsubscribedCopy(page);
  expect(mock.posts).toEqual([{ u: U, t: T, action: 'unsubscribe' }]);
  await expect(page.getByRole('heading', { name: COPY.subscribedHeading })).toHaveCount(0);

  await expectThemeReadable(page, COPY.unsubscribedHeading);
  await noHorizontalScroll(page);
});

test('unsubscribed: Turn catch-ups back on posts resubscribe and returns to the subscribed state @theme', async ({
  page,
}) => {
  const mock = await mockFunction(page, { subscribed: false });
  await page.goto(PAGE_URL);

  await expectUnsubscribedCopy(page);
  await page.waitForLoadState('networkidle');
  expect(mock.posts).toEqual([]);

  await page.getByRole('button', { name: COPY.resubscribeButton, exact: true }).click();
  await expectSubscribedCopy(page);
  expect(mock.posts).toEqual([{ u: U, t: T, action: 'resubscribe' }]);
});

test('bad token: a 404 from the function shows the invalid link message @theme', async ({
  page,
}) => {
  const mock = await mockFunction(page, { subscribed: null });
  await page.goto(PAGE_URL);

  await expect(root(page)).toHaveAttribute('data-state', 'invalid', { timeout: READY_TIMEOUT });
  await expect(page.getByText(COPY.invalid, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: COPY.unsubscribeButton, exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: COPY.resubscribeButton, exact: true })).toHaveCount(
    0,
  );
  expect(mock.gets.length).toBeGreaterThanOrEqual(1);
  expect(mock.posts).toEqual([]);
});

test('missing u and t: invalid without calling the function', async ({ page }) => {
  const mock = await mockFunction(page, { subscribed: true });
  await page.goto('/unsubscribe');

  await expect(root(page)).toHaveAttribute('data-state', 'invalid', { timeout: READY_TIMEOUT });
  await expect(page.getByText(COPY.invalid, { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(mock.gets).toEqual([]);
  expect(mock.posts).toEqual([]);
});

test('only one of u or t: invalid without calling the function', async ({ page }) => {
  const mock = await mockFunction(page, { subscribed: true });
  await page.goto(`/unsubscribe?u=${U}`);

  await expect(root(page)).toHaveAttribute('data-state', 'invalid', { timeout: READY_TIMEOUT });
  await expect(page.getByText(COPY.invalid, { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(mock.gets).toEqual([]);
  expect(mock.posts).toEqual([]);
});

test('touch targets: Unsubscribe, Keep getting catch-ups and Turn catch-ups back on are at least 44px', async ({
  page,
}) => {
  await mockFunction(page, { subscribed: true });
  await page.goto(PAGE_URL);
  await expectSubscribedCopy(page);

  expectMinTouchTarget(
    await page.getByRole('button', { name: COPY.unsubscribeButton, exact: true }).boundingBox(),
  );
  expectMinTouchTarget(
    await page.getByRole('link', { name: COPY.keepLink, exact: true }).boundingBox(),
  );

  await page.getByRole('button', { name: COPY.unsubscribeButton, exact: true }).click();
  await expectUnsubscribedCopy(page);
  expectMinTouchTarget(
    await page.getByRole('button', { name: COPY.resubscribeButton, exact: true }).boundingBox(),
  );
});

test('no flicker: while the GET is pending, no state copy and no data-state', async ({ page }) => {
  await mockFunction(page, { subscribed: true, getDelayMs: 1_500 });
  const getSeen = page.waitForRequest(
    (req) => req.url().includes('/functions/v1/catchup-unsubscribe') && req.method() === 'GET',
  );
  await page.goto(PAGE_URL);
  await getSeen;

  // The GET is in flight: the page must show neither state yet.
  await expect(root(page)).toBeAttached({ timeout: READY_TIMEOUT });
  for (let i = 0; i < 4; i += 1) {
    await expect(root(page)).not.toHaveAttribute('data-state', /.*/, { timeout: 100 });
    await expect(page.getByText(COPY.subscribedHeading, { exact: true })).toBeHidden({
      timeout: 100,
    });
    await expect(page.getByText(COPY.invalid, { exact: true })).toBeHidden({ timeout: 100 });
    await expect(page.getByText(COPY.unsubscribedHeading, { exact: true })).toBeHidden({
      timeout: 100,
    });
    await page.waitForTimeout(100);
  }

  await expectSubscribedCopy(page);
});

test('laptop: the subscribed card fits the viewport with no horizontal scroll @desktop', async ({
  page,
}) => {
  await mockFunction(page, { subscribed: true });
  await page.goto(PAGE_URL);
  await expectSubscribedCopy(page);

  await noHorizontalScroll(page);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const box = await root(page).boundingBox();
  expect(box).not.toBeNull();
  const heading = await page
    .getByRole('heading', { name: COPY.subscribedHeading, exact: true })
    .boundingBox();
  const button = await page
    .getByRole('button', { name: COPY.unsubscribeButton, exact: true })
    .boundingBox();
  for (const b of [heading, button]) {
    expect(b).not.toBeNull();
    expect(b!.x).toBeGreaterThanOrEqual(0);
    expect(b!.x + b!.width).toBeLessThanOrEqual(viewport!.width);
    expect(b!.y + b!.height).toBeLessThanOrEqual(viewport!.height);
  }
  // A readable card on a laptop, not a full-bleed phone column.
  expect(button!.width).toBeLessThan(viewport!.width);
});
