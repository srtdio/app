import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Format keys (8 Nov 2026): a format key that is on turns its glyph ink (fg),
// never a tile, ring or fill; at rest every key is the one grey (fg-2). The
// phone format row's X close and send are matching filled circles (RowKey
// solid and RowSend share bg-accent / text-accent-fg on the same 36 face in a
// 44 tall hit). Source guard on ui/WritingBox; rendered checks live in
// ui/WritingBox.test.tsx.
const SRC = readFileSync(
  fileURLToPath(new URL('../components/ui/WritingBox.tsx', import.meta.url)),
  'utf8',
);

/** The body of a top-level `export function <name>` in the source. */
function fnBody(name: string): string {
  const start = SRC.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const next = SRC.indexOf('\nexport ', start + 1);
  return SRC.slice(start, next < 0 ? undefined : next);
}

/** The face class picked for an on key (the string after `on ?`). */
export function onFaceClass(body: string): string | null {
  const m = /\bon\s*\?\s*'([^']*)'/.exec(body);
  return m === null ? null : (m[1] ?? null);
}

const TILE = /\bbg-|\bborder\b|\bring\b|lit-selected|lit-well|shadow/;

describe('format keys: on = glyph ink only; phone close matches send', () => {
  it('an on RowKey turns the glyph ink and draws no tile, ring or fill', () => {
    const face = onFaceClass(fnBody('RowKey'));
    expect(face).not.toBeNull();
    expect(face).toMatch(/\btext-fg\b/);
    expect(face ?? '').not.toMatch(TILE);
  });

  it('a resting RowKey is the one grey (fg-2) with no edge', () => {
    const body = fnBody('RowKey');
    expect(body).toMatch(/:\s*'text-fg-2 lit-hover'/);
    expect(body).not.toMatch(/border-transparent|lit-selected/);
  });

  it('the phone close is a solid RowKey, the same face as RowSend', () => {
    expect(SRC).toMatch(/<RowKey label="Close formatting" solid data-row-key="close"/);
    expect(fnBody('RowKey')).toMatch(/solid \? 'bg-accent text-accent-fg'/);
    expect(fnBody('RowSend')).toContain("'bg-accent text-accent-fg'");
    // Both keep the 44 tall hit with the 36 face.
    for (const name of ['RowKey', 'RowSend']) {
      expect(fnBody(name)).toContain('inline-flex h-11 w-9 shrink-0 items-stretch py-1');
    }
  });

  it('the phone row drops Aa and Quote; send stays last in its one slot, the mic hides', () => {
    expect(SRC).toMatch(/phoneFormat\s*\?\s*FORMAT_KEYS\.filter\(\(k\) => k\.action !== 'quote'\)/);
    // Send never moves into the format row (a remount would drop its submit).
    expect(SRC).not.toMatch(/\{phoneFormat \? sendKey : null\}/);
    expect(SRC).toContain('const micShown = !(formatOpen && phoneFormat);');
    expect(SRC).toContain("{shape === 'card' ? trailing : null}");
  });

  it('onFaceClass reads the on branch and catches a tile', () => {
    expect(onFaceClass("on ? 'border lit-selected' : 'x'")).toBe('border lit-selected');
    expect('border lit-selected').toMatch(TILE);
    expect(onFaceClass("solid ? 'a' : on ? 'text-fg' : 'b'")).toBe('text-fg');
  });

  it('CLAUDE.md records the rule', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../CLAUDE.md', import.meta.url)), 'utf8');
    expect(doc).toContain('format-keys.test.ts');
  });
});
