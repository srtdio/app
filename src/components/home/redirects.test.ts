import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// public/_redirects is read by Cloudflare Pages top to bottom; the first match wins.
const lines = readFileSync(join(process.cwd(), 'public/_redirects'), 'utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/).join(' '))
  .filter((line) => line !== '' && !line.startsWith('#'));

describe('public/_redirects', () => {
  it('/pricing and /pricing/ go to / with a 301, above the "/" rewrite', () => {
    const rewrite = lines.indexOf('/ /prerender/home 200');
    expect(rewrite).toBeGreaterThanOrEqual(0);
    for (const rule of ['/pricing / 301', '/pricing/ / 301']) {
      const at = lines.indexOf(rule);
      expect(at, rule).toBeGreaterThanOrEqual(0);
      expect(at, rule).toBeLessThan(rewrite);
    }
  });

  it('has no SPA catch-all: Pages ignores it, and its own fallback serves the shell', () => {
    expect(lines.some((line) => line.startsWith('/* '))).toBe(false);
    expect(lines).toHaveLength(3);
  });
});
