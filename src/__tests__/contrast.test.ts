// Guard: every text token clears WCAG AA (4.5:1) on bg, panel, panel-2 and
// panel-3 in both themes, read straight from the hex tokens in src/index.css.
// The stage inks (review, approved, rejected, parked) count as text: they are
// the stage chip and dot labels.

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
  for (const [, name, hex] of (block[1] ?? '').matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    if (name !== undefined && hex !== undefined) out[name] = hex;
  }
  return out;
}

function channel(hex: string, i: number): number {
  const c = parseInt(hex.slice(i, i + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

function ratio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function token(t: Record<string, string>, name: string): string {
  const hex = t[name];
  if (hex === undefined) throw new Error(`missing --${name}`);
  return hex;
}

const TEXT = [
  'fg',
  'fg-2',
  'fg-3',
  'accent-text',
  'good',
  'warn',
  'bad',
  'stage-review',
  'stage-approved',
  'stage-rejected',
  'stage-parked',
];
const SURFACES = ['bg', 'panel', 'panel-2', 'panel-3'];

describe.each([':root', '.dark'])('contrast: %s', (selector) => {
  const t = tokens(selector);
  for (const text of TEXT) {
    for (const surface of SURFACES) {
      it(`${text} on ${surface} is at least 4.5:1`, () => {
        expect(ratio(token(t, text), token(t, surface))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('white accent-fg on accent-fill is at least 4.5:1', () => {
    expect(ratio(token(t, 'accent-fg'), token(t, 'accent-fill'))).toBeGreaterThanOrEqual(4.5);
  });
});
