// X3: the edit queue behind Save changes. Nothing is written while editing:
// the queue holds the plan_save ops in order and applyPlanOps paints the
// bundle as they would leave it.

import { describe, expect, it } from 'vitest';
import type { PlanSaveOp } from '@srtdio/rpc';
import {
  applyPlanOps,
  hasQueuedOps,
  headerDraftOf,
  queueOp,
  removedIds,
  withHeaderUpdate,
} from '@/lib/chat/plan-drag';
import type { PlanBundle, PlanItemRow } from '@/lib/chat/plans';

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

describe('the header update op', () => {
  it('one update op, first in the queue, replaced on every edit', () => {
    const draft = headerDraftOf(bundle.plan);
    expect(draft).toEqual({ title: 'Week', startsOn: '2026-10-12', endsOn: '2026-10-16' });
    const moved: PlanSaveOp[] = [
      {
        op: 'move',
        item_id: 'a',
        target_date: '2026-10-14',
        item_ids: ['b', 'c', 'a'],
        keep_reviews: true,
      },
    ];
    const once = withHeaderUpdate(moved, bundle.plan, { ...draft, title: ' Launch week ' });
    expect(once[0]).toEqual({
      op: 'update',
      title: 'Launch week',
      starts_on: '2026-10-12',
      ends_on: '2026-10-16',
    });
    expect(once).toHaveLength(2);
    const twice = withHeaderUpdate(once, bundle.plan, { ...draft, endsOn: '2026-10-19' });
    expect(twice.filter((op) => op.op === 'update')).toHaveLength(1);
    expect(twice[0]).toMatchObject({ op: 'update', title: 'Week', ends_on: '2026-10-19' });
  });

  it('back to the plan’s own values drops the op; an empty title is never swapped for the plan’s', () => {
    const draft = headerDraftOf(bundle.plan);
    const edited = withHeaderUpdate([], bundle.plan, { ...draft, title: 'X' });
    expect(hasQueuedOps(edited)).toBe(true);
    expect(withHeaderUpdate(edited, bundle.plan, draft)).toEqual([]);
    // F11: an emptied title stays empty in the queue (Save is blocked by "Add a title.").
    expect(withHeaderUpdate([], bundle.plan, { ...draft, title: '   ' })).toEqual([
      { op: 'update', title: '', starts_on: '2026-10-12', ends_on: '2026-10-16' },
    ]);
  });
});

describe('applyPlanOps paints the queue without writing', () => {
  it('update, remove, move and reorder in order', () => {
    let ops: PlanSaveOp[] = [];
    ops = withHeaderUpdate(ops, bundle.plan, {
      title: 'Renamed',
      startsOn: '2026-10-12',
      endsOn: '2026-10-19',
    });
    ops = queueOp(ops, { op: 'remove', item_id: 'b' });
    ops = queueOp(ops, {
      op: 'move',
      item_id: 'a',
      target_date: '2026-10-18',
      item_ids: ['c', 'a'],
      keep_reviews: false,
    });
    ops = queueOp(ops, { op: 'reorder', item_ids: ['a', 'c'] });
    expect(ops.map((op) => op.op)).toEqual(['update', 'remove', 'move', 'reorder']);
    const next = applyPlanOps(bundle, ops);
    expect(next.plan).toMatchObject({ title: 'Renamed', ends_on: '2026-10-19' });
    expect(next.items.map((i) => i.id)).toEqual(['c', 'a']);
    expect(next.items.find((i) => i.id === 'a')?.target_date).toBe('2026-10-18');
    // b is gone with its review; a's tick was reset by the move (keep false).
    expect(next.reviews).toEqual([]);
    expect(removedIds(ops)).toEqual(new Set(['b']));
    // The source bundle is untouched.
    expect(bundle.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('a kept move keeps the approval; an empty queue is the same bundle', () => {
    const kept = applyPlanOps(bundle, [
      {
        op: 'move',
        item_id: 'a',
        target_date: '2026-10-15',
        item_ids: ['b', 'c', 'a'],
        keep_reviews: true,
      },
    ]);
    expect(kept.reviews.some((r) => r.item_id === 'a')).toBe(true);
    expect(applyPlanOps(bundle, [])).toBe(bundle);
    expect(hasQueuedOps([])).toBe(false);
  });
});
