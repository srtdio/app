// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, PipelinePost, listPosts } from '@srtdio/posts';
import type { Result } from '@srtdio/rpc';

// The Pipeline's shared posts read: a tab return paints the kept posts at any
// age (keptPipelinePosts); inside the freshness window the page's refresh
// joins them with no request, past it the refresh asks again. A nav press and
// the mount share one request. Change events mark the kept read stale, never
// drop it; the board's own writes replace it.

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/member-role', () => ({
  readSharedMemberRole: () => Promise.resolve({ ok: true, role: 'agency' }),
}));

import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import {
  keptPipelinePosts,
  prefetchPipelineData,
  primePipelinePosts,
  readPipelinePosts,
  stalePipelinePosts,
} from '@/lib/pipeline-posts';
import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';

const client = {} as Client;
const post = { id: 'p1', stage: 'review' } as unknown as PipelinePost;
const moved = { id: 'p1', stage: 'parked' } as unknown as PipelinePost;

function reader() {
  return vi.fn(async (): Promise<Result<PipelinePost[]>> => ({ ok: true, data: [post] }));
}

const failed = (): Promise<Result<PipelinePost[]>> =>
  Promise.resolve({ ok: false, error: { code: 'unknown', message: 'boom' } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  resetSessionReads();
});

describe('Pipeline posts on tab return', () => {
  it('inside the window: the kept posts paint and the refresh asks nothing', async () => {
    const read = reader();
    await readPipelinePosts(client, 'u1', 'w1', read);
    vi.setSystemTime(Date.now() + READ_FRESH_MS - 1);
    expect(keptPipelinePosts('u1', 'w1')).toEqual([post]);
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('past the window: the kept posts still paint, and the refresh asks again', async () => {
    const read = reader();
    await readPipelinePosts(client, 'u1', 'w1', read);
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1);
    expect(keptPipelinePosts('u1', 'w1')).toEqual([post]);
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a first read still running is joined and paints nothing early', async () => {
    let land: (value: Result<PipelinePost[]>) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<Result<PipelinePost[]>>((resolve) => {
          land = resolve;
        }),
    );
    const first = readPipelinePosts(client, 'u1', 'w1', read);
    const second = readPipelinePosts(client, 'u1', 'w1', read);
    expect(keptPipelinePosts('u1', 'w1')).toBeUndefined();
    land({ ok: true, data: [post] });
    expect(await first).toEqual(await second);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a failed first read is never kept; a failed refresh keeps the last posts', async () => {
    await readPipelinePosts(client, 'u1', 'w1', failed);
    expect(keptPipelinePosts('u1', 'w1')).toBeUndefined();

    await readPipelinePosts(client, 'u1', 'w1', reader());
    stalePipelinePosts('u1', 'w1');
    await readPipelinePosts(client, 'u1', 'w1', failed);
    expect(keptPipelinePosts('u1', 'w1')).toEqual([post]);
  });

  it('a post or plan change, or the board marking it, keeps the posts and reads again', async () => {
    const read = reader();
    await readPipelinePosts(client, 'u1', 'w1', read);

    window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId: 'p1' } }));
    expect(keptPipelinePosts('u1', 'w1')).toEqual([post]);
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT));
    expect(keptPipelinePosts('u1', 'w1')).toEqual([post]);
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read).toHaveBeenCalledTimes(3);

    stalePipelinePosts('u1', 'w1');
    expect(keptPipelinePosts('u1', 'w1')).toEqual([post]);
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("the board's own write replaces the kept posts as a fresh read", async () => {
    const read = reader();
    await readPipelinePosts(client, 'u1', 'w1', read);
    primePipelinePosts('u1', 'w1', [moved]);
    expect(keptPipelinePosts('u1', 'w1')).toEqual([moved]);
    const joined = await readPipelinePosts(client, 'u1', 'w1', read);
    expect(joined).toEqual({ ok: true, data: [moved] });
    expect(read).toHaveBeenCalledTimes(1);
    // A later change still marks the written posts stale.
    window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId: 'p1' } }));
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never serves another user or workspace', async () => {
    await readPipelinePosts(client, 'u1', 'w1', reader());
    expect(keptPipelinePosts('u2', 'w1')).toBeUndefined();
    expect(keptPipelinePosts('u1', 'w2')).toBeUndefined();
  });

  it('a nav press starts the read and the mount joins it: one request', async () => {
    const read = reader();
    // The press starts the read through the page's own key; stand in for the
    // network by starting it with the same reader first, then the press joins.
    const mount = readPipelinePosts(client, 'u1', 'w1', read);
    await prefetchPipelineData({ userId: 'u1', workspaceId: 'w1' });
    await mount;
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('Pipeline posts trace id', () => {
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("passes the load's trace id to listPosts (posts_list p_trace_id)", async () => {
    const read = reader();
    await readPipelinePosts(client, 'u1', 'w1', read, '01920000-0000-7000-8000-0000000000bb');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(client, {
      workspaceId: 'w1',
      limit: 500,
      traceId: '01920000-0000-7000-8000-0000000000bb',
    });
  });

  it('mints a uuid v7 trace id when the caller passes none (nav-press prefetch)', async () => {
    const read = vi.fn<typeof listPosts>(async () => ({ ok: true, data: [post] }));
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read.mock.calls[0]?.[1].traceId).toMatch(V7);
  });

  it("a joined read keeps the first load's trace id: one request, one trace", async () => {
    const read = reader();
    const first = readPipelinePosts(
      client,
      'u1',
      'w1',
      read,
      '01920000-0000-7000-8000-0000000000c1',
    );
    const second = readPipelinePosts(
      client,
      'u1',
      'w1',
      read,
      '01920000-0000-7000-8000-0000000000c2',
    );
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ traceId: '01920000-0000-7000-8000-0000000000c1' }),
    );
  });
});
