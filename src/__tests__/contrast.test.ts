// Guard: every text token clears WCAG AA (4.5:1) on bg and panel in both
// themes, read straight from the hex tokens in src/index.css.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

function tokens(selector: string): Record<string, string> {
  // Top-level theme blocks only; the @layer base copies are indented.
  const escaped = selector.replace('.', '\\.');
  const block = new RegExp(`^${escaped} \\{([\\s\\S]*?)^\\}`, 'm').exec(css);
  if (block === null) throw new Error(`missing ${selector} block`);
  const out: Record<string, string> = {};
  for (const m of block[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = ['fg', 'fg-2', 'fg-3', 'accent-text', 'good', 'warn', 'bad'];
const SURFACES = ['bg', 'panel'];

describe.each([':root', '.dark'])('contrast: %s', (selector) => {
  const t = tokens(selector);
  for (const text of TEXT) {
    for (const surface of SURFACES) {
      it(`${text} on ${surface} is at least 4.5:1`, () => {
        expect(t[text], `--${text}`).toMatch(/^#/);
        expect(t[surface], `--${surface}`).toMatch(/^#/);
        expect(ratio(t[text], t[surface])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('white accent-fg on accent-fill is at least 4.5:1', () => {
    expect(ratio(t['accent-fg'], t['accent-fill'])).toBeGreaterThanOrEqual(4.5);
  });
});
