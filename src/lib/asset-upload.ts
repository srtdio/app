// Client upload module for the Assets library. This is the single source of
// truth for: what the file picker accepts, the pre-flight size/type checks that
// run before any bytes leave the device, the POST to the asset-upload Worker,
// the worker-error -> plain-English copy map, and the sequential run loop.
//
// The picker `accept` attribute and the pre-check are both derived from the one
// shared MIME allowlist in @srtdio/storage so they can never drift. Pure helpers
// are unit-tested directly; the network call takes an injected fetcher so tests
// drive it with a mock and the app passes fetchWithTrace.

import { ALLOWED_MIME_TYPES, isAllowedMime } from '@srtdio/storage';

// Hard ceiling mirrored from the worker pipeline (MAX_FILE_SIZE_BYTES, 100 MB).
// The worker rejects strictly greater than this, so the client matches exactly:
// a file equal to the limit is allowed, one byte over is not.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// The picker `accept` attribute, built from the shared allowlist. Importing the
// list rather than re-listing it keeps the picker and the pre-check in lockstep
// with the worker's server-side allowlist.
export const UPLOAD_ACCEPT = ALLOWED_MIME_TYPES.join(',');

export type Precheck = { ok: true } | { ok: false; message: string };

/**
 * Size-then-type gate, run at selection time before any request. A rejected file
 * never enters the queue and never triggers a network call. Size is checked
 * first so an oversize file reports the size error even if its type is also off.
 */
export function precheckFile(file: File): Precheck {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: 'Files up to 100MB only' };
  }
  if (!isAllowedMime(file.type)) {
    return { ok: false, message: "This file type isn't supported" };
  }
  return { ok: true };
}

/**
 * Map a worker error code (or a transport failure, code 'network') to the copy
 * shown in a toast. Unknown codes fall back to the generic retry line. No
 * em-dashes in any string (CLAUDE.md).
 */
export function uploadErrorMessage(code: string): string {
  switch (code) {
    case 'file_too_large':
      return 'Files up to 100MB only';
    case 'unsupported_mime':
      return "This file type isn't supported";
    case 'mime_mismatch':
      return "File contents don't match the file type";
    case 'virus_detected':
      return 'This file was blocked for safety';
    default:
      return 'Upload failed. Check your connection and retry';
  }
}

export type UploadOutcome =
  | { ok: true; reused: boolean; assetId: string; assetVersionId?: string }
  | { ok: false; message: string };

export interface UploadConfig {
  endpoint: string;
  token: string;
  workspaceId: string;
  /**
   * The filename the multipart part is sent under. It carries the user's chosen
   * display name (plus the original extension) so the worker persists it as
   * assets.filename for newly stored content.
   *
   * NOTE on display-name persistence: there is no authenticated client write
   * path for assets (no rename RPC, no member UPDATE policy: writes go through
   * the service-role worker only). So the name is persisted ONLY via this upload
   * filename, which the worker stores on first upload of given content. For a
   * deduped response (reused=true) the existing asset keeps its original
   * filename and is NOT renamed. Full display-name control (rename, and renaming
   * on dedup) needs a backend write path and is left for a follow-up.
   */
  filename: string;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * POST one file as multipart {file, workspace_id} with a Bearer token. Never
 * throws: a transport failure or a non-OK status becomes { ok: false } with
 * mapped copy. On success returns the asset id and whether the content was
 * deduped (reused).
 */
export async function uploadAssetFile(file: File, config: UploadConfig): Promise<UploadOutcome> {
  const form = new FormData();
  form.append('file', file, config.filename);
  form.append('workspace_id', config.workspaceId);

  let response: Response;
  try {
    response = await config.fetcher(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
    });
  } catch {
    return { ok: false, message: uploadErrorMessage('network') };
  }

  const body = await readJson(response);

  if (!response.ok) {
    return { ok: false, message: uploadErrorMessage(errorCode(body)) };
  }

  const asset = assetField(body);
  if (asset === null) {
    return { ok: false, message: uploadErrorMessage('network') };
  }
  // assetVersionId is the version the gallery add flow pins; include the key only
  // when the worker returned it, so callers that ignore it are unaffected.
  return {
    ok: true,
    reused: asset.reused,
    assetId: asset.assetId,
    ...(asset.assetVersionId !== null ? { assetVersionId: asset.assetVersionId } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return 'network';
}

function assetField(
  body: unknown,
): { assetId: string; reused: boolean; assetVersionId: string | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const asset = (body as { asset?: unknown }).asset;
  if (typeof asset !== 'object' || asset === null) return null;
  const assetId = (asset as { assetId?: unknown }).assetId;
  const reused = (asset as { reused?: unknown }).reused;
  const versionId = (asset as { versionId?: unknown }).versionId;
  if (typeof assetId !== 'string') return null;
  return {
    assetId,
    reused: reused === true,
    assetVersionId: typeof versionId === 'string' ? versionId : null,
  };
}

/**
 * Compose the upload filename from the user's display name and the original
 * file name: trim the display name and append the original extension when the
 * name does not already carry it.
 */
export function uploadFilename(displayName: string, originalName: string): string {
  const trimmed = displayName.trim();
  const dot = originalName.lastIndexOf('.');
  const ext = dot > 0 ? originalName.slice(dot) : '';
  if (ext === '' || trimmed.toLowerCase().endsWith(ext.toLowerCase())) return trimmed;
  return `${trimmed}${ext}`;
}

/** Every queued file must carry a non-empty display name before upload enables. */
export function allNamed(names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => name.trim() !== '');
}

// ---------------------------------------------------------------------------
// Add link + rename. Both POST to sibling routes on the SAME asset-upload
// worker (/links, /rename) behind the same Bearer auth + CORS as upload. The
// network calls take an injected fetcher so tests drive them with a mock; pure
// helpers (validation, the error maps, the role gate) are unit-tested directly.
// ---------------------------------------------------------------------------

/**
 * Validate the Add link field client-side, before any request: the value must
 * parse as a URL and start with http:// or https:// (a bare host or a non-web
 * scheme is rejected). Trims first so trailing whitespace never blocks a submit.
 */
export function isValidLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map a /links worker error code (or the transport failure code 'network') to
 * the copy shown in a toast. Unknown codes fall back to the generic retry line.
 * No em-dashes in any string (CLAUDE.md).
 */
export function linkErrorMessage(code: string): string {
  switch (code) {
    case 'invalid_url':
      return 'Enter a full link starting with https://';
    case 'name_required':
      return 'The link needs a name';
    default:
      return "Couldn't add the link. Check your connection and retry";
  }
}

export type LinkOutcome = { ok: true; assetId: string } | { ok: false; message: string };

export interface AddLinkConfig {
  /** The asset-upload worker base URL; the /links route is POSTed beneath it. */
  endpoint: string;
  token: string;
  workspaceId: string;
  url: string;
  name: string;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/** Join the worker base URL with a sibling route, tolerating a trailing slash. */
function workerRoute(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * POST {workspace_id, url, name} to the worker's /links route with a Bearer
 * token. Never throws: a transport failure or a non-OK status becomes
 * { ok: false } with mapped copy. The url and name are sent trimmed.
 */
export async function addAssetLink(config: AddLinkConfig): Promise<LinkOutcome> {
  let response: Response;
  try {
    response = await config.fetcher(workerRoute(config.endpoint, '/links'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        workspace_id: config.workspaceId,
        url: config.url.trim(),
        name: config.name.trim(),
      }),
    });
  } catch {
    return { ok: false, message: linkErrorMessage('network') };
  }

  const body = await readJson(response);
  if (!response.ok) {
    return { ok: false, message: linkErrorMessage(errorCode(body)) };
  }
  return { ok: true, assetId: assetIdOf(body) };
}

/**
 * Map a /folders create failure (or the transport code 'network') to toast copy.
 * Create never returns folder_name_taken (the worker auto-numbers a sibling
 * collision), so there is no collision line; everything falls back to the
 * generic retry copy. No em-dashes in any string (CLAUDE.md).
 */
export function folderErrorMessage(code: string): string {
  switch (code) {
    default:
      return "Couldn't create the folder. Check your connection and retry";
  }
}

export type FolderCreateOutcome =
  | { ok: true; folder: { id: string; name: string; parentId: string | null } }
  | { ok: false; message: string };

export interface CreateFolderConfig {
  /** The asset-upload worker base URL; the /folders route is POSTed beneath it. */
  endpoint: string;
  token: string;
  workspaceId: string;
  name: string;
  /** The parent folder id, or null to create at the library root. */
  parentId: string | null;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * POST {workspace_id, name, parent_id} to the worker's /folders route with a
 * Bearer token. Never throws: a transport failure or a non-OK status becomes
 * { ok: false } with mapped copy. On success returns the created folder (the
 * server may auto-number the name, so the returned name is authoritative).
 */
export async function createFolderRequest(
  config: CreateFolderConfig,
): Promise<FolderCreateOutcome> {
  let response: Response;
  try {
    response = await config.fetcher(workerRoute(config.endpoint, '/folders'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        workspace_id: config.workspaceId,
        name: config.name.trim(),
        parent_id: config.parentId,
      }),
    });
  } catch {
    return { ok: false, message: folderErrorMessage('network') };
  }

  const body = await readJson(response);
  if (!response.ok) {
    return { ok: false, message: folderErrorMessage(errorCode(body)) };
  }
  const folder = folderField(body);
  if (folder === null) {
    return { ok: false, message: folderErrorMessage('network') };
  }
  return { ok: true, folder };
}

/** Read the created folder from a {folder:{id,name,parent_id}} body; null when absent. */
function folderField(body: unknown): { id: string; name: string; parentId: string | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const folder = (body as { folder?: unknown }).folder;
  if (typeof folder !== 'object' || folder === null) return null;
  const f = folder as { id?: unknown; name?: unknown; parent_id?: unknown };
  if (typeof f.id !== 'string' || typeof f.name !== 'string') return null;
  return { id: f.id, name: f.name, parentId: typeof f.parent_id === 'string' ? f.parent_id : null };
}

export type FolderRenameOutcome =
  | { ok: true; folder: { id: string; name: string; parentId: string | null } }
  | { ok: false; nameTaken: boolean; message: string };

export interface RenameFolderConfig {
  /** The asset-upload worker base URL; the /folders/rename route is POSTed beneath it. */
  endpoint: string;
  token: string;
  workspaceId: string;
  folderId: string;
  name: string;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * POST {workspace_id, folder_id, name} to the worker's /folders/rename route with
 * a Bearer token. Never throws. On success returns the (possibly normalized)
 * folder. A sibling-name collision (folder_name_taken) is surfaced inline via
 * nameTaken:true; a 403 is the role guard (defense in depth) so it gets the
 * agency-only line; everything else falls back to the retry copy.
 */
export async function renameFolderRequest(
  config: RenameFolderConfig,
): Promise<FolderRenameOutcome> {
  let response: Response;
  try {
    response = await config.fetcher(workerRoute(config.endpoint, '/folders/rename'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        workspace_id: config.workspaceId,
        folder_id: config.folderId,
        name: config.name.trim(),
      }),
    });
  } catch {
    return {
      ok: false,
      nameTaken: false,
      message: "Couldn't rename the folder. Check your connection and retry",
    };
  }

  const body = await readJson(response);
  if (!response.ok) {
    if (errorCode(body) === 'folder_name_taken') {
      return {
        ok: false,
        nameTaken: true,
        message: 'A folder with this name already exists here',
      };
    }
    if (response.status === 403) {
      return { ok: false, nameTaken: false, message: 'Only the agency team can rename folders' };
    }
    return {
      ok: false,
      nameTaken: false,
      message: "Couldn't rename the folder. Check your connection and retry",
    };
  }

  const folder = folderField(body);
  if (folder === null) {
    return {
      ok: false,
      nameTaken: false,
      message: "Couldn't rename the folder. Check your connection and retry",
    };
  }
  return { ok: true, folder };
}

export type FolderDeleteOutcome = { ok: true } | { ok: false; message: string };

export interface DeleteFolderConfig {
  /** The asset-upload worker base URL; the /folders/delete route is POSTed beneath it. */
  endpoint: string;
  token: string;
  workspaceId: string;
  folderId: string;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * POST {workspace_id, folder_id} to the worker's /folders/delete route with a
 * Bearer token. Never throws. A 200 is success (the worker soft-deletes the
 * folder and detaches its child folders + assets to the root); a 403 is the role
 * guard; everything else falls back to the retry copy.
 */
export async function deleteFolderRequest(
  config: DeleteFolderConfig,
): Promise<FolderDeleteOutcome> {
  let response: Response;
  try {
    response = await config.fetcher(workerRoute(config.endpoint, '/folders/delete'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        workspace_id: config.workspaceId,
        folder_id: config.folderId,
      }),
    });
  } catch {
    return { ok: false, message: "Couldn't delete the folder. Check your connection and retry" };
  }

  if (!response.ok) {
    if (response.status === 403) {
      return { ok: false, message: 'Only the agency team can delete folders' };
    }
    return { ok: false, message: "Couldn't delete the folder. Check your connection and retry" };
  }
  return { ok: true };
}

/** Roles allowed to rename assets; mirrors the worker's 403 as defense in depth. */
export function canRenameAssets(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'agency';
}

/**
 * Map a /rename failure to toast copy. A 403 is the server-side role guard
 * (defense in depth: the edit affordance is already hidden for clients), so it
 * gets the agency-only line; everything else falls back to the retry line.
 */
export function renameErrorMessage(status: number): string {
  if (status === 403) return 'Only the agency team can rename assets';
  return "Couldn't rename this asset. Check your connection and retry";
}

export type RenameOutcome = { ok: true } | { ok: false; message: string };

export interface RenameConfig {
  /** The asset-upload worker base URL; the /rename route is POSTed beneath it. */
  endpoint: string;
  token: string;
  workspaceId: string;
  assetId: string;
  name: string;
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * POST {workspace_id, asset_id, name} to the worker's /rename route with a
 * Bearer token. Never throws: a transport failure or a non-OK status becomes
 * { ok: false } with mapped copy; a 200 is success.
 */
export async function renameAsset(config: RenameConfig): Promise<RenameOutcome> {
  let response: Response;
  try {
    response = await config.fetcher(workerRoute(config.endpoint, '/rename'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        workspace_id: config.workspaceId,
        asset_id: config.assetId,
        name: config.name.trim(),
      }),
    });
  } catch {
    return { ok: false, message: renameErrorMessage(0) };
  }
  if (!response.ok) {
    return { ok: false, message: renameErrorMessage(response.status) };
  }
  return { ok: true };
}

/** Read the new asset's id from a {asset} body, tolerating assetId or id; '' when absent. */
function assetIdOf(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const asset = (body as { asset?: unknown }).asset;
    if (typeof asset === 'object' && asset !== null) {
      const a = asset as { assetId?: unknown; id?: unknown };
      if (typeof a.assetId === 'string') return a.assetId;
      if (typeof a.id === 'string') return a.id;
    }
  }
  return '';
}

/** One item to upload: a stable id, the bytes, and the name to send it under. */
export interface QueueItem {
  id: string;
  file: File;
  filename: string;
}

export interface RunResult {
  succeeded: string[];
  failed: { id: string; message: string }[];
}

export interface RunHooks {
  onStart?: (id: string) => void;
  onResult?: (id: string, outcome: UploadOutcome) => void;
}

/**
 * Upload a queue one file at a time (sequential, per the worker contract). A
 * failure does not abort the run: the rest of the queue still uploads and the
 * failure is returned with its copy so the UI can offer an inline retry. The
 * hooks let the caller flip per-file UI state before and after each upload.
 */
export async function runUploads(
  items: readonly QueueItem[],
  uploadOne: (item: QueueItem) => Promise<UploadOutcome>,
  hooks?: RunHooks,
): Promise<RunResult> {
  const result: RunResult = { succeeded: [], failed: [] };
  for (const item of items) {
    hooks?.onStart?.(item.id);
    const outcome = await uploadOne(item);
    hooks?.onResult?.(item.id, outcome);
    if (outcome.ok) result.succeeded.push(item.id);
    else result.failed.push({ id: item.id, message: outcome.message });
  }
  return result;
}
