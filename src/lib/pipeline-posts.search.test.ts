// Pipeline search regression: the board's search is ONE posts_search call
// (src/lib/pipeline-posts.ts searchPipelinePosts) driven by the shared runner
// (src/lib/search/server-search.ts): nothing under 2 characters, the settled
// query after the debounce, a newer query aborting the call in flight.
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/posts';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/member-role', () => ({
  readSharedMemberRole: () => Promise.resolve({ ok: true, role: 'agency' }),
}));

import { PIPELINE_POSTS_LIMIT, postsSearchArgs, searchPipelinePosts } from '@/lib/pipeline-posts';
import { createServerSearchRunner } from '@/lib/search/server-search';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  header?: string;
}

/** An rpc stand-in: records each call; answers `rows`, or never ('pending'). */
function rpcClient(rows: unknown[] | 'pending') {
  const calls: RpcCall[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    const call: RpcCall = { fn, args };
    calls.push(call);
    const builder = {
      setHeader: (_name: string, value: string) => {
        call.header = value;
        return builder;
      },
      abortSignal: (signal: AbortSignal) => {
        call.signal = signal;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        (rows === 'pending'
          ? new Promise<never>(() => {})
          : Promise.resolve({ data: rows, error: null })
        ).then(resolve, reject),
    };
    return builder;
  };
  return { client: { rpc } as unknown as Client, calls };
}

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (run: () => void): unknown => {
      const id = next++;
      pending.set(id, run);
      return id;
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    flush: (): void => {
      const runs = [...pending.values()];
      pending.clear();
      runs.forEach((run) => run());
    },
  };
}

function runnerFor(client: Client) {
  const timers = manualTimers();
  const runner = createServerSearchRunner({
    fetch: (query, signal) => searchPipelinePosts(client, { workspaceId: 'w1', query }, signal),
    onChange: () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { runner, timers };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Pipeline search (posts_search)', () => {
  it('sends nothing under 2 characters', () => {
    const { client, calls } = rpcClient([]);
    const { runner, timers } = runnerFor(client);
    runner.setQuery(' a ');
    timers.flush();
    expect(calls).toEqual([]);
  });

  it('calls posts_search with the query as typed (the proc escapes LIKE), a uuid_v7 trace and the board cap', () => {
    const { client, calls } = rpcClient([]);
    const { runner, timers } = runnerFor(client);
    runner.setQuery(' 50%_off ');
    timers.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('posts_search');
    expect(calls[0]?.args).toMatchObject({
      p_workspace_id: 'w1',
      p_query: '50%_off',
      p_limit: PIPELINE_POSTS_LIMIT,
    });
    expect(calls[0]?.args).not.toHaveProperty('p_stage');
    expect(calls[0]?.args.p_trace_id).toMatch(UUID);
    expect(calls[0]?.header).toBe(calls[0]?.args.p_trace_id);
  });

  it('a newer query aborts the call in flight', () => {
    const { client, calls } = rpcClient('pending');
    const { runner, timers } = runnerFor(client);
    runner.setQuery('la');
    timers.flush();
    expect(calls[0]?.signal?.aborted).toBe(false);
    runner.setQuery('lau');
    expect(calls[0]?.signal?.aborted).toBe(true);
    timers.flush();
    expect(calls.map((c) => c.args.p_query)).toEqual(['la', 'lau']);
  });

  it('maps rows exactly as posts_list does', async () => {
    const row = {
      id: 'p1',
      title: 'Launch',
      stage: 'review',
      thumbnail_asset_version_id: 'v1',
      first_media_asset_version_id: 'v2',
      first_media_kind: 'image',
      first_media_width: 10,
      first_media_height: 20,
    };
    const { client } = rpcClient([row]);
    const result = await searchPipelinePosts(client, { workspaceId: 'w1', query: 'launch' });
    expect(result).toEqual({
      ok: true,
      data: [
        {
          id: 'p1',
          title: 'Launch',
          stage: 'review',
          thumbnailAssetVersionId: 'v1',
          firstMedia: { assetVersionId: 'v2', kind: 'image', width: 10, height: 20 },
        },
      ],
    });
  });

  it('postsSearchArgs passes a stage only when given', () => {
    expect(
      postsSearchArgs({ workspaceId: 'w1', query: 'ab', traceId: 't', stage: 'review' }),
    ).toMatchObject({ p_stage: 'review' });
  });
});
