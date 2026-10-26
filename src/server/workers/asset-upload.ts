// Cloudflare Worker: asset upload + read route.
//
// POST  multipart/form-data { file, workspace_id, origin?, asset_id?, folder_id?,
//                             thumbnail?, thumbnail_page_count? }
//   origin is 'library' (default when missing) or 'chat'. A chat file never
//   becomes a version of another asset and never goes into a folder.
//   -> verifies the caller's Bearer token, confirms they are an active member of
//      workspace_id, runs the upload pipeline, and returns the asset summary.
//      The acting user is the verified token's `sub` claim only - the body never
//      carries an uploaded_by id.
//      An optional `thumbnail` JPEG (pdf, video, docx, xlsx, or a raster
//      image's list copy; made on the sender's device) rides in the SAME
//      request as the file and is stored in the same flow, right after the
//      original, as the version's thumbnail rendition (shared bucket:
//      ws/<ws>/<asset>/<version>/thumbnail). An invalid or failed thumbnail is
//      ignored and never fails the upload. The response then carries
//      thumbnail {width,height,page_count?}.
// POST  /thumbnail multipart/form-data { workspace_id, asset_version_id,
//                             thumbnail, thumbnail_page_count? }
//   -> same auth + membership gate, then attaches the thumbnail to an existing
//      version of that workspace through the same store as the in-request part
//      (key from the workspace's bucket layout, asset_renditions insert ON
//      CONFLICT DO NOTHING). A repeat call for the same version answers the
//      stored rendition and writes nothing. The client sends a direct upload's
//      original at once and its thumbnail here once both are ready.
//      200 {thumbnail:{width,height,page_count?}}; 404 for a version outside
//      the workspace (or a chat file of another uploader); 422 invalid_image
//      for a thumbnail that fails validation (nothing stored).
// GET   ?workspace_id=&asset_id=
//   -> same auth + membership gate, then returns the current summary scoped to
//      the workspace (cross-tenant 404).
// GET   /usage?workspace_id=
//   -> same auth + membership gate, then the workspace's stored bytes from the
//      workspace_bytes_used RPC { usedBytes, warnAtBytes, warn, exempt }
//      (asset-upload-usage.ts). A failed read is 503 usage_unavailable.
//
// Storage cap (checkWorkspaceCap, asset-upload-usage.ts): after auth +
// membership and before any bytes are stored, a direct POST (the file part's
// declared size), POST /multipart/create (size) and POST /multipart/complete
// (the real assembled size; a refused upload is aborted and its staging
// removed) are refused with 413 workspace_full when the workspace would go over
// the cap. Chat and library uploads alike; exempt owners are never capped.
//
// Resumable uploads (R2 multipart, 8 MB parts; see asset-upload-multipart.ts):
//   POST /multipart/create   {workspace_id, size, content_type}
//   PUT  /multipart/part     ?workspace_id&key&upload_id&part_number, raw bytes
//   GET  /multipart/parts    ?workspace_id&key&upload_id
//   POST /multipart/complete the POST form above with {key, upload_id, filename,
//                            content_type} in place of the file part
//   POST /multipart/abort    {workspace_id, key, upload_id}
//
// The Worker is the only holder of the Supabase service-role key and the R2
// credentials; neither is ever shipped to the browser. Caller tokens are
// verified against the project's published asymmetric JWKS (ES256); membership
// is an explicit service-role DB read, not an RLS side effect. Expected pipeline
// failures map to 4xx; unexpected faults bubble up to a 500.

import {
  createLinkAsset,
  createSupabaseAssetRepository,
  createSupabaseRenditionStore,
  checkThumbnail,
  getVersionSummary,
  storeThumbnailRendition,
  THUMBNAIL_MAX_BYTES,
  getAssetSummary,
  resolveUploadTarget,
  renameAsset,
  runUploadPipeline,
  selectScanner,
  err,
  ok,
  type AssetOrigin,
  type AssetRepository,
  type AssetSummary,
  type RenditionStore,
  type Result,
  type ThumbnailOutcome,
  type UploadError,
  type UploadErrorCode,
  type UploadInput,
} from '@/server/assets';
import { R2StorageClient } from '@srtdio/storage';
import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';
// Reuse asset-read's verified-token + membership primitives verbatim so the two
// workers cannot drift: same ES256 JWKS verification, same workspace_members read.
import { createSupabaseAssetReadStore, getSupabaseJwks, verifyCaller } from './asset-read';
import { isPreviewOrigin } from '@/server/preview-origin';
import {
  abortUpload,
  completeUpload,
  createUpload,
  listUploadedParts,
  MULTIPART_PART_SIZE,
  uploadPart,
  type MultipartDeps,
  type MultipartError,
} from './asset-upload-multipart';
import {
  checkWorkspaceCap,
  createSupabaseUsageStore,
  resolveWorkspaceUsage,
} from './asset-upload-usage';
import { handlePurge, handlePurgeChat } from './asset-upload-purge';

export interface AssetUploadEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  /** Public key: POST /purge calls asset_purge_request as the caller (anon role + bearer). */
  SUPABASE_PUBLISHABLE_KEY: string;
  VIRUS_SCAN_PROVIDER?: string;
  /**
   * The one shared R2 bucket (a wrangler [vars] entry). A workspace whose
   * asset_bucket equals it gets ID-only keys; an empty legacy workspace is
   * moved to it on its first upload. Never hardcoded in code.
   */
  SHARED_ASSET_BUCKET: string;
  /**
   * Comma-separated list of browser origins allowed to call this Worker
   * cross-origin. Operator sets it as a Worker var/secret; when unset the code
   * falls back to {@link DEFAULT_ALLOWED_ORIGINS}.
   */
  ALLOWED_ORIGINS?: string;
}

/**
 * Known site origin (the production domain srtd.io) used when ALLOWED_ORIGINS is
 * unset. The sole entry is treated as the primary origin.
 * Mirrors asset-read so the two workers' CORS surface cannot drift.
 */
const DEFAULT_ALLOWED_ORIGINS = ['https://srtd.io'] as const;

/** Preflight cache lifetime: 24 hours. */
const CORS_MAX_AGE_SECONDS = 86_400;

/** Every code the worker can return, including the auth/transport layer. */
export type UploadResponseCode =
  | UploadErrorCode
  | 'folder_name_taken'
  | 'workspace_full'
  | 'usage_unavailable'
  | 'thumbnail_not_stored'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'method_not_allowed'
  | 'internal_error';

const STATUS_BY_CODE: Record<UploadResponseCode, number> = {
  unsupported_mime: 415,
  blocked_type: 415,
  encrypted_file: 422,
  embedded_content: 422,
  archive_limits: 422,
  external_content: 422,
  mime_mismatch: 415,
  file_too_large: 413,
  empty_file: 400,
  invalid_image: 422,
  virus_detected: 422,
  not_found: 404,
  folder_name_taken: 409,
  workspace_full: 413,
  usage_unavailable: 503,
  thumbnail_not_stored: 409,
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  method_not_allowed: 405,
  internal_error: 500,
};

/** Canonical UUID shape (any version), case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * A link URL the DB will accept: it must start with http:// or https://
 * (matching the asset_versions.external_url CHECK, case-sensitive like the
 * Postgres regex) and parse as a URL. Rejecting here turns a would-be DB
 * constraint throw (500) into a clean 400.
 */
function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//.test(value)) {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Roles permitted to rename an asset. A 'client' member is denied. */
const RENAME_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'agency']);

/** The single membership read the upload path authorizes against. */
export interface MembershipChecker {
  isActiveMember(input: { userId: string; workspaceId: string }): Promise<boolean>;
}

/** Runs the upload pipeline with its deps already bound. */
export type PipelineRunner = (input: UploadInput) => Promise<Result<AssetSummary, UploadError>>;

export interface UploadDeps {
  membership: MembershipChecker;
  runPipeline: PipelineRunner;
}

export interface AuthorizedUploadInput {
  /** The acting user, from the verified token's `sub`. Never from the body. */
  userId: string;
  workspaceId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  traceId: string;
  /** Parsed from the form's `origin` field; missing means 'library'. */
  origin: AssetOrigin;
  assetId?: string;
  /** Verified destination folder for a new upload (live + in this workspace). */
  folderId?: string;
  /** Caller-supplied friendly name; absent leaves folder auto-naming to the pipeline. */
  displayName?: string;
}

export interface UploadResult {
  summary: AssetSummary;
  reused: boolean;
}

/**
 * Gate the upload on workspace membership, then run the pipeline with the actor
 * fixed to the verified user id. The membership check always runs before any
 * bytes are processed; a non-member is a forbidden Result and never reaches the
 * pipeline.
 */
export async function authorizeAndUpload(
  deps: UploadDeps,
  input: AuthorizedUploadInput,
): Promise<Result<UploadResult, { code: UploadResponseCode; message: string }>> {
  const member = await deps.membership.isActiveMember({
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  if (!member) {
    return err({ code: 'forbidden', message: 'Not a member of this workspace.' });
  }

  const result = await deps.runPipeline({
    workspaceId: input.workspaceId,
    uploadedBy: input.userId,
    filename: input.filename,
    contentType: input.contentType,
    bytes: input.bytes,
    traceId: input.traceId,
    origin: input.origin,
    ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
  });
  if (!result.ok) {
    return err(result.error);
  }
  return ok({ summary: result.value, reused: result.value.reused });
}

/**
 * Render any thrown value into a stable log string. PostgREST surfaces failures
 * as plain objects (not Error instances), so a bare template literal would log
 * '[object Object]' and lose the code/message/details/hint. Never returned to
 * the client - logging only.
 */
export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    return JSON.stringify({
      code: e.code,
      message: e.message,
      details: e.details,
      hint: e.hint,
    });
  }
  return String(error);
}

/** The configured allowlist, falling back to the known site origins. */
function allowedOrigins(env: AssetUploadEnv): readonly string[] {
  const list = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  return list.length > 0 ? list : DEFAULT_ALLOWED_ORIGINS;
}

/**
 * The Access-Control-Allow-Origin value to echo back, or null when the request
 * carries no Origin or an origin outside the allowlist. Never `*`: requests
 * carry Authorization, so the origin is reflected only when explicitly allowed.
 */
function resolveAllowedOrigin(request: Request, env: AssetUploadEnv): string | null {
  const origin = request.headers.get('Origin');
  if (origin === null) {
    return null;
  }
  return allowedOrigins(env).includes(origin) || isPreviewOrigin(origin) ? origin : null;
}

/** Attach the reflected origin (and Vary) when one is allowed. */
function applyCors(headers: Headers, acao: string | null): void {
  if (acao !== null) {
    headers.set('Access-Control-Allow-Origin', acao);
    headers.set('Vary', 'Origin');
  }
}

/**
 * Answer a CORS preflight. The browser only accepts the actual request when the
 * echoed origin matches, so an allowed origin is reflected and a disallowed one
 * falls back to the primary site origin.
 */
function preflightResponse(request: Request, env: AssetUploadEnv): Response {
  const acao =
    resolveAllowedOrigin(request, env) ?? allowedOrigins(env)[0] ?? DEFAULT_ALLOWED_ORIGINS[0];
  const headers = new Headers({
    'Access-Control-Allow-Origin': acao,
    'Access-Control-Allow-Methods': 'POST, GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': `authorization, content-type, ${TRACE_ID_HEADER.toLowerCase()}`,
    'Access-Control-Max-Age': String(CORS_MAX_AGE_SECONDS),
    Vary: 'Origin',
  });
  return new Response(null, { status: 204, headers });
}

function json(status: number, body: unknown, traceId: string, acao: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(TRACE_ID_HEADER, traceId);
  applyCors(headers, acao);
  return new Response(JSON.stringify(body), { status, headers });
}

function buildStorage(env: AssetUploadEnv): R2StorageClient {
  return new R2StorageClient(
    {
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_R2_ACCESS_KEY_ID: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    },
    tracedFetch,
  );
}

function buildRepository(env: AssetUploadEnv): AssetRepository {
  return createSupabaseAssetRepository({
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
  });
}

function buildPipelineRunner(env: AssetUploadEnv): PipelineRunner {
  const deps = {
    storage: buildStorage(env),
    repository: buildRepository(env),
    scanner: selectScanner(env.VIRUS_SCAN_PROVIDER),
    sharedBucket: env.SHARED_ASSET_BUCKET,
  };
  return (input) => runUploadPipeline(deps, input);
}

/** The thumbnail fields of a stored rendition, as the response carries them. */
interface ThumbnailBody {
  width: number;
  height: number;
  page_count?: number;
}

function renditionStore(env: AssetUploadEnv, traceId: string): RenditionStore {
  return createSupabaseRenditionStore(
    { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY },
    traceId,
  );
}

/** The one set of deps every thumbnail store (in-request part or POST /thumbnail) uses. */
function thumbnailDeps(
  env: AssetUploadEnv,
  traceId: string,
): Parameters<typeof storeThumbnailRendition>[0] {
  return {
    storage: buildStorage(env),
    repository: buildRepository(env),
    renditions: renditionStore(env, traceId),
    sharedBucket: env.SHARED_ASSET_BUCKET,
  };
}

/**
 * A deduped pdf/video upload sent without a thumbnail part (the sender's
 * attempt timed out, say) still reports the version's stored thumbnail, so
 * the message meta keeps its size. Never throws.
 */
async function existingThumbnail(
  env: AssetUploadEnv,
  summary: AssetSummary,
  traceId: string,
): Promise<ThumbnailBody | null> {
  const mime = summary.mimeType.toLowerCase();
  if (mime !== 'application/pdf' && !mime.startsWith('video/')) return null;
  try {
    const found = await renditionStore(env, traceId).findRendition(summary.versionId, 'thumbnail');
    if (found === null || found.width === null || found.height === null) return null;
    return { width: found.width, height: found.height };
  } catch (error) {
    logger.error(`asset upload thumbnail lookup failed: ${serializeError(error)}`, {
      asset_version_id: summary.versionId,
    });
    return null;
  }
}

/**
 * Store the upload's thumbnail part, when there is one. Never throws and never
 * changes the upload's status: an invalid part is logged and ignored, a
 * storage or DB fault is logged and the response simply has no thumbnail.
 */
async function attachThumbnail(
  env: AssetUploadEnv,
  input: {
    summary: AssetSummary;
    part: FormDataEntryValue | null;
    pageCountField: FormDataEntryValue | null;
    traceId: string;
  },
): Promise<ThumbnailBody | null> {
  const { part } = input;
  if (part === null) {
    return input.summary.reused ? existingThumbnail(env, input.summary, input.traceId) : null;
  }
  if (!(part instanceof Blob)) {
    logger.warn('asset upload thumbnail ignored', { reason: 'not_a_file' });
    return null;
  }
  try {
    // Refuse to buffer an oversize part: the cap is checked again on the bytes.
    if (part.size > THUMBNAIL_MAX_BYTES) {
      logger.warn('asset upload thumbnail ignored', { reason: 'size' });
      return null;
    }
    const outcome: ThumbnailOutcome = await storeThumbnailRendition(
      thumbnailDeps(env, input.traceId),
      {
        summary: input.summary,
        bytes: new Uint8Array(await part.arrayBuffer()),
        pageCountField: typeof input.pageCountField === 'string' ? input.pageCountField : null,
        traceId: input.traceId,
      },
    );
    if (!outcome.stored) {
      logger.warn('asset upload thumbnail ignored', {
        reason: outcome.reason,
        asset_version_id: input.summary.versionId,
      });
      return null;
    }
    return {
      width: outcome.width,
      height: outcome.height,
      ...(outcome.pageCount !== undefined ? { page_count: outcome.pageCount } : {}),
    };
  } catch (error) {
    logger.error(`asset upload thumbnail failed: ${serializeError(error)}`, {
      asset_version_id: input.summary.versionId,
    });
    return null;
  }
}

/**
 * The upload POST. 'direct' carries the file part; 'multipart' (POST
 * /multipart/complete) carries {key, upload_id, filename, content_type} of a
 * resumable upload whose parts are already in R2, and is otherwise the same
 * form. Both run the same pipeline, so the cap and file-type rules are shared.
 */
async function handlePost(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
  mode: 'direct' | 'multipart' = 'direct',
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  // Idempotency-Key is accepted but needs no dedicated storage: the pipeline's
  // sha256 content-dedup already makes a retry of identical bytes safe (it
  // returns reused=true and stores nothing new). We surface the key in logs only.
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (idempotencyKey !== null && idempotencyKey !== '') {
    logger.info('asset upload carries idempotency key', { idempotency_key: idempotencyKey });
  }

  const form = await request.formData();
  const file = form.get('file');
  const workspaceId = form.get('workspace_id');
  const assetId = form.get('asset_id');
  const folderIdField = form.get('folder_id');
  const displayNameField = form.get('display_name');
  const originField = form.get('origin');
  const thumbnailPart = form.get('thumbnail');
  const thumbnailPageCount = form.get('thumbnail_page_count');

  const stagedKey = form.get('key');
  const stagedUploadId = form.get('upload_id');
  const stagedFilename = form.get('filename');
  const stagedContentType = form.get('content_type');
  if (mode === 'direct' && !(file instanceof File)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Missing file part.' } },
      traceId,
      acao,
    );
  }
  if (
    mode === 'multipart' &&
    (typeof stagedKey !== 'string' ||
      typeof stagedUploadId !== 'string' ||
      typeof stagedFilename !== 'string' ||
      stagedFilename === '' ||
      typeof stagedContentType !== 'string')
  ) {
    return json(
      400,
      {
        error: {
          code: 'bad_request',
          message: 'key, upload_id, filename and content_type are required.',
        },
      },
      traceId,
      acao,
    );
  }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Missing workspace_id.' } },
      traceId,
      acao,
    );
  }
  if (!isUuid(workspaceId)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid id format.' } },
      traceId,
      acao,
    );
  }

  // Upload origin: missing is 'library'; anything but 'library' or 'chat' is 400.
  let origin: AssetOrigin = 'library';
  if (originField !== null) {
    if (originField !== 'library' && originField !== 'chat') {
      return json(
        400,
        { error: { code: 'bad_request', message: 'origin must be library or chat.' } },
        traceId,
        acao,
      );
    }
    origin = originField;
  }
  const hasAssetId = typeof assetId === 'string' && assetId !== '';
  const hasFolderId = typeof folderIdField === 'string' && folderIdField !== '';
  if (origin === 'chat' && (hasAssetId || hasFolderId)) {
    return json(
      400,
      {
        error: {
          code: 'bad_request',
          message: 'A chat upload cannot target an asset or a folder.',
        },
      },
      traceId,
      acao,
    );
  }

  // Optional destination folder: when present it must be a UUID and a live folder
  // in this workspace (the cross-tenant guard); a valid id files the new asset there.
  let folderId: string | undefined;
  if (typeof folderIdField === 'string' && folderIdField !== '') {
    if (!isUuid(folderIdField)) {
      return json(
        400,
        { error: { code: 'bad_request', message: 'Invalid id format.' } },
        traceId,
        acao,
      );
    }
    const folder = await buildRepository(env).getFolder(workspaceId, folderIdField);
    if (folder === null) {
      return json(
        400,
        { error: { code: 'bad_request', message: 'Folder not found in this workspace.' } },
        traceId,
        acao,
      );
    }
    folderId = folderIdField;
  }

  // Optional friendly name: validated only when supplied (display_name is never
  // required here; forcing a name is a later frontend concern).
  let displayName: string | undefined;
  if (typeof displayNameField === 'string' && displayNameField.trim() !== '') {
    const valid = validName(displayNameField);
    if (valid === null) {
      return json(
        400,
        { error: { code: 'bad_request', message: 'display_name must be 1 to 500 characters.' } },
        traceId,
        acao,
      );
    }
    displayName = valid;
  }

  let filename: string;
  let contentType: string;
  let bytes: Uint8Array;
  let staged: { bucket: string; key: string } | null = null;
  // Membership first: no usage or R2 read for a caller outside the workspace.
  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('asset upload denied: caller not a workspace member', {
      workspace_id: workspaceId,
    });
    return json(
      403,
      { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
      traceId,
      acao,
    );
  }
  if (file instanceof File && mode === 'direct') {
    // The declared sizes of the file part and its optional thumbnail part,
    // before any bytes are read or stored.
    const cap = await checkWorkspaceCap({
      workspaceId,
      addBytes: file.size + (thumbnailPart instanceof File ? thumbnailPart.size : 0),
      store: createSupabaseUsageStore(env, traceId),
    });
    if (!cap.ok) {
      return json(STATUS_BY_CODE[cap.error.code], { error: cap.error }, traceId, acao);
    }
    filename = file.name;
    contentType = file.type;
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    // The cap runs inside completeUpload on the real assembled size.
    const key = String(stagedKey);
    const assembled = await completeUpload(buildMultipartDeps(env), {
      userId: caller.value,
      workspaceId,
      key,
      uploadId: String(stagedUploadId),
      traceId,
    });
    if (!assembled.ok) {
      return multipartError(assembled.error, traceId, acao);
    }
    filename = String(stagedFilename);
    contentType = String(stagedContentType);
    bytes = assembled.value.bytes;
    staged = { bucket: assembled.value.bucket, key };
  }

  const outcome = await authorizeAndUpload(
    {
      membership: createSupabaseAssetReadStore(env),
      runPipeline: buildPipelineRunner(env),
    },
    {
      userId: caller.value,
      workspaceId,
      filename,
      contentType,
      bytes,
      traceId,
      origin,
      ...(typeof assetId === 'string' && assetId !== '' ? { assetId } : {}),
      ...(folderId !== undefined ? { folderId } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    },
  );

  // The pipeline stored its own copy (or refused the file): the staging
  // object of a resumable upload is no longer needed either way. A thrown
  // pipeline fault skips this, so a retried complete can still read it.
  if (staged !== null) {
    await dropStaged(env, staged, traceId);
  }

  if (!outcome.ok) {
    if (outcome.error.code === 'forbidden') {
      logger.warn('asset upload denied: caller not a workspace member', {
        workspace_id: workspaceId,
      });
    }
    return json(STATUS_BY_CODE[outcome.error.code], { error: outcome.error }, traceId, acao);
  }
  const thumbnail = await attachThumbnail(env, {
    summary: outcome.value.summary,
    part: thumbnailPart,
    pageCountField: thumbnailPageCount,
    traceId,
  });
  return json(
    outcome.value.reused ? 200 : 201,
    { asset: outcome.value.summary, ...(thumbnail !== null ? { thumbnail } : {}) },
    traceId,
    acao,
  );
}

/**
 * POST /thumbnail: attach a sender-made thumbnail to a version already stored
 * (a direct upload sends its original first and this once both are ready).
 * Same Bearer auth and membership gate as the upload. Validation runs before
 * any write, so a refused thumbnail stores nothing; the store itself is the
 * in-request path's (storeThumbnailRendition), so a repeat is idempotent.
 */
async function handleThumbnail(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Expected multipart form data.' } },
      traceId,
      acao,
    );
  }
  const workspaceId = form.get('workspace_id');
  const versionId = form.get('asset_version_id');
  const part = form.get('thumbnail');
  const pageCountField = form.get('thumbnail_page_count');
  if (
    typeof workspaceId !== 'string' ||
    typeof versionId !== 'string' ||
    !isUuid(workspaceId) ||
    !isUuid(versionId)
  ) {
    return json(
      400,
      {
        error: { code: 'bad_request', message: 'workspace_id and asset_version_id are required.' },
      },
      traceId,
      acao,
    );
  }
  if (!(part instanceof Blob)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Missing thumbnail part.' } },
      traceId,
      acao,
    );
  }
  if (pageCountField !== null && typeof pageCountField !== 'string') {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid thumbnail_page_count.' } },
      traceId,
      acao,
    );
  }
  // Refuse to buffer an oversize part before anything else is read.
  if (part.size > THUMBNAIL_MAX_BYTES) {
    logger.warn('asset thumbnail refused', { reason: 'size', asset_version_id: versionId });
    return json(
      422,
      { error: { code: 'invalid_image', message: 'Invalid thumbnail.' } },
      traceId,
      acao,
    );
  }

  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('asset thumbnail denied: caller not a workspace member', {
      workspace_id: workspaceId,
    });
    return json(
      403,
      { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
      traceId,
      acao,
    );
  }

  const summary = await getVersionSummary(buildRepository(env), {
    workspaceId,
    versionId,
    callerId: caller.value,
  });
  if (!summary.ok) {
    return json(STATUS_BY_CODE[summary.error.code], { error: summary.error }, traceId, acao);
  }

  const bytes = new Uint8Array(await part.arrayBuffer());
  const checked = checkThumbnail({ summary: summary.value, bytes, pageCountField });
  if (!checked.ok) {
    logger.warn('asset thumbnail refused', {
      reason: checked.reason,
      asset_version_id: versionId,
    });
    return json(
      422,
      { error: { code: 'invalid_image', message: 'Invalid thumbnail.' } },
      traceId,
      acao,
    );
  }

  // The storage cap counts the thumbnail, as it does for the in-request part.
  // A version that already has one adds nothing, so a repeat is never refused.
  const deps = thumbnailDeps(env, traceId);
  const existing = await deps.renditions.findRendition(versionId, 'thumbnail');
  if (existing === null) {
    const cap = await checkWorkspaceCap({
      workspaceId,
      addBytes: bytes.byteLength,
      store: createSupabaseUsageStore(env, traceId),
    });
    if (!cap.ok) {
      return json(STATUS_BY_CODE[cap.error.code], { error: cap.error }, traceId, acao);
    }
  }

  const outcome = await storeThumbnailRendition(deps, {
    summary: summary.value,
    bytes,
    pageCountField,
    traceId,
  });
  if (!outcome.stored) {
    logger.warn('asset thumbnail not stored', {
      reason: outcome.reason,
      asset_version_id: versionId,
    });
    return json(
      STATUS_BY_CODE.thumbnail_not_stored,
      { error: { code: 'thumbnail_not_stored', message: 'Thumbnail not stored.' } },
      traceId,
      acao,
    );
  }
  logger.info('asset thumbnail attached', { asset_version_id: versionId });
  const thumbnail: ThumbnailBody = {
    width: outcome.width,
    height: outcome.height,
    ...(outcome.pageCount !== undefined ? { page_count: outcome.pageCount } : {}),
  };
  return json(200, { thumbnail }, traceId, acao);
}

function buildMultipartDeps(env: AssetUploadEnv): MultipartDeps {
  const repository = buildRepository(env);
  return {
    storage: buildStorage(env),
    bucketFor: (workspaceId) => repository.getAssetBucket(workspaceId),
    uploadBucketFor: async (workspaceId, traceId) =>
      (
        await resolveUploadTarget(repository, {
          workspaceId,
          sharedBucket: env.SHARED_ASSET_BUCKET,
          traceId,
        })
      ).bucket,
    newId: () => crypto.randomUUID(),
    checkCap: ({ workspaceId, addBytes, traceId }) =>
      checkWorkspaceCap({ workspaceId, addBytes, store: createSupabaseUsageStore(env, traceId) }),
  };
}

/** Delete a resumable upload's staging object. Never throws. */
async function dropStaged(
  env: AssetUploadEnv,
  staged: { bucket: string; key: string },
  traceId: string,
): Promise<void> {
  try {
    await buildStorage(env).deleteObject(staged.bucket, staged.key, traceId);
  } catch (error) {
    logger.error(`asset upload staging delete failed: ${serializeError(error)}`, {
      key: staged.key,
    });
  }
}

function multipartError(error: MultipartError, traceId: string, acao: string | null): Response {
  return json(STATUS_BY_CODE[error.code], { error }, traceId, acao);
}

/**
 * Verify the caller and their membership of the workspace for a multipart
 * route. Returns the verified user id, or the error response to send.
 */
async function multipartCaller(
  request: Request,
  env: AssetUploadEnv,
  workspaceId: unknown,
  traceId: string,
  acao: string | null,
): Promise<{ ok: true; userId: string; workspaceId: string } | { ok: false; response: Response }> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return {
      ok: false,
      response: json(
        401,
        { error: { code: 'unauthorized', message: caller.error.message } },
        traceId,
        acao,
      ),
    };
  }
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) {
    return {
      ok: false,
      response: json(
        400,
        { error: { code: 'bad_request', message: 'Invalid workspace_id.' } },
        traceId,
        acao,
      ),
    };
  }
  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('multipart upload denied: caller not a workspace member', {
      workspace_id: workspaceId,
    });
    return {
      ok: false,
      response: json(
        403,
        { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
        traceId,
        acao,
      ),
    };
  }
  return { ok: true, userId: caller.value, workspaceId };
}

/** POST /multipart/create {workspace_id, size, content_type} -> {key, upload_id, part_size, part_count}. */
async function handleMultipartCreate(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return json(400, { error: { code: 'bad_request', message: parsed.error } }, traceId, acao);
  }
  const auth = await multipartCaller(request, env, parsed.value.workspace_id, traceId, acao);
  if (!auth.ok) return auth.response;
  const { size, content_type: contentType } = parsed.value;
  if (typeof size !== 'number' || typeof contentType !== 'string') {
    return json(
      400,
      { error: { code: 'bad_request', message: 'size and content_type are required.' } },
      traceId,
      acao,
    );
  }
  const result = await createUpload(buildMultipartDeps(env), {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    size,
    contentType,
    traceId,
  });
  if (!result.ok) return multipartError(result.error, traceId, acao);
  return json(
    201,
    {
      key: result.value.key,
      upload_id: result.value.uploadId,
      part_size: result.value.partSize,
      part_count: result.value.partCount,
    },
    traceId,
    acao,
  );
}

/** PUT /multipart/part?workspace_id&key&upload_id&part_number, raw bytes -> {part_number, etag}. */
async function handleMultipartPart(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const auth = await multipartCaller(
    request,
    env,
    url.searchParams.get('workspace_id'),
    traceId,
    acao,
  );
  if (!auth.ok) return auth.response;
  // Refuse to buffer an oversize part: the size is checked again on the bytes.
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MULTIPART_PART_SIZE) {
    return json(
      413,
      { error: { code: 'file_too_large', message: 'Part exceeds 8 MB.' } },
      traceId,
      acao,
    );
  }
  const result = await uploadPart(buildMultipartDeps(env), {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    key: url.searchParams.get('key') ?? '',
    uploadId: url.searchParams.get('upload_id') ?? '',
    partNumber: Number(url.searchParams.get('part_number')),
    body: new Uint8Array(await request.arrayBuffer()),
    traceId,
  });
  if (!result.ok) return multipartError(result.error, traceId, acao);
  return json(
    200,
    { part_number: result.value.partNumber, etag: result.value.etag },
    traceId,
    acao,
  );
}

/** GET /multipart/parts?workspace_id&key&upload_id -> {parts: [{part_number, size}]}. */
async function handleMultipartParts(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const auth = await multipartCaller(
    request,
    env,
    url.searchParams.get('workspace_id'),
    traceId,
    acao,
  );
  if (!auth.ok) return auth.response;
  const result = await listUploadedParts(buildMultipartDeps(env), {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    key: url.searchParams.get('key') ?? '',
    uploadId: url.searchParams.get('upload_id') ?? '',
    traceId,
  });
  if (!result.ok) return multipartError(result.error, traceId, acao);
  return json(
    200,
    { parts: result.value.map((p) => ({ part_number: p.partNumber, size: p.size })) },
    traceId,
    acao,
  );
}

/** POST /multipart/abort {workspace_id, key, upload_id}. Idempotent. */
async function handleMultipartAbort(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return json(400, { error: { code: 'bad_request', message: parsed.error } }, traceId, acao);
  }
  const auth = await multipartCaller(request, env, parsed.value.workspace_id, traceId, acao);
  if (!auth.ok) return auth.response;
  const { key, upload_id: uploadId } = parsed.value;
  const result = await abortUpload(buildMultipartDeps(env), {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    key: typeof key === 'string' ? key : '',
    uploadId: typeof uploadId === 'string' ? uploadId : '',
    traceId,
  });
  if (!result.ok) return multipartError(result.error, traceId, acao);
  return json(200, { ok: true }, traceId, acao);
}

async function handleGet(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id');
  const assetId = url.searchParams.get('asset_id');
  if (!workspaceId || !assetId) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'workspace_id and asset_id are required.' } },
      traceId,
      acao,
    );
  }
  if (!isUuid(workspaceId) || !isUuid(assetId)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid id format.' } },
      traceId,
      acao,
    );
  }

  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('asset read denied: caller not a workspace member', { workspace_id: workspaceId });
    return json(
      403,
      { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
      traceId,
      acao,
    );
  }

  const result = await getAssetSummary(buildRepository(env), { workspaceId, assetId });
  if (!result.ok) {
    return json(STATUS_BY_CODE[result.error.code], { error: result.error }, traceId, acao);
  }
  return json(200, { asset: result.value }, traceId, acao);
}

/** Trim a candidate name and confirm it is 1-500 chars, or null when invalid. */
async function handleUsage(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  const workspaceId = new URL(request.url).searchParams.get('workspace_id');
  if (!workspaceId || !isUuid(workspaceId)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'A valid workspace_id is required.' } },
      traceId,
      acao,
    );
  }

  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('usage read denied: caller not a workspace member', { workspace_id: workspaceId });
    return json(
      403,
      { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
      traceId,
      acao,
    );
  }

  const result = await resolveWorkspaceUsage({
    workspaceId,
    store: createSupabaseUsageStore(env, traceId),
  });
  if (!result.ok) {
    const status = result.error.code === 'not_found' ? 404 : 503;
    return json(status, { error: result.error }, traceId, acao);
  }
  return json(200, result.value, traceId, acao);
}

function validName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 500 ? trimmed : null;
}

/**
 * Trim a candidate folder name and confirm it is 1-80 chars, or null when
 * invalid. Distinct from {@link validName} (1-500, asset filenames): folders.name
 * is a 1..80 column, so reuse would let an over-long name reach a DB CHECK throw.
 */
function validFolderName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 80 ? trimmed : null;
}

/**
 * Read an optional parent/target folder reference from a JSON body. `null` or an
 * absent field means the root; a present value must be a UUID. Returns the
 * normalized id (or null) on success, or `false` when the value is malformed.
 */
function readOptionalFolderId(value: unknown): string | null | false {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && isUuid(value)) {
    return value;
  }
  return false;
}

/** Parse a JSON object body, or a bad_request error string when it is not one. */
async function readJsonObject(request: Request): Promise<Result<Record<string, unknown>, string>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err('Body must be JSON.');
  }
  if (typeof body !== 'object' || body === null) {
    return err('Body must be a JSON object.');
  }
  return ok(body as Record<string, unknown>);
}

/**
 * POST /links: create a link asset. Same auth + membership gate as the file
 * upload, then a link-shaped asset + version are written with no R2 interaction.
 */
async function handleCreateLink(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return json(400, { error: { code: 'bad_request', message: parsed.error } }, traceId, acao);
  }
  const { workspace_id: workspaceId, url, name: rawName } = parsed.value;
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid workspace_id.' } },
      traceId,
      acao,
    );
  }
  if (typeof url !== 'string' || !isHttpUrl(url)) {
    return json(400, { error: { code: 'bad_request', message: 'Invalid url.' } }, traceId, acao);
  }
  const name = validName(rawName);
  if (name === null) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'name must be 1 to 500 characters.' } },
      traceId,
      acao,
    );
  }

  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('link create denied: caller not a workspace member', { workspace_id: workspaceId });
    return json(
      403,
      { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
      traceId,
      acao,
    );
  }

  const summary = await createLinkAsset(buildRepository(env), {
    workspaceId,
    uploadedBy: caller.value,
    name,
    url,
    traceId,
  });
  return json(201, { asset: summary }, traceId, acao);
}

/**
 * POST /rename: rename an asset's filename. Membership is read with its role in
 * one query; only owner/admin/agency may rename, a client is forbidden. Only
 * assets.filename changes - version rows and attachments are never touched.
 */
async function handleRename(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return json(400, { error: { code: 'bad_request', message: parsed.error } }, traceId, acao);
  }
  const { workspace_id: workspaceId, asset_id: assetId, name: rawName } = parsed.value;
  if (
    typeof workspaceId !== 'string' ||
    !isUuid(workspaceId) ||
    typeof assetId !== 'string' ||
    !isUuid(assetId)
  ) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid id format.' } },
      traceId,
      acao,
    );
  }
  const name = validName(rawName);
  if (name === null) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'name must be 1 to 500 characters.' } },
      traceId,
      acao,
    );
  }

  const repository = buildRepository(env);
  const membership = await repository.getMembership(workspaceId, caller.value);
  if (membership === null || !RENAME_ROLES.has(membership.role)) {
    logger.warn('asset rename denied: caller lacks an eligible role', {
      workspace_id: workspaceId,
    });
    return json(
      403,
      { error: { code: 'forbidden', message: 'You do not have permission to rename assets.' } },
      traceId,
      acao,
    );
  }

  const result = await renameAsset(repository, {
    workspaceId,
    assetId,
    name,
    actorUserId: caller.value,
    traceId,
  });
  if (!result.ok) {
    return json(STATUS_BY_CODE[result.error.code], { error: result.error }, traceId, acao);
  }
  return json(200, { asset: result.value }, traceId, acao);
}

/** Roles permitted to rename or delete a folder. Same set as asset rename; a
 * 'client' member is denied. */
const FOLDER_MANAGE_ROLES = RENAME_ROLES;

/**
 * POST /folders: create a folder. Same auth + membership gate as the file upload
 * (any active member). A non-null parent must be a live folder in the same
 * workspace (no cross-workspace parent). A sibling-name collision is resolved
 * desktop-style in the repository ("Campaigns", "Campaigns 2", ...), so create
 * never returns folder_name_taken; the response carries the resolved name.
 */
async function handleCreateFolder(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return json(400, { error: { code: 'bad_request', message: parsed.error } }, traceId, acao);
  }
  const { workspace_id: workspaceId, name: rawName, parent_id: rawParentId } = parsed.value;
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid workspace_id.' } },
      traceId,
      acao,
    );
  }
  const name = validFolderName(rawName);
  if (name === null) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'name must be 1 to 80 characters.' } },
      traceId,
      acao,
    );
  }
  const parentId = readOptionalFolderId(rawParentId);
  if (parentId === false) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid parent_id.' } },
      traceId,
      acao,
    );
  }

  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('folder create denied: caller not a workspace member', {
      workspace_id: workspaceId,
    });
    return json(
      403,
      { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
      traceId,
      acao,
    );
  }

  const repository = buildRepository(env);
  if (parentId !== null) {
    const parent = await repository.getFolder(workspaceId, parentId);
    if (parent === null) {
      return json(
        400,
        { error: { code: 'bad_request', message: 'Parent folder not found in this workspace.' } },
        traceId,
        acao,
      );
    }
  }

  const folder = await repository.createFolder({
    workspaceId,
    name,
    parentId,
    actorUserId: caller.value,
    traceId,
  });
  return json(201, { folder }, traceId, acao);
}

/**
 * POST /folders/rename: rename a folder. owner/admin/agency only (a client is
 * forbidden), mirroring the asset rename role gate. 404 for an unknown or
 * cross-tenant folder; a name collision is a 409.
 */
async function handleRenameFolder(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return json(400, { error: { code: 'bad_request', message: parsed.error } }, traceId, acao);
  }
  const { workspace_id: workspaceId, folder_id: folderId, name: rawName } = parsed.value;
  if (
    typeof workspaceId !== 'string' ||
    !isUuid(workspaceId) ||
    typeof folderId !== 'string' ||
    !isUuid(folderId)
  ) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid id format.' } },
      traceId,
      acao,
    );
  }
  const name = validFolderName(rawName);
  if (name === null) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'name must be 1 to 80 characters.' } },
      traceId,
      acao,
    );
  }

  const repository = buildRepository(env);
  const membership = await repository.getMembership(workspaceId, caller.value);
  if (membership === null || !FOLDER_MANAGE_ROLES.has(membership.role)) {
    logger.warn('folder rename denied: caller lacks an eligible role', {
      workspace_id: workspaceId,
    });
    return json(
      403,
      { error: { code: 'forbidden', message: 'You do not have permission to manage folders.' } },
      traceId,
      acao,
    );
  }

  const folder = await repository.getFolder(workspaceId, folderId);
  if (folder === null) {
    return json(
      404,
      { error: { code: 'not_found', message: 'Folder not found in this workspace.' } },
      traceId,
      acao,
    );
  }

  const result = await repository.renameFolder({
    workspaceId,
    folderId,
    name,
    actorUserId: caller.value,
    traceId,
  });
  if (!result.ok) {
    return json(STATUS_BY_CODE[result.error.code], { error: result.error }, traceId, acao);
  }
  return json(200, { folder: result.value }, traceId, acao);
}

/**
 * POST /folders/delete: soft-delete a folder. owner/admin/agency only. Child
 * folders are reparented to root and assets detached to All assets before the
 * folder is tombstoned. 404 for an unknown or cross-tenant folder.
 */
async function handleDeleteFolder(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return json(400, { error: { code: 'bad_request', message: parsed.error } }, traceId, acao);
  }
  const { workspace_id: workspaceId, folder_id: folderId } = parsed.value;
  if (
    typeof workspaceId !== 'string' ||
    !isUuid(workspaceId) ||
    typeof folderId !== 'string' ||
    !isUuid(folderId)
  ) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid id format.' } },
      traceId,
      acao,
    );
  }

  const repository = buildRepository(env);
  const membership = await repository.getMembership(workspaceId, caller.value);
  if (membership === null || !FOLDER_MANAGE_ROLES.has(membership.role)) {
    logger.warn('folder delete denied: caller lacks an eligible role', {
      workspace_id: workspaceId,
    });
    return json(
      403,
      { error: { code: 'forbidden', message: 'You do not have permission to manage folders.' } },
      traceId,
      acao,
    );
  }

  const folder = await repository.getFolder(workspaceId, folderId);
  if (folder === null) {
    return json(
      404,
      { error: { code: 'not_found', message: 'Folder not found in this workspace.' } },
      traceId,
      acao,
    );
  }

  await repository.softDeleteFolderWithDetach({
    workspaceId,
    folderId,
    actorUserId: caller.value,
    traceId,
  });
  return json(200, { ok: true }, traceId, acao);
}

/**
 * POST /folders/move: move assets into a folder (or to the All assets root when
 * target_folder_id is null). Any active member. The id set is 1..200 UUIDs; a
 * non-null target must be a live folder in the same workspace. One batch update.
 */
async function handleMoveAssets(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(
      401,
      { error: { code: 'unauthorized', message: caller.error.message } },
      traceId,
      acao,
    );
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return json(400, { error: { code: 'bad_request', message: parsed.error } }, traceId, acao);
  }
  const {
    workspace_id: workspaceId,
    asset_ids: rawAssetIds,
    target_folder_id: rawTargetId,
  } = parsed.value;
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid workspace_id.' } },
      traceId,
      acao,
    );
  }
  if (!Array.isArray(rawAssetIds) || rawAssetIds.length < 1 || rawAssetIds.length > 200) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'asset_ids must be 1 to 200 ids.' } },
      traceId,
      acao,
    );
  }
  for (const id of rawAssetIds) {
    if (typeof id !== 'string' || !isUuid(id)) {
      return json(
        400,
        { error: { code: 'bad_request', message: 'Invalid id format.' } },
        traceId,
        acao,
      );
    }
  }
  const assetIds = rawAssetIds as string[];
  const targetFolderId = readOptionalFolderId(rawTargetId);
  if (targetFolderId === false) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Invalid target_folder_id.' } },
      traceId,
      acao,
    );
  }

  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('folder move denied: caller not a workspace member', {
      workspace_id: workspaceId,
    });
    return json(
      403,
      { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
      traceId,
      acao,
    );
  }

  const repository = buildRepository(env);
  if (targetFolderId !== null) {
    const target = await repository.getFolder(workspaceId, targetFolderId);
    if (target === null) {
      return json(
        400,
        { error: { code: 'bad_request', message: 'Target folder not found in this workspace.' } },
        traceId,
        acao,
      );
    }
  }

  const moved = await repository.moveAssetsToFolder({
    workspaceId,
    assetIds,
    targetFolderId,
    actorUserId: caller.value,
    traceId,
  });
  return json(200, { moved }, traceId, acao);
}

export default {
  async fetch(request: Request, env: AssetUploadEnv): Promise<Response> {
    const traceId = extractTraceId(request);
    logger.setTraceId(traceId);
    const acao = resolveAllowedOrigin(request, env);
    try {
      if (request.method === 'OPTIONS') {
        return preflightResponse(request, env);
      }
      if (request.method === 'POST') {
        const path = new URL(request.url).pathname;
        if (path === '/links') {
          return await handleCreateLink(request, env, traceId, acao);
        }
        if (path === '/rename') {
          return await handleRename(request, env, traceId, acao);
        }
        if (path === '/folders') {
          return await handleCreateFolder(request, env, traceId, acao);
        }
        if (path === '/folders/rename') {
          return await handleRenameFolder(request, env, traceId, acao);
        }
        if (path === '/folders/delete') {
          return await handleDeleteFolder(request, env, traceId, acao);
        }
        if (path === '/folders/move') {
          return await handleMoveAssets(request, env, traceId, acao);
        }
        if (path === '/multipart/create') {
          return await handleMultipartCreate(request, env, traceId, acao);
        }
        if (path === '/multipart/complete') {
          return await handlePost(request, env, traceId, acao, 'multipart');
        }
        if (path === '/multipart/abort') {
          return await handleMultipartAbort(request, env, traceId, acao);
        }
        if (path === '/thumbnail') {
          return await handleThumbnail(request, env, traceId, acao);
        }
        if (path === '/purge') return await handlePurge(request, env, traceId, acao);
        if (path === '/purge-chat') return await handlePurgeChat(request, env, traceId, acao);
        return await handlePost(request, env, traceId, acao);
      }
      if (request.method === 'PUT' && new URL(request.url).pathname === '/multipart/part') {
        return await handleMultipartPart(request, env, traceId, acao);
      }
      if (request.method === 'GET') {
        const getPath = new URL(request.url).pathname;
        if (getPath === '/multipart/parts') {
          return await handleMultipartParts(request, env, traceId, acao);
        }
        if (getPath === '/usage') {
          return await handleUsage(request, env, traceId, acao);
        }
        return await handleGet(request, env, traceId, acao);
      }
      return json(
        405,
        { error: { code: 'method_not_allowed', message: 'Use GET, POST or PUT.' } },
        traceId,
        acao,
      );
    } catch (error) {
      logger.error(`asset upload failed: ${serializeError(error)}`);
      return json(
        500,
        { error: { code: 'internal_error', message: 'Upload failed.' } },
        traceId,
        acao,
      );
    } finally {
      logger.clearTraceId();
    }
  },
};
