import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SHEET_THUMB_HEIGHT,
  THUMB_WIDTH,
  docxThumbSize,
  drawDocxThumb,
  drawXlsxThumb,
  type DrawContext,
} from './thumbnail-draw';
import { THUMB_GRID_COLS, THUMB_GRID_ROWS, THUMB_LINE_CHARS, THUMB_MAX_LINES } from './types';

/** A context that records every touch and fails on anything outside DrawContext. */
function recorder(): { ctx: DrawContext; touched: Set<string>; texts: string[]; rects: number } {
  const touched = new Set<string>();
  const texts: string[] = [];
  let rects = 0;
  const state: Record<string, unknown> = {};
  const allowed = new Set([
    'fillStyle',
    'font',
    'textBaseline',
    'fillRect',
    'fillText',
    'measureText',
  ]);
  const ctx = new Proxy(state, {
    get(_t, prop) {
      const name = String(prop);
      touched.add(name);
      if (!allowed.has(name)) throw new Error(`drawer touched ${name}`);
      if (name === 'fillRect') return () => void rects++;
      if (name === 'fillText') return (text: string) => void texts.push(text);
      if (name === 'measureText') return (text: string) => ({ width: text.length * 10 });
      return state[name];
    },
    set(_t, prop, value) {
      const name = String(prop);
      touched.add(name);
      if (!allowed.has(name)) throw new Error(`drawer set ${name}`);
      state[name] = value;
      return true;
    },
  }) as unknown as DrawContext;
  return {
    ctx,
    touched,
    texts,
    get rects() {
      return rects;
    },
  };
}

describe('the office thumbnail drawer', () => {
  it('never builds HTML, never draws images: source has no innerHTML, DOM or drawImage', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./thumbnail-draw.ts', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/);
    expect(code).not.toMatch(/createElement|DOMParser|drawImage|new Image|FontFace|srcdoc/);
  });

  it('Word: at most 12 lines, each capped, only fillRect/fillText/measureText', () => {
    const r = recorder();
    const long = 'word '.repeat(400);
    drawDocxThumb(r.ctx, 580, 750, {
      kind: 'docx',
      title: 'A very long title that will wrap onto a second line and then keep going on',
      paragraphs: Array.from({ length: 20 }, () => long),
      aspect: 1.29,
    });
    expect(r.texts.length).toBeLessThanOrEqual(THUMB_MAX_LINES);
    expect(r.texts.every((t) => t.length <= THUMB_LINE_CHARS + 1)).toBe(true);
    expect(r.rects).toBe(1);
  });

  it('Excel: at most 8 x 5 cells plus letters and row numbers; numbers right-aligned', () => {
    const r = recorder();
    const cells = Array.from({ length: THUMB_GRID_ROWS }, (_, i) =>
      Array.from({ length: THUMB_GRID_COLS }, (_, c) => ({ text: `${i}:${c}`, numeric: c === 1 })),
    );
    drawXlsxThumb(r.ctx, THUMB_WIDTH, SHEET_THUMB_HEIGHT, { kind: 'xlsx', cells });
    const headers = THUMB_GRID_COLS + THUMB_GRID_ROWS;
    expect(r.texts.length).toBe(headers + THUMB_GRID_ROWS * THUMB_GRID_COLS);
    expect(r.texts.slice(0, THUMB_GRID_COLS)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(
      [...r.touched].every((t) =>
        ['fillStyle', 'font', 'textBaseline', 'fillRect', 'fillText', 'measureText'].includes(t),
      ),
    ).toBe(true);
  });

  it('page sizes stay within the thumbnail box', () => {
    expect(docxThumbSize(11 / 8.5)).toEqual({ width: 580, height: 751 });
    expect(docxThumbSize(5)).toEqual({ width: 580, height: 1160 });
    expect(docxThumbSize(Number.NaN)).toEqual({ width: 580, height: 751 });
  });
});
