import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { PLAN_READ_CHUNK } from '@/lib/chat/plans';
import { PLAN_TAB_PAGE, readPlanTab } from '@/lib/plan-tab-read';

type Row = Record<string, unknown>;

interface Call {
  table: string;
  filters: string[];
  range: [number, number] | null;
  limit: number | null;
  ins: number;
}

/**
 * A recording PostgREST-ish fake: every awaited query is one request; the
 * table's rows are filtered by eq / is / in and sliced by range or limit.
 */
function fakeClient(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const from = vi.fn((table: string) => {
    const call: Call = { table, filters: [], range: null, limit: null, ins: 0 };
    let rows = [...(tables[table] ?? [])];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => {
      call.filters.push(`${c}=${String(v)}`);
      rows = rows.filter((r) => r[c] === v);
      return q;
    };
    q.in = (c: string, vs: unknown[]) => {
      call.ins = vs.length;
      rows = rows.filter((r) => vs.includes(r[c]));
      return q;
    };
    for (const m of ['is', 'gte', 'lte', 'order', 'abortSignal']) q[m] = () => q;
    q.range = (a: number, b: number) => {
      call.range = [a, b];
      return q;
    };
    q.limit = (n: number) => {
      call.limit = n;
      return q;
    };
    q.then = (resolve: (v: unknown) => unknown) => {
      calls.push(call);
      const page =
        call.range !== null
          ? rows.slice(call.range[0], call.range[1] + 1)
          : call.limit !== null
            ? rows.slice(0, call.limit)
            : rows;
      return Promise.resolve({ data: page, error: null }).then(resolve);
    };
    return q;
  });
  const rpc = vi.fn(async () => ({ data: [], error: null }));
  return { client: { from, rpc } as unknown as Client, calls, rpc };
}

function world(plans: number, itemsPer: number, posts: number): Record<string, Row[]> {
  const planRows: Row[] = [];
  const items: Row[] = [];
  const postRows: Row[] = [];
  for (let p = 0; p < plans; p += 1) {
    const id = `plan-${p}`;
    planRows.push({
      id,
      workspace_id: 'ws',
      title: id,
      starts_on: '2026-10-19',
      ends_on: '2026-10-25',
      audience: p % 2 === 0 ? 'client' : 'team',
      created_by: null,
    });
    for (let i = 0; i < itemsPer; i += 1) {
      const postId = i % 2 === 0 ? `post-${p}-${i}` : null;
      if (postId !== null) {
        postRows.push({
          id: postId,
          workspace_id: 'ws',
          title: postId,
          stage: 'review',
          target_date: '2026-10-21T12:00:00Z',
        });
      }
      items.push({
        id: `item-${p}-${i}`,
        plan_id: id,
        kind: postId !== null ? 'post' : 'concept',
        position: i,
        title: postId === null ? 'Concept' : null,
        description: null,
        post_id: postId,
        created_at: '2026-10-01T00:00:00Z',
        target_date: postId === null ? '2026-10-20' : null,
      });
    }
  }
  for (let k = 0; k < posts; k += 1) {
    postRows.push({
      id: `loose-${k}`,
      workspace_id: 'ws',
      title: `Loose ${k}`,
      stage: 'review',
      target_date: '2026-10-22T12:00:00Z',
    });
  }
  return { plans: planRows, plan_items: items, posts: postRows, plan_item_reviews: [] };
}

const INPUT = {
  workspaceId: 'ws',
  range: { start: '2026-10-19', end: '2026-10-25' },
  timeZone: 'UTC',
  onlyShared: false,
};

describe('readPlanTab', () => {
  it('makes the same number of requests for 2 plans or 40 (no read per plan or item)', async () => {
    const small = fakeClient(world(2, 2, 1));
    const large = fakeClient(world(40, 2, 10));
    const a = await readPlanTab(small.client, INPUT);
    const b = await readPlanTab(large.client, INPUT);
    expect(a.ok && b.ok).toBe(true);
    expect(small.calls.length).toBe(large.calls.length);
    expect(small.rpc.mock.calls.length).toBe(large.rpc.mock.calls.length);
    // plans, the any-plan probe, dated posts, items, reviews, posts by id, tiles.
    expect(large.calls.map((c) => c.table)).toEqual([
      'plans',
      'plans',
      'posts',
      'plan_items',
      'plan_item_reviews',
      'posts',
      'asset_attachments',
    ]);
    for (const call of large.calls) expect(call.ins).toBeLessThanOrEqual(PLAN_READ_CHUNK);
    if (b.ok) {
      expect(b.data.bundles).toHaveLength(40);
      // Posts that are plan items are never loose posts.
      expect(b.data.posts.map((p) => p.id).every((id) => id.startsWith('loose-'))).toBe(true);
      expect(b.data.posts).toHaveLength(10);
      expect(b.data.anyPlan).toBe(true);
    }
  });

  it('pages a list read at 1000 rows, then reads the next page while one is full', async () => {
    const fake = fakeClient(world(1, 0, PLAN_TAB_PAGE + 5));
    const res = await readPlanTab(fake.client, INPUT);
    expect(res.ok).toBe(true);
    const postPages = fake.calls.filter((c) => c.table === 'posts' && c.range !== null);
    expect(postPages.map((c) => c.range)).toEqual([
      [0, PLAN_TAB_PAGE - 1],
      [PLAN_TAB_PAGE, 2 * PLAN_TAB_PAGE - 1],
    ]);
    if (res.ok) expect(res.data.posts).toHaveLength(PLAN_TAB_PAGE + 5);
    const planPages = fake.calls.filter((c) => c.table === 'plans' && c.range !== null);
    expect(planPages).toHaveLength(1);
  });

  it('approvers read shared plans only; the phone reads every plan and no posts', async () => {
    const fake = fakeClient(world(4, 1, 3));
    const res = await readPlanTab(fake.client, { ...INPUT, range: null, onlyShared: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.bundles.map((b) => b.plan.audience)).toEqual(['client', 'client']);
      expect(res.data.posts).toEqual([]);
    }
    expect(
      fake.calls
        .filter((c) => c.table === 'plans')
        .every((c) => c.filters.includes('audience=client')),
    ).toBe(true);
    expect(fake.calls.some((c) => c.table === 'posts' && c.range !== null)).toBe(false);
  });

  it('says when the workspace has no plan at all', async () => {
    const fake = fakeClient(world(0, 0, 2));
    const res = await readPlanTab(fake.client, INPUT);
    expect(res.ok && res.data.anyPlan).toBe(false);
  });

  it('reads the tiles alongside the reviews, not after them (one round trip less)', async () => {
    const fake = fakeClient(world(2, 2, 1));
    const from = fake.client.from as unknown as (t: string) => Record<string, unknown>;
    let releaseReviews: () => void = () => undefined;
    const reviewsGate = new Promise<void>((done) => {
      releaseReviews = done;
    });
    const started: string[] = [];
    (fake.client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const q = from(table);
      const then = q.then as (resolve: (v: unknown) => unknown) => Promise<unknown>;
      q.then = (resolve: (v: unknown) => unknown) => {
        started.push(table);
        return table === 'plan_item_reviews'
          ? reviewsGate.then(() => then(resolve))
          : then(resolve);
      };
      return q;
    };
    const pending = readPlanTab(fake.client, INPUT);
    for (let i = 0; i < 20 && !started.includes('asset_attachments'); i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // The tiles were asked for while the reviews were still out.
    expect(started).toContain('asset_attachments');
    releaseReviews();
    const res = await pending;
    expect(res.ok).toBe(true);
  });
});
