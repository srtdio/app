import { describe, expect, it } from 'vitest';
import {
  applyMove,
  dropIndex,
  findItem,
  flattenOrder,
  hasTicks,
  isNoop,
  moveItem,
  moveToEnd,
  type DayIds,
} from '@/lib/chat/plan-drag';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

const DAYS: DayIds[] = [
  { day: '2026-10-12', ids: ['a', 'b'] },
  { day: '2026-10-13', ids: [] },
  { day: '2026-10-14', ids: ['c'] },
  { day: null, ids: ['d'] },
];

describe('plan drag order math', () => {
  it('reorders within a day and flattens the full plan order', () => {
    const next = moveItem(DAYS, 'b', '2026-10-12', 0);
    expect(next[0]?.ids).toEqual(['b', 'a']);
    expect(flattenOrder(next)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('moves across days, to an empty day and to No date', () => {
    expect(flattenOrder(moveItem(DAYS, 'a', '2026-10-14', 0))).toEqual(['b', 'a', 'c', 'd']);
    expect(moveItem(DAYS, 'a', '2026-10-14', 1)[2]?.ids).toEqual(['c', 'a']);
    expect(moveItem(DAYS, 'c', '2026-10-13', 0)[1]?.ids).toEqual(['c']);
    const toNone = moveItem(DAYS, 'a', null, 1);
    expect(toNone[3]?.ids).toEqual(['d', 'a']);
    expect(flattenOrder(toNone)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('first and last positions clamp; Move puts it at the end of the day', () => {
    expect(moveItem(DAYS, 'd', '2026-10-12', -5)[0]?.ids).toEqual(['d', 'a', 'b']);
    expect(moveItem(DAYS, 'd', '2026-10-12', 99)[0]?.ids).toEqual(['a', 'b', 'd']);
    expect(moveToEnd(DAYS, 'a', '2026-10-12')[0]?.ids).toEqual(['b', 'a']);
    expect(moveToEnd(DAYS, 'c', null)[3]?.ids).toEqual(['d', 'c']);
  });

  it('cancel or a drop where it already is changes nothing', () => {
    expect(isNoop(DAYS, 'b', { day: '2026-10-12', index: 1 })).toBe(true);
    expect(isNoop(DAYS, 'b', { day: '2026-10-12', index: 0 })).toBe(false);
    expect(isNoop(DAYS, 'b', { day: '2026-10-14', index: 0 })).toBe(false);
    // An unknown item or day leaves the order as it is.
    expect(flattenOrder(moveItem(DAYS, 'zz', '2026-10-12', 0))).toEqual(flattenOrder(DAYS));
    expect(flattenOrder(moveItem(DAYS, 'a', '2026-12-01', 0))).toEqual(flattenOrder(DAYS));
    expect(findItem(DAYS, 'c')).toEqual({ day: '2026-10-14', index: 0 });
    expect(findItem(DAYS, 'zz')).toBeNull();
  });

  it('the drop index counts the rows whose middle is above the pointer', () => {
    expect(dropIndex([30, 106], 10)).toBe(0);
    expect(dropIndex([30, 106], 50)).toBe(1);
    expect(dropIndex([30, 106], 200)).toBe(2);
    expect(dropIndex([], 50)).toBe(0);
  });
});

function item(id: string, over: Partial<PlanItemRow> = {}): PlanItemRow {
  return {
    id,
    plan_id: 'plan',
    kind: 'concept',
    position: 0,
    title: id,
    description: null,
    post_id: null,
    created_at: '2026-10-09T10:00:00Z',
    target_date: null,
    ...over,
  };
}

describe('the optimistic move', () => {
  const bundle: PlanBundle = {
    plan: {
      id: 'plan',
      workspace_id: 'ws',
      title: 'Week',
      starts_on: '2026-10-12',
      ends_on: '2026-10-16',
      audience: 'client',
      created_by: null,
    },
    items: [
      item('a', { target_date: '2026-10-12', position: 0 }),
      item('b', { target_date: '2026-10-12', position: 1 }),
      item('c', { target_date: '2026-10-14', position: 2 }),
    ],
    reviews: [
      { item_id: 'a', side: 'client', status: 'approved' },
      { item_id: 'b', side: 'team', status: 'approved' },
    ],
    postStages: {},
    postInfo: {},
  };

  it('a day change sets the day, the order, and drops its ticks (the server resets them)', () => {
    expect(hasTicks(bundle, 'a')).toBe(true);
    const next = applyMove(bundle, 'a', '2026-10-15', ['b', 'c', 'a']);
    expect(next.items.map((i) => [i.id, i.target_date])).toEqual([
      ['b', '2026-10-12'],
      ['c', '2026-10-14'],
      ['a', '2026-10-15'],
    ]);
    expect(next.reviews.map((r) => r.item_id)).toEqual(['b']);
    expect(hasTicks(next, 'a')).toBe(false);
  });

  it('a same-day reorder keeps the ticks; No date sorts last', () => {
    const same = applyMove(bundle, 'b', '2026-10-12', ['b', 'a', 'c']);
    expect(same.items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(same.reviews).toHaveLength(2);
    const none = applyMove(bundle, 'a', null, ['b', 'c', 'a']);
    expect(none.items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(none.items[2]?.target_date).toBeNull();
  });
});
