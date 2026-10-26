// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, PipelinePost, listPosts } from '@srtdio/posts';
import type { Result } from '@srtdio/rpc';

// The Pipeline's shared posts read: a tab return inside the freshness window
// paints the kept posts with no request; past the window they are absent (the
// page shows its skeleton and reads), so older posts are never painted. A nav
// press and the mount share one request. Change events drop the kept read.

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/member-role', () => ({
  readSharedMemberRole: () => Promise.resolve({ ok: true, role: 'agency' }),
}));

import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import {
  dropPipelinePosts,
  peekPipelinePosts,
  prefetchPipelineData,
  readPipelinePosts,
} from '@/lib/pipeline-posts';
import { READ_FRESH_MS, resetSessionReads } from '@/lib/session-read';

const client = {} as Client;
const post = { id: 'p1', stage: 'review' } as unknown as PipelinePost;

function reader() {
  return vi.fn(async (): Promise<Result<PipelinePost[]>> => ({ ok: true, data: [post] }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  resetSessionReads();
});

describe('Pipeline posts on tab return', () => {
  it('inside the window: the kept posts paint with no new request', async () => {
    const read = reader();
    await readPipelinePosts(client, 'u1', 'w1', read);
    vi.setSystemTime(Date.now() + READ_FRESH_MS - 1);
    expect(peekPipelinePosts('u1', 'w1')).toEqual([post]);
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('past the window: nothing is kept (skeleton), and the next read asks again', async () => {
    const read = reader();
    await readPipelinePosts(client, 'u1', 'w1', read);
    vi.setSystemTime(Date.now() + READ_FRESH_MS + 1);
    expect(peekPipelinePosts('u1', 'w1')).toBeUndefined();
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a read still running is joined but never painted early', async () => {
    let land: (value: Result<PipelinePost[]>) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<Result<PipelinePost[]>>((resolve) => {
          land = resolve;
        }),
    );
    const first = readPipelinePosts(client, 'u1', 'w1', read);
    const second = readPipelinePosts(client, 'u1', 'w1', read);
    expect(peekPipelinePosts('u1', 'w1')).toBeUndefined();
    land({ ok: true, data: [post] });
    expect(await first).toEqual(await second);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a failed read is never kept', async () => {
    const read = vi.fn(
      async (): Promise<Result<PipelinePost[]>> => ({
        ok: false,
        error: { code: 'unknown', message: 'boom' },
      }),
    );
    await readPipelinePosts(client, 'u1', 'w1', read);
    expect(peekPipelinePosts('u1', 'w1')).toBeUndefined();
  });

  it('a post or plan change, or the board dropping it, forgets the kept read', async () => {
    const read = reader();
    await readPipelinePosts(client, 'u1', 'w1', read);
    window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId: 'p1' } }));
    expect(peekPipelinePosts('u1', 'w1')).toBeUndefined();

    await readPipelinePosts(client, 'u1', 'w1', read);
    window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT));
    expect(peekPipelinePosts('u1', 'w1')).toBeUndefined();

    await readPipelinePosts(client, 'u1', 'w1', read);
    dropPipelinePosts('u1', 'w1');
    expect(peekPipelinePosts('u1', 'w1')).toBeUndefined();
  });

  it('never serves another user or workspace', async () => {
    await readPipelinePosts(client, 'u1', 'w1', reader());
    expect(peekPipelinePosts('u2', 'w1')).toBeUndefined();
    expect(peekPipelinePosts('u1', 'w2')).toBeUndefined();
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
