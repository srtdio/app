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
  | { ok: true; reused: boolean; assetId: string }
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
  return { ok: true, reused: asset.reused, assetId: asset.assetId };
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

function assetField(body: unknown): { assetId: string; reused: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const asset = (body as { asset?: unknown }).asset;
  if (typeof asset !== 'object' || asset === null) return null;
  const assetId = (asset as { assetId?: unknown }).assetId;
  const reused = (asset as { reused?: unknown }).reused;
  if (typeof assetId !== 'string') return null;
  return { assetId, reused: reused === true };
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
