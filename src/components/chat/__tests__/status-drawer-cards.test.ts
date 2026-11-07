// Chat open-items drawer (flat look): the drawer is the lit layer; its
// sections are flat, parted by a --border hairline, no card frame. Rows are
// flat and bleed 12 past the text, so the divider and the pressed fill run
// wider than the words and stay square.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../StatusDrawer.tsx', import.meta.url)), 'utf8');

describe('StatusDrawer section cards', () => {
  it('each section is flat: a hairline between sections, no card frame', () => {
    expect(src).toContain('py-3 first:pt-0 [&+&]:border-t [&+&]:border-border');
    expect(src).not.toContain('rounded-xl border bg-panel p-3 pb-1 lit-card');
    expect(src).not.toMatch(/\blit-card\b/);
  });

  it('rows bleed past the text and part with a border-border divider', () => {
    expect(src).toContain("const ROW_RULE = '[&+&]:border-t [&+&]:border-border';");
    expect(src).toMatch(/const ROW = `\$\{ROW_BASE\} -mx-3 px-3 \$\{ROW_RULE\}`;/);
  });

  it('every PressableRow in the drawer is flat (square pressed fill)', () => {
    const rows = [...src.matchAll(/<PressableRow\b[^>]*?>/gs)].map((m) => m[0]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row, row).toMatch(/\bflat\b/);
  });
});
