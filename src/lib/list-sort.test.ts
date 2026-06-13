import { describe, expect, it } from 'vitest';
import { filterByTitle, sortByDate, type DateSortable } from '@/lib/list-sort';

interface Row extends DateSortable {
  id: string;
  title: string;
}

function row(over: Partial<Row>): Row {
  return { id: 'r', title: 'Untitled', created_at: '2026-01-01', target_date: null, ...over };
}

describe('sortByDate', () => {
  const a = row({ id: 'a', created_at: '2026-01-01', target_date: '2026-03-01' });
  const b = row({ id: 'b', created_at: '2026-02-01', target_date: null });
  const c = row({ id: 'c', created_at: '2026-03-01', target_date: '2026-02-01' });

  it('orders newest first by created_at descending', () => {
    expect(sortByDate([a, b, c], 'newest').map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('orders oldest first by created_at ascending', () => {
    expect(sortByDate([c, b, a], 'oldest').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders by target_date ascending with nulls last', () => {
    expect(sortByDate([a, b, c], 'target').map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = [a, b, c];
    sortByDate(input, 'newest');
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterByTitle', () => {
  const items = [row({ id: 'a', title: 'Launch teaser' }), row({ id: 'b', title: 'Recap reel' })];

  it('matches case-insensitively on a trimmed substring', () => {
    expect(filterByTitle(items, '  TEASER ').map((r) => r.id)).toEqual(['a']);
  });

  it('returns the full list for an empty or whitespace query', () => {
    expect(filterByTitle(items, '')).toHaveLength(2);
    expect(filterByTitle(items, '   ')).toHaveLength(2);
  });

  it('returns nothing when no title matches', () => {
    expect(filterByTitle(items, 'zzz')).toHaveLength(0);
  });
});
