import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The Bank's applied filter line: each pill is removed by the bin (IconTrash,
// "Remove <pill>"), never an X; the line's own Clear stays a text button.
describe('BankFilterLine pill remove (no-cross)', () => {
  const src = readFileSync(new URL('./BankList.tsx', import.meta.url), 'utf8');

  it('the pill remove is a bin labelled "Remove <pill>"', () => {
    const at = src.indexOf('label={`Remove ${pill.label}`}');
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf('</IconButton>', at);
    expect(src.slice(at, end)).toContain('<IconTrash');
  });

  it('no X anywhere in the Bank list', () => {
    expect(src).not.toMatch(/\bIconX\b/);
  });
});
