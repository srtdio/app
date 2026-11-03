import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The stage chip row renders inside SectionHeader's child row, which already
// carries the mt-3 gap below search. Its own margin stacked a second 12px on
// Pipeline only, so the chips sat lower than on Briefs, Assets and Activity.
describe('StageChips spacing', () => {
  it('adds no top margin or bottom padding of its own', () => {
    const src = readFileSync(fileURLToPath(new URL('./StageChips.tsx', import.meta.url)), 'utf8');
    const row = /data-chip-row=""\s*className="([^"]*)"/.exec(src)?.[1] ?? '';
    expect(row).not.toBe('');
    expect(row.split(' ')).not.toContain('mt-3');
    expect(row.split(' ')).not.toContain('pb-1');
  });
});
