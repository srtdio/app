// Pure status filter for the Briefs surface. Search and sort are shared via
// list-sort; this covers the All / Open / Closed chips, the URL state they live
// in (?status=&q=), and the keyset-paged workspace read the list loads from.

import type { Brief, BriefWithThumbnail } from '@srtdio/briefs';
import type { Client, Result } from '@srtdio/rpc';
import type { BriefStatus } from '@/components/pages/BriefCard';

export type BriefFilter = 'all' | BriefStatus;

/** The chip the list opens on when the URL names none. */
export const BRIEF_FILTER_DEFAULT: BriefFilter = 'open';

/** Keep every brief for "all", otherwise only those matching the status. */
export function filterBriefsByStatus(briefs: Brief[], filter: BriefFilter): Brief[] {
  if (filter === 'all') return briefs;
  return briefs.filter((brief) => brief.status === filter);
}

/** The ?status= value as a filter; anything unknown or absent is the default (Open). */
export function parseBriefFilter(value: string | null): BriefFilter {
  return value === 'all' || value === 'open' || value === 'closed' ? value : BRIEF_FILTER_DEFAULT;
}

/**
 * The list's URL params for a filter and search: the default chip and an empty
 * search are left out, every other param is kept as it was. Pure.
 */
export function briefListParams(
  current: URLSearchParams,
  filter: BriefFilter,
  search: string,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (filter === BRIEF_FILTER_DEFAULT) next.delete('status');
  else next.set('status', filter);
  if (search === '') next.delete('q');
  else next.set('q', search);
  return next;
}

/**
 * The brief detail param "Add note" sets (after a note failed to post on
 * create): the detail strips it and focuses the comment box.
 */
export const BRIEF_NOTE_PARAM = 'note';

/** Briefs per list page. */
export const BRIEF_LIST_PAGE_SIZE = 100;

/** Where the next briefs page starts: the last loaded row's (created_at, id). */
export interface BriefCursor {
  createdAt: string;
  id: string;
}

/** Whether another page follows, and where it starts. Never null. */
export type BriefPageNext = { done: true } | { done: false; cursor: BriefCursor };

/** One page of a workspace's briefs, newest first. */
export interface BriefPage {
  items: BriefWithThumbnail[];
  next: BriefPageNext;
}

/**
 * The PostgREST `or` filter for "strictly after the cursor" in (created_at
 * desc, id desc) order: an older brief, or the same instant with a smaller id.
 * Values are double-quoted so the timestamp's punctuation is never read as
 * filter syntax. Pure.
 */
export function briefKeysetFilter(cursor: BriefCursor): string {
  const at = `"${cursor.createdAt}"`;
  const id = `"${cursor.id}"`;
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt.${id})`;
}

/**
 * Append `incoming` to `existing`, skipping any id already present (a brief
 * created between two page reads can arrive twice). Keeps the existing order;
 * pure and non-mutating.
 */
export function mergeBriefPages<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(existing.map((item) => item.id));
  const out = [...existing];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// One row of the batched first-image lookup (mirrors @srtdio/briefs listBriefs):
// an asset_attachments row with its pinned version's mime_type embedded via an
// inner join, so only image-backed attachments survive.
interface FirstImageRow {
  entity_id: string;
  asset_version_id: string;
  asset_versions: { mime_type: string | null } | null;
}

/**
 * Each brief's first live image attachment (lowest position, then earliest
 * attached_at) in ONE IN read over the page's ids, the same read
 * @srtdio/briefs listBriefs makes for its thumbnails. No ids, no round trip.
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
  if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
  const first = new Map<string, string>();
  for (const row of (data ?? []) as unknown as FirstImageRow[]) {
    if (!first.has(row.entity_id)) first.set(row.entity_id, row.asset_version_id);
  }
  return { ok: true, data: first };
}

/**
 * One page of a workspace's live briefs, newest first (created_at desc, id
 * desc), each with its card thumbnail. Keyset paged: pass the previous page's
 * `next.cursor` for the following page. The same table, columns, filters and
 * RLS as @srtdio/briefs listBriefs (which pages by offset); this reads one row
 * past the page size to learn whether another page exists, then one IN read for
 * the page's thumbnails. Two requests per page, never N+1.
 */
export async function listBriefsPage(
  client: Client,
  workspaceId: string,
  cursor?: BriefCursor,
): Promise<Result<BriefPage>> {
  let query = client
    .from('briefs')
    .select('*')
    .is('deleted_at', null)
    .eq('workspace_id', workspaceId);
  if (cursor !== undefined) query = query.or(briefKeysetFilter(cursor));
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(BRIEF_LIST_PAGE_SIZE + 1);
  if (error) return { ok: false, error: { code: 'unknown', message: error.message } };

  const fetched: Brief[] = data ?? [];
  const rows = fetched.slice(0, BRIEF_LIST_PAGE_SIZE);
  const thumbnails = await firstImageByBrief(
    client,
    rows.map((brief) => brief.id),
  );
  if (!thumbnails.ok) return thumbnails;

  const last = rows[rows.length - 1];
  const next: BriefPageNext =
    fetched.length > BRIEF_LIST_PAGE_SIZE && last !== undefined
      ? { done: false, cursor: { createdAt: last.created_at, id: last.id } }
      : { done: true };
  return {
    ok: true,
    data: {
      items: rows.map((brief) => ({
        ...brief,
        thumbnailAssetVersionId: thumbnails.data.get(brief.id) ?? null,
      })),
      next,
    },
  };
}
