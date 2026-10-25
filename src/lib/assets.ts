// The asset read + shaping layer for the workspace-global Assets library.
//
// Reads are plain RLS-scoped SELECTs through the supabase client (policies
// assets_select_member / asset_versions_select_member / asset_attachments_select_member),
// mirroring @srtdio/briefs: no proc, no service role, tenant isolation is
// Postgres' job. listAssets does two round-trips (assets + their current version
// embedded, then a single attachments read for the per-asset live count) so
// there is no N+1. All shaping below is pure and unit-tested; kinds, labels and
// counts are derived from the fetched rows, never hardcoded.

import { assetRestore, type Client, type Result } from '@srtdio/rpc';
import type { PurgeRequest, PurgeResponse } from '@/server/workers/asset-upload-purge-contracts';

/**
 * The version kinds the server records (asset_versions.kind CHECK, live). A
 * version whose kind is not one of these (or an asset with no current version)
 * has kind null and shows under All only.
 */
export const ASSET_KINDS = [
  'image',
  'video',
  'audio',
  'pdf',
  'document',
  'spreadsheet',
  'presentation',
  'link',
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/** The Assets tabs, in display order. `all` shows every asset. */
export type AssetTab = 'all' | 'media' | 'pdf' | 'docs' | 'sheets' | 'links';

export const ASSET_TABS: readonly AssetTab[] = ['all', 'media', 'pdf', 'docs', 'sheets', 'links'];

export const ASSET_TAB_DEFAULT: AssetTab = 'all';

/** The one mapping from a version kind to its (non-All) tab. */
export const KIND_TAB: Record<AssetKind, Exclude<AssetTab, 'all'>> = {
  image: 'media',
  video: 'media',
  audio: 'media',
  pdf: 'pdf',
  document: 'docs',
  presentation: 'docs',
  spreadsheet: 'sheets',
  link: 'links',
};

export const TAB_LABELS: Record<AssetTab, string> = {
  all: 'All',
  media: 'Media',
  pdf: 'PDF',
  docs: 'Docs',
  sheets: 'Sheets',
  links: 'Links',
};

/** What an empty tab says. All keeps the page's own empty states. */
export const TAB_EMPTY: Record<Exclude<AssetTab, 'all'>, string> = {
  media: 'Photos and videos show up here.',
  pdf: 'PDFs show up here.',
  docs: 'Docs show up here.',
  sheets: 'Sheets show up here.',
  links: 'Links show up here.',
};

/** The version's raw kind, or null when it is missing or not a known kind. */
export function toAssetKind(rawKind: string | null): AssetKind | null {
  return ASSET_KINDS.find((kind) => kind === rawKind) ?? null;
}

/** The tab named by a ?type= value; anything else (missing, unknown) is All. */
export function parseAssetTab(value: string | null): AssetTab {
  return ASSET_TABS.find((tab) => tab === value) ?? ASSET_TAB_DEFAULT;
}

/** Whether an asset shows under a tab. */
export function inTab(item: Pick<AssetListItem, 'kind'>, tab: AssetTab): boolean {
  if (tab === 'all') return true;
  return item.kind !== null && KIND_TAB[item.kind] === tab;
}

/** One asset, flattened with the fields of its current version for the grid. */
export interface AssetListItem {
  id: string;
  filename: string;
  /** Human-friendly name (backfilled from the post title); may be null. */
  displayName: string | null;
  folderPath: string;
  /** The real folders-table parent of this asset; null = library root. */
  folderId: string | null;
  tags: string[];
  uploadedAt: string;
  currentVersionId: string | null;
  /** The current version's kind; null when there is none or it is unknown. */
  kind: AssetKind | null;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** PDF page count (asset_versions.page_count); null when unknown. */
  pageCount: number | null;
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
  page_count: number | null;
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
  folder_id: string | null;
  tags: string[];
  uploaded_at: string;
  current_version_id: string | null;
  current_version: RawVersion | null;
}

// assets.current_version_id and asset_versions.asset_id are two distinct FKs
// between the same pair of tables, so the embed MUST be disambiguated by the
// exact constraint name or PostgREST 300s on the ambiguous relationship.
const ASSET_SELECT =
  'id, filename, display_name, folder_path, folder_id, tags, uploaded_at, current_version_id, ' +
  'current_version:asset_versions!assets_current_version_id_fkey(' +
  'id, kind, mime_type, size_bytes, width, height, duration_ms, page_count, external_url, r2_key, version_number)';

/**
 * Flatten raw asset rows + a per-asset attachment-count map into the display
 * shape. Pure: tests drive this directly with fixture rows. An asset whose
 * current_version is missing (mid-upload, or hidden by RLS) still renders, with
 * a null kind and null version fields.
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
      folderId: row.folder_id,
      tags: row.tags,
      uploadedAt: row.uploaded_at,
      currentVersionId: row.current_version_id,
      kind: toAssetKind(v?.kind ?? null),
      mimeType: v?.mime_type ?? null,
      sizeBytes: v?.size_bytes ?? null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      durationMs: v?.duration_ms ?? null,
      pageCount: v?.page_count ?? null,
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
  // The two reads are independent: run them together (one round trip of wait).
  const [assetsResult, attachmentsResult] = await Promise.all([
    client
      .from('assets')
      .select(ASSET_SELECT)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('uploaded_at', { ascending: false }),
    client
      .from('asset_attachments')
      .select('asset_id')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
  ]);
  if (assetsResult.error) {
    return { ok: false, error: { code: 'unknown', message: assetsResult.error.message } };
  }
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

/** The most ids a single asset_delete_many call may carry (matches the move cap). */
export const BULK_DELETE_MAX = 200;

/** Pure boundary predicate: a bulk delete is allowed only for 1..BULK_DELETE_MAX ids, so the RPC is never called with 0 or over the cap. */
export function canBulkDelete(count: number): boolean {
  return count >= 1 && count <= BULK_DELETE_MAX;
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

/** Per-tab counts over the given items: All is the total, each kind counts once. */
export function buildTabCounts(items: AssetListItem[]): Record<AssetTab, number> {
  const counts: Record<AssetTab, number> = {
    all: items.length,
    media: 0,
    pdf: 0,
    docs: 0,
    sheets: 0,
    links: 0,
  };
  for (const item of items) {
    if (item.kind !== null) counts[KIND_TAB[item.kind]] += 1;
  }
  return counts;
}

/**
 * Apply the tab and the client-side name search. Search matches the display
 * label (display_name ?? filename) across the whole library.
 */
export function filterAssets(
  items: AssetListItem[],
  tab: AssetTab,
  search: string,
): AssetListItem[] {
  const query = search.trim().toLowerCase();
  return items.filter((item) => {
    if (!inTab(item, tab)) return false;
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

/** Sort rank for Type: the item's tab position; an unknown kind sorts last. */
function typeRank(item: AssetListItem): number {
  return item.kind === null ? ASSET_TABS.length : ASSET_TABS.indexOf(KIND_TAB[item.kind]);
}

function compareName(a: AssetListItem, b: AssetListItem): number {
  return displayLabel(a).localeCompare(displayLabel(b), undefined, { sensitivity: 'base' });
}

/**
 * Order the list by the chosen sort. Recent = uploaded_at desc; Name = label
 * caseless; Size = size_bytes desc; Type = tab order then name. Pure and
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
        const byKind = typeRank(a) - typeRank(b);
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

// ---------------------------------------------------------------------------
// Recently deleted. A deleted library file stays readable (RLS policy
// assets_select_deleted_member) until the owner purges it or 31 days pass, so
// the list is one plain SELECT with every version's size embedded.
// Restore is the asset_restore proc; purge is the asset-upload Worker's /purge
// route (owner only), behind the same Bearer auth as the other worker routes.
// ---------------------------------------------------------------------------

/** How long a deleted file is kept before the purge job removes it for good. */
const RECENTLY_DELETED_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left before a file deleted at `deletedAt` is gone; never below 0. */
export function daysLeft(deletedAt: string, now: number = Date.now()): number {
  const elapsed = Math.floor((now - Date.parse(deletedAt)) / DAY_MS);
  return Math.max(0, RECENTLY_DELETED_DAYS - elapsed);
}

function fileCount(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** One Recently deleted row's detail line: "<size> · gone in <d> days". */
export function goneInLine(sizeBytes: number | null, days: number): string {
  return `${humanizeSize(sizeBytes)} · gone in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Bytes as megabytes for the Empty now hint: one decimal under 10 MB, whole above. */
export function formatMegabytes(bytes: number): string {
  const mb = Math.max(0, bytes) / (1024 * 1024);
  return mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
}

/** The owner's Empty now hint: "Frees <X> MB right away." */
export function freesLine(bytes: number): string {
  return `Frees ${formatMegabytes(bytes)} MB right away.`;
}

/** The Empty now confirm body: "<n> files deleted for good. ..." */
export function emptyConfirmMessage(count: number): string {
  return `${fileCount(count)} deleted for good. Nothing is saved, and this can't be undone.`;
}

/** One file in Recently deleted. */
export interface DeletedAssetItem {
  id: string;
  /** display_name ?? filename, shown in full. */
  name: string;
  deletedAt: string;
  sizeBytes: number | null;
}

interface RawDeletedRow {
  id: string;
  filename: string;
  display_name: string | null;
  deleted_at: string;
  versions: { size_bytes: number | null }[] | null;
}

// Every version, not just the current one: a purge frees them all. Embedded
// through asset_versions.asset_id (disambiguated from current_version_id).
// Renditions are not embedded: authenticated holds no SELECT on
// asset_renditions, so their bytes are not counted here.
const DELETED_SELECT =
  'id, filename, display_name, deleted_at, ' +
  'versions:asset_versions!asset_versions_asset_id_fkey(size_bytes)';

/** Sum of every version's size; null when no version records one. */
function versionsBytes(versions: RawDeletedRow['versions']): number | null {
  const sizes = (versions ?? []).flatMap((v) => (v.size_bytes === null ? [] : [v.size_bytes]));
  return sizes.length === 0 ? null : sizes.reduce((sum, size) => sum + size, 0);
}

/** Flatten raw deleted rows into the display shape. Pure. */
function shapeDeletedAssets(rows: RawDeletedRow[]): DeletedAssetItem[] {
  return rows.map((row) => ({
    id: row.id,
    name: displayLabel({ displayName: row.display_name, filename: row.filename }),
    deletedAt: row.deleted_at,
    sizeBytes: versionsBytes(row.versions),
  }));
}

/** Total bytes Recently deleted holds, for the Empty now hint. */
export function deletedBytes(items: DeletedAssetItem[]): number {
  return items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
}

/**
 * List one workspace's Recently deleted library files, most recently deleted
 * first, in ONE read (sizes sum the embedded versions). Files the
 * owner already asked to purge are excluded, matching the RLS policy.
 */
export async function listDeletedAssets(
  client: Client,
  workspaceId: string,
): Promise<Result<DeletedAssetItem[]>> {
  const result = await client
    .from('assets')
    .select(DELETED_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('origin', 'library')
    .not('deleted_at', 'is', null)
    .is('purge_requested_at', null)
    .order('deleted_at', { ascending: false });
  if (result.error) {
    return { ok: false, error: { code: 'unknown', message: result.error.message } };
  }
  return { ok: true, data: shapeDeletedAssets((result.data ?? []) as unknown as RawDeletedRow[]) };
}

/** Restore one deleted file to the library via asset_restore. */
export function restoreAsset(
  client: Client,
  assetId: string,
  traceId: string,
): Promise<Result<undefined>> {
  return assetRestore(client, { p_asset_id: assetId, p_trace_id: traceId });
}

export interface PurgeConfig {
  /** The asset-upload worker base URL; the /purge route is POSTed beneath it. */
  endpoint: string;
  token: string;
  workspaceId: string;
  /** The files to delete for good; omitted = everything in Recently deleted. */
  assetIds?: string[] | undefined;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

function isPurgeResponse(body: unknown): body is PurgeResponse {
  if (typeof body !== 'object' || body === null) return false;
  const { requested, removed, freedBytes } = body as Record<string, unknown>;
  return [requested, removed, freedBytes].every(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
}

/** The worker's error code from an {error:{code}} body, or `http_<status>`. */
function purgeErrorCode(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code !== '') return code;
    }
  }
  return `http_${status}`;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * POST {workspace_id, asset_ids?} to the worker's /purge route with a Bearer
 * token. Never throws: a transport failure is { ok: false } with message
 * 'network', a non-OK status carries the worker's error code (owner_only,
 * not_member, ...) as the message, and a malformed 200 body is 'bad_response'.
 */
export async function purgeAssets(config: PurgeConfig): Promise<Result<PurgeResponse>> {
  const request: PurgeRequest = { workspace_id: config.workspaceId };
  if (config.assetIds !== undefined) request.asset_ids = config.assetIds;
  let response: Response;
  try {
    response = await config.fetcher(`${config.endpoint.replace(/\/+$/, '')}/purge`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, error: { code: 'unknown', message: 'network' } };
  }
  const body = await readBody(response);
  if (!response.ok) {
    return {
      ok: false,
      error: { code: 'unknown', message: purgeErrorCode(body, response.status) },
    };
  }
  if (!isPurgeResponse(body)) {
    return { ok: false, error: { code: 'unknown', message: 'bad_response' } };
  }
  return {
    ok: true,
    data: { requested: body.requested, removed: body.removed, freedBytes: body.freedBytes },
  };
}

// ---------------------------------------------------------------------------
// Delete blocked by use. asset_delete / asset_delete_many raise 'asset_in_use'
// when a live post, brief or comment still attaches the file; the error names
// no parent, so findAssetsInUse looks it up with bounded reads (attachments,
// then one read per parent table), never one per asset.
// ---------------------------------------------------------------------------

/** The delete confirm body, under "Delete <name>?". */
export const DELETE_CONFIRM_MESSAGE =
  'It moves to Recently deleted and is gone for good after 31 days. It keeps using storage until then, unless the owner empties it earlier.';

/** What a delete call came back with, for the confirm surfaces. */
export type AssetDeleteOutcome = 'deleted' | 'in_use' | 'failed';

/** Whether a delete proc failed because the file is still attached somewhere live. */
export function isAssetInUseError(error: { message: string }): boolean {
  return error.message === 'asset_in_use';
}

export type AssetParentKind = 'post' | 'brief' | 'comment';

/** Where a blocked file is used, and the route that opens it. */
export interface AssetParent {
  kind: AssetParentKind;
  href: string;
}

export interface AssetInUse {
  assetId: string;
  parent: AssetParent;
}

/** The in-use sheet's button for a parent kind. */
export function openParentLabel(kind: AssetParentKind): string {
  if (kind === 'brief') return 'Open brief';
  if (kind === 'comment') return 'Open comment';
  return 'Open post';
}

/**
 * The in-use sheet body, matching where the file is used. `more` is how many
 * other selected files are also in use. A post or comment names what to delete
 * first; a brief never does (briefs are read-only once created), so the file
 * simply stays. A failed lookup (kind null) says only that it is in use. Pure.
 */
export function assetInUseMessage(
  name: string,
  more: number,
  kind: AssetParentKind | null = 'post',
): string {
  const subject = more > 0 ? `${name} and ${more} more are` : `${name} is`;
  if (kind === 'brief') {
    return `${subject} attached to a brief. Briefs can't be changed once created, so the file stays.`;
  }
  if (kind === 'comment') {
    return `${subject} attached to a comment. Delete the comment first, then the file.`;
  }
  if (kind === null) return `${subject} still in use, so it can't be deleted.`;
  return `${subject} part of a post. Delete the post first, then the file.`;
}

/** The in-use sheet title for where the file is used. Pure. */
export function inUseTitle(kind: AssetParentKind | null): string {
  if (kind === 'brief') return 'Used in a brief';
  if (kind === 'comment') return 'Used in a comment';
  if (kind === 'post') return 'Used in a post';
  return 'File in use';
}

/** The toast after a bulk delete kept the files that are in use. Pure. */
export function inUseKeptLabel(count: number): string {
  return count === 1
    ? '1 file is in use and was kept.'
    : `${count} files are in use and were kept.`;
}

/**
 * Split a bulk delete into the files that are free to delete and the ones in
 * use. asset_delete_many is all-or-nothing (one in-use file refuses the whole
 * call), so the page checks once, then deletes only the free subset. Pure.
 */
export function splitFreeAssets(
  ids: readonly string[],
  inUse: readonly { assetId: string }[],
): { free: string[]; kept: string[] } {
  const used = new Set(inUse.map((row) => row.assetId));
  return {
    free: ids.filter((id) => !used.has(id)),
    kept: ids.filter((id) => used.has(id)),
  };
}

function entityHref(entityType: string, entityId: string): string | null {
  if (entityType === 'post') return `/posts/${entityId}`;
  if (entityType === 'brief') return `/briefs/${entityId}`;
  return null;
}

interface RawAttachment {
  asset_id: string;
  entity_type: string;
  entity_id: string;
}

interface RawComment {
  id: string;
  entity_type: string;
  entity_id: string;
}

/**
 * Pick each asset's live parent from the reads below. Pure. Assets keep the
 * order of `assetIds`; attachments are taken newest first; an attachment whose
 * parent is not live (deleted, hidden by RLS) is skipped, as asset_in_use does.
 */
export function resolveAssetParents(
  assetIds: readonly string[],
  attachments: RawAttachment[],
  livePostIds: ReadonlySet<string>,
  liveBriefIds: ReadonlySet<string>,
  liveComments: ReadonlyMap<string, RawComment>,
): AssetInUse[] {
  const out: AssetInUse[] = [];
  for (const assetId of assetIds) {
    for (const row of attachments) {
      if (row.asset_id !== assetId) continue;
      let parent: AssetParent | null = null;
      if (row.entity_type === 'post' && livePostIds.has(row.entity_id)) {
        parent = { kind: 'post', href: `/posts/${row.entity_id}` };
      } else if (row.entity_type === 'brief' && liveBriefIds.has(row.entity_id)) {
        parent = { kind: 'brief', href: `/briefs/${row.entity_id}` };
      } else if (row.entity_type === 'comment') {
        const comment = liveComments.get(row.entity_id);
        const base = comment ? entityHref(comment.entity_type, comment.entity_id) : null;
        if (comment && base !== null) {
          parent = { kind: 'comment', href: `${base}?comment=${comment.id}` };
        }
      }
      if (parent !== null) {
        out.push({ assetId, parent });
        break;
      }
    }
  }
  return out;
}

function idsOfType(rows: RawAttachment[], type: string): string[] {
  return [...new Set(rows.filter((row) => row.entity_type === type).map((row) => row.entity_id))];
}

/**
 * Which of `assetIds` are still used by a live post, brief or comment, each with
 * the route to its parent. One attachments read, then at most one read each of
 * posts, briefs and comments in parallel (all RLS-scoped).
 */
export async function findAssetsInUse(
  client: Client,
  assetIds: readonly string[],
): Promise<Result<AssetInUse[]>> {
  if (assetIds.length === 0) return { ok: true, data: [] };
  const attachments = await client
    .from('asset_attachments')
    .select('asset_id, entity_type, entity_id')
    .in('asset_id', [...assetIds])
    .is('deleted_at', null)
    .order('attached_at', { ascending: false });
  if (attachments.error) {
    return { ok: false, error: { code: 'unknown', message: attachments.error.message } };
  }
  const rows = (attachments.data ?? []) as RawAttachment[];
  const postIds = idsOfType(rows, 'post');
  const briefIds = idsOfType(rows, 'brief');
  const commentIds = idsOfType(rows, 'comment');

  const [posts, briefs, comments] = await Promise.all([
    postIds.length === 0
      ? null
      : client.from('posts').select('id').in('id', postIds).is('deleted_at', null),
    briefIds.length === 0
      ? null
      : client.from('briefs').select('id').in('id', briefIds).is('deleted_at', null),
    commentIds.length === 0
      ? null
      : client
          .from('comments')
          .select('id, entity_type, entity_id')
          .in('id', commentIds)
          .is('deleted_at', null),
  ]);
  const failed = [posts, briefs, comments].find((res) => res !== null && res.error !== null);
  if (failed?.error) {
    return { ok: false, error: { code: 'unknown', message: failed.error.message } };
  }
  const livePostIds = new Set(((posts?.data ?? []) as { id: string }[]).map((row) => row.id));
  const liveBriefIds = new Set(((briefs?.data ?? []) as { id: string }[]).map((row) => row.id));
  const liveComments = new Map(
    ((comments?.data ?? []) as RawComment[]).map((row) => [row.id, row]),
  );
  return {
    ok: true,
    data: resolveAssetParents(assetIds, rows, livePostIds, liveBriefIds, liveComments),
  };
}
