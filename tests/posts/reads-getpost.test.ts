// Boundary coverage for getPost: a plain RLS-scoped select on posts with
// post_versions and post_annotations embedded in one round trip (no N+1). The
// spec asserts the single query, the soft-delete filter, the ascending
// version_number order on the embedded versions, the split of the embedded
// shapes off the post row, and the absent/error cases.

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/posts/src/index';
import { getPost } from '../../packages/posts/src/index';

const POST = 'post-1';

interface Call {
  method: string;
  args: unknown[];
}

// A recording PostgREST-ish builder: every chained query method returns self and
// logs its call; maybeSingle resolves the configured result. Mirrors the gallery
// read spec, but terminates on maybeSingle rather than an awaited chain.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order']) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.maybeSingle = (...args: unknown[]) => {
    calls.push({ method: 'maybeSingle', args });
    return Promise.resolve(result);
  };
  const from = vi.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return b;
  });
  return { client: { from } as unknown as Client, from, calls };
}

function postRow() {
  return {
    id: POST,
    workspace_id: 'w',
    title: 'A post',
    caption: 'c',
    stage: 'draft',
    deleted_at: null,
    post_versions: [
      {
        id: 'v1',
        version_number: 1,
        snapshot: { caption: 'c', gallery: [] },
        created_by: 'u',
        created_at: 't1',
      },
      {
        id: 'v2',
        version_number: 2,
        snapshot: { caption: 'c2', gallery: [] },
        created_by: 'u',
        created_at: 't2',
      },
    ],
    post_annotations: [{ id: 'a1', kind: 'caption_span' }],
  };
}

describe('getPost', () => {
  it('reads one post with versions + annotations embedded, in one query', async () => {
    const { client, from, calls } = makeClient({ data: postRow(), error: null });

    const result = await getPost(client, POST);

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('posts');
    expect(calls).toContainEqual({ method: 'eq', args: ['id', POST] });
    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    expect(calls).toContainEqual({ method: 'maybeSingle', args: [] });
    expect(result.ok && result.data?.versions.map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(result.ok && result.data?.annotations.map((a) => a.id)).toEqual(['a1']);
    // The embedded versions ride the post row; the post itself excludes them.
    expect(result.ok && result.data !== null && 'post_versions' in result.data.post).toBe(false);
  });

  it('orders the embedded versions by version_number ascending', async () => {
    const { client, calls } = makeClient({ data: postRow(), error: null });
    await getPost(client, POST);
    expect(calls).toContainEqual({
      method: 'order',
      args: ['version_number', { referencedTable: 'post_versions', ascending: true }],
    });
  });

  it('returns { data: null } when the post is absent or hidden by RLS', async () => {
    const { client } = makeClient({ data: null, error: null });
    const result = await getPost(client, POST);
    expect(result.ok && result.data).toBeNull();
  });

  it('surfaces a read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    const result = await getPost(client, POST);
    expect(result.ok).toBe(false);
  });
});
