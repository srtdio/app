import { describe, expect, it } from 'vitest';
import { orderBriefsFixed, sortBriefs, sortClosedBriefs } from '@/lib/brief-sort';

const row = (id: string, target_date: string | null, updated_at: string) => ({
  id,
  target_date,
  updated_at,
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

describe('fixed creator order (9 Nov 2026: no Sort)', () => {
  const b = (
    id: string,
    status: 'open' | 'closed',
    target_date: string | null,
    updated_at: string,
    closed_at: string | null = null,
  ) => ({ id, status, target_date, updated_at, closed_at });

  it('closed briefs: closed_at newest first, a missing closed_at falls back to updated_at', () => {
    const rows = [
      b('c-old', 'closed', null, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
      b('c-new', 'closed', null, '2026-10-01T00:00:00Z', '2026-10-09T00:00:00Z'),
      b('c-none', 'closed', null, '2026-10-05T00:00:00Z', null),
    ];
    expect(sortClosedBriefs(rows).map((r) => r.id)).toEqual(['c-new', 'c-none', 'c-old']);
  });

  it('All: open by due (undated last by newest updated), then closed by closed_at', () => {
    const rows = [
      b('closed-old', 'closed', '2026-10-01', '2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z'),
      b('open-undated-old', 'open', null, '2026-10-01T00:00:00Z'),
      b('open-late', 'open', '2026-11-20', '2026-10-01T00:00:00Z'),
      b('closed-new', 'closed', null, '2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z'),
      b('open-soon', 'open', '2026-11-10', '2026-10-01T00:00:00Z'),
      b('open-undated-new', 'open', null, '2026-10-06T00:00:00Z'),
    ];
    expect(orderBriefsFixed(rows).map((r) => r.id)).toEqual([
      'open-soon',
      'open-late',
      'open-undated-new',
      'open-undated-old',
      'closed-new',
      'closed-old',
    ]);
  });

  it('never mutates the input', () => {
    const rows = [
      b('x', 'closed', null, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      b('y', 'open', '2026-11-01', '2026-10-01T00:00:00Z'),
    ];
    const copy = [...rows];
    orderBriefsFixed(rows);
    expect(rows).toEqual(copy);
  });
});
