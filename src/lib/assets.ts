// The asset read + shaping layer for the workspace-global Assets library.
//
// Reads are plain RLS-scoped SELECTs through the supabase client (policies
// assets_select_member / asset_versions_select_member / asset_attachments_select_member),
// mirroring @srtdio/briefs: no proc, no service role, tenant isolation is
// Postgres' job. listAssets does two round-trips (assets + their current version
// embedded, then a single attachments read for the per-asset live count) so
// there is no N+1. All shaping below is pure and unit-tested; kinds, labels and
// counts are derived from the fetched rows, never hardcoded.

import type { Client, Result } from '@srtdio/rpc';

/** The three buckets the library groups assets into for display and filtering. */
export type AssetKind = 'image' | 'link' | 'file';

/** Kinds in chip order, paired with their display label. Counts come from data. */
export const KIND_LABELS: Record<AssetKind, string> = {
  image: 'Images',
  link: 'Links',
  file: 'Docs',
};

export const KIND_ORDER: AssetKind[] = ['image', 'link', 'file'];

/** A filter selection: a concrete kind, or `all` for no kind restriction. */
export type KindFilter = AssetKind | 'all';

/**
 * Derive the display kind from a version's raw `kind` string. Anything that is
 * not an image or a link is treated as a generic file/doc, so a new server-side
 * kind never breaks the UI; it just falls into Docs.
 */
export function deriveKind(rawKind: string | null): AssetKind {
  if (rawKind === 'image') return 'image';
  if (rawKind === 'link') return 'link';
  return 'file';
}

/** One asset, flattened with the fields of its current version for the grid. */
export interface AssetListItem {
  id: string;
  filename: string;
  /** Human-friendly name (backfilled from the post title); may be null. */
  displayName: string | null;
  folderPath: string;
  tags: string[];
  uploadedAt: string;
  currentVersionId: string | null;
  rawKind: string | null;
  kind: AssetKind;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  externalUrl: string | null;
  r2Key: string | null;
  versionNumber: number | null;
  attachmentCount: number;
}

/** Shape of the embedded current-version row (subset selected below). */
interface RawVersion {
  id: string;
  kind: string;
  mime_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  external_url: string | null;
  r2_key: string | null;
  version_number: number;
}

/** Shape of one asset row with its embedded current version. */
interface RawAssetRow {
  id: string;
  filename: string;
  display_name: string | null;
  folder_path: string;
  tags: string[];
  uploaded_at: string;
  current_version_id: string | null;
  current_version: RawVersion | null;
}

// assets.current_version_id and asset_versions.asset_id are two distinct FKs
// between the same pair of tables, so the embed MUST be disambiguated by the
// exact constraint name or PostgREST 300s on the ambiguous relationship.
const ASSET_SELECT =
  'id, filename, display_name, folder_path, tags, uploaded_at, current_version_id, ' +
  'current_version:asset_versions!assets_current_version_id_fkey(' +
  'id, kind, mime_type, size_bytes, width, height, duration_ms, external_url, r2_key, version_number)';

/**
 * Flatten raw asset rows + a per-asset attachment-count map into the display
 * shape. Pure: tests drive this directly with fixture rows. An asset whose
 * current_version is missing (mid-upload, or hidden by RLS) still renders, as a
 * file with null version fields.
 */
export function shapeAssets(
  rows: RawAssetRow[],
  attachmentCounts: ReadonlyMap<string, number>,
): AssetListItem[] {
  return rows.map((row) => {
    const v = row.current_version;
    return {
      id: row.id,
      filename: row.filename,
      displayName: row.display_name ?? null,
      folderPath: row.folder_path,
      tags: row.tags,
      uploadedAt: row.uploaded_at,
      currentVersionId: row.current_version_id,
      rawKind: v?.kind ?? null,
      kind: deriveKind(v?.kind ?? null),
      mimeType: v?.mime_type ?? null,
      sizeBytes: v?.size_bytes ?? null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      durationMs: v?.duration_ms ?? null,
      externalUrl: v?.external_url ?? null,
      r2Key: v?.r2_key ?? null,
      versionNumber: v?.version_number ?? null,
      attachmentCount: attachmentCounts.get(row.id) ?? 0,
    };
  });
}

/** Count live (non-deleted) attachments per asset id from the flat read. */
export function countAttachments(rows: { asset_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.asset_id, (counts.get(row.asset_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * List the active assets of one workspace, newest first, each flattened with its
 * current version and live attachment count. A transport/PostgREST failure
 * surfaces as { ok: false } rather than a throw, matching the @srtdio wrappers.
 */
export async function listAssets(
  client: Client,
  workspaceId: string,
): Promise<Result<AssetListItem[]>> {
  const assetsResult = await client
    .from('assets')
    .select(ASSET_SELECT)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('uploaded_at', { ascending: false });
  if (assetsResult.error) {
    return { ok: false, error: { code: 'unknown', message: assetsResult.error.message } };
  }

  const attachmentsResult = await client
    .from('asset_attachments')
    .select('asset_id')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);
  if (attachmentsResult.error) {
    return { ok: false, error: { code: 'unknown', message: attachmentsResult.error.message } };
  }

  const rows = (assetsResult.data ?? []) as unknown as RawAssetRow[];
  const counts = countAttachments((attachmentsResult.data ?? []) as { asset_id: string }[]);
  return { ok: true, data: shapeAssets(rows, counts) };
}

/**
 * Read the current member's role in a workspace with one RLS-scoped SELECT
 * (workspace_members is readable by members, mirroring the reads above; no proc,
 * no worker round-trip). Returns null when there is no active membership or the
 * read fails, and callers treat null as "no edit rights".
 */
export async function fetchMemberRole(
  client: Client,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const res = await client
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .eq('active', true)
    .maybeSingle();
  if (res.error || res.data === null) return null;
  return (res.data as { role: string | null }).role;
}

/**
 * Return a new list with one asset's display name replaced, so a rename updates
 * the grid card (and the open lightbox, which derives its title from the same
 * list) without a full reload. displayLabel prefers displayName, so setting it
 * shows the new name regardless of which column the worker persisted.
 */
export function renameAssetInList(
  items: AssetListItem[],
  assetId: string,
  name: string,
): AssetListItem[] {
  return items.map((item) => (item.id === assetId ? { ...item, displayName: name } : item));
}

/** The name shown on the card and matched by search/sort: display_name ?? filename. */
export function displayLabel(item: Pick<AssetListItem, 'displayName' | 'filename'>): string {
  const name = item.displayName;
  return name !== null && name.trim() !== '' ? name : item.filename;
}

/**
 * Return a new list with every asset whose id is in `ids` removed. Pure, so the
 * optimistic delete + rollback in AssetsPage is unit-tested without React: the
 * caller snapshots the current list, removes optimistically, and restores the
 * snapshot on failure.
 */
export function removeAssetsById(
  items: AssetListItem[],
  ids: ReadonlySet<string> | readonly string[],
): AssetListItem[] {
  const set = ids instanceof Set ? ids : new Set(ids);
  return items.filter((item) => !set.has(item.id));
}

/** Outcome of a bulk delete: the ids that succeeded and the ones that failed. */
export interface BatchDeleteOutcome {
  succeeded: string[];
  failed: { id: string; message: string }[];
}

/**
 * Delete many assets with a bounded number of in-flight requests, mirroring the
 * concurrency cap PresignCache applies to presigns so a large multi-select never
 * fires one request per id at once. `run` is injected (the assetDelete wrapper
 * in the app, a fake in tests) and returns the @srtdio Result shape; a rejected
 * id is partitioned into `failed`, never aborting the rest of the batch. Order
 * of `succeeded` is not significant; the caller removes them as a set.
 */
export async function deleteAssetsBatch(
  ids: readonly string[],
  limit: number,
  run: (id: string) => Promise<Result<unknown>>,
): Promise<BatchDeleteOutcome> {
  const outcome: BatchDeleteOutcome = { succeeded: [], failed: [] };
  const queue = [...ids];
  const width = Math.max(1, Math.min(limit, queue.length));

  async function worker(): Promise<void> {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const result = await run(id);
        if (result.ok) outcome.succeeded.push(id);
        else outcome.failed.push({ id, message: result.error.message });
      } catch (error) {
        outcome.failed.push({ id, message: error instanceof Error ? error.message : 'unknown' });
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return outcome;
}

/** Per-kind counts plus the `all` total, built generically from the items. */
export function buildKindCounts(items: AssetListItem[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = { all: items.length, image: 0, link: 0, file: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

/** Kinds that have at least one asset, in chip order. Zero-count kinds are hidden. */
export function visibleKinds(counts: Record<KindFilter, number>): AssetKind[] {
  return KIND_ORDER.filter((kind) => counts[kind] > 0);
}

/**
 * Apply the kind chip and the client-side name search. Search matches the
 * display label (display_name ?? filename) and ignores the folder so a query
 * reaches the whole library; folder scoping is applied by the caller only when
 * the search box is empty.
 */
export function filterAssets(
  items: AssetListItem[],
  kind: KindFilter,
  search: string,
): AssetListItem[] {
  const query = search.trim().toLowerCase();
  return items.filter((item) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (query !== '' && !displayLabel(item).toLowerCase().includes(query)) return false;
    return true;
  });
}

/** The library sort orders, in menu order. */
export type AssetSort = 'recent' | 'name' | 'size' | 'type';

export const ASSET_SORT_DEFAULT: AssetSort = 'recent';

export const ASSET_SORT_OPTIONS: { value: AssetSort; label: string }[] = [
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'type', label: 'Type' },
];

function compareName(a: AssetListItem, b: AssetListItem): number {
  return displayLabel(a).localeCompare(displayLabel(b), undefined, { sensitivity: 'base' });
}

/**
 * Order the list by the chosen sort. Recent = uploaded_at desc; Name = label
 * caseless; Size = size_bytes desc; Type = kind (chip order) then name. Pure and
 * non-mutating; the whole library is in memory (listAssets is unpaginated), so a
 * client sort is correct here.
 */
export function sortAssets(items: AssetListItem[], sort: AssetSort): AssetListItem[] {
  const copy = [...items];
  switch (sort) {
    case 'name':
      return copy.sort(compareName);
    case 'size':
      return copy.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    case 'type':
      return copy.sort((a, b) => {
        const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
        return byKind !== 0 ? byKind : compareName(a, b);
      });
    case 'recent':
    default:
      return copy.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }
}

/** What an image card's tile should render: a loading shimmer, the image, or a fallback. */
export type ImageTileState = 'shimmer' | 'image' | 'fallback';

/**
 * Decide the image tile state from the presign lifecycle. A presign-or-load
 * error, a disabled endpoint, or a missing stored version all fall back to the
 * glyph; a resolved URL shows the image; otherwise we are still presigning.
 */
export function imageTileState(args: {
  enabled: boolean;
  hasVersion: boolean;
  url: string | null;
  failed: boolean;
}): ImageTileState {
  if (args.failed || !args.enabled || !args.hasVersion) return 'fallback';
  if (args.url !== null) return 'image';
  return 'shimmer';
}

/** Immediate child folder names of `folder` derived from every asset path. */
export function subfolders(items: AssetListItem[], folder: string): string[] {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  const names = new Set<string>();
  for (const item of items) {
    const path = item.folderPath;
    if (!path.startsWith(prefix) || path === prefix) continue;
    const rest = path.slice(prefix.length);
    const name = rest.split('/')[0];
    if (name !== undefined && name !== '') names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Split a folder path into breadcrumb segments with their cumulative paths. */
export function breadcrumbSegments(folder: string): { name: string; path: string }[] {
  const parts = folder.split('/').filter((p) => p !== '');
  const segments: { name: string; path: string }[] = [];
  let acc = '';
  for (const part of parts) {
    acc = `${acc}/${part}`;
    segments.push({ name: part, path: `${acc}/` });
  }
  return segments;
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Humanize a byte count, or an em-dash-free placeholder when unknown. */
export function humanizeSize(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '-';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${SIZE_UNITS[unit]}`;
}

/** Uppercase file extension from a filename, or empty when there is none. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toUpperCase();
}

/** A short MIME badge: the subtype (image/png -> PNG), uppercased. */
export function mimeBadge(mime: string | null): string {
  if (mime === null || mime === '') return 'FILE';
  const subtype = mime.split('/')[1] ?? mime;
  return (subtype.split('+')[0] ?? subtype).toUpperCase();
}

/** The host of an external link, falling back to the raw value when unparsable. */
export function linkDomain(url: string | null): string {
  if (url === null || url === '') return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** `W x H` pixel dimensions, or a placeholder when either side is unknown. */
export function formatDimensions(width: number | null, height: number | null): string {
  if (width === null || height === null) return '-';
  return `${width} x ${height}`;
}
