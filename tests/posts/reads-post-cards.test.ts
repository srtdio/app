// Boundary coverage for readPostCards, the live chat post card's batched read:
// at most TWO queries for a whole message's ids (posts IN ids, then one
// asset_attachments IN over the posts that came back), never one per post. The
// attachment rows fold into the first image (lowest position), the live
// attachment count and a has-video flag per post.

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/posts/src/index';
import {
  POST_CARD_ROW_COLUMNS,
  mediaSummaryByPost,
  readPostCards,
} from '../../packages/posts/src/reads';

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

function makeClient(results: { posts: TableResult; asset_attachments: TableResult }) {
  const calls: Call[] = [];
  const from = vi.fn((table: 'posts' | 'asset_attachments') => {
    calls.push({ table, method: 'from', args: [table] });
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'like', 'order', 'limit']) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(results[table]).then(resolve);
    return b;
  });
  return { client: { from } as unknown as Client, from, calls };
}

function post(id: string) {
  return {
    id,
    number: 1,
    title: `post ${id}`,
    format: 'carousel',
    platform: 'instagram',
    stage: 'review',
    target_date: null,
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
  };
}

function attachment(
  entityId: string,
  versionId: string,
  mime: string,
  size: { width: number; height: number } | null = null,
) {
  return {
    entity_id: entityId,
    asset_version_id: versionId,
    asset_versions: { mime_type: mime, width: size?.width ?? null, height: size?.height ?? null },
  };
}

const ok = (data: unknown): TableResult => ({ data, error: null });

describe('readPostCards', () => {
  it('reads the card columns for every id in ONE workspace-scoped posts IN read', async () => {
    const { client, calls } = makeClient({ posts: ok([post('p1')]), asset_attachments: ok([]) });
    await readPostCards(client, { workspaceId: WS, ids: ['p1', 'p2'] });
    const posts = calls.filter((c) => c.table === 'posts');
    expect(POST_CARD_ROW_COLUMNS).toBe(
      'id, number, title, format, platform, stage, target_date, stage_entered_at, approved_by, approved_at, caption',
    );
    expect(posts).toContainEqual({
      table: 'posts',
      method: 'select',
      args: [POST_CARD_ROW_COLUMNS],
    });
    expect(posts).toContainEqual({ table: 'posts', method: 'eq', args: ['workspace_id', WS] });
    expect(posts).toContainEqual({ table: 'posts', method: 'in', args: ['id', ['p1', 'p2']] });
    expect(posts).toContainEqual({ table: 'posts', method: 'is', args: ['deleted_at', null] });
  });

  it('issues exactly 2 queries for a batch of any size; attachments only for returned posts', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const { client, from, calls } = makeClient({
      posts: ok(ids.slice(0, 10).map(post)),
      asset_attachments: ok([]),
    });
    await readPostCards(client, { workspaceId: WS, ids });
    expect(from).toHaveBeenCalledTimes(2);
    expect(from.mock.calls.map((c) => c[0])).toEqual(['posts', 'asset_attachments']);
    const att = calls.filter((c) => c.table === 'asset_attachments');
    expect(att).toContainEqual({
      table: 'asset_attachments',
      method: 'select',
      // The first media's stored size rides the same batched read (no N+1).
      args: ['entity_id, asset_version_id, asset_versions!inner(mime_type, width, height)'],
    });
    expect(att).toContainEqual({
      table: 'asset_attachments',
      method: 'eq',
      args: ['entity_type', 'post'],
    });
    expect(att.filter((c) => c.method === 'in')).toEqual([
      { table: 'asset_attachments', method: 'in', args: ['entity_id', ids.slice(0, 10)] },
    ]);
    expect(att).toContainEqual({
      table: 'asset_attachments',
      method: 'is',
      args: ['deleted_at', null],
    });
    // All media kinds are read (counted), so no image-only filter here.
    expect(att.some((c) => c.method === 'like')).toBe(false);
  });

  it('folds attachments into thumbnail, count and has-video per post', async () => {
    const { client } = makeClient({
      posts: ok([post('p1'), post('p2'), post('p3')]),
      asset_attachments: ok([
        attachment('p1', 'v-video', 'video/mp4'),
        attachment('p1', 'v-img-a', 'image/png'),
        attachment('p1', 'v-img-b', 'image/jpeg'),
        attachment('p2', 'v-only-video', 'video/quicktime'),
      ]),
    });
    const result = await readPostCards(client, { workspaceId: WS, ids: ['p1', 'p2', 'p3'] });
    expect(result.ok).toBe(true);
    const byId = new Map((result.ok ? result.data : []).map((r) => [r.id, r]));
    expect(byId.get('p1')).toMatchObject({
      thumbnailAssetVersionId: 'v-img-a',
      mediaCount: 3,
      hasVideo: true,
    });
    expect(byId.get('p2')).toMatchObject({
      thumbnailAssetVersionId: null,
      mediaCount: 1,
      hasVideo: true,
    });
    expect(byId.get('p3')).toMatchObject({
      thumbnailAssetVersionId: null,
      mediaCount: 0,
      hasVideo: false,
    });
  });

  it('does not read at all for no ids, and skips attachments when no post came back', async () => {
    const empty = makeClient({ posts: ok([]), asset_attachments: ok([]) });
    expect(await readPostCards(empty.client, { workspaceId: WS, ids: [] })).toEqual({
      ok: true,
      data: [],
    });
    expect(empty.from).not.toHaveBeenCalled();
    await readPostCards(empty.client, { workspaceId: WS, ids: ['hidden'] });
    expect(empty.from.mock.calls.map((c) => c[0])).toEqual(['posts']);
  });

  it('surfaces either read failure as a Result error, never throwing', async () => {
    const postsFail = makeClient({
      posts: { data: null, error: { message: 'boom' } },
      asset_attachments: ok([]),
    });
    expect((await readPostCards(postsFail.client, { workspaceId: WS, ids: ['p1'] })).ok).toBe(
      false,
    );
    const attFail = makeClient({
      posts: ok([post('p1')]),
      asset_attachments: { data: null, error: { message: 'boom' } },
    });
    expect((await readPostCards(attFail.client, { workspaceId: WS, ids: ['p1'] })).ok).toBe(false);
  });
});

describe('readPostCards first media (A1 / A2)', () => {
  it('returns the first image or video in display order with its stored width and height', async () => {
    const { client } = makeClient({
      posts: ok([post('p1'), post('p2'), post('p3'), post('p4')]),
      asset_attachments: ok([
        attachment('p1', 'v-doc', 'application/pdf'),
        attachment('p1', 'v-square', 'image/jpeg', { width: 1080, height: 1080 }),
        attachment('p1', 'v-later', 'video/mp4', { width: 1080, height: 1920 }),
        attachment('p2', 'v-reel', 'video/mp4', { width: 1080, height: 1920 }),
        attachment('p2', 'v-after', 'image/png', { width: 100, height: 100 }),
        attachment('p3', 'v-old', 'image/png'),
      ]),
    });
    const result = await readPostCards(client, { workspaceId: WS, ids: ['p1', 'p2', 'p3', 'p4'] });
    const byId = new Map((result.ok ? result.data : []).map((r) => [r.id, r]));
    expect(byId.get('p1')?.firstMedia).toEqual({
      assetVersionId: 'v-square',
      kind: 'image',
      width: 1080,
      height: 1080,
    });
    // Mixed image + video: the first media item in display order decides.
    expect(byId.get('p2')?.firstMedia).toEqual({
      assetVersionId: 'v-reel',
      kind: 'video',
      width: 1080,
      height: 1920,
    });
    // An older upload with no stored size: null dims (the card falls back).
    expect(byId.get('p3')?.firstMedia).toEqual({
      assetVersionId: 'v-old',
      kind: 'image',
      width: null,
      height: null,
    });
    expect(byId.get('p4')?.firstMedia).toBeNull();
  });
});

describe('mediaSummaryByPost', () => {
  it('ignores rows with no embedded version mime for thumbnail and video, but counts them', () => {
    const map = mediaSummaryByPost([
      { entity_id: 'p1', asset_version_id: 'v1', asset_versions: null },
      attachment('p1', 'v2', 'image/webp'),
    ]);
    expect(map.get('p1')).toEqual({
      thumbnailAssetVersionId: 'v2',
      firstMedia: { assetVersionId: 'v2', kind: 'image', width: null, height: null },
      mediaCount: 2,
      hasVideo: false,
    });
  });
});
