// Chat open-items drawer: grey sheet, one lit card per section; rows inside a
// card are flat and bleed to its edges, so the divider and the pressed fill
// run edge to edge and stay square (the card clips its corners).
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../StatusDrawer.tsx', import.meta.url)), 'utf8');

describe('StatusDrawer section cards', () => {
  it('each section is a clipping lit card on the grey sheet', () => {
    expect(src).toContain('mb-3 overflow-hidden rounded-xl border bg-panel p-3 pb-1 lit-card');
  });

  it('rows bleed to the card edges and part with a border-border divider', () => {
    expect(src).toContain("const ROW_RULE = '[&+&]:border-t [&+&]:border-border';");
    expect(src).toMatch(/const ROW = `\$\{ROW_BASE\} -mx-3 px-3 \$\{ROW_RULE\}`;/);
  });

  it('every PressableRow in the drawer is flat (square pressed fill inside the card)', () => {
    const rows = [...src.matchAll(/<PressableRow\b[^>]*?>/gs)].map((m) => m[0]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row, row).toMatch(/\bflat\b/);
  });
});
