// Boundary coverage for getPostGallery: a plain RLS-scoped read on
// asset_attachments (not a proc), so it drives a fake PostgREST builder rather
// than the rpc transport. asset_attachments.entity_id is a TEXT column with no FK
// to posts, so the gallery is read directly off asset_attachments with the
// version and parent-asset filename embedded; the spec asserts the order, the
// soft-delete filter, the embedded filename mapping, and the empty case.

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/posts/src/index';
import { getPostGallery } from '../../packages/posts/src/index';

const POST = 'post-1';

interface Call {
  method: string;
  args: unknown[];
}

// A recording PostgREST-ish builder: every chained query method returns self and
// logs its call; awaiting the chain yields the configured result. Mirrors the
// chat shared-posts read spec.
function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order']) {
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

function row(overrides: { id: string; position: number; filename: string | null }) {
  return {
    id: overrides.id,
    asset_id: `asset-${overrides.id}`,
    asset_version_id: `ver-${overrides.id}`,
    position: overrides.position,
    asset_versions: {
      mime_type: 'image/png',
      kind: 'image',
      width: 800,
      height: 1000,
      duration_ms: null,
      r2_key: `r2/${overrides.id}`,
      external_url: null,
    },
    assets: overrides.filename === null ? null : { filename: overrides.filename },
  };
}

describe('getPostGallery', () => {
  it('reads asset_attachments in one round trip, in position order', async () => {
    const { client, from, calls } = makeClient({
      data: [
        row({ id: 'a', position: 0, filename: 'first.png' }),
        row({ id: 'b', position: 1, filename: 'second.png' }),
      ],
      error: null,
    });

    const result = await getPostGallery(client, POST);

    // One query, on asset_attachments, scoped to this post, ordered by position.
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('asset_attachments');
    expect(calls).toContainEqual({ method: 'eq', args: ['entity_type', 'post'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['entity_id', POST] });
    expect(calls).toContainEqual({ method: 'order', args: ['position', { ascending: true }] });
    expect(result.ok && result.data.map((i) => i.position)).toEqual([0, 1]);
    expect(result.ok && result.data.map((i) => i.assetAttachmentId)).toEqual(['a', 'b']);
  });

  it('applies the deleted_at IS NULL soft-delete filter', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await getPostGallery(client, POST);
    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
  });

  it('maps the filename from the embedded asset, with a fallback when missing', async () => {
    const { client } = makeClient({
      data: [
        row({ id: 'a', position: 0, filename: 'photo.png' }),
        row({ id: 'b', position: 1, filename: null }),
      ],
      error: null,
    });

    const result = await getPostGallery(client, POST);
    expect(result.ok && result.data[0]?.filename).toBe('photo.png');
    expect(result.ok && result.data[1]?.filename).toBe('Untitled');
  });

  it('returns [] (never null) when the post has no images', async () => {
    const { client } = makeClient({ data: null, error: null });
    const result = await getPostGallery(client, POST);
    expect(result.ok && result.data).toEqual([]);
  });

  it('surfaces a read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    const result = await getPostGallery(client, POST);
    expect(result.ok).toBe(false);
  });
});
