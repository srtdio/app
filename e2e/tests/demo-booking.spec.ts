import { expect, test, type Page, type Request } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';

// /demo (the home bundle, which the harness mounts itself): a valid booking
// POSTs to the demo-request-send edge function and, on { ok: true }, the form
// gives way to Booked; a failed send keeps the form with an inline error;
// invalid fields send nothing. The home bundle is light only, so the dark
// project checks it stays light too. Tagged @theme. Linux WebKit approximates
// iOS WebKit; it is not iOS.

const FUNCTION_URL = '**/functions/v1/demo-request-send';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
};

interface DemoNet {
  posts: Array<Record<string, unknown>>;
  blocked: string[];
}

/** Answer demo-request-send with `status`/`body`; block every other non-localhost request. */
async function routeDemo(page: Page, status: number, body: unknown): Promise<DemoNet> {
  const net: DemoNet = { posts: [], blocked: [] };
  await page.route(/^(?!https?:\/\/localhost[:/]|blob:|data:)/, async (route) => {
    net.blocked.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route(FUNCTION_URL, async (route) => {
    const request: Request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    net.posts.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
    await route.fulfill({
      status,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  });
  return net;
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

/** Fill valid fields; returns the chosen day's short label ("Mon 19 Oct") and slot. */
async function fillValid(page: Page): Promise<{ day: string; iso: string; slot: string }> {
  await page.locator('#demo-name').fill('Asha');
  await page.locator('#demo-email').fill('you@agency.com');
  await page.locator('#demo-mobile').fill('9876543210');
  const day = page.locator('.cal-day:not(:disabled)').first();
  expectMinTouchTarget(await day.boundingBox());
  const dataDay = (await day.getAttribute('data-day')) ?? '';
  await day.click();
  const slot = '12:30 pm';
  const slotButton = page.getByRole('button', { name: slot });
  expectMinTouchTarget(await slotButton.boundingBox());
  await slotButton.click();
  const summary = (await page.locator('[data-demo-summary]').textContent()) ?? '';
  const short = /^([A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}),/.exec(summary)?.[1] ?? '';
  expect(short).not.toBe('');
  const [y, m, d] = dataDay.split('-').map(Number);
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { day: short, iso, slot };
}

async function expectLight(page: Page): Promise<void> {
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(255, 255, 255)',
  );
}

interface CtaStyle {
  height: number;
  radius: string;
  bg: string;
  fg: string;
  accentFill: string;
}

/** The CTA's painted box and colours, and the app accent fill token resolved on <html>. */
async function ctaStyle(page: Page, selector: string): Promise<CtaStyle> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no CTA at ${sel}`);
    const style = getComputedStyle(el);
    // Resolve the token through a probe so hex and rgb() compare as one format.
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--accent-fill)';
    el.parentElement!.appendChild(probe);
    const accentFill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      height: el.getBoundingClientRect().height,
      radius: style.borderTopLeftRadius,
      bg: style.backgroundColor,
      fg: style.color,
      accentFill,
    };
  }, selector);
}

/** WCAG 2 contrast ratio of two opaque rgb() colours. */
function contrast(a: string, b: string): number {
  const lum = (rgb: string): number => {
    const [r, g, bl] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Same Button as the app's primary (in-app New post): accent fill, 44 tall, 8px radius. */
async function expectAppPrimary(page: Page, selector: string): Promise<void> {
  const cta = await ctaStyle(page, selector);
  expect(cta.height).toBe(44);
  expect(cta.radius).toBe('8px');
  expect(cta.accentFill).not.toBe('rgba(0, 0, 0, 0)');
  expect(cta.bg).toBe(cta.accentFill);
  expect(contrast(cta.fg, cta.bg)).toBeGreaterThanOrEqual(4.5);
}

test('the Book my demo CTA is the app primary button @theme', async ({ page }) => {
  await page.goto('/demo');
  await expect(page.getByRole('button', { name: 'Book my demo' })).toBeVisible();
  await expectAppPrimary(page, '.home .demo-form .btn');
});

test('valid booking sends the request and shows Booked @theme', async ({ page }) => {
  const errors = watchConsole(page);
  const net = await routeDemo(page, 200, { ok: true });
  await page.goto('/demo');
  await expect(page.getByRole('button', { name: 'Book my demo' })).toBeVisible();
  await expectLight(page);

  // The honeypot is off screen, out of the tab order and hidden from AT.
  const honeypot = page.locator('input[name="website"]');
  await expect(honeypot).toHaveAttribute('tabindex', '-1');
  await expect(honeypot).toHaveAttribute('aria-hidden', 'true');
  // Clipped to nothing (its layout box is the input's padding, so Playwright's
  // box-based toBeVisible would call it visible): nothing paints or hits there.
  const hp = await honeypot.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { position: style.position, clip: style.clip, hit: hit === el };
  });
  expect(hp.position).toBe('absolute');
  expect(hp.clip.replace(/,/g, '')).toBe('rect(0px 0px 0px 0px)');
  expect(hp.hit).toBe(false);

  const { day, iso, slot } = await fillValid(page);
  const submit = page.getByRole('button', { name: 'Book my demo' });
  expectMinTouchTarget(await submit.boundingBox());
  await submit.click();

  const booked = page.getByRole('heading', { name: 'Booked' });
  await expect(booked).toBeVisible();
  await expect(booked).toBeFocused();
  await expect(page.locator('[data-demo-booked] .notice')).toHaveText(
    `${day} · ${slot} IST. The team sends a Google Meet link to your email before the call.`,
  );
  const back = page.locator('[data-demo-booked]').getByRole('link', { name: 'Back to home' });
  await expect(back).toHaveAttribute('href', '/');
  expectMinTouchTarget(await back.boundingBox());

  expect(net.posts).toEqual([
    { name: 'Asha', email: 'you@agency.com', mobile: '9876543210', day: iso, slot, website: '' },
  ]);
  await expect(page.getByText(/opens soon/i)).toHaveCount(0);
  await expectLight(page);
  expect(net.blocked).toEqual([]);
  expect(errors).toEqual([]);
});

test('a 502 shows the inline error and re-enables the button', async ({ page }) => {
  const net = await routeDemo(page, 502, { error: 'send_failed' });
  await page.goto('/demo');
  await fillValid(page);
  const submit = page.getByRole('button', { name: 'Book my demo' });
  await submit.click();
  await expect(page.getByRole('alert')).toHaveText("Couldn't send. Try again.");
  await expect(submit).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Booked' })).toHaveCount(0);
  await expect(page.locator('#demo-name')).toHaveValue('Asha');
  expect(net.posts).toHaveLength(1);
  await expect(page.getByText(/opens soon/i)).toHaveCount(0);
  expect(net.blocked).toEqual([]);
});

test('invalid fields keep the validation and send nothing', async ({ page }) => {
  const net = await routeDemo(page, 200, { ok: true });
  await page.goto('/demo');
  const submit = page.getByRole('button', { name: 'Book my demo' });
  await submit.click();
  await expect(page.getByText('Enter your name.')).toBeVisible();
  await expect(page.getByText('Enter an email like you@agency.com.')).toBeVisible();
  await expect(page.getByText('Enter a 10 digit mobile number.')).toBeVisible();
  await expect(page.getByText('Pick a day for the call.')).toBeVisible();
  await expect(page.locator('#demo-name')).toBeFocused();

  // Fix all but the email: still nothing sent, email takes focus.
  await page.locator('#demo-name').fill('Asha');
  await page.locator('#demo-email').fill('not-an-email');
  await page.locator('#demo-mobile').fill('9876543210');
  await page.locator('.cal-day:not(:disabled)').first().click();
  await page.getByRole('button', { name: '12:30 pm' }).click();
  await submit.click();
  await expect(page.getByText('Enter an email like you@agency.com.')).toBeVisible();
  await expect(page.locator('#demo-email')).toBeFocused();
  await expect(page.getByText('Enter your name.')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Booked' })).toHaveCount(0);
  expect(net.posts).toEqual([]);
  await expect(page.getByText(/opens soon/i)).toHaveCount(0);
});
