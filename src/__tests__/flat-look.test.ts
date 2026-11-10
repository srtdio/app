import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  listCardFrame,
  LIST_CARD_COVER,
  LIST_CARD_GRID,
  LIST_CARD_STACK,
} from '@/components/ui/ListCard';

// Guard: the FLAT LOOK (Slack style, decided 7 Nov 2026). In-content surfaces
// are flat: src/index.css ends its theme tokens with one ':root, .dark' block
// that zeroes every in-content lit-* height (rows, chips, cards, buttons,
// bubbles) and turns headers, side panes and the dock into a --border
// hairline. Floating layers (lit-float, lit-overlay) keep their soft shadow:
// the flat block never names them. List rows (ui/ListCard) are flat frames:
// no border, radius, lit height or clip, bled -mx-4 / px-4, the 72 height
// (h-18).
const CSS = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

const FLAT_OPEN = /(^|\n):root,\s*\n?\s*\.dark \{/;

/** The theme block opening at column 0 with `sel {` (the first match). */
function themeBlock(sel: string): { at: number; body: string } {
  const re = new RegExp(`(^|\\n)${sel.replace('.', '\\.')} \\{`);
  const hit = re.exec(CSS);
  if (hit === null) return { at: -1, body: '' };
  const at = hit.index + hit[0].length;
  return { at: hit.index, body: CSS.slice(at, CSS.indexOf('\n}', at)) };
}

function flatBlock(): { at: number; body: string } {
  const hit = FLAT_OPEN.exec(CSS);
  if (hit === null) return { at: -1, body: '' };
  const at = hit.index + hit[0].length;
  return { at: hit.index, body: CSS.slice(at, CSS.indexOf('\n}', at)) };
}

const value = (body: string, name: string): string =>
  (new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1] ?? '').replace(/\s+/g, ' ').trim();

describe('flat look: the index.css token block', () => {
  const flat = flatBlock();
  const root = themeBlock(':root');
  const dark = themeBlock('.dark');

  it('exists as one ":root, .dark" block, after .dark and before @layer base', () => {
    expect(flat.at, 'FLAT LOOK block').toBeGreaterThan(-1);
    expect(CSS.match(new RegExp(FLAT_OPEN.source, 'g')) ?? [], 'one flat block').toHaveLength(1);
    const note = CSS.indexOf('FLAT LOOK (Slack style, decided 7 Nov 2026)');
    expect(note).toBeGreaterThan(dark.at);
    expect(note).toBeLessThan(flat.at);
    expect(root.at).toBeGreaterThan(-1);
    expect(dark.at).toBeGreaterThan(root.at);
    // Later in source with the same specificity: its values win in both themes.
    expect(flat.at).toBeGreaterThan(dark.at);
    const layerBase = CSS.indexOf('@layer base {');
    expect(layerBase).toBeGreaterThan(flat.at);
  });

  it('zeroes the in-content heights to no shadow (0 0 #0000)', () => {
    for (const name of [
      'lit-hl',
      'lit-raised',
      'lit-card',
      'lit-btn-primary',
      'lit-btn-success',
      'lit-btn-danger',
      'lit-btn-secondary',
      'lit-chip',
      'lit-well',
      'lit-well-soft',
      'lit-pill',
      'lit-tint',
      'lit-active',
      'lit-media',
      'lit-avatar',
      'lit-badge',
      'lit-bubble-own',
      'lit-bubble-other',
      'lit-strip',
    ]) {
      expect(value(flat.body, name), name).toBe('0 0 #0000');
    }
  });

  it('drops every gloss and gradient fill (none)', () => {
    for (const name of [
      'lit-surface',
      'lit-chip-bg',
      'lit-overlay-bg',
      'lit-bubble-other-bg',
      'lit-shine',
      'lit-muted-shine',
    ]) {
      expect(value(flat.body, name), name).toBe('none');
    }
  });

  it('edges, the header, the side pane and the dock are the --border hairline', () => {
    for (const name of ['lit-edge-top', 'lit-edge-side', 'lit-edge-bottom']) {
      expect(value(flat.body, name), name).toBe('var(--border)');
    }
    expect(value(flat.body, 'lit-header')).toBe('0 1px 0 var(--border)');
    expect(value(flat.body, 'lit-side')).toBe('1px 0 0 var(--border)');
    expect(value(flat.body, 'lit-dock')).toBe('0 -1px 0 var(--border)');
  });

  it('floating layers keep their light: lit-float, lit-overlay, lit-knob, --sel-edge untouched', () => {
    for (const name of [
      'lit-float',
      'lit-overlay',
      'lit-knob',
      'lit-dock-joined',
      'sel-edge',
      'shadow-spotlight',
    ]) {
      expect(flat.body, name).not.toContain(`--${name}:`);
    }
    // Still set, with a real shadow, in both themes.
    for (const body of [root.body, dark.body]) {
      for (const name of ['lit-float', 'lit-overlay']) {
        const v = value(body, name);
        expect(v, name).not.toBe('');
        expect(v, name).not.toBe('0 0 #0000');
        expect(v, name).not.toBe('none');
      }
    }
  });

  it('the dark --border is lifted so the hairline reads on near-black (#2a2c30, 42 44 48)', () => {
    expect(value(dark.body, 'border')).toBe('#2a2c30');
    expect(value(dark.body, 'border-rgb')).toBe('42 44 48');
  });
});

describe('flat look: the list row frame (ui/ListCard)', () => {
  const tokens = (cls: string): string[] => cls.split(/\s+/).filter(Boolean);

  for (const [name, frame] of [
    ['listCardFrame()', listCardFrame()],
    ['listCardFrame(true)', listCardFrame(true)],
  ] as const) {
    it(`${name}: no border, rounded, lit- or overflow-hidden; -mx-4, px-4, h-18`, () => {
      expect(frame).not.toMatch(/border/);
      expect(frame).not.toMatch(/rounded/);
      expect(frame).not.toMatch(/lit-/);
      expect(frame).not.toContain('overflow-hidden');
      expect(tokens(frame)).toEqual(expect.arrayContaining(['-mx-4', 'px-4', 'h-18']));
    });
  }

  it('rows touch: no gap in the stack, only a laptop column gap in the grid', () => {
    expect(tokens(LIST_CARD_STACK)).toEqual(['flex', 'flex-col']);
    expect(tokens(LIST_CARD_GRID)).not.toContain('gap-2');
    expect(tokens(LIST_CARD_GRID).filter((t) => /^gap-/.test(t))).toEqual([]);
    expect(tokens(LIST_CARD_GRID)).toContain('md:gap-x-8');
  });

  it('the tap cover fills the row edge to edge (no radius of its own)', () => {
    expect(LIST_CARD_COVER).not.toMatch(/rounded/);
    expect(tokens(LIST_CARD_COVER)).toEqual(expect.arrayContaining(['absolute', 'inset-0']));
  });
});
