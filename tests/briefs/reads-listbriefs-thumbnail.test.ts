// Boundary coverage for listBriefs' first-image thumbnail resolution: after the
// briefs SELECT, exactly ONE additional read over asset_attachments resolves each
// row's first reference image's asset_version_id (no N+1, never one read per
// brief). The spec asserts the single batched query regardless of brief count, the
// lowest-position pick, and the null cases (link only, none, soft-deleted). Mirrors
// the posts spec (tests/posts/reads-listposts.test.ts) for entity_type='brief';
// entity_id is TEXT and brief ids are JS strings, so the IN filter carries plain
// strings with no uuid cast. Pure unit, not gated on BRIEFS_SUITE.

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/briefs/src/index';
import { listBriefs } from '../../packages/briefs/src/index';

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
// awaited, yields that table's configured result. listBriefs issues two reads
// (briefs, then asset_attachments), so each needs its own terminal result; both
// chains terminate on an awaited builder, not a maybeSingle.
function makeClient(results: { briefs: TableResult; asset_attachments: TableResult }) {
  const calls: Call[] = [];
  const from = vi.fn((table: 'briefs' | 'asset_attachments') => {
    calls.push({ table, method: 'from', args: [table] });
    const result = results[table];
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'gte', 'lte', 'like', 'order', 'range']) {
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

function brief(id: string) {
  return { id, title: `brief ${id}`, status: 'open', deleted_at: null };
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

describe('listBriefs thumbnail resolution', () => {
  it('resolves first-image thumbnails in a SINGLE attachments query for N briefs (no N+1)', async () => {
    const { client, calls } = makeClient({
      briefs: { data: [brief('b1'), brief('b2'), brief('b3')], error: null },
      asset_attachments: {
        data: [attachment('b1', 'ver-1'), attachment('b3', 'ver-3')],
        error: null,
      },
    });

    const result = await listBriefs(client);

    // Exactly one asset_attachments read, regardless of the three briefs returned.
    expect(attachmentCalls(calls)).toHaveLength(1);
    // Scoped to brief entities, the returned ids (plain TEXT, no cast), live rows,
    // image mime only.
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'eq',
      args: ['entity_type', 'brief'],
    });
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'in',
      args: ['entity_id', ['b1', 'b2', 'b3']],
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
    const byId = new Map(result.data.map((b) => [b.id, b.thumbnailAssetVersionId]));
    expect(byId.get('b1')).toBe('ver-1');
    expect(byId.get('b2')).toBeNull();
    expect(byId.get('b3')).toBe('ver-3');
  });

  it('picks the lowest-position image when a brief has two image attachments', async () => {
    // The query orders position then attached_at ascending, so the first row per
    // brief is the chosen one; the reducer keeps that first row.
    const { client } = makeClient({
      briefs: { data: [brief('b1')], error: null },
      asset_attachments: {
        data: [attachment('b1', 'ver-low'), attachment('b1', 'ver-high')],
        error: null,
      },
    });

    const result = await listBriefs(client);
    expect(result.ok && result.data[0]?.thumbnailAssetVersionId).toBe('ver-low');
  });

  it('returns null for a link-only brief (no image attachment)', async () => {
    // The inner join + LIKE 'image/%' filters non-image (link/file/video)
    // attachments server-side, so the brief simply never appears in the result.
    const { client } = makeClient({
      briefs: { data: [brief('b1')], error: null },
      asset_attachments: { data: [], error: null },
    });

    const result = await listBriefs(client);
    expect(result.ok && result.data[0]?.thumbnailAssetVersionId).toBeNull();
  });

  it('returns null when a brief has no attachments at all', async () => {
    const { client } = makeClient({
      briefs: { data: [brief('b1')], error: null },
      asset_attachments: { data: null, error: null },
    });

    const result = await listBriefs(client);
    expect(result.ok && result.data[0]?.thumbnailAssetVersionId).toBeNull();
  });

  it('ignores a soft-deleted image attachment (returns null)', async () => {
    // A soft-deleted attachment is excluded by the deleted_at IS NULL filter, so
    // the server returns no row for the brief and the thumbnail is null.
    const { client, calls } = makeClient({
      briefs: { data: [brief('b1')], error: null },
      asset_attachments: { data: [], error: null },
    });

    const result = await listBriefs(client);
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'is',
      args: ['deleted_at', null],
    });
    expect(result.ok && result.data[0]?.thumbnailAssetVersionId).toBeNull();
  });

  it('returns [] without an attachments round trip when no briefs come back', async () => {
    const { client, calls } = makeClient({
      briefs: { data: [], error: null },
      asset_attachments: { data: [], error: null },
    });

    const result = await listBriefs(client);
    expect(result.ok && result.data).toEqual([]);
    expect(attachmentCalls(calls)).toHaveLength(0);
  });

  it('surfaces a briefs read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({
      briefs: { data: null, error: { message: 'boom' } },
      asset_attachments: { data: [], error: null },
    });

    const result = await listBriefs(client);
    expect(result.ok).toBe(false);
  });

  it('surfaces an attachments read failure as a Result error, never throwing', async () => {
    const { client } = makeClient({
      briefs: { data: [brief('b1')], error: null },
      asset_attachments: { data: null, error: { message: 'boom' } },
    });

    const result = await listBriefs(client);
    expect(result.ok).toBe(false);
  });
});
