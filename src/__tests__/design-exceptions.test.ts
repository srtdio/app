import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Lock (CLAUDE.md "Lock"): every written design exception lives in one table,
// docs/design-exceptions.md, at most 20 rows, each with a reason and a date.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_ROWS = 20;
const DATE = /^\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/;

export interface ExceptionRow {
  part: string;
  exception: string;
  why: string;
  date: string;
}

/** The table rows of a markdown doc (header and separator dropped). */
export function exceptionRows(md: string): ExceptionRow[] {
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  return lines.slice(2).map((l) => {
    const cells = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    const [part = '', exception = '', why = '', date = ''] = cells.map((c) => c.trim());
    return { part, exception, why, date };
  });
}

describe('design exceptions', () => {
  const md = readFileSync(`${ROOT}docs/design-exceptions.md`, 'utf8');
  const rows = exceptionRows(md);

  it('the table has the four columns', () => {
    const header = md.split('\n').find((l) => l.trim().startsWith('|')) ?? '';
    const cells = header
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    expect(cells).toEqual(['Part or screen', 'Exception', 'Why', 'Date approved']);
  });

  it(`holds 1..${MAX_ROWS} rows`, () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length, `more than ${MAX_ROWS} exceptions: one must go first`).toBeLessThanOrEqual(
      MAX_ROWS,
    );
  });

  it('every row names a part, the exception, a reason and a date', () => {
    for (const r of rows) {
      expect(r.part, 'part or screen').not.toBe('');
      expect(r.exception, `${r.part}: exception`).not.toBe('');
      expect(r.why, `${r.part}: reason`).not.toBe('');
      expect(r.date, `${r.part}: date approved`).toMatch(DATE);
    }
  });

  it('CLAUDE.md points at the file', () => {
    const doc = readFileSync(`${ROOT}CLAUDE.md`, 'utf8');
    expect(doc).toContain('docs/design-exceptions.md');
  });

  it('the parser flags a row with no reason or date', () => {
    const bad = exceptionRows(
      '| Part or screen | Exception | Why | Date approved |\n| --- | --- | --- | --- |\n| A | B |  |  |',
    );
    expect(bad).toEqual([{ part: 'A', exception: 'B', why: '', date: '' }]);
  });
});
