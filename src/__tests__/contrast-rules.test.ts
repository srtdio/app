// Guard: every field, edge, state and outline clears 3:1 and every text token
// 4.5:1, in light and dark, read straight from the theme blocks of
// src/index.css (WCAG 2.x relative luminance). Translucent tokens (the dark
// field line, the hover and press fills, the lit edges) are blended over the
// surface they sit on before the ratio is taken. contrast.test.ts keeps the
// older text pairs; this file adds the edges and states of "Visible and lit".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

type Rgba = { r: number; g: number; b: number; a: number };

/** The top-level theme block (`:root {` or `.dark {` at column 0), not the @layer copies. */
function block(selector: string): string {
  const escaped = selector.replace('.', '\\.');
  const hit = new RegExp(`^${escaped} \\{([\\s\\S]*?)^\\}`, 'm').exec(css);
  if (hit === null) throw new Error(`missing ${selector} block`);
  return hit[1] ?? '';
}

function parse(value: string): Rgba | null {
  const v = value.trim();
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (hex6 !== null) {
    const n = parseInt(hex6[1] ?? '0', 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(v);
  if (hex3 !== null) {
    const [r, g, b] = [...(hex3[1] ?? '000')].map((c) => parseInt(`${c}${c}`, 16));
    return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/.exec(v);
  if (rgba !== null) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return null;
}

/** Every colour token of a theme block (hex or rgba; var() and gradients are skipped). */
function tokens(selector: string): Record<string, Rgba> {
  const out: Record<string, Rgba> = {};
  for (const [, name, value] of block(selector).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    const colour = parse(value ?? '');
    if (name !== undefined && colour !== null) out[name] = colour;
  }
  return out;
}

/** `top` laid over an opaque `under` (source-over). */
function over(top: Rgba, under: Rgba): Rgba {
  const mix = (t: number, u: number): number => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG ratio of `fg` (blended over `bg` when translucent) against opaque `bg`. */
function ratio(fg: Rgba, bg: Rgba): number {
  const la = luminance(over(fg, bg));
  const lb = luminance(bg);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function pick(t: Record<string, Rgba>, name: string): Rgba {
  const c = t[name];
  if (c === undefined) throw new Error(`missing colour token --${name}`);
  return c;
}

/** The first colour stop of a gradient token (`linear-gradient(#fff, ...)`): its lit top. */
function gradientTop(selector: string, name: string): Rgba {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(block(selector))?.[1] ?? '';
  const stop = /linear-gradient\(\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))/.exec(value)?.[1];
  const colour = stop === undefined ? null : parse(stop);
  if (colour === null) throw new Error(`no gradient top for --${name} in ${selector}`);
  return colour;
}

const TEXT = [
  'fg',
  'fg-2',
  'fg-3',
  'good',
  'warn',
  'bad',
  'stage-review',
  'stage-approved',
  'stage-rejected',
  'stage-parked',
];
const TEXT_SURFACES = ['bg', 'panel', 'panel-2', 'panel-3'];
/** Field line, control edge and outline: 3:1 against every surface a control sits on. */
const EDGES = ['field-line', 'border-strong', 'sel-edge'];
const EDGE_SURFACES = ['bg', 'panel', 'panel-2'];

describe.each([':root', '.dark'])('contrast rules: %s', (selector) => {
  const t = tokens(selector);

  for (const text of TEXT) {
    for (const surface of TEXT_SURFACES) {
      it(`text: ${text} on ${surface} is at least 4.5:1`, () => {
        expect(ratio(pick(t, text), pick(t, surface))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  for (const edge of EDGES) {
    for (const surface of EDGE_SURFACES) {
      it(`edge: ${edge} on ${surface} is at least 3:1`, () => {
        expect(ratio(pick(t, edge), pick(t, surface))).toBeGreaterThanOrEqual(3);
      });
    }
  }

  // Hover keeps the light: the --hover-fill overlay must visibly move the
  // surface under it (a 1.1 luminance ratio is about the smallest step that
  // reads on a hovering pointer), on a plain panel and on the chip gradient.
  it('hover-fill over panel moves the luminance by at least 1.1', () => {
    const panel = pick(t, 'panel');
    expect(ratio(pick(t, 'hover-fill'), panel)).toBeGreaterThanOrEqual(1.1);
  });

  it('hover-fill over the chip gradient top moves the luminance by at least 1.1', () => {
    const top = gradientTop(selector, 'lit-chip-bg');
    expect(ratio(pick(t, 'hover-fill'), top)).toBeGreaterThanOrEqual(1.1);
  });

  it('press-fill is stronger than hover-fill (pressed reads past hovered)', () => {
    const panel = pick(t, 'panel');
    expect(ratio(pick(t, 'press-fill'), panel)).toBeGreaterThan(
      ratio(pick(t, 'hover-fill'), panel),
    );
  });

  // Disabled primary: bg-fg-3 under accent-fg ink, never opacity.
  it('disabled primary: accent-fg on fg-3 is at least 4.5:1', () => {
    expect(ratio(pick(t, 'accent-fg'), pick(t, 'fg-3'))).toBeGreaterThanOrEqual(4.5);
  });

  // The own bubble's faintest drawn line (unplayed voice bars, on-bubble/45).
  it('on-bubble at 45% on bubble-own is at least 3:1', () => {
    const faint = { ...pick(t, 'on-bubble'), a: 0.45 };
    expect(ratio(faint, pick(t, 'bubble-own'))).toBeGreaterThanOrEqual(3);
  });

  it('on-bubble on bubble-own is at least 4.5:1', () => {
    expect(ratio(pick(t, 'on-bubble'), pick(t, 'bubble-own'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrast rules: dark lighting', () => {
  const t = tokens('.dark');

  // Higher is lighter: a raised surface's top edge must separate from the
  // panel it sits on, not only its shadow (dark mode never relies on a shadow alone).
  it('lit-edge-top blended on panel is at least 1.25:1', () => {
    expect(ratio(pick(t, 'lit-edge-top'), pick(t, 'panel'))).toBeGreaterThanOrEqual(1.25);
  });

  it('the dark lit edges dim from top to side to bottom', () => {
    const panel = pick(t, 'panel');
    const top = ratio(pick(t, 'lit-edge-top'), panel);
    const side = ratio(pick(t, 'lit-edge-side'), panel);
    const bottom = ratio(pick(t, 'lit-edge-bottom'), panel);
    expect(top).toBeGreaterThan(side);
    expect(side).toBeGreaterThan(bottom);
  });
});

describe('contrast rules: the parser reads every token it is asked for', () => {
  it.each([':root', '.dark'])('%s has every colour token this guard names', (selector) => {
    const t = tokens(selector);
    const names = [
      ...TEXT,
      ...TEXT_SURFACES,
      ...EDGES,
      'hover-fill',
      'press-fill',
      'accent-fg',
      'on-bubble',
      'bubble-own',
      'knob',
    ];
    expect(names.filter((n) => t[n] === undefined)).toEqual([]);
  });
});
