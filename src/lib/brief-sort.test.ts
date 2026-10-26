import { describe, expect, it } from 'vitest';
import {
  BRIEF_SORT_DEFAULT,
  BRIEF_SORT_OPTIONS,
  sanitizeBriefSort,
  sortBriefs,
} from '@/lib/brief-sort';

const row = (id: string, target_date: string | null, updated_at: string) => ({
  id,
  target_date,
  updated_at,
});

describe('brief sort options', () => {
  it('lists Due date (default) then Newest first', () => {
    expect(BRIEF_SORT_OPTIONS.map((o) => o.label)).toEqual(['Due date', 'Newest first']);
    expect(BRIEF_SORT_OPTIONS.map((o) => o.value)).toEqual(['due', 'updated']);
    expect(BRIEF_SORT_DEFAULT).toBe('due');
  });

  it('heals an unknown stored value to the default', () => {
    expect(sanitizeBriefSort('updated')).toBe('updated');
    expect(sanitizeBriefSort('newest')).toBe('due');
  });
});

describe('sortBriefs', () => {
  const items = [
    row('none', null, '2026-10-05T00:00:00Z'),
    row('late', '2026-11-01', '2026-10-01T00:00:00Z'),
    row('soon-old', '2026-10-25', '2026-10-02T00:00:00Z'),
    row('soon-new', '2026-10-25', '2026-10-04T00:00:00Z'),
  ];

  it('due date: soonest first, ties by recently updated, undated last', () => {
    expect(sortBriefs(items, 'due').map((b) => b.id)).toEqual([
      'soon-new',
      'soon-old',
      'late',
      'none',
    ]);
  });

  it('recently updated: newest updated_at first', () => {
    expect(sortBriefs(items, 'updated').map((b) => b.id)).toEqual([
      'none',
      'soon-new',
      'soon-old',
      'late',
    ]);
  });

  it('never mutates the input', () => {
    const copy = [...items];
    sortBriefs(items, 'due');
    expect(items).toEqual(copy);
  });
});
