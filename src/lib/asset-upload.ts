// Client upload module for the Assets library. This is the single source of
// truth for: what the file picker accepts, the pre-flight size/type checks that
// run before any bytes leave the device, the POST to the asset-upload Worker,
// the worker-error -> plain-English copy map, and the run loop (up to three
// files at once, see upload-queue.ts).
//
// The picker `accept` attribute and the pre-check are both derived from the one
// shared MIME allowlist in @srtdio/storage so they can never drift. Pure helpers
// are unit-tested directly; the network call takes an injected fetcher so tests
// drive it with a mock and the app passes fetchWithTrace.

import { ALLOWED_MIME_TYPES, isAllowedMime } from '@srtdio/storage';
import { logger } from '@/lib/logger';
import { reportWorkspaceFull } from '@/lib/storage-full';
import { TRACE_ID_HEADER } from '@/lib/trace';
import {
  isListCopyImage,
  makeImageThumbnail,
  sharedThumbnail,
  thumbnailKind,
  THUMBNAIL_TIMEOUT_MS,
  type Thumbnail,
  type ThumbnailResult,
} from '@/lib/files/thumbnail';
import {
  UPLOAD_CONCURRENCY,
  bytesToFraction,
  monotonicProgress,
  runWithConcurrency,
} from '@/lib/upload-queue';

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
 * shown in a toast. Unknown codes fall back to the generic retry line, which
 * never mentions the connection. No em-dashes in any string (CLAUDE.md).
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
    case 'blocked_type':
      return "This file type isn't allowed";
    case 'encrypted_file':
      return "Password-protected files can't be shared";
    case 'embedded_content':
      return "This file contains embedded content that can't be checked.";
    case 'archive_limits':
      return 'This file is too complex to check';
    case 'external_content':
      return "This file loads content from the internet and can't be shared.";
    case WORKSPACE_FULL_CODE:
      return 'This workspace is full';
    default:
      return "Couldn't upload. Try again.";
  }
}

/** The thumbnail the worker stored for this version (pdf/video only). */
export interface StoredThumbnail {
  width: number;
  height: number;
  /** PDFs only: the page count the thumbnail was made with. */
  pageCount?: number;
}

/** The asset-upload Worker's 413 code for an upload that does not fit the workspace. */
const WORKSPACE_FULL_CODE = 'workspace_full';

/** A failed upload; code is set only for a full workspace (the full sheet is already open). */
type UploadFailure = { ok: false; message: string; code?: typeof WORKSPACE_FULL_CODE };

export type UploadOutcome =
  | {
      ok: true;
      reused: boolean;
      assetId: string;
      assetVersionId?: string;
      /**
       * Present only when the upload's own reply carried the stored thumbnail.
       * A thumbnail attached after the original is never on the outcome: it
       * reaches config.onThumbnail instead.
       */
      thumbnail?: StoredThumbnail;
    }
  | UploadFailure;

/** Makes the thumbnail sent with a pdf/video upload or an image's list copy; tests inject a fake. */
type ThumbnailMaker = (file: File) => Promise<ThumbnailResult>;

export type UploadConfig = UploadConfigBase & UploadTransport;

/**
 * Where an upload comes from, sent as the `origin` form field and stored as
 * assets.origin. Only the chat composer (and its outbox) sends 'chat'; a chat
 * file stays in its chat and never shows in Assets.
 */
export type AssetOrigin = 'library' | 'chat';

interface UploadConfigBase {
  endpoint: string;
  token: string;
  workspaceId: string;
  /** Required so no caller can forget it; the worker would default to 'library'. */
  origin: AssetOrigin;
  /**
   * The ORIGINAL device filename, sent as the multipart part name and stored by
   * the worker as assets.filename. It keeps its extension so the type-icon /
   * preview logic still works; the friendly shown name rides separately in
   * displayName. The worker resolves the shown label as display_name ?? filename.
   */
  filename: string;
  /**
   * The friendly shown name, persisted as assets.display_name. Sent only when a
   * non-empty value is provided; omitted at the request level otherwise (the
   * worker then falls back to filename for the label).
   */
  displayName?: string | null;
  /** Destination folder id; sent as folder_id, omitted at the library root (null). */
  folderId?: string | null;
  /**
   * Thumbnail maker for pdf/video files; defaults to the shared sender-side
   * one (one attempt per File, also shown on the sending bubble).
   */
  makeThumbnail?: ThumbnailMaker;
  /**
   * Called once if a thumbnail is attached after the outcome resolved (POST
   * /thumbnail landed). The outcome never waits for it; callers that want the
   * stored rendition's size listen here. Never called for a failed thumbnail.
   */
  onThumbnail?: (thumbnail: StoredThumbnail) => void;
  /** Waits between part retries; tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The XMLHttpRequest transport: the only way to observe upload progress
 * (fetch exposes no request-body progress). `traceId` rides as X-Trace-Id, as
 * fetchWithTrace would add it; `createRequest` is injected by tests.
 */
export interface XhrTransport {
  traceId: string;
  /** Upload progress as a fraction 0..1; only called when the size is computable. */
  onProgress?: (fraction: number) => void;
  /** Aborting it aborts the request at once (the POST then rejects like a transport failure). */
  signal?: AbortSignal;
  createRequest?: () => XMLHttpRequest;
}

/** The fetch-shaped POST: tests pass a mock; the app passes fetchWithTrace. */
export type UploadFetcher = (input: string, init: RequestInit) => Promise<Response>;

/** How the POST goes out: an injected fetcher (Assets, posts) or XHR (chat, with progress). */
export type UploadTransport =
  | { fetcher: UploadFetcher; xhr?: undefined }
  | { xhr: XhrTransport; fetcher?: undefined };

/** A finished POST as the response parser reads it, whichever transport sent it. */
interface UploadResponse {
  ok: boolean;
  body: unknown;
}

/** Parse an XHR response body as JSON; null when empty or malformed. */
function parseXhrBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * POST the form over XMLHttpRequest with the same headers the fetch path sends
 * (Bearer + X-Trace-Id). Resolves on any HTTP status; rejects on a transport
 * failure (network error, abort, timeout), which the caller maps to 'network'.
 */
export function xhrPost(
  endpoint: string,
  headers: Record<string, string>,
  body: FormData,
  transport: XhrTransport,
): Promise<UploadResponse> {
  return xhrSend('POST', endpoint, headers, body, transport);
}

/** {@link xhrPost} for any method and body; status is kept for retry decisions. */
function xhrSend(
  method: string,
  endpoint: string,
  headers: Record<string, string>,
  body: XMLHttpRequestBodyInit | null,
  transport: XhrTransport,
): Promise<UploadResponse & { status: number }> {
  return new Promise((resolve, reject) => {
    const signal = transport.signal;
    // Cancelled before it started: no request at all.
    if (signal?.aborted === true) {
      reject(new Error('upload aborted'));
      return;
    }
    const request = transport.createRequest?.() ?? new XMLHttpRequest();
    const onAbort = (): void => request.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const release = (): void => signal?.removeEventListener('abort', onAbort);
    request.open(method, endpoint);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.setRequestHeader(TRACE_ID_HEADER, transport.traceId);
    const onProgress = transport.onProgress;
    if (onProgress !== undefined) {
      request.upload.onprogress = (event: ProgressEvent) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(bytesToFraction(event.loaded, event.total));
        }
      };
    }
    request.onload = () => {
      release();
      resolve({
        ok: request.status >= 200 && request.status < 300,
        status: request.status,
        body: parseXhrBody(request.responseText),
      });
    };
    const fail = (): void => {
      release();
      reject(new Error('upload transport failed'));
    };
    request.onerror = fail;
    request.onabort = fail;
    request.ontimeout = fail;
    request.send(body);
  });
}

/** Send the form through whichever transport the config carries. */
async function postUpload(
  endpoint: string,
  headers: Record<string, string>,
  body: FormData,
  transport: UploadTransport,
): Promise<UploadResponse> {
  if (transport.xhr !== undefined) return xhrPost(endpoint, headers, body, transport.xhr);
  const response = await transport.fetcher(endpoint, { method: 'POST', headers, body });
  return { ok: response.ok, body: await readJson(response) };
}

/**
 * Window event fired after every successful upload (library, chat, post
 * composer: they all go through uploadAssetFile), so the shell can re-read
 * storage usage without importing any upload surface.
 */
export const UPLOAD_COMPLETE_EVENT = 'sorted:upload-complete';

export interface UploadCompleteDetail {
  workspaceId: string;
}

function dispatchUploadComplete(workspaceId: string): void {
  // No window outside the browser (node-run tests): nothing is listening there.
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<UploadCompleteDetail>(UPLOAD_COMPLETE_EVENT, { detail: { workspaceId } }),
  );
}

/**
 * POST one file as multipart {file, workspace_id} (plus an optional display_name
 * and folder_id) with a Bearer token, over the config's transport (XHR when the
 * caller wants progress). Never throws: a transport failure or a
 * non-OK status becomes { ok: false } with mapped copy. On success returns the
 * asset id and whether the content was deduped (reused). A file of one part or
 * less goes out at once. The outcome resolves as soon as the original is
 * stored and never waits on the thumbnail: one still being made follows on
 * POST /thumbnail in the background (config.onThumbnail hears when it lands).
 */
export async function uploadAssetFile(
  file: File,
  givenConfig: UploadConfig,
): Promise<UploadOutcome> {
  // The bar only ever moves forward, even when a request or part is retried.
  const givenXhr = givenConfig.xhr;
  const config: UploadConfig =
    givenXhr?.onProgress !== undefined
      ? {
          ...givenConfig,
          fetcher: undefined,
          xhr: { ...givenXhr, onProgress: monotonicProgress(givenXhr.onProgress) },
        }
      : givenConfig;
  const resumable = file.size > RESUMABLE_PART_SIZE;
  const form = new FormData();
  if (!resumable) form.append('file', file, config.filename);
  form.append('workspace_id', config.workspaceId);
  form.append('origin', config.origin);
  if (config.displayName != null && config.displayName.trim() !== '') {
    form.append('display_name', config.displayName);
  }
  if (config.folderId != null) {
    form.append('folder_id', config.folderId);
  }
  // The thumbnail starts now, alongside the original, and never holds it back.
  // A resumable upload carries it in the complete form only when it is already
  // made by then; otherwise (and always on the direct POST) it follows on its
  // own POST /thumbnail once the original is stored.
  const listCopy = thumbnailKind(file.type) === null && isListCopyImage(file.type);
  const wantsThumbnail = thumbnailKind(file.type) !== null || listCopy;
  const thumbnail: Promise<ThumbnailResult | null> = wantsThumbnail
    ? boundedThumbnail(
        file,
        config.makeThumbnail ?? (listCopy ? makeImageThumbnail : sharedThumbnail),
      )
    : Promise.resolve(null);

  let response: UploadResponse;
  // True once the thumbnail rode on the upload itself (resumable complete form).
  let sentWithUpload = false;
  if (resumable) {
    const sent = await uploadResumable(file, form, config, thumbnail);
    if (!sent.ok) return sent;
    response = sent.response;
    sentWithUpload = sent.thumbnailSent;
  } else {
    try {
      response = await postUpload(
        config.endpoint,
        { Authorization: `Bearer ${config.token}` },
        form,
        config,
      );
    } catch {
      return { ok: false, message: uploadErrorMessage('network') };
    }
  }

  if (!response.ok) return refused(errorCode(response.body), file);

  const asset = assetField(response.body);
  if (asset === null) {
    return { ok: false, message: uploadErrorMessage('network') };
  }
  // assetVersionId is the version the gallery add flow pins; include the key only
  // when the worker returned it, so callers that ignore it are unaffected.
  const storedThumbnail = thumbnailField(response.body);
  if (
    wantsThumbnail &&
    !sentWithUpload &&
    storedThumbnail === null &&
    asset.assetVersionId !== null
  ) {
    // The original is stored and the outcome goes back now; the thumbnail is
    // attached in the background and never awaited here.
    void attachLateThumbnail(config, asset.assetVersionId, thumbnail);
  }
  dispatchUploadComplete(config.workspaceId);
  return {
    ok: true,
    reused: asset.reused,
    assetId: asset.assetId,
    ...(asset.assetVersionId !== null ? { assetVersionId: asset.assetVersionId } : {}),
    ...(storedThumbnail !== null ? { thumbnail: storedThumbnail } : {}),
  };
}

/**
 * Attach a thumbnail to a version already stored: once the thumbnail is made,
 * POST it to /thumbnail over the upload's own transport (same Bearer and
 * X-Trace-Id), then announce the upload again and tell config.onThumbnail.
 * Runs after the outcome resolved; never throws and never changes the
 * outcome: a missing thumbnail or a failed post is null (the failure is logged).
 */
async function attachLateThumbnail(
  config: UploadConfig,
  versionId: string,
  thumbnail: Promise<ThumbnailResult | null>,
): Promise<StoredThumbnail | null> {
  try {
    const made = await thumbnail;
    if (made === null || !made.ok) return null;
    const stored = await postThumbnail(config, versionId, made);
    if (stored === null) return null;
    dispatchUploadComplete(config.workspaceId);
    config.onThumbnail?.(stored);
    return stored;
  } catch (error) {
    logger.warn('asset thumbnail attach failed', {
      asset_version_id: versionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** POST {workspace_id, asset_version_id, thumbnail, thumbnail_page_count?} to /thumbnail. Never throws. */
async function postThumbnail(
  config: UploadConfig,
  versionId: string,
  made: Thumbnail,
): Promise<StoredThumbnail | null> {
  const form = new FormData();
  form.append('workspace_id', config.workspaceId);
  form.append('asset_version_id', versionId);
  appendThumbnail(form, made);
  try {
    const reply = await send(
      config,
      'POST',
      workerRoute(config.endpoint, '/thumbnail'),
      form,
      null,
    );
    if (!reply.ok) {
      logger.warn('asset thumbnail attach refused', {
        asset_version_id: versionId,
        status: reply.status,
        code: errorCode(reply.body),
      });
      return null;
    }
    return thumbnailField(reply.body);
  } catch (error) {
    logger.warn('asset thumbnail attach failed', {
      asset_version_id: versionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Add a made thumbnail (and a PDF's page count) to the upload form; nothing otherwise. */
function appendThumbnail(form: FormData, thumbnail: ThumbnailResult | null): void {
  if (thumbnail === null || !thumbnail.ok) return;
  form.append('thumbnail', thumbnail.blob, 'thumbnail.jpg');
  if (thumbnail.pageCount !== undefined) {
    form.append('thumbnail_page_count', String(thumbnail.pageCount));
  }
}

/**
 * Wait for the file's thumbnail, never longer than THUMBNAIL_TIMEOUT_MS and
 * never failing: a maker that throws, rejects or hangs is NoThumbnail, so the
 * upload itself goes on without one.
 */
async function boundedThumbnail(file: File, make: ThumbnailMaker): Promise<ThumbnailResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<ThumbnailResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), THUMBNAIL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => make(file))
        .catch((): ThumbnailResult => ({ ok: false, reason: 'failed' })),
      cap,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A positive integer, or null. */
function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Read the stored thumbnail ({thumbnail:{width,height,page_count?}}); null when absent or malformed. */
function thumbnailField(body: unknown): StoredThumbnail | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { thumbnail?: unknown }).thumbnail;
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as { width?: unknown; height?: unknown; page_count?: unknown };
  const width = positiveInt(t.width);
  const height = positiveInt(t.height);
  if (width === null || height === null) return null;
  const pageCount = positiveInt(t.page_count);
  return { width, height, ...(pageCount !== null ? { pageCount } : {}) };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * A worker refusal as an outcome. A full workspace (413 workspace_full) also
 * opens the shell's full sheet for this file's size.
 */
function refused(code: string, file: File): UploadFailure {
  if (code !== WORKSPACE_FULL_CODE) return { ok: false, message: uploadErrorMessage(code) };
  reportWorkspaceFull(file.size);
  return { ok: false, message: uploadErrorMessage(code), code };
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
 * Build `count` sequential display names "${base} N" continuing past the highest
 * number already used among `existingLabels`. A label counts only when it matches
 * ^<base> (\d+)$ case-insensitively with `base` taken literally (regex-escaped),
 * so a metacharacter in the base never widens the match. `max` is the largest
 * such N (0 when none), and the returned names are max+1 .. max+count: the
 * increment is over the existing labels, never the batch count, so two files
 * added at once become "<base> 1", "<base> 2" rather than colliding.
 */
export function nextUploadNames(
  base: string,
  existingLabels: readonly string[],
  count: number,
): string[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped} (\\d+)$`, 'i');
  let max = 0;
  for (const label of existingLabels) {
    const match = pattern.exec(label);
    if (match === null) continue;
    const n = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const names: string[] = [];
  for (let i = 1; i <= count; i += 1) names.push(`${base} ${max + i}`);
  return names;
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
      return "Couldn't add the link. Try again.";
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
function folderErrorMessage(code: string): string {
  switch (code) {
    default:
      return "Couldn't create the folder. Try again.";
  }
}

type FolderCreateOutcome =
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

type FolderRenameOutcome =
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
      message: "Couldn't rename the folder. Try again.",
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
      return {
        ok: false,
        nameTaken: false,
        message: 'Only creators and admins can rename folders.',
      };
    }
    return {
      ok: false,
      nameTaken: false,
      message: "Couldn't rename the folder. Try again.",
    };
  }

  const folder = folderField(body);
  if (folder === null) {
    return {
      ok: false,
      nameTaken: false,
      message: "Couldn't rename the folder. Try again.",
    };
  }
  return { ok: true, folder };
}

type FolderDeleteOutcome = { ok: true } | { ok: false; message: string };

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
    return { ok: false, message: "Couldn't delete the folder. Try again." };
  }

  if (!response.ok) {
    if (response.status === 403) {
      return { ok: false, message: 'Only creators and admins can delete folders.' };
    }
    return { ok: false, message: "Couldn't delete the folder. Try again." };
  }
  return { ok: true };
}

type MoveAssetsOutcome = { ok: true; moved: number } | { ok: false; message: string };

export interface MoveAssetsConfig {
  /** The asset-upload worker base URL; the /folders/move route is POSTed beneath it. */
  endpoint: string;
  token: string;
  workspaceId: string;
  /** The assets to relocate; the worker batch-updates their folder_id. */
  assetIds: string[];
  /** The destination folder id, or null to move back to the library root. */
  targetFolderId: string | null;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/** Shared retry copy for a failed move. No em-dashes in any string (CLAUDE.md). */
const MOVE_RETRY = "Couldn't move the files. Try again.";

/**
 * POST {workspace_id, asset_ids, target_folder_id} to the worker's /folders/move
 * route with a Bearer token. Never throws: a transport failure or a non-OK status
 * becomes { ok: false } with the retry copy. On success it reads a numeric
 * `moved` count from the body (0 when absent or not a number). Move is allowed
 * for every active member, so there is no role-gated 403 branch.
 */
export async function moveAssetsRequest(config: MoveAssetsConfig): Promise<MoveAssetsOutcome> {
  let response: Response;
  try {
    response = await config.fetcher(workerRoute(config.endpoint, '/folders/move'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        workspace_id: config.workspaceId,
        asset_ids: config.assetIds,
        target_folder_id: config.targetFolderId,
      }),
    });
  } catch {
    return { ok: false, message: MOVE_RETRY };
  }
  if (!response.ok) {
    return { ok: false, message: MOVE_RETRY };
  }
  return { ok: true, moved: movedCount(await readJson(response)) };
}

/** Read a numeric `moved` count from a {moved} body; 0 when absent or not finite. */
function movedCount(body: unknown): number {
  if (typeof body === 'object' && body !== null) {
    const moved = (body as { moved?: unknown }).moved;
    if (typeof moved === 'number' && Number.isFinite(moved)) return moved;
  }
  return 0;
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
  if (status === 403) return 'Only creators and admins can rename files.';
  return "Couldn't rename this file. Try again.";
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

/**
 * One item to upload: a stable id, the bytes, the ORIGINAL filename to send the
 * part under (stored as assets.filename), and the friendly display name to
 * persist (display_name); displayName is null when none applies.
 */
export interface QueueItem {
  id: string;
  file: File;
  filename: string;
  displayName?: string | null;
}

interface RunResult {
  succeeded: string[];
  failed: { id: string; message: string }[];
}

interface RunHooks {
  onStart?: (id: string) => void;
  onResult?: (id: string, outcome: UploadOutcome) => void;
}

/**
 * Upload a queue with up to {@link UPLOAD_CONCURRENCY} files in flight at once
 * (each file is its own request, so each reports its own progress). Files
 * start in queue order. A failure, even a thrown one, does not stop the run:
 * the rest still upload and the failure is returned with its copy so the UI
 * can offer an inline retry. The hooks let the caller flip per-file UI state
 * as each file starts and finishes; the result lists ids in queue order.
 */
export async function runUploads(
  items: readonly QueueItem[],
  uploadOne: (item: QueueItem) => Promise<UploadOutcome>,
  hooks?: RunHooks,
  concurrency: number = UPLOAD_CONCURRENCY,
): Promise<RunResult> {
  const outcomes = await runWithConcurrency(items, concurrency, async (item) => {
    hooks?.onStart?.(item.id);
    let outcome: UploadOutcome;
    try {
      outcome = await uploadOne(item);
    } catch {
      outcome = { ok: false, message: uploadErrorMessage('network') };
    }
    hooks?.onResult?.(item.id, outcome);
    return outcome;
  });
  const result: RunResult = { succeeded: [], failed: [] };
  items.forEach((item, index) => {
    const settled = outcomes[index];
    const outcome: UploadOutcome =
      settled?.ok === true ? settled.value : { ok: false, message: uploadErrorMessage('network') };
    if (outcome.ok) result.succeeded.push(item.id);
    else result.failed.push({ id: item.id, message: outcome.message });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Resumable uploads. A file over one part (8 MB) goes up as an R2 multipart
// upload through the same worker: create, one PUT per 8 MB part, complete (the
// same form as the direct POST, minus the file). When a part fails, the client
// waits for the device to come back online, asks the worker which parts R2
// already holds, and carries on from the last finished one. Each part gets up
// to 3 retries; after that the upload is aborted and fails with a plain reason.
// ---------------------------------------------------------------------------

/** Part size for resumable uploads; must match the worker (MULTIPART_PART_SIZE). */
export const RESUMABLE_PART_SIZE = 8 * 1024 * 1024;

/** Retries per part (and per create / complete call) before the upload fails. */
export const PART_RETRIES = 3;

/** Shown when a resumable upload runs out of retries. No connection wording. */
export const RESUME_FAILED_MESSAGE =
  "Couldn't finish uploading this file. It stopped partway too many times. Try again.";

/** A worker reply as the resumable path reads it. */
type Reply = { ok: boolean; status: number; body: unknown };

/** Thrown by the resumable path to end the upload with this message. */
class ResumeFailure extends Error {}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve once the device reports it is online (at once when it already is or cannot say). */
function waitForOnline(signal?: AbortSignal): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve();
  if (typeof window === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      window.removeEventListener('online', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    window.addEventListener('online', done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Send one request over the config's transport. Rejects on a transport failure. */
async function send(
  config: UploadConfig,
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit | null,
  contentType: string | null,
  /** This request's own body progress 0..1 (a part's); XHR only. */
  onRequestProgress?: (fraction: number) => void,
): Promise<Reply> {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.token}` };
  if (contentType !== null) headers['content-type'] = contentType;
  if (config.xhr !== undefined) {
    // The file's progress is worked out by the part loop from each part's bytes.
    const { traceId, signal, createRequest } = config.xhr;
    return xhrSend(method, url, headers, body, {
      traceId,
      ...(signal !== undefined ? { signal } : {}),
      ...(createRequest !== undefined ? { createRequest } : {}),
      ...(onRequestProgress !== undefined ? { onProgress: onRequestProgress } : {}),
    });
  }
  const response = await config.fetcher(url, {
    method,
    headers,
    ...(body !== null ? { body: body as BodyInit } : {}),
  });
  return { ok: response.ok, status: response.status, body: await readJson(response) };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Retry worth trying: no reply at all, or a 5xx / 429. */
function retryable(reply: Reply | null): boolean {
  return reply === null || reply.status >= 500 || reply.status === 429;
}

/**
 * Run one call with up to {@link PART_RETRIES} retries. Between attempts it
 * waits for the device to be online, backs off, and runs `beforeRetry` (the
 * part loop uses it to re-read the stored parts). A non-retryable reply is
 * returned as is; running out of retries throws ResumeFailure.
 */
async function withRetries(
  config: UploadConfig,
  call: () => Promise<Reply>,
  beforeRetry?: () => Promise<boolean>,
): Promise<Reply> {
  const sleep = config.sleep ?? defaultSleep;
  const signal = config.xhr?.signal;
  for (let attempt = 0; ; attempt += 1) {
    if (isAborted(signal)) throw new ResumeFailure(uploadErrorMessage('network'));
    let reply: Reply | null = null;
    try {
      reply = await call();
    } catch {
      reply = null;
    }
    if (!retryable(reply)) return reply as Reply;
    if (isAborted(signal)) throw new ResumeFailure(uploadErrorMessage('network'));
    if (attempt >= PART_RETRIES) throw new ResumeFailure(RESUME_FAILED_MESSAGE);
    await waitForOnline(signal);
    await sleep(1000 * 2 ** attempt);
    // The call may have landed even though its reply was lost.
    if (beforeRetry !== undefined && (await beforeRetry().catch(() => false))) {
      return { ok: true, status: 200, body: null };
    }
  }
}

/** Read {key, upload_id} off a create reply; null when malformed. */
function createdField(body: unknown): { key: string; uploadId: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { key?: unknown; upload_id?: unknown };
  return typeof b.key === 'string' && typeof b.upload_id === 'string'
    ? { key: b.key, uploadId: b.upload_id }
    : null;
}

/** Part numbers and sizes R2 already holds, from a parts reply. */
function partsField(body: unknown): Map<number, number> {
  const stored = new Map<number, number>();
  if (typeof body !== 'object' || body === null) return stored;
  const parts = (body as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return stored;
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const p = part as { part_number?: unknown; size?: unknown };
    if (typeof p.part_number === 'number' && typeof p.size === 'number') {
      stored.set(p.part_number, p.size);
    }
  }
  return stored;
}

/**
 * Upload a file over 8 MB as a resumable multipart upload, then send the
 * complete form (fields, no file part). The thumbnail is being made while the
 * parts go up; the complete form carries it only when it is already made, and
 * never waits for it (thumbnailSent false: the caller attaches it later).
 * Never throws: returns the complete reply on success or the failure outcome.
 */
async function uploadResumable(
  file: File,
  form: FormData,
  config: UploadConfig,
  thumbnail: Promise<ThumbnailResult | null>,
): Promise<{ ok: true; response: UploadResponse; thumbnailSent: boolean } | UploadFailure> {
  // What the thumbnail settled to so far; no `made` while it is still being made.
  const settled: { made?: ThumbnailResult | null } = {};
  void thumbnail.then((made) => {
    settled.made = made;
  });
  const route = (path: string): string => workerRoute(config.endpoint, path);
  const onProgress = config.xhr?.onProgress;
  let upload: { key: string; uploadId: string } | null = null;
  const target = (): string => {
    const query = new URLSearchParams({
      workspace_id: config.workspaceId,
      key: upload?.key ?? '',
      upload_id: upload?.uploadId ?? '',
    });
    return query.toString();
  };
  const storedParts = async (): Promise<Map<number, number>> => {
    const reply = await send(config, 'GET', route(`/multipart/parts?${target()}`), null, null);
    return reply.ok ? partsField(reply.body) : new Map();
  };
  try {
    const created = await withRetries(config, () =>
      send(
        config,
        'POST',
        route('/multipart/create'),
        JSON.stringify({
          workspace_id: config.workspaceId,
          size: file.size,
          content_type: file.type,
        }),
        'application/json',
      ),
    );
    if (!created.ok) return refused(errorCode(created.body), file);
    upload = createdField(created.body);
    if (upload === null) return { ok: false, message: uploadErrorMessage('network') };

    const total = Math.ceil(file.size / RESUMABLE_PART_SIZE);
    let done = 0;
    for (let part = 1; part <= total; part += 1) {
      const start = (part - 1) * RESUMABLE_PART_SIZE;
      const chunk = file.slice(start, Math.min(start + RESUMABLE_PART_SIZE, file.size));
      const sentBefore = done;
      const reply = await withRetries(
        config,
        () =>
          send(
            config,
            'PUT',
            route(`/multipart/part?${target()}&part_number=${part}`),
            chunk,
            'application/octet-stream',
            onProgress !== undefined
              ? (fraction) =>
                  onProgress(bytesToFraction(sentBefore + fraction * chunk.size, file.size))
              : undefined,
          ),
        async () => (await storedParts()).get(part) === chunk.size,
      );
      if (!reply.ok) return refused(errorCode(reply.body), file);
      done += chunk.size;
      onProgress?.(bytesToFraction(done, file.size));
    }

    const thumbnailSent = 'made' in settled;
    appendThumbnail(form, settled.made ?? null);
    form.append('key', upload.key);
    form.append('upload_id', upload.uploadId);
    form.append('filename', config.filename);
    form.append('content_type', file.type);
    const completed = await withRetries(config, () =>
      send(config, 'POST', route('/multipart/complete'), form, null),
    );
    return {
      ok: true,
      response: { ok: completed.ok, body: completed.body },
      thumbnailSent,
    };
  } catch (error) {
    if (upload !== null) {
      const { key, uploadId } = upload;
      void send(
        config,
        'POST',
        route('/multipart/abort'),
        JSON.stringify({ workspace_id: config.workspaceId, key, upload_id: uploadId }),
        'application/json',
      ).catch(() => undefined);
    }
    return {
      ok: false,
      message: error instanceof ResumeFailure ? error.message : uploadErrorMessage('network'),
    };
  }
}
