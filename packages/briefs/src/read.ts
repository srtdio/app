// The brief read layer: plain RLS-scoped SELECTs, no proc involved. Tenant
// isolation is Postgres' job (the caller's JWT drives RLS), so these functions
// add no membership checks of their own. Results are wrapped in the same Result
// shape the write wrappers use, so callers branch uniformly; a transport/Postgrest
// failure surfaces as a { code: 'unknown' } error rather than a throw.

import type { Client, DomainError, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';

export type Brief = Database['public']['Tables']['briefs']['Row'];

/** Default page size for {@link listBriefs}. */
export const BRIEFS_PAGE_SIZE = 50;

export interface ListBriefsFilters {
  /** Restrict to open or closed briefs. */
  status?: 'open' | 'closed';
  /** Restrict to briefs created by this user id. */
  createdBy?: string;
  /** Inclusive lower bound on target_date (ISO `YYYY-MM-DD`). */
  targetDateFrom?: string;
  /** Inclusive upper bound on target_date (ISO `YYYY-MM-DD`). */
  targetDateTo?: string;
  /** Page size. Defaults to {@link BRIEFS_PAGE_SIZE}. */
  limit?: number;
  /** Row offset for pagination. Defaults to 0. */
  offset?: number;
}

/** A brief plus its per-request derived count of live linked posts. */
export interface BriefWithLinkedCount {
  brief: Brief;
  /** count(*) of posts pointing at this brief, excluding soft-deleted ones. */
  linked_posts_count: number;
}

/**
 * A brief list row plus the asset_version_id of its first reference image (for the
 * card thumbnail), or null when the brief has no image attachment. The thumbnail is
 * resolved by {@link listBriefs} in one extra batched query over every returned
 * brief, never one query per brief. Mirrors @srtdio/posts PipelinePost.
 */
export type BriefWithThumbnail = Brief & { thumbnailAssetVersionId: string | null };

function transportError(message: string): DomainError {
  return { code: 'unknown', message };
}

// One row of the batched first-image lookup: an asset_attachments row with its
// pinned version's mime_type embedded via an inner join (so only image-backed
// attachments survive). The aliased select is wider than the generated row type
// can express, so callers cast through `unknown`. Mirrors @srtdio/posts.
interface FirstImageRow {
  entity_id: string;
  asset_version_id: string;
  asset_versions: { mime_type: string | null } | null;
}

/**
 * Resolve each brief's first image attachment's asset_version_id in ONE query over
 * asset_attachments (no N+1, never one read per brief). "First image" is the live
 * (deleted_at IS NULL), image-mime attachment with the lowest position, tie-broken
 * by the earliest attached_at. The inner join + LIKE 'image/%' drops video/link/
 * file attachments server-side; rows arrive grouped by entity_id and ordered
 * position then attached_at ascending, so the first row seen per brief wins. Briefs
 * with no image attachment never appear in the map (the caller maps them to null).
 * entity_id is a TEXT column and brief ids are JS strings, so no uuid cast is
 * needed. Returns an empty map without a round trip when there are no brief ids.
 * A re-implementation of @srtdio/posts firstImageByPost for entity_type='brief';
 * firstImageByPost is not exported, so this never imports from packages/posts.
 */
async function firstImageByBrief(
  client: Client,
  briefIds: string[],
): Promise<Result<Map<string, string>>> {
  if (briefIds.length === 0) return { ok: true, data: new Map() };

  const { data, error } = await client
    .from('asset_attachments')
    .select('entity_id, asset_version_id, asset_versions!inner(mime_type)')
    .eq('entity_type', 'brief')
    .in('entity_id', briefIds)
    .is('deleted_at', null)
    .like('asset_versions.mime_type', 'image/%')
    .order('entity_id', { ascending: true })
    .order('position', { ascending: true })
    .order('attached_at', { ascending: true });

  if (error) return { ok: false, error: transportError(error.message) };

  const rows = (data ?? []) as unknown as FirstImageRow[];
  const firstByBrief = new Map<string, string>();
  for (const row of rows) {
    if (!firstByBrief.has(row.entity_id)) firstByBrief.set(row.entity_id, row.asset_version_id);
  }
  return { ok: true, data: firstByBrief };
}

/**
 * List briefs visible to the caller, newest first. Soft-deleted briefs are
 * excluded; the "recently deleted" surface is a separate concern. One additional
 * batched query then resolves each row's first reference image's asset_version_id
 * for the card thumbnail ({@link firstImageByBrief}); briefs with no image carry
 * null. No N+1. Returns [] (never null) when no briefs match.
 */
export async function listBriefs(
  client: Client,
  filters: ListBriefsFilters = {},
): Promise<Result<BriefWithThumbnail[]>> {
  let query = client.from('briefs').select('*').is('deleted_at', null);
  if (filters.status !== undefined) query = query.eq('status', filters.status);
  if (filters.createdBy !== undefined) query = query.eq('created_by', filters.createdBy);
  if (filters.targetDateFrom !== undefined)
    query = query.gte('target_date', filters.targetDateFrom);
  if (filters.targetDateTo !== undefined) query = query.lte('target_date', filters.targetDateTo);

  const limit = filters.limit ?? BRIEFS_PAGE_SIZE;
  const offset = filters.offset ?? 0;

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return { ok: false, error: transportError(error.message) };

  const briefs = data ?? [];
  const thumbnails = await firstImageByBrief(
    client,
    briefs.map((brief) => brief.id),
  );
  if (!thumbnails.ok) return thumbnails;

  return {
    ok: true,
    data: briefs.map((brief) => ({
      ...brief,
      thumbnailAssetVersionId: thumbnails.data.get(brief.id) ?? null,
    })),
  };
}

/**
 * Fetch one brief by id together with a freshly derived linked_posts_count.
 * Returns `{ ok: true, data: null }` when the brief is absent or hidden by RLS.
 * The count is never stored; it is computed per request.
 */
export async function getBrief(
  client: Client,
  briefId: string,
): Promise<Result<BriefWithLinkedCount | null>> {
  const { data, error } = await client
    .from('briefs')
    .select('*')
    .eq('id', briefId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return { ok: false, error: transportError(error.message) };
  if (data === null) return { ok: true, data: null };

  const countResult = await client
    .from('posts')
    .select('*', { count: 'exact', head: true })
    .eq('brief_id', briefId)
    .is('deleted_at', null);
  if (countResult.error) return { ok: false, error: transportError(countResult.error.message) };

  return { ok: true, data: { brief: data, linked_posts_count: countResult.count ?? 0 } };
}
