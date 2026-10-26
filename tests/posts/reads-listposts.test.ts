// Boundary coverage for listPosts: the Pipeline reads its whole board in ONE
// public.posts_list call (posts columns plus the media summary), never a posts
// read followed by an asset_attachments read. The spec asserts the single call,
// its explicit p_trace_id, the args it forwards, the row mapping (thumbnail and
// cover from the thumbnail_asset_version_id / first_media_* columns, null media
// included) and that failures come back as a Result, never a throw.

import { describe, expect, it, vi } from 'vitest';
import type { Client, Post, PostsListRow } from '../../packages/posts/src/index';
import { listPosts, pipelinePostFromRow } from '../../packages/posts/src/index';

const WS = 'ws-1';

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

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

function makeClient(result: RpcResult) {
  const rpc = vi.fn<(fn: string, args: Record<string, unknown>) => Promise<RpcResult>>(
    async () => result,
  );
  const from = vi.fn(() => {
    throw new Error('listPosts must not read a table directly');
  });
  return { client: { rpc, from } as unknown as Client, rpc, from };
}

function post(id: string): Post {
  return {
    id,
    workspace_id: WS,
    title: `post ${id}`,
    caption: null,
    bucket_id: null,
    owner_user_id: null,
    platform: 'instagram',
    format: 'single',
    stage: 'draft',
    target_date: null,
    origin: 'agency',
    brief_id: null,
    row_version: 1,
    created_by: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    deleted_at: null,
    stage_entered_at: '2026-10-01T00:00:00.000Z',
    legacy_author_name: null,
    number: 1,
    approved_by: null,
    approved_at: null,
    approved_on_behalf_of: null,
  };
}

function row(id: string, media: Partial<PostsListRow> = {}): PostsListRow {
  return {
    ...post(id),
    thumbnail_asset_version_id: null,
    first_media_asset_version_id: null,
    first_media_kind: null,
    first_media_width: null,
    first_media_height: null,
    ...media,
  };
}

describe('listPosts: one posts_list call', () => {
  it('stamps X-Trace-Id with the exact p_trace_id it sends', async () => {
    const { client, rpc, setHeader } = headerClient({ data: [row('p1')], error: null });
    const result = await listPosts(client, { workspaceId: WS, traceId: 'trace-h' });
    expect(result.ok).toBe(true);
    expect(rpc.mock.calls[0]?.[0]).toBe('posts_list');
    const traceId = rpc.mock.calls[0]?.[1].p_trace_id;
    expect(traceId).toBe('trace-h');
    expect(setHeader).toHaveBeenCalledTimes(1);
    expect(setHeader).toHaveBeenCalledWith('X-Trace-Id', traceId);
  });

  it('a minted trace id is a uuid v7 and is the X-Trace-Id header too', async () => {
    const { client, rpc, setHeader } = headerClient({ data: [], error: null });
    await listPosts(client, { workspaceId: WS });
    const traceId = rpc.mock.calls[0]?.[1].p_trace_id;
    expect(String(traceId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(setHeader).toHaveBeenCalledWith('X-Trace-Id', traceId);
  });

  it('makes exactly one rpc call and no table read, for any number of posts', async () => {
    const { client, rpc, from } = makeClient({
      data: [row('p1'), row('p2'), row('p3')],
      error: null,
    });

    const result = await listPosts(client, { workspaceId: WS, traceId: 'trace-1' });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
    expect(rpc.mock.calls[0]?.[0]).toBe('posts_list');
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      p_trace_id: 'trace-1',
      p_workspace_id: WS,
      p_limit: 50,
    });
    expect(result.ok && result.data.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('forwards stage and the before cursor, and caps the limit at 500', async () => {
    const { client, rpc } = makeClient({ data: [], error: null });

    await listPosts(client, {
      workspaceId: WS,
      stage: 'review',
      before: '2026-10-02T00:00:00.000Z',
      limit: 10_000,
      traceId: 'trace-2',
    });

    expect(rpc.mock.calls[0]?.[1]).toEqual({
      p_trace_id: 'trace-2',
      p_workspace_id: WS,
      p_stage: 'review',
      p_before: '2026-10-02T00:00:00.000Z',
      p_limit: 500,
    });
  });

  it('always sends an explicit p_trace_id (a fresh one when the caller has none)', async () => {
    const { client, rpc } = makeClient({ data: [], error: null });

    await listPosts(client, { workspaceId: WS });

    const args = rpc.mock.calls[0]?.[1] ?? {};
    expect(typeof args.p_trace_id).toBe('string');
    expect(String(args.p_trace_id).length).toBeGreaterThan(0);
  });

  it('maps the media summary columns onto thumbnail and cover', async () => {
    const { client } = makeClient({
      data: [
        // A video first, then an image: the cover is the video, the thumbnail the image.
        row('p1', {
          thumbnail_asset_version_id: 'ver-i1',
          first_media_asset_version_id: 'ver-v1',
          first_media_kind: 'video',
          first_media_width: 1920,
          first_media_height: 1080,
        }),
        // An image with no stored size (older upload).
        row('p2', {
          thumbnail_asset_version_id: 'ver-i2',
          first_media_asset_version_id: 'ver-i2',
          first_media_kind: 'image',
        }),
        // No photo or video.
        row('p3'),
      ],
      error: null,
    });

    const result = await listPosts(client, { workspaceId: WS, traceId: 't' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.data.map((p) => [p.id, p]));
    expect(byId.get('p1')?.thumbnailAssetVersionId).toBe('ver-i1');
    expect(byId.get('p1')?.firstMedia).toEqual({
      assetVersionId: 'ver-v1',
      kind: 'video',
      width: 1920,
      height: 1080,
    });
    expect(byId.get('p2')?.firstMedia).toEqual({
      assetVersionId: 'ver-i2',
      kind: 'image',
      width: null,
      height: null,
    });
    // No photo or video: the cover is known to be none (null), not unread.
    expect(byId.get('p3')?.thumbnailAssetVersionId).toBeNull();
    expect(byId.get('p3')?.firstMedia).toBeNull();
  });

  it('returns [] when the proc returns no rows or null data', async () => {
    const empty = makeClient({ data: [], error: null });
    expect(await listPosts(empty.client, { workspaceId: WS, traceId: 't' })).toEqual({
      ok: true,
      data: [],
    });
    const none = makeClient({ data: null, error: null });
    expect(await listPosts(none.client, { workspaceId: WS, traceId: 't' })).toEqual({
      ok: true,
      data: [],
    });
  });

  it('surfaces a proc failure as a Result error, never throwing', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    const result = await listPosts(client, { workspaceId: WS, traceId: 't' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown');
  });
});

describe('pipelinePostFromRow', () => {
  it('keeps every posts column and drops the raw media columns', () => {
    const mapped = pipelinePostFromRow(
      row('p1', {
        thumbnail_asset_version_id: 'ver-1',
        first_media_asset_version_id: 'ver-1',
        first_media_kind: 'image',
        first_media_width: 1080,
        first_media_height: 1350,
      }),
    );
    expect(mapped).toEqual({
      ...post('p1'),
      thumbnailAssetVersionId: 'ver-1',
      firstMedia: { assetVersionId: 'ver-1', kind: 'image', width: 1080, height: 1350 },
    });
    // The raw proc columns do not leak onto the Pipeline row.
    expect(Object.keys(mapped)).not.toContain('first_media_kind');
    expect(Object.keys(mapped)).not.toContain('thumbnail_asset_version_id');
  });

  it('maps null media to a null thumbnail and a null cover', () => {
    const mapped = pipelinePostFromRow(row('p1'));
    expect(mapped.thumbnailAssetVersionId).toBeNull();
    expect(mapped.firstMedia).toBeNull();
  });

  it('treats an unknown media kind as no cover', () => {
    const mapped = pipelinePostFromRow(
      row('p1', { first_media_asset_version_id: 'ver-x', first_media_kind: 'audio' }),
    );
    expect(mapped.firstMedia).toBeNull();
  });
});
