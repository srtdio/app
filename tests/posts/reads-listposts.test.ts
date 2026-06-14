// Boundary coverage for listPosts' first-image thumbnail resolution: after the
// posts SELECT, exactly ONE additional read over asset_attachments resolves each
// row's first image attachment's asset_version_id (no N+1, never one read per
// post). The spec asserts the single batched query regardless of post count, the
// lowest-position pick, and the null cases (video/link only, none, soft-deleted).

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/posts/src/index';
import { listPosts } from '../../packages/posts/src/index';

const WS = 'ws-1';

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

interface TableResult {
  data: unknown;
  error: { message: string } | null;
}

// A recording PostgREST-ish builder keyed by table: from(table) returns a fresh
// builder that logs every chained method (tagged with its table) and, when
// awaited, yields that table's configured result. listPosts issues two reads
// (posts, then asset_attachments), so each needs its own terminal result; both
// chains terminate on an awaited builder, not a maybeSingle.
function makeClient(results: { posts: TableResult; asset_attachments: TableResult }) {
  const calls: Call[] = [];
  const from = vi.fn((table: 'posts' | 'asset_attachments') => {
    calls.push({ table, method: 'from', args: [table] });
    const result = results[table];
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'lt', 'like', 'order', 'limit']) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return b;
  });
  return { client: { from } as unknown as Client, from, calls };
}

function post(id: string) {
  return { id, workspace_id: WS, title: `post ${id}`, stage: 'draft', deleted_at: null };
}

// One asset_attachments row as it arrives from the embedded inner-join select.
function attachment(entityId: string, assetVersionId: string) {
  return {
    entity_id: entityId,
    asset_version_id: assetVersionId,
    asset_versions: { mime_type: 'image/png' },
  };
}

function attachmentCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.table === 'asset_attachments' && c.method === 'from');
}

describe('listPosts thumbnail resolution', () => {
  it('resolves first-image thumbnails in a SINGLE attachments query for N posts (no N+1)', async () => {
    const { client, calls } = makeClient({
      posts: { data: [post('p1'), post('p2'), post('p3')], error: null },
      asset_attachments: {
        data: [attachment('p1', 'ver-1'), attachment('p3', 'ver-3')],
        error: null,
      },
    });

    const result = await listPosts(client, { workspaceId: WS });

    // Exactly one asset_attachments read, regardless of the three posts returned.
    expect(attachmentCalls(calls)).toHaveLength(1);
    // Scoped to post entities, the returned ids, live rows, image mime only.
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'eq',
      args: ['entity_type', 'post'],
    });
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'in',
      args: ['entity_id', ['p1', 'p2', 'p3']],
    });
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'is',
      args: ['deleted_at', null],
    });
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'like',
      args: ['asset_versions.mime_type', 'image/%'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.data.map((p) => [p.id, p.thumbnailAssetVersionId]));
    expect(byId.get('p1')).toBe('ver-1');
    expect(byId.get('p2')).toBeNull();
    expect(byId.get('p3')).toBe('ver-3');
  });

  it('picks the lowest-position image when a post has two image attachments', async () => {
    // The query orders position then attached_at ascending, so the first row per
    // post is the chosen one; the reducer keeps that first row.
    const { client } = makeClient({
      posts: { data: [post('p1')], error: null },
      asset_attachments: {
        data: [attachment('p1', 'ver-low'), attachment('p1', 'ver-high')],
        error: null,
      },
    });

    const result = await listPosts(client, { workspaceId: WS });
    expect(result.ok && result.data[0]?.thumbnailAssetVersionId).toBe('ver-low');
  });

  it('returns null when a post has only a non-image (video/link) attachment', async () => {
    // The inner join + LIKE 'image/%' filters non-image attachments server-side,
    // so the post simply never appears in the attachments result.
    const { client } = makeClient({
      posts: { data: [post('p1')], error: null },
      asset_attachments: { data: [], error: null },
    });

    const result = await listPosts(client, { workspaceId: WS });
    expect(result.ok && result.data[0]?.thumbnailAssetVersionId).toBeNull();
  });

  it('returns null when a post has no attachments at all', async () => {
    const { client } = makeClient({
      posts: { data: [post('p1')], error: null },
      asset_attachments: { data: null, error: null },
    });

    const result = await listPosts(client, { workspaceId: WS });
    expect(result.ok && result.data[0]?.thumbnailAssetVersionId).toBeNull();
  });

  it('ignores a soft-deleted image attachment (returns null)', async () => {
    // A soft-deleted attachment is excluded by the deleted_at IS NULL filter, so
    // the server returns no row for the post and the thumbnail is null.
    const { client, calls } = makeClient({
      posts: { data: [post('p1')], error: null },
      asset_attachments: { data: [], error: null },
    });

    const result = await listPosts(client, { workspaceId: WS });
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'is',
      args: ['deleted_at', null],
    });
    expect(result.ok && result.data[0]?.thumbnailAssetVersionId).toBeNull();
  });

  it('returns [] without an attachments round trip when no posts come back', async () => {
    const { client, calls } = makeClient({
      posts: { data: [], error: null },
      asset_attachments: { data: [], error: null },
    });

    const result = await listPosts(client, { workspaceId: WS });
    expect(result.ok && result.data).toEqual([]);
    expect(attachmentCalls(calls)).toHaveLength(0);
  });

  it('surfaces a posts read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({
      posts: { data: null, error: { message: 'boom' } },
      asset_attachments: { data: [], error: null },
    });

    const result = await listPosts(client, { workspaceId: WS });
    expect(result.ok).toBe(false);
  });

  it('surfaces an attachments read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({
      posts: { data: [post('p1')], error: null },
      asset_attachments: { data: null, error: { message: 'boom' } },
    });

    const result = await listPosts(client, { workspaceId: WS });
    expect(result.ok).toBe(false);
  });
});
