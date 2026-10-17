// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DemoPage from './DemoPage';
import { FEATURES, FEATURE_KEYS, featureFromHash, featureId } from './features';
import { isHomeBundlePath } from './guest-path';
import { homePageFor } from './HomeEntry';
import HomePage from './HomePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver; the clips never mount without a media base anyway.
const send = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
}));
vi.mock('@/lib/fetch', () => ({ fetchWithTrace: send.fetch }));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://db.test/', VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key' },
}));

vi.mock('./media', () => ({
  HOME_MEDIA_BASE: null,
  clipFor: () => null,
  mediaUrl: () => null,
}));

function attrs(html: string, selector: RegExp): string[] {
  return [...html.matchAll(selector)].map((m) => m[1] ?? '');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('routes', () => {
  it('/demo is the only home-bundle path', () => {
    expect(isHomeBundlePath('/demo')).toBe(true);
    for (const path of ['/', '/pipeline', '/pricing', '/stories', '/Demo']) {
      expect(isHomeBundlePath(path)).toBe(false);
    }
  });

  it('HomeEntry picks the page by path', () => {
    expect(homePageFor('/demo')).toBe('demo');
    expect(homePageFor('/')).toBe('home');
  });

  it('/pricing is no page of its own, and no home page shows a price or a trial', () => {
    expect(homePageFor('/pricing')).toBe('home');
    for (const html of [renderToStaticMarkup(<HomePage />), renderToStaticMarkup(<DemoPage />)]) {
      expect(html).not.toContain('₹');
      expect(html).not.toContain('15 days');
      expect(html).not.toContain('/pricing');
    }
  });
});

describe('homepage copy', () => {
  const html = renderToStaticMarkup(<HomePage />);

  it('the new hero and features lines are present, the old ones gone', () => {
    expect(html).not.toContain('top-line');
    expect(html).toContain('Social media teams <em>hate WhatsApp.</em>');
    expect(html).toContain(
      'Approvals, feedback and files get buried in group chats that never switch off. Sorted gives each client one workspace, so WhatsApp goes back to being WhatsApp.',
    );
    expect(html).toContain('The three jobs WhatsApp was never built to do.');
    expect(html).not.toContain('block <em>your clients');
    expect(html).not.toContain('Each one replaces a habit');
  });

  it('the signup band apostrophe renders as an apostrophe, not a raw entity', () => {
    expect(html).toContain('You&#x27;ve scrolled this far. Might as well sign up.');
    expect(html).not.toContain('&amp;pos;');
  });

  it('hero, signup band and closing section each carry their own line; no 15-day line', () => {
    expect(html).toContain('Work chat that stays out of the WhatsApp group.');
    expect(html).toContain('Free. Faster than finding that one voice note.');
    expect(html).toContain('Made for people who’ve typed “any update?” too many times.');
    expect(html).not.toContain('15 days free');
  });

  it('every Book a demo goes to /demo; no mailto is left', () => {
    expect(html).not.toContain('mailto:');
    expect(html).toContain('href="/demo"');
  });
});

describe('sidebar', () => {
  it('every tile targets exactly one feature card, from the same key list', () => {
    const html = renderToStaticMarkup(<HomePage />);
    const cardIds = attrs(html, /<article id="([^"]+)"/g);
    const tiles = attrs(html, /href="([^"]+)" data-feature-tile/g);
    expect(cardIds).toEqual(FEATURE_KEYS.map(featureId));
    expect(tiles).toEqual(cardIds.map((id) => `#${id}`));
    expect(FEATURES.map((f) => f.key)).toEqual([...FEATURE_KEYS]);
  });

  it('on /demo the tiles load "/#feature-<key>"', () => {
    const html = renderToStaticMarkup(<DemoPage />);
    expect(attrs(html, /href="([^"]+)" data-feature-tile/g)).toEqual(
      FEATURE_KEYS.map((key) => `/#${featureId(key)}`),
    );
  });

  it('reads a tile hash back to its key', () => {
    expect(featureFromHash('#feature-plan')).toBe('plan');
    expect(featureFromHash('#feature-nope')).toBeNull();
    expect(featureFromHash('#features')).toBeNull();
  });

  it('no section labels; one Book a demo row and no Pricing row; stories are not links', () => {
    const html = renderToStaticMarkup(<HomePage />);
    const panel = html.slice(html.indexOf('class="panel"'), html.indexOf('class="foot"'));
    expect(panel).not.toContain('class="lbl');
    for (const word of ['>Product<', '>Company<', '>Stories<']) expect(panel).not.toContain(word);
    const nav = panel.slice(panel.indexOf('class="nav-main"'));
    expect(nav).not.toContain('Pricing');
    expect(nav.match(/href="\/demo"/g)).toHaveLength(1);
    const stories = nav.slice(nav.indexOf('class="stories"'));
    expect(stories).not.toMatch(/<a\b|<button\b|tabindex|role="link"|role="button"/);
    expect(stories.match(/Coming soon/g)).toHaveLength(3);
    expect(stories).toContain('Why every agency has a file called final_FINAL_v3');
    expect(html).not.toContain('/stories');
  });
});

describe('/demo', () => {
  async function mountDemo(): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<DemoPage />);
    });
    return host;
  }

  function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('an empty submit shows every error and focuses the first', async () => {
    const host = await mountDemo();
    await act(async () => {
      host.querySelector('form')?.requestSubmit();
    });
    const errors = Array.from(host.querySelectorAll('.err')).map((e) => e.textContent);
    expect(errors).toEqual([
      'Enter your name.',
      'Enter an email like you@agency.com.',
      'Enter a 10 digit mobile number.',
      'Pick a day for the call.',
      'Pick a time for the call.',
    ]);
    expect(document.activeElement?.id).toBe('demo-name');
  });

  async function fillValid(host: HTMLElement): Promise<HTMLInputElement> {
    const input = (id: string): HTMLInputElement =>
      host.querySelector<HTMLInputElement>(`#${id}`) as HTMLInputElement;
    await act(async () => {
      type(input('demo-name'), 'Asha');
      type(input('demo-email'), 'you@agency.com');
      type(input('demo-mobile'), '98765 43210');
    });
    expect(input('demo-mobile').value).toBe('9876543210');
    const firstDay = host.querySelector<HTMLButtonElement>('.cal-day:not(:disabled)');
    await act(async () => {
      firstDay?.click();
    });
    const slot = host.querySelector<HTMLButtonElement>('.slot');
    await act(async () => {
      slot?.click();
    });
    expect(host.querySelector('[data-demo-summary]')?.textContent).toMatch(
      /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, 11:00 am IST · 30 min$/,
    );
    return input('demo-name');
  }

  it('a valid submit posts the request and shows Booked in place of the form', async () => {
    send.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const host = await mountDemo();
    await fillValid(host);
    const summary = host.querySelector('[data-demo-summary]')?.textContent ?? '';
    const shown = summary.slice(0, summary.indexOf(','));
    await act(async () => {
      host.querySelector('form')?.requestSubmit();
    });

    expect(send.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = send.fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://db.test/functions/v1/demo-request-send');
    expect(new Headers(init?.headers).get('apikey')).toBe('publishable-key');
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(body).toMatchObject({
      name: 'Asha',
      email: 'you@agency.com',
      mobile: '9876543210',
      slot: '11:00 am',
      website: '',
    });
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(host.querySelector('form')).toBeNull();
    const booked = host.querySelector('[data-demo-booked]');
    expect(booked?.querySelector('h2')?.textContent).toBe('Booked');
    expect(booked?.querySelector('p')?.textContent).toBe(
      `${shown} · 11:00 am IST. The team sends a Google Meet link to your email before the call.`,
    );
    expect(booked?.querySelector('a')?.getAttribute('href')).toBe('/');
    expect(booked?.querySelector('a')?.textContent).toBe('Back to home');
    expect(host.textContent).not.toMatch(/opens soon/i);
  });

  it('a failed send keeps the form, shows the error and re-enables the button', async () => {
    send.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'send_failed' } }), { status: 502 }),
    );
    const host = await mountDemo();
    const name = await fillValid(host);
    await act(async () => {
      host.querySelector('form')?.requestSubmit();
    });
    expect(host.querySelector('[role="alert"].err')?.textContent).toBe("Couldn't send. Try again.");
    expect(host.querySelector('form')).not.toBeNull();
    expect(name.value).toBe('Asha');
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    expect(host.textContent).not.toMatch(/booked/i);
  });

  it('the honeypot is hidden from people and sent as website', async () => {
    const host = await mountDemo();
    const trap = host.querySelector<HTMLInputElement>('input[name="website"]');
    expect(trap?.getAttribute('aria-hidden')).toBe('true');
    expect(trap?.tabIndex).toBe(-1);
    expect(trap?.getAttribute('autocomplete')).toBe('off');
  });

  it('slots wait for a day; weekends and today are not pickable', async () => {
    const host = await mountDemo();
    expect(host.textContent).toContain('Pick a time (IST, 30 min)');
    expect(host.textContent).toContain('Choose a day first. Weekdays only.');
    expect(host.querySelector('.slot')).toBeNull();
    const today = host.querySelector<HTMLButtonElement>('[aria-current="date"]');
    if (today !== null) expect(today.disabled).toBe(true);
  });
});

describe('copy rules', () => {
  it('no em-dashes in the home pages', () => {
    const dir = join(process.cwd(), 'src/components/home');
    for (const file of readdirSync(dir).filter((f) => /\.(tsx?|css)$/.test(f))) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src, file).not.toContain('—');
    }
  });
});
