// Autosave paint: ops waiting behind their Undo strip are laid over the read
// in order by applyPlanOps; nothing is written by the paint.

import { describe, expect, it } from 'vitest';
import type { PlanSaveOp } from '@srtdio/rpc';
import { applyPlanOps } from '@/lib/chat/plan-drag';
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

describe('applyPlanOps paints the pending ops without writing', () => {
  it('update, remove, move and reorder in order', () => {
    const ops: PlanSaveOp[] = [
      { op: 'update', title: 'Renamed', starts_on: '2026-10-12', ends_on: '2026-10-19' },
      { op: 'remove', item_id: 'b' },
      {
        op: 'move',
        item_id: 'a',
        target_date: '2026-10-18',
        item_ids: ['c', 'a'],
        keep_reviews: false,
      },
      { op: 'reorder', item_ids: ['a', 'c'] },
    ];
    const next = applyPlanOps(bundle, ops);
    expect(next.plan).toMatchObject({ title: 'Renamed', ends_on: '2026-10-19' });
    expect(next.items.map((i) => i.id)).toEqual(['c', 'a']);
    expect(next.items.find((i) => i.id === 'a')?.target_date).toBe('2026-10-18');
    // b is gone with its review; a's tick was reset by the move (keep false).
    expect(next.reviews).toEqual([]);
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
  });
});
