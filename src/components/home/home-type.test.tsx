// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import DemoPage from './DemoPage';
import HomePage from './HomePage';
import { NBSP, keepLastWords } from './no-orphan';

// Homepage and /demo type (13 Nov 2026): Montserrat only (800 headlines, 600
// sub-headlines and labels, 400 body, 600 buttons), black and white text only,
// and no word alone on a last line. The e2e twin (home-pages.spec.ts) measures
// the rendered lines at phone, tablet and laptop widths.

vi.mock('@/lib/fetch', () => ({ fetchWithTrace: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://db.test/', VITE_SUPABASE_PUBLISHABLE_KEY: 'publishable-key' },
}));
vi.mock('./media', () => ({ HOME_MEDIA_BASE: null, clipFor: () => null, mediaUrl: () => null }));

const css = readFileSync(join(process.cwd(), 'src/components/home/home.css'), 'utf8');
/** home.css without comments. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Each `selector { body }` block of home.css, media queries flattened. */
function blocks(): { selector: string; body: string }[] {
  return [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? '').trim(),
    body: m[2] ?? '',
  }));
}

describe('keepLastWords', () => {
  it('joins the last two words with a no-break space', () => {
    expect(keepLastWords('Chat. Plan. Approve.')).toBe(`Chat. Plan.${NBSP}Approve.`);
    expect(keepLastWords('Weekdays, 10:30 am and 3:30 pm.')).toBe(
      `Weekdays, 10:30 am and 3:30${NBSP}pm.`,
    );
  });

  it('leaves a single word alone and drops trailing space', () => {
    expect(keepLastWords('Approvals')).toBe('Approvals');
    expect(keepLastWords('two words ')).toBe(`two${NBSP}words`);
  });
});

describe('home.css type', () => {
  it('uses Montserrat only, self-hosted', () => {
    expect(rules).not.toMatch(/Bricolage|JetBrains|'Inter'|fonts\.googleapis|fonts\.gstatic/);
    expect(rules).toContain("font-family: 'Montserrat Variable';");
    expect(rules).toContain('@fontsource-variable/montserrat/files/montserrat-latin-wght-normal');
    expect(rules).toMatch(/--sans: var\(--display\);/);
    expect(rules).toMatch(/--mono: var\(--display\);/);
  });

  it('weights by role: 800 headlines, 600 sub-headlines and buttons, 400 body', () => {
    const weight = (selector: string): string | undefined => {
      const block = blocks().find((b) => b.selector === selector);
      return /font(?:-weight)?:\s*(\d00)/.exec(block?.body ?? '')?.[1];
    };
    expect(weight('.home .d')).toBe('800');
    expect(weight('.home .card h3')).toBe('600');
    expect(weight('.home .sb h3')).toBe('600');
    expect(weight('.home .btn')).toBe('600');
    expect(weight('.home .card .k')).toBe('600');
    expect(weight('.home .sb .kick')).toBe('600');
    expect(rules).not.toMatch(/font-variation-settings/);
    for (const { selector, body } of blocks()) {
      if (selector === '@font-face') continue;
      expect(body).not.toMatch(/font(?:-weight)?:\s*(?:100|200|300|700|900)\b/);
    }
  });

  it('text is black or white: no grey text outside disabled days and the placeholder', () => {
    const allowed = new Set([
      '.home .cal-day:disabled',
      '.home .cal-out',
      '.home .band input::placeholder',
    ]);
    for (const { selector, body } of blocks()) {
      if (allowed.has(selector)) continue;
      expect(`${selector} ${body}`).not.toMatch(
        /(?:^|\s)color:\s*(?:var\(--(?:fg-2|fg-3|band-muted)\)|#8a8f98)/m,
      );
    }
    for (let i = 1; i <= 5; i += 1) expect(rules).toContain(`--t${i}-ink: #08090a;`);
  });
});

/** Text of every heading and paragraph-like element in a static render. */
function lines(html: string): { tag: string; text: string }[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [
    ...doc.querySelectorAll('h1, h2, h3, p, small, .points li, .note, .proof, .story .title'),
  ].map((el) => ({ tag: el.tagName, text: (el.textContent ?? '').trim() }));
}

describe('no word alone on a last line', () => {
  it('every multi-word line on the homepage and /demo ends with two joined words', () => {
    for (const html of [renderToStaticMarkup(<HomePage />), renderToStaticMarkup(<DemoPage />)]) {
      const found = lines(html).filter(({ text }) => /\s/.test(text));
      expect(found.length).toBeGreaterThan(10);
      for (const { tag, text } of found) {
        // The hero headline keeps "WhatsApp." alone on its line by design.
        if (text.startsWith('Social media teams')) continue;
        expect(`${tag}: ${text}`).toMatch(new RegExp(`${NBSP}\\S+$`, 'u'));
      }
    }
  });
});
