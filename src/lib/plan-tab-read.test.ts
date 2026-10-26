import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { PLAN_BUNDLE_PAGE } from '@/lib/chat/plan-bundle';
import { mergePlanTabPages, readPlanTab } from '@/lib/plan-tab-read';

type Row = Record<string, unknown>;

interface World {
  timezone: string;
  plans: Row[];
  items: Row[];
  posts: Row[];
}

/** `plans` plans, one a day back from 25 Oct, each with one post item; `loose` posts on 22 Oct. */
function world(plans: number, loose: number, timezone = 'UTC'): World {
  const w: World = { timezone, plans: [], items: [], posts: [] };
  for (let p = 0; p < plans; p += 1) {
    const day = new Date(Date.UTC(2026, 9, 25 - p)).toISOString().slice(0, 10);
    const id = `plan-${String(p).padStart(3, '0')}`;
    w.plans.push({
      id,
      workspace_id: 'ws',
      title: id,
      starts_on: day,
      ends_on: day,
      audience: p % 2 === 0 ? 'client' : 'team',
      created_by: null,
    });
    w.items.push({
      id: `item-${p}`,
      plan_id: id,
      kind: 'post',
      position: 0,
      title: null,
      description: null,
      post_id: `post-${p}`,
      created_at: '2026-10-01T00:00:00Z',
      target_date: null,
    });
    w.posts.push({ id: `post-${p}`, stage: 'review', title: 'P', target_date: `${day}T12:00:00Z` });
  }
  for (let k = 0; k < loose; k += 1) {
    w.posts.push({
      id: `loose-${k}`,
      stage: 'review',
      title: `Loose ${k}`,
      target_date: '2026-10-22T12:00:00Z',
    });
  }
  return w;
}

/** plan_bundle_read in tab mode over the world, as the proc pages it. */
function fakeClient(w: World) {
  const calls: Array<Record<string, unknown>> = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, ...args });
    const start = typeof args.p_range_start === 'string' ? args.p_range_start : null;
    const end = typeof args.p_range_end === 'string' ? args.p_range_end : null;
    const shared = args.p_only_shared === true;
    const beforeOn = typeof args.p_before_starts_on === 'string' ? args.p_before_starts_on : null;
    const beforeId = typeof args.p_before_id === 'string' ? args.p_before_id : null;
    const key = (p: Row): string => `${String(p.starts_on)}|${String(p.id)}`;
    const visible = w.plans.filter((p) => !shared || p.audience === 'client');
    const sel = visible
      .filter(
        (p) => start === null || (String(p.starts_on) <= String(end) && String(p.ends_on) >= start),
      )
      .filter((p) => beforeOn === null || key(p) < `${beforeOn}|${String(beforeId)}`)
      .sort((a, b) => (key(a) < key(b) ? 1 : -1))
      .slice(0, PLAN_BUNDLE_PAGE + 1);
    const page = sel.slice(0, PLAN_BUNDLE_PAGE);
    const last = page[page.length - 1];
    const ids = new Set(page.map((p) => p.id));
    const items = w.items.filter((i) => ids.has(i.plan_id));
    const postIds = new Set(items.map((i) => i.post_id));
    return {
      data: {
        timezone: w.timezone,
        plans: [...page].sort((a, b) => (key(a) < key(b) ? -1 : 1)),
        items,
        draft_rows: [],
        next_cursor:
          sel.length > PLAN_BUNDLE_PAGE && last !== undefined
            ? { starts_on: last.starts_on, id: last.id }
            : null,
        reviews: [],
        posts: w.posts.filter((p) => postIds.has(p.id)),
        comment_counts: {},
        thumbs: {
          posts: Object.fromEntries([...postIds].map((id) => [String(id), `v-${String(id)}`])),
          concepts: {},
        },
        also_in: null,
        loose_posts:
          start !== null
            ? w.posts.filter((p) => String(p.target_date).slice(0, 10) >= '2026-10-01')
            : [],
        any_plan: page.length > 0 || (start !== null && visible.length > 0),
        last_sent_at: null,
      },
      error: null,
    };
  });
  const from = vi.fn(() => {
    throw new Error('no table reads');
  });
  return { client: { rpc, from } as unknown as Client, calls, rpc, from };
}

const RANGE = { start: '2026-10-19', end: '2026-10-25' };
const INPUT = { workspaceId: 'ws', range: RANGE, onlyShared: false };

describe('readPlanTab (plan_bundle_read, tab mode)', () => {
  it('one request for a range of up to a page of plans, no table read, no zone read', async () => {
    const fake = fakeClient(world(5, 2));
    const res = await readPlanTab(fake.client, INPUT);
    expect(res.ok).toBe(true);
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.from).not.toHaveBeenCalled();
    expect(fake.calls[0]).toMatchObject({
      fn: 'plan_bundle_read',
      p_workspace_id: 'ws',
      p_range_start: RANGE.start,
      p_range_end: RANGE.end,
    });
    expect(fake.calls[0]).not.toHaveProperty('p_plan_ids');
    expect(fake.calls[0]).not.toHaveProperty('_trace_id');
    if (!res.ok) return;
    // starts_on then id order, whatever order the page came in.
    const starts = res.data.bundles.map((b) => b.plan.starts_on);
    expect(starts).toEqual([...starts].sort());
    // Posts that are plan items are never loose posts.
    expect(res.data.posts.map((p) => p.id)).toEqual(['loose-0', 'loose-1']);
    expect(res.data.anyPlan).toBe(true);
    expect(res.data.nextCursor).toBeNull();
    expect(res.data.thumbs.posts['post-0']).toBe('v-post-0');
  });

  it('the zone comes from the bundle: a loose post is kept by its day there', async () => {
    const w = world(1, 0, 'America/Los_Angeles');
    // 26 Oct 03:00 UTC is 25 Oct in Los Angeles (inside the range), 26 Oct in UTC (outside).
    w.posts.push({
      id: 'late',
      stage: 'draft',
      title: 'Late',
      target_date: '2026-10-26T03:00:00Z',
    });
    const fake = fakeClient(w);
    const res = await readPlanTab(fake.client, INPUT);
    expect(res.ok && res.data.timeZone).toBe('America/Los_Angeles');
    expect(res.ok && res.data.posts.map((p) => p.id)).toEqual(['late']);
    const utc = await readPlanTab(fakeClient({ ...w, timezone: 'UTC' }).client, INPUT);
    expect(utc.ok && utc.data.posts).toEqual([]);
  });

  it('a range with more than a page of plans reads on with the cursor (the grid cannot page)', async () => {
    const w = world(30, 0);
    for (const p of w.plans) {
      p.starts_on = '2026-10-19';
      p.ends_on = '2026-10-25';
    }
    const fake = fakeClient(w);
    const res = await readPlanTab(fake.client, INPUT);
    expect(fake.rpc).toHaveBeenCalledTimes(3);
    expect(fake.calls[1]).toMatchObject({ p_before_starts_on: '2026-10-19' });
    expect(res.ok && res.data.bundles).toHaveLength(30);
    expect(res.ok && res.data.nextCursor).toBeNull();
  });

  it('the phone list reads one page and hands back the cursor; the cursor becomes the next args', async () => {
    const fake = fakeClient(world(30, 0));
    const first = await readPlanTab(fake.client, { ...INPUT, range: null });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.calls[0]).not.toHaveProperty('p_range_start');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.bundles).toHaveLength(PLAN_BUNDLE_PAGE);
    expect(first.data.posts).toEqual([]);
    const cursor = first.data.nextCursor;
    expect(cursor).not.toBeNull();
    if (cursor === null) return;
    // The newest 12: plan-000 (25 Oct) back to plan-011.
    expect(cursor).toEqual({ startsOn: '2026-10-14', id: 'plan-011' });
    const second = await readPlanTab(fake.client, { ...INPUT, range: null, before: cursor });
    expect(fake.calls[1]).toMatchObject({
      p_before_starts_on: '2026-10-14',
      p_before_id: 'plan-011',
    });
    if (!second.ok) return;
    const merged = mergePlanTabPages(first.data, second.data);
    expect(merged.bundles).toHaveLength(24);
    const third = await readPlanTab(fake.client, {
      ...INPUT,
      range: null,
      before: merged.nextCursor,
    });
    if (!third.ok) return;
    const all = mergePlanTabPages(merged, third.data);
    expect(all.bundles).toHaveLength(30);
    // The last page: no cursor (the Load more hides).
    expect(all.nextCursor).toBeNull();
    const ids = all.bundles.map((b) => b.plan.id);
    expect(new Set(ids).size).toBe(30);
    expect(all.bundles.map((b) => b.plan.starts_on)).toEqual(
      [...all.bundles.map((b) => b.plan.starts_on)].sort(),
    );
  });

  it('approvers read shared plans only (p_only_shared)', async () => {
    const fake = fakeClient(world(4, 0));
    const res = await readPlanTab(fake.client, { ...INPUT, range: null, onlyShared: true });
    expect(fake.calls[0]).toMatchObject({ p_only_shared: true });
    expect(res.ok && res.data.bundles.map((b) => b.plan.audience)).toEqual(['client', 'client']);
  });

  it('says when the workspace has no plan at all', async () => {
    const res = await readPlanTab(fakeClient(world(0, 2)).client, INPUT);
    expect(res.ok && res.data.anyPlan).toBe(false);
  });

  it('a failed read fails (never throws)', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'workspace_member_only' } }));
    const res = await readPlanTab({ rpc } as unknown as Client, INPUT);
    expect(!res.ok && res.error.code).toBe('workspace_member_only');
  });
});

describe('mergePlanTabPages', () => {
  it('dedupes by plan id, merges tiles, takes the later cursor', async () => {
    const fake = fakeClient(world(14, 0));
    const first = await readPlanTab(fake.client, { ...INPUT, range: null });
    if (!first.ok) return;
    const again = mergePlanTabPages(first.data, first.data);
    expect(again.bundles).toHaveLength(first.data.bundles.length);
    const later = {
      ...first.data,
      nextCursor: null,
      thumbs: { posts: { x: 'v-x' }, concepts: {} },
    };
    const merged = mergePlanTabPages(first.data, later);
    expect(merged.nextCursor).toBeNull();
    expect(merged.thumbs.posts.x).toBe('v-x');
    expect(merged.thumbs.posts['post-0']).toBe('v-post-0');
  });
});
