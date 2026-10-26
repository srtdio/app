import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  PLAN_BUNDLE_CHUNK,
  PLAN_BUNDLE_PAGE,
  parsePlanBundle,
  planBundleArgs,
  readPlanBundleRpc,
} from '@/lib/chat/plan-bundle';

const TRACE = '01900000-0000-7000-8000-000000000000';

// A PostgREST-like builder: setHeader and abortSignal return the same builder,
// and awaiting it resolves the answer. rpc() returns it, so the X-Trace-Id the
// call stamps is observable beside the p_trace_id it sends.
function headerClient(answer: { data: unknown; error: null }) {
  const setHeader = vi.fn<(name: string, value: string) => unknown>();
  const abortSignal = vi.fn<(signal: AbortSignal) => unknown>();
  const builder = {
    setHeader,
    abortSignal,
    then: (resolve: (value: typeof answer) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(answer).then(resolve, reject),
  };
  setHeader.mockReturnValue(builder);
  abortSignal.mockReturnValue(builder);
  const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => typeof builder>(() => builder);
  return { client: { rpc } as unknown as Client, rpc, setHeader, abortSignal };
}

/** One plan_bundle_read answer in the proc's exact jsonb shape. */
const RAW = {
  timezone: 'Asia/Kolkata',
  plans: [
    {
      id: 'plan-1',
      workspace_id: 'ws',
      title: 'Week',
      starts_on: '2026-10-19',
      ends_on: '2026-10-25',
      audience: 'client',
      created_by: 'u1',
      updated_at: '2026-10-18T10:00:00.000000Z',
    },
    // A malformed row is dropped.
    { id: 'broken', audience: 'client' },
  ],
  items: [
    {
      id: 'item-c',
      plan_id: 'plan-1',
      kind: 'concept',
      position: 1,
      title: 'Reel',
      description: 'd',
      post_id: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      target_date: '2026-10-20',
    },
    {
      id: 'item-p',
      plan_id: 'plan-1',
      kind: 'post',
      position: 0,
      title: null,
      description: null,
      post_id: 'post-1',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-02T00:00:00Z',
      target_date: null,
    },
  ],
  draft_rows: [
    {
      plan_id: 'plan-1',
      item_id: 'item-d',
      item_position: 2,
      post_number: 7,
      title: 'Draft',
      target_date: '2026-10-21T06:30:00+00:00',
    },
  ],
  next_cursor: { starts_on: '2026-10-19', id: 'plan-1' },
  reviews: [
    {
      item_id: 'item-c',
      side: 'client',
      status: 'approved',
      reviewed_by: 'u2',
      reviewed_at: '2026-10-03T00:00:00Z',
    },
    { item_id: 'item-p', side: 'nobody', status: 'approved' },
  ],
  posts: [
    {
      id: 'post-1',
      stage: 'review',
      title: 'Carousel',
      format: 'carousel',
      target_date: '2026-10-21T06:30:00+00:00',
    },
  ],
  comment_counts: { 'item-c': 3 },
  thumbs: {
    posts: { 'post-1': 'v-post' },
    concepts: { 'item-c': { kind: 'image', versionId: 'v-c' }, 'item-x': { kind: 'file' } },
  },
  also_in: { 'post-1': ['Launch', 'October'] },
  loose_posts: [{ id: 'loose-1', title: 'Loose', stage: 'draft', target_date: null }],
  any_plan: true,
  last_sent_at: '2026-10-18T09:00:00.000000Z',
};

describe('parsePlanBundle', () => {
  it('maps every part of the jsonb', () => {
    const res = parsePlanBundle(RAW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = res.data;
    expect(d.timezone).toBe('Asia/Kolkata');
    expect(d.plans).toEqual([
      {
        id: 'plan-1',
        workspace_id: 'ws',
        title: 'Week',
        starts_on: '2026-10-19',
        ends_on: '2026-10-25',
        audience: 'client',
        created_by: 'u1',
        updated_at: '2026-10-18T10:00:00.000000Z',
      },
    ]);
    expect(d.items.map((i) => [i.id, i.kind, i.post_id, i.target_date])).toEqual([
      ['item-c', 'concept', null, '2026-10-20'],
      ['item-p', 'post', 'post-1', null],
    ]);
    expect(d.items[0]?.updated_at).toBe('2026-10-02T00:00:00Z');
    expect(d.draftRows).toEqual([
      {
        plan_id: 'plan-1',
        item_id: 'item-d',
        item_position: 2,
        post_number: 7,
        title: 'Draft',
        target_date: '2026-10-21T06:30:00+00:00',
      },
    ]);
    expect(d.nextCursor).toEqual({ startsOn: '2026-10-19', id: 'plan-1' });
    expect(d.reviews).toEqual([
      {
        item_id: 'item-c',
        side: 'client',
        status: 'approved',
        reviewed_by: 'u2',
        reviewed_at: '2026-10-03T00:00:00Z',
      },
    ]);
    expect(d.posts).toEqual([
      {
        id: 'post-1',
        stage: 'review',
        title: 'Carousel',
        format: 'carousel',
        target_date: '2026-10-21T06:30:00+00:00',
      },
    ]);
    expect(d.commentCounts).toEqual({ 'item-c': 3 });
    expect(d.thumbs).toEqual({
      posts: { 'post-1': 'v-post' },
      concepts: { 'item-c': { kind: 'image', versionId: 'v-c' }, 'item-x': { kind: 'file' } },
    });
    expect(d.alsoIn).toEqual({ 'post-1': ['Launch', 'October'] });
    expect(d.loosePosts).toEqual([
      { id: 'loose-1', title: 'Loose', stage: 'draft', target_date: null },
    ]);
    expect(d.anyPlan).toBe(true);
    expect(d.lastSentAt).toBe('2026-10-18T09:00:00.000000Z');
  });

  it('a null next_cursor, also_in and last_sent_at read as none', () => {
    const res = parsePlanBundle({
      ...RAW,
      next_cursor: null,
      also_in: null,
      last_sent_at: null,
      any_plan: false,
    });
    expect(res.ok && res.data.nextCursor).toBeNull();
    expect(res.ok && res.data.alsoIn).toEqual({});
    expect(res.ok && res.data.lastSentAt).toBeNull();
    expect(res.ok && res.data.anyPlan).toBe(false);
  });

  it('absent lists and maps read as empty', () => {
    const res = parsePlanBundle({ timezone: 'UTC' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plans).toEqual([]);
    expect(res.data.items).toEqual([]);
    expect(res.data.thumbs).toEqual({ posts: {}, concepts: {} });
    expect(res.data.commentCounts).toEqual({});
  });

  it('anything but an object with a timezone fails', () => {
    expect(parsePlanBundle(null).ok).toBe(false);
    expect(parsePlanBundle([]).ok).toBe(false);
    expect(parsePlanBundle({ plans: [] }).ok).toBe(false);
  });
});

describe('planBundleArgs', () => {
  it('by id: explicit p_trace_id, ids deduped and capped at 200, no _trace_id', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    const args = planBundleArgs({ workspaceId: 'ws', planIds: ['p0', ...ids] }, TRACE);
    expect(args.p_trace_id).toBe(TRACE);
    expect(args.p_workspace_id).toBe('ws');
    expect(args.p_plan_ids).toHaveLength(PLAN_BUNDLE_CHUNK);
    expect(PLAN_BUNDLE_CHUNK).toBe(200);
    expect(Object.keys(args)).not.toContain('_trace_id');
    expect(Object.keys(args)).not.toContain('p_before_starts_on');
  });

  it('tab mode: range, shared only and the cursor as p_before_*', () => {
    const args = planBundleArgs(
      {
        workspaceId: 'ws',
        range: { start: '2026-10-01', end: '2026-10-31' },
        onlyShared: true,
        before: { startsOn: '2026-10-05', id: 'plan-9' },
      },
      TRACE,
    );
    expect(args).toEqual({
      p_trace_id: TRACE,
      p_workspace_id: 'ws',
      p_range_start: '2026-10-01',
      p_range_end: '2026-10-31',
      p_only_shared: true,
      p_before_starts_on: '2026-10-05',
      p_before_id: 'plan-9',
    });
    expect(PLAN_BUNDLE_PAGE).toBe(12);
  });

  it('one plan with a chat: p_channel_id (the last send)', () => {
    const args = planBundleArgs({ workspaceId: 'ws', planIds: ['a'], channelId: 'dm__x' }, TRACE);
    expect(args.p_channel_id).toBe('dm__x');
    expect(args.p_plan_ids).toEqual(['a']);
  });
});

describe('readPlanBundleRpc', () => {
  it('stamps X-Trace-Id with the exact p_trace_id it sends, then attaches the signal', async () => {
    const { client, rpc, setHeader, abortSignal } = headerClient({ data: RAW, error: null });
    const signal = new AbortController().signal;
    const res = await readPlanBundleRpc(
      client,
      { workspaceId: 'ws', planIds: ['plan-1'], traceId: TRACE },
      signal,
    );
    expect(res.ok && res.data.plans.map((p) => p.id)).toEqual(['plan-1']);
    expect(rpc.mock.calls[0]?.[0]).toBe('plan_bundle_read');
    const traceId = rpc.mock.calls[0]?.[1].p_trace_id;
    expect(traceId).toBe(TRACE);
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Trace-Id', traceId);
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });

  it('a minted trace id is a uuid v7 and is the X-Trace-Id header too', async () => {
    const { client, rpc, setHeader } = headerClient({ data: RAW, error: null });
    await readPlanBundleRpc(client, { workspaceId: 'ws', planIds: ['a'] });
    const traceId = rpc.mock.calls[0]?.[1].p_trace_id;
    expect(String(traceId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(setHeader).toHaveBeenCalledWith('X-Trace-Id', traceId);
  });

  it('one rpc call with the built args, parsed', async () => {
    const rpc = vi.fn(async () => ({ data: RAW, error: null }));
    const res = await readPlanBundleRpc({ rpc } as unknown as Client, {
      workspaceId: 'ws',
      planIds: ['plan-1'],
      traceId: TRACE,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('plan_bundle_read', {
      p_trace_id: TRACE,
      p_workspace_id: 'ws',
      p_plan_ids: ['plan-1'],
    });
    expect(res.ok && res.data.plans.map((p) => p.id)).toEqual(['plan-1']);
  });

  it('a generated trace id is a uuid v7 when none is given', async () => {
    const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<unknown>>(
      async () => ({
        data: RAW,
        error: null,
      }),
    );
    await readPlanBundleRpc({ rpc } as unknown as Client, { workspaceId: 'ws', planIds: ['a'] });
    const args = rpc.mock.calls[0]?.[1];
    expect(String(args?.p_trace_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("'workspace_member_only' keeps its code; other errors are unknown", async () => {
    const refused = vi.fn(async () => ({
      data: null,
      error: { message: 'workspace_member_only' },
    }));
    const a = await readPlanBundleRpc({ rpc: refused } as unknown as Client, {
      workspaceId: 'ws',
    });
    expect(!a.ok && a.error.code).toBe('workspace_member_only');
    const broken = vi.fn(async () => ({ data: null, error: { message: 'boom' } }));
    const b = await readPlanBundleRpc({ rpc: broken } as unknown as Client, { workspaceId: 'ws' });
    expect(!b.ok && b.error.code).toBe('unknown');
  });

  it('never throws', async () => {
    const rpc = vi.fn(() => {
      throw new Error('offline');
    });
    const res = await readPlanBundleRpc({ rpc } as unknown as Client, { workspaceId: 'ws' });
    expect(res.ok).toBe(false);
  });
});
