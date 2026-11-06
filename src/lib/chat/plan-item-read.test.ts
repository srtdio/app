// planItemRead (a bank idea, no bundle) and readItemBuckets: one select per
// table, buckets batched by an id list (never per item), a missing row fails.

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  PLAN_ITEM_NOT_FOUND,
  PLAN_READ_CHUNK,
  planItemRead,
  readItemBuckets,
  withBucketIds,
  type PlanItemRow,
} from '@/lib/chat/plans';

type Call = { table: string; op: string; args: unknown[] };

/** A PostgREST double: every chain resolves to the rows given for its table. */
function fakeClient(rows: Record<string, unknown[]>, fail: Record<string, string> = {}) {
  const calls: Call[] = [];
  const from = vi.fn((table: string) => {
    const result = {
      data: fail[table] !== undefined ? null : (rows[table] ?? []),
      error: fail[table] !== undefined ? { message: fail[table] } : null,
    };
    const q: Record<string, unknown> = {};
    for (const op of ['select', 'in', 'is', 'eq', 'order', 'limit', 'range', 'contains']) {
      q[op] = (...args: unknown[]) => {
        calls.push({ table, op, args });
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return q;
  });
  return { client: { from } as unknown as Client, from, calls };
}

const idea: PlanItemRow = {
  id: 'i1',
  plan_id: null,
  kind: 'concept',
  position: 0,
  title: 'Monsoon reel',
  description: 'Rain on the farm',
  post_id: null,
  created_at: '2026-11-06T00:00:00Z',
  target_date: null,
  linked_post_id: 'p1',
  show_to_client: false,
  archived_at: null,
  starred_at: null,
  last_active_at: '2026-11-06T00:00:00Z',
  came_from_plan_title: 'Week of 2 Nov',
};

const noNames = vi.fn(() => Promise.resolve({ ok: true as const, data: [] }));

describe('readItemBuckets', () => {
  it('one select for every item on screen, grouped by item', async () => {
    const { client, from, calls } = fakeClient({
      plan_item_buckets: [
        { item_id: 'a', bucket_id: 'b1' },
        { item_id: 'a', bucket_id: 'b2' },
        { item_id: 'c', bucket_id: 'b1' },
      ],
    });
    const result = await readItemBuckets(client, ['a', 'b', 'c', 'a']);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('plan_item_buckets');
    expect(calls).toContainEqual({
      table: 'plan_item_buckets',
      op: 'in',
      args: ['item_id', ['a', 'b', 'c']],
    });
    expect(result).toEqual({ ok: true, data: { a: ['b1', 'b2'], c: ['b1'] } });
    expect(
      withBucketIds([idea, { ...idea, id: 'a' }], { a: ['b1'] }).map((i) => i.bucket_ids),
    ).toEqual([[], ['b1']]);
  });

  it('chunks at PLAN_READ_CHUNK ids per select; none reads nothing', async () => {
    const ids = Array.from({ length: PLAN_READ_CHUNK + 1 }, (_, n) => `id${n}`);
    const { client, from } = fakeClient({});
    expect((await readItemBuckets(client, ids)).ok).toBe(true);
    expect(from).toHaveBeenCalledTimes(2);
    const empty = fakeClient({});
    expect(await readItemBuckets(empty.client, [])).toEqual({ ok: true, data: {} });
    expect(empty.from).not.toHaveBeenCalled();
  });
});

describe('planItemRead', () => {
  it('the row, then comments, files, buckets and the linked post: one select each', async () => {
    const { client, from } = fakeClient({
      plan_items: [idea],
      plan_item_comments: [],
      asset_attachments: [],
      plan_item_buckets: [{ item_id: 'i1', bucket_id: 'b1' }],
      posts: [{ id: 'p1', stage: 'review', title: 'Reel', format: 'reel', target_date: null }],
    });
    const result = await planItemRead(client, 'i1', noNames);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.item).toMatchObject({ id: 'i1', plan_id: null, bucket_ids: ['b1'] });
    expect(result.data.postStages).toEqual({ p1: 'review' });
    expect(result.data.postInfo.p1).toMatchObject({ title: 'Reel' });
    expect(result.data.screen).toEqual({ comments: [], files: [], names: {} });
    const tables = from.mock.calls.map((c) => c[0]);
    expect(tables.sort()).toEqual(
      [
        'asset_attachments',
        'plan_item_buckets',
        'plan_item_comments',
        'plan_items',
        'posts',
      ].sort(),
    );
  });

  it('no linked post: no posts select', async () => {
    const { client, from } = fakeClient({ plan_items: [{ ...idea, linked_post_id: null }] });
    expect((await planItemRead(client, 'i1', noNames)).ok).toBe(true);
    expect(from.mock.calls.map((c) => c[0])).not.toContain('posts');
  });

  it('a row the viewer cannot read fails; a table error fails', async () => {
    const gone = fakeClient({ plan_items: [] });
    expect(await planItemRead(gone.client, 'i1', noNames)).toEqual({
      ok: false,
      error: { code: 'unknown', message: PLAN_ITEM_NOT_FOUND },
    });
    const broken = fakeClient({ plan_items: [idea] }, { plan_item_buckets: 'boom' });
    const result = await planItemRead(broken.client, 'i1', noNames);
    expect(result.ok).toBe(false);
  });
});
