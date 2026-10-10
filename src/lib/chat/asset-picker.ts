// The composer's Assets tile: pick existing library assets and send them as
// chat attachments, no upload. One RLS-scoped read per page (assets with their
// current version embedded): library origin only, not deleted, link assets left
// out (a link is not a file to attach), newest uploaded first, 50 a page on a
// (uploaded_at, id) keyset, with an exact count on the first page. Search is a
// server-side ILIKE on display_name or filename. A pick becomes an already
// uploaded attachment on the version id, its meta built the way an uploaded
// file's is (toLibraryAttachment), so the send and the schedule pass the ids
// straight through. Folders are not browsable here (not readable by members).

import type { Client, Result } from '@srtdio/rpc';
import { isImageMime } from '@srtdio/storage';
import { abortable } from '@/lib/chat-reads';
import {
  toLibraryAttachment,
  type LibraryVersionRow,
  type MessageAttachment,
} from '@/lib/chat/attachments';

/** Page size of the library picker (the "Load 50 more" step). */
export const ASSET_PAGE_SIZE = 50;

/** Search debounce, in milliseconds. */
export const ASSET_SEARCH_DEBOUNCE_MS = 200;

/** The library picker's error line when a read fails; the raw text is only logged. */
export const ASSETS_LOAD_FAILED = "Couldn't load assets, try again";

/** One library asset as the picker shows and sends it. */
export interface LibraryAsset {
  assetId: string;
  /** The current version id: what the send carries and the thumbnail presigns. */
  versionId: string;
  /** display_name, else filename: the attachment's name. */
  name: string;
  /** The stored filename (its extension labels a file tile). */
  filename: string;
  uploadedAt: string;
  version: LibraryVersionRow & { width: number | null; height: number | null; kind: string };
}

/** Keyset cursor: the (uploaded_at, id) of the last asset shown. */
export interface AssetCursor {
  uploadedAt: string;
  id: string;
}

export interface AssetPage {
  rows: LibraryAsset[];
  /** Exact match count on the first page, else null. */
  count: number | null;
}

interface RawLibraryRow {
  id: string;
  filename: string;
  display_name: string | null;
  uploaded_at: string;
  current_version_id: string | null;
  current_version: {
    id: string;
    kind: string;
    mime_type: string | null;
    size_bytes: number | null;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
  } | null;
}

// assets.current_version_id and asset_versions.asset_id are two FKs between the
// same tables, so the embed names its constraint; !inner drops an asset with no
// current version and lets the link-kind filter apply to the parent row.
export const LIBRARY_SELECT =
  'id, filename, display_name, uploaded_at, current_version_id, ' +
  'current_version:asset_versions!assets_current_version_id_fkey!inner(' +
  'id, kind, mime_type, size_bytes, width, height, duration_ms)';

/** Quote a PostgREST filter value so commas, dots and parens stay literal. */
function quoteFilterValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (match) => `\\${match}`)}"`;
}

/** Escape LIKE metacharacters so a typed % or _ matches itself. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** The or() expression for a search: display_name or filename ILIKE the term. Null when empty. Pure. */
export function assetSearchOr(raw: string): string | null {
  const term = raw.trim();
  if (term === '') return null;
  const pattern = quoteFilterValue(`%${escapeLike(term)}%`);
  return `display_name.ilike.${pattern},filename.ilike.${pattern}`;
}

/** The or() expression for "after this cursor" in (uploaded_at desc, id desc). Pure. */
export function assetCursorOr(cursor: AssetCursor): string {
  const at = quoteFilterValue(cursor.uploadedAt);
  return `uploaded_at.lt.${at},and(uploaded_at.eq.${at},id.lt.${quoteFilterValue(cursor.id)})`;
}

/** The cursor after a page: its last row. Pure. */
export function assetCursorAfter(rows: readonly LibraryAsset[]): AssetCursor | null {
  const last = rows[rows.length - 1];
  return last === undefined ? null : { uploadedAt: last.uploadedAt, id: last.assetId };
}

/** Shape the raw rows; a row without a current version is dropped. Pure. */
export function shapeLibraryRows(rows: readonly RawLibraryRow[]): LibraryAsset[] {
  const out: LibraryAsset[] = [];
  for (const row of rows) {
    const v = row.current_version;
    if (v === null || row.current_version_id === null) continue;
    out.push({
      assetId: row.id,
      versionId: row.current_version_id,
      name: row.display_name !== null && row.display_name !== '' ? row.display_name : row.filename,
      filename: row.filename,
      uploadedAt: row.uploaded_at,
      version: {
        id: row.current_version_id,
        kind: v.kind,
        mime_type: v.mime_type,
        size_bytes: v.size_bytes,
        width: v.width,
        height: v.height,
        duration_ms: v.duration_ms,
      },
    });
  }
  return out;
}

/**
 * One page of the workspace's library assets: origin 'library', not deleted,
 * no link assets, newest uploaded first. One request per page (count:'exact'
 * on the first). Never throws.
 */
export async function listLibraryAssetsPage(
  client: Client,
  params: {
    workspaceId: string;
    search: string;
    cursor: AssetCursor | null;
    signal?: AbortSignal;
  },
): Promise<Result<AssetPage>> {
  try {
    const first = params.cursor === null;
    let query = client
      .from('assets')
      .select(LIBRARY_SELECT, first ? { count: 'exact' } : {})
      .eq('workspace_id', params.workspaceId)
      .eq('origin', 'library')
      .is('deleted_at', null)
      .neq('current_version.kind', 'link');
    const search = assetSearchOr(params.search);
    if (search !== null) query = query.or(search);
    if (params.cursor !== null) query = query.or(assetCursorOr(params.cursor));
    query = query
      .order('uploaded_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(ASSET_PAGE_SIZE);
    const { data, error, count } = await abortable(query, params.signal);
    if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
    return {
      ok: true,
      data: {
        rows: shapeLibraryRows((data ?? []) as unknown as RawLibraryRow[]),
        count: first ? (count ?? 0) : null,
      },
    };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

/** Whether a library asset shows as an image thumbnail (else a file tile). Pure. */
export function isLibraryImage(asset: LibraryAsset): boolean {
  return asset.version.mime_type !== null && isImageMime(asset.version.mime_type);
}

/** Toggle an asset in the picker's selection, matched by asset id. Pure. */
export function toggleLibraryAsset(
  selected: readonly LibraryAsset[],
  asset: LibraryAsset,
): LibraryAsset[] {
  return selected.some((item) => item.assetId === asset.assetId)
    ? selected.filter((item) => item.assetId !== asset.assetId)
    : [...selected, asset];
}

/**
 * The confirmed picks as composer attachments: already uploaded (version id,
 * no local half), meta shaped like an uploaded file's, in pick order. A pick
 * already in the composer (same version) is not added twice. Pure.
 */
export function libraryAttachments(
  picks: readonly LibraryAsset[],
  existing: readonly MessageAttachment[] = [],
): MessageAttachment[] {
  const have = new Set(existing.map((a) => a.assetId));
  const out: MessageAttachment[] = [];
  for (const pick of picks) {
    if (have.has(pick.versionId)) continue;
    have.add(pick.versionId);
    out.push(toLibraryAttachment(pick.version, pick.name));
  }
  return out;
}

/** The "Load 50 more" row's progress text. Pure. */
export function assetsShownOf(shown: number, total: number): string {
  return `${shown} of ${total}`;
}
