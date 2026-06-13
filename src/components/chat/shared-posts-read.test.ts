import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { listPostsForPicker, readPostsByIds } from '@srtdio/posts';

const WS = 'ws-1';

interface Call {
  method: string;
  args: unknown[];
}

// A recording PostgREST-ish builder: every chained query method returns self and
// logs its call; awaiting yields the configured result. Mirrors chat-reads.test.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'in', 'ilike', 'order', 'limit']) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const from = vi.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return b;
  });
  return { client: { from } as unknown as Client, from, calls };
}

describe('listPostsForPicker', () => {
  it('is RLS-scoped: filters by workspace and stage, newest first', async () => {
    const { client, from, calls } = makeClient({
      data: [{ id: 'p1', title: 'A', platform: 'instagram', format: 'reel', stage: 'review' }],
      error: null,
    });

    const result = await listPostsForPicker(client, { workspaceId: WS, stage: 'review' });

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('posts');
    expect(calls).toContainEqual({ method: 'eq', args: ['workspace_id', WS] });
    expect(calls).toContainEqual({ method: 'eq', args: ['stage', 'review'] });
    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    expect(result.ok && result.data).toHaveLength(1);
  });

  it('applies a case-insensitive title match when a search term is given', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await listPostsForPicker(client, { workspaceId: WS, titleQuery: 'launch' });
    expect(calls).toContainEqual({ method: 'ilike', args: ['title', '%launch%'] });
  });

  it('passes no stage for "All Posts" and no title filter for a blank search', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await listPostsForPicker(client, { workspaceId: WS, titleQuery: '   ' });
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'stage')).toBe(false);
    expect(calls.some((c) => c.method === 'ilike')).toBe(false);
  });

  it('surfaces a read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    const result = await listPostsForPicker(client, { workspaceId: WS });
    expect(result.ok).toBe(false);
  });
});

describe('readPostsByIds', () => {
  it('resolves every id in ONE batched IN read (no per-id loop)', async () => {
    const { client, from, calls } = makeClient({
      data: [
        { id: 'p1', title: 'A', platform: 'instagram', format: 'reel', stage: 'review' },
        { id: 'p2', title: 'B', platform: 'tiktok', format: 'video', stage: 'approved' },
      ],
      error: null,
    });

    const result = await readPostsByIds(client, { workspaceId: WS, ids: ['p1', 'p2'] });

    // Batched: a single posts read, a single IN clause over all ids.
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('posts');
    const inCalls = calls.filter((c) => c.method === 'in');
    expect(inCalls).toHaveLength(1);
    expect(inCalls[0]?.args).toEqual(['id', ['p1', 'p2']]);
    expect(calls).toContainEqual({ method: 'eq', args: ['workspace_id', WS] });
    expect(result.ok && result.data).toHaveLength(2);
  });

  it('does not read when there are no ids', async () => {
    const { client, from } = makeClient({ data: [], error: null });
    const result = await readPostsByIds(client, { workspaceId: WS, ids: [] });
    expect(from).not.toHaveBeenCalled();
    expect(result.ok && result.data).toEqual([]);
  });

  it('surfaces a read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    const result = await readPostsByIds(client, { workspaceId: WS, ids: ['p1'] });
    expect(result.ok).toBe(false);
  });
});
