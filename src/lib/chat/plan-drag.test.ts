import { describe, expect, it } from 'vitest';
import type { PlanSaveOp } from '@srtdio/rpc';
import {
  applyMove,
  dayIdsOf,
  dropIndex,
  findItem,
  flattenOrder,
  hasTicks,
  isNoop,
  isRenderableRange,
  moveItem,
  moveToEnd,
  orderLike,
  rebuildOps,
  withHeaderUpdate,
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

describe('Save changes on fresh data (F8)', () => {
  const plan: PlanBundle['plan'] = {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week',
    starts_on: '2026-10-12',
    ends_on: '2026-10-16',
    audience: 'team',
    created_by: null,
  };
  const bundleOf = (items: PlanItemRow[]): PlanBundle => ({
    plan,
    items,
    reviews: [],
    postStages: {},
    postInfo: {},
  });
  // As the session started: a, b on Mon 12; c on Wed 14; d on No date.
  const start = bundleOf([
    item('a', { target_date: '2026-10-12', position: 0 }),
    item('b', { target_date: '2026-10-12', position: 1 }),
    item('c', { target_date: '2026-10-14', position: 2 }),
    item('d', { target_date: null, position: 3 }),
  ]);

  it('dayIdsOf groups the items by day in order, No date last; orderLike keeps the session order', () => {
    expect(dayIdsOf(start)).toEqual([
      { day: '2026-10-12', ids: ['a', 'b'] },
      { day: '2026-10-14', ids: ['c'] },
      { day: null, ids: ['d'] },
    ]);
    // Ids the session ordered first, then the rest; unknown ids are gone.
    expect(
      orderLike(
        [
          { day: '2026-10-12', ids: ['x', 'a', 'b'] },
          { day: null, ids: ['d'] },
        ],
        ['b', 'a', 'zz'],
      ),
    ).toEqual(['b', 'a', 'x', 'd']);
  });

  it('the same plan: the queue rebuilds to the same full order', () => {
    const ops: PlanSaveOp[] = [
      {
        op: 'move',
        item_id: 'a',
        target_date: '2026-10-14',
        item_ids: ['b', 'c', 'a', 'd'],
        keep_reviews: false,
      },
    ];
    expect(rebuildOps(start, ops)).toEqual(ops);
  });

  it('others added items stay on their day after this session’s placed items; removed items drop out', () => {
    // Since the edit began: x was added on Wed 14 and y on Mon 12, b was removed.
    const fresh = bundleOf([
      item('a', { target_date: '2026-10-12', position: 0 }),
      item('y', { target_date: '2026-10-12', position: 5 }),
      item('c', { target_date: '2026-10-14', position: 2 }),
      item('x', { target_date: '2026-10-14', position: 4 }),
      item('d', { target_date: null, position: 3 }),
    ]);
    const ops: PlanSaveOp[] = [
      // This session also removed b: someone else did first, so it is dropped.
      { op: 'remove', item_id: 'b' },
      {
        op: 'move',
        item_id: 'a',
        target_date: '2026-10-14',
        item_ids: ['c', 'a', 'd'],
        keep_reviews: true,
      },
    ];
    expect(rebuildOps(fresh, ops)).toEqual([
      {
        op: 'move',
        item_id: 'a',
        target_date: '2026-10-14',
        item_ids: ['y', 'c', 'a', 'x', 'd'],
        keep_reviews: true,
      },
    ]);
  });

  it('a move to a day with no items yet, a reorder, the header update kept; a move of a removed item drops', () => {
    const fresh = bundleOf([
      item('a', { target_date: '2026-10-12', position: 0 }),
      item('c', { target_date: '2026-10-14', position: 2 }),
      item('d', { target_date: null, position: 3 }),
    ]);
    const update: PlanSaveOp = {
      op: 'update',
      title: 'Week',
      starts_on: '2026-10-12',
      ends_on: '2026-10-18',
    };
    const out = rebuildOps(fresh, [
      update,
      {
        op: 'move',
        item_id: 'b',
        target_date: '2026-10-13',
        item_ids: ['a', 'b'],
        keep_reviews: false,
      },
      {
        op: 'move',
        item_id: 'c',
        target_date: '2026-10-13',
        item_ids: ['a', 'c', 'd'],
        keep_reviews: false,
      },
      { op: 'reorder', item_ids: ['d', 'c', 'a'] },
    ]);
    expect(out).toEqual([
      update,
      {
        op: 'move',
        item_id: 'c',
        target_date: '2026-10-13',
        item_ids: ['a', 'c', 'd'],
        keep_reviews: false,
      },
      { op: 'reorder', item_ids: ['a', 'c', 'd'] },
    ]);
  });

  it('nothing left: a queue whose items are all gone rebuilds to nothing', () => {
    expect(rebuildOps(bundleOf([]), [{ op: 'remove', item_id: 'a' }])).toEqual([]);
  });
});

describe('the header draft (F10, F11)', () => {
  const plan = { title: 'Week', starts_on: '2026-10-12', ends_on: '2026-10-16' };

  it('F10: an empty From or To, or From after To, keeps the last range that rendered', () => {
    expect(isRenderableRange({ startsOn: '2026-10-12', endsOn: '2026-10-12' })).toBe(true);
    expect(isRenderableRange({ startsOn: '', endsOn: '2026-10-16' })).toBe(false);
    expect(isRenderableRange({ startsOn: '2026-10-17', endsOn: '2026-10-16' })).toBe(false);
    // No earlier edit: the plan's own range, so no op.
    const noRange = { title: 'Week', startsOn: '', endsOn: '2026-10-16' };
    expect(withHeaderUpdate([], plan, noRange)).toEqual([]);
    // An earlier valid edit: its range is kept while the fields are broken.
    const widened = withHeaderUpdate([], plan, {
      title: 'Week',
      startsOn: '2026-10-12',
      endsOn: '2026-10-19',
    });
    const kept = [{ op: 'update', title: 'Week', starts_on: '2026-10-12', ends_on: '2026-10-19' }];
    const backwards = { title: 'Week', startsOn: '2026-10-20', endsOn: '2026-10-19' };
    expect(withHeaderUpdate(widened, plan, backwards)).toEqual(kept);
    const noEnd = { title: 'Week', startsOn: '2026-10-12', endsOn: '' };
    expect(withHeaderUpdate(widened, plan, noEnd)).toEqual(kept);
  });

  it('F11: an empty title is never swapped for the saved one', () => {
    expect(
      withHeaderUpdate([], plan, { title: '  ', startsOn: '2026-10-12', endsOn: '2026-10-16' }),
    ).toEqual([{ op: 'update', title: '', starts_on: '2026-10-12', ends_on: '2026-10-16' }]);
  });
});
