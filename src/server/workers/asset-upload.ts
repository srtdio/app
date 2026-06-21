// Cloudflare Worker: asset upload + read route.
//
// POST  multipart/form-data { file, workspace_id, asset_id? }
//   -> verifies the caller's Bearer token, confirms they are an active member of
//      workspace_id, runs the upload pipeline, and returns the asset summary.
//      The acting user is the verified token's `sub` claim only - the body never
//      carries an uploaded_by id.
// GET   ?workspace_id=&asset_id=
//   -> same auth + membership gate, then returns the current summary scoped to
//      the workspace (cross-tenant 404).
//
// The Worker is the only holder of the Supabase service-role key and the R2
// credentials; neither is ever shipped to the browser. Caller tokens are
// verified against the project's published asymmetric JWKS (ES256); membership
// is an explicit service-role DB read, not an RLS side effect. Expected pipeline
// failures map to 4xx; unexpected faults bubble up to a 500.

import {
  createLinkAsset,
  createSupabaseAssetRepository,
  getAssetSummary,
  renameAsset,
  runUploadPipeline,
  selectScanner,
  err,
  ok,
  type AssetRepository,
  type AssetSummary,
  type Result,
  type UploadError,
  type UploadErrorCode,
  type UploadInput,
} from '@/server/assets';
import { R2StorageClient, type StorageClient } from '@srtdio/storage';
import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';
// Reuse asset-read's verified-token + membership primitives verbatim so the two
// workers cannot drift: same ES256 JWKS verification, same workspace_members read.
import { createSupabaseAssetReadStore, getSupabaseJwks, verifyCaller } from './asset-read';

export interface AssetUploadEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  VIRUS_SCAN_PROVIDER?: string;
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
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'method_not_allowed'
  | 'internal_error';

const STATUS_BY_CODE: Record<UploadResponseCode, number> = {
  unsupported_mime: 415,
  mime_mismatch: 415,
  file_too_large: 413,
  empty_file: 400,
  invalid_image: 422,
  virus_detected: 422,
  not_found: 404,
  folder_name_taken: 409,
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
  assetId?: string;
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
    ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
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
  return allowedOrigins(env).includes(origin) ? origin : null;
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
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
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

function buildStorage(env: AssetUploadEnv): StorageClient {
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
  };
  return (input) => runUploadPipeline(deps, input);
}

async function handlePost(
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

  if (!(file instanceof File)) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Missing file part.' } },
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

  const bytes = new Uint8Array(await file.arrayBuffer());
  const outcome = await authorizeAndUpload(
    {
      membership: createSupabaseAssetReadStore(env),
      runPipeline: buildPipelineRunner(env),
    },
    {
      userId: caller.value,
      workspaceId,
      filename: file.name,
      contentType: file.type,
      bytes,
      traceId,
      ...(typeof assetId === 'string' && assetId !== '' ? { assetId } : {}),
    },
  );

  if (!outcome.ok) {
    if (outcome.error.code === 'forbidden') {
      logger.warn('asset upload denied: caller not a workspace member', {
        workspace_id: workspaceId,
      });
    }
    return json(STATUS_BY_CODE[outcome.error.code], { error: outcome.error }, traceId, acao);
  }
  return json(outcome.value.reused ? 200 : 201, { asset: outcome.value.summary }, traceId, acao);
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
        return await handlePost(request, env, traceId, acao);
      }
      if (request.method === 'GET') {
        return await handleGet(request, env, traceId, acao);
      }
      return json(
        405,
        { error: { code: 'method_not_allowed', message: 'Use GET or POST.' } },
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
