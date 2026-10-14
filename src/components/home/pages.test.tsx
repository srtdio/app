// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANS } from './config';
import { DEMO_NOTICE } from './demo';
import DemoPage from './DemoPage';
import { FEATURES, FEATURE_KEYS, featureFromHash, featureId } from './features';
import { isHomeBundlePath } from './guest-path';
import { homePageFor } from './HomeEntry';
import HomePage from './HomePage';
import PricingPage from './PricingPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver; the clips never mount without a media base anyway.
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
  it('/pricing and /demo are home-bundle paths; nothing else is', () => {
    expect(isHomeBundlePath('/pricing')).toBe(true);
    expect(isHomeBundlePath('/demo')).toBe(true);
    for (const path of ['/', '/pipeline', '/pricing/x', '/stories', '/Demo']) {
      expect(isHomeBundlePath(path)).toBe(false);
    }
  });

  it('HomeEntry picks the page by path', () => {
    expect(homePageFor('/pricing')).toBe('pricing');
    expect(homePageFor('/demo')).toBe('demo');
    expect(homePageFor('/')).toBe('home');
  });
});

describe('homepage copy', () => {
  const html = renderToStaticMarkup(<HomePage />);

  it('the new hero and features lines are present, the old ones gone', () => {
    expect(html).not.toContain('top-line');
    expect(html).toContain('Social media agencies <em>hate WhatsApp.</em>');
    expect(html).toContain(
      'Approvals, feedback and files get buried in group chats that never switch off. Sorted gives each client one workspace, so WhatsApp goes back to being WhatsApp.',
    );
    expect(html).toContain('The three jobs WhatsApp was never built to do.');
    expect(html).not.toContain('block <em>your clients');
    expect(html).not.toContain('Each one replaces a habit');
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

  it('on /pricing and /demo the tiles load "/#feature-<key>"', () => {
    for (const html of [
      renderToStaticMarkup(<PricingPage />),
      renderToStaticMarkup(<DemoPage />),
    ]) {
      expect(attrs(html, /href="([^"]+)" data-feature-tile/g)).toEqual(
        FEATURE_KEYS.map((key) => `/#${featureId(key)}`),
      );
    }
  });

  it('reads a tile hash back to its key', () => {
    expect(featureFromHash('#feature-plan')).toBe('plan');
    expect(featureFromHash('#feature-nope')).toBeNull();
    expect(featureFromHash('#features')).toBeNull();
  });

  it('Pricing and Book a demo rows, once each; stories are not links or buttons', () => {
    const html = renderToStaticMarkup(<HomePage />);
    const nav = html.slice(html.indexOf('class="nav-main"'), html.indexOf('class="foot"'));
    expect(nav.match(/href="\/pricing"/g)).toHaveLength(1);
    expect(nav).toContain('from ₹499');
    expect(nav.match(/href="\/demo"/g)).toHaveLength(1);
    const stories = nav.slice(nav.indexOf('class="stories"'));
    expect(stories).not.toMatch(/<a\b|<button\b|tabindex|role="link"|role="button"/);
    expect(stories.match(/Coming soon/g)).toHaveLength(3);
    expect(stories).toContain('Why every agency has a file called final_FINAL_v3');
    expect(html).not.toContain('/stories');
  });
});

describe('/pricing', () => {
  it('renders one card per plan from the config, with its CTA', () => {
    const html = renderToStaticMarkup(<PricingPage />);
    expect(attrs(html, /data-plan="([^"]+)"/g)).toEqual(PLANS.map((p) => p.name));
    for (const plan of PLANS) {
      expect(html).toContain(plan.price);
      expect(html).toContain(`href="${plan.cta.href}">${plan.cta.label}</a>`);
    }
    expect(html).toContain('One price per client. Clients are free.');
    expect(html).toContain('href="/">');
    expect(html).toContain('Back to home');
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

  it('a valid submit sends nothing, stores nothing, logs nothing, and shows the notice', async () => {
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: beacon });
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );

    const host = await mountDemo();
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
    await act(async () => {
      host.querySelector('form')?.requestSubmit();
    });

    expect(host.querySelector('[role="status"].notice')?.textContent).toBe(DEMO_NOTICE);
    expect(host.querySelectorAll('.err')).toHaveLength(0);
    // The form stays, filled in; never a "booked" message.
    expect(host.querySelector('form')).not.toBeNull();
    expect(input('demo-name').value).toBe('Asha');
    expect(host.textContent).not.toMatch(/booked|see you/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
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
