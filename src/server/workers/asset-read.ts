// Cloudflare Worker: asset read path.
//
// POST application/json { asset_version_id }
//   -> verifies the caller, authorizes them against the asset version's
//      workspace, and returns a short-lived signed R2 GET URL:
//      { url, expires_at }.
//
// The Worker is the only holder of the Supabase service-role key and the R2
// credentials; neither is ever shipped to the browser. Caller tokens are
// verified against the project's published asymmetric JWKS (ES256), so no
// shared secret is held here. The caller is identified from the verified
// token's `sub` claim only - never from
// a request-supplied id. Authorization is an explicit DB read against
// workspace_members (membership is not in the JWT), not an RLS side effect, so
// the lookup uses the service role and the worker gates access itself.
//
// This is a read/query endpoint: no idempotency key, no state mutation, no
// audit row. Expected failures (missing/invalid token, unknown version,
// non-member) are returned as typed Results and mapped to 4xx; system faults
// throw and become a 500.

import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { R2StorageClient } from '@srtdio/storage';
import { tracedFetch } from '@/server/traced-fetch';
import { err, ok, type Result } from '@/server/assets/types';
import { extractTraceId } from '@/server/trace';
import { logger } from '@/server/logger';
import { TRACE_ID_HEADER } from '@/lib/trace';

/** Signed-URL lifetime: 15 minutes. */
const URL_TTL_SECONDS = 900;

export interface AssetReadEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  SUPABASE_URL: string;
  /** Service role: used only for the server-side row lookups below. */
  SUPABASE_SECRET_KEY: string;
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
 */
const DEFAULT_ALLOWED_ORIGINS = ['https://srtd.io'] as const;

/** Preflight cache lifetime: 24 hours. */
const CORS_MAX_AGE_SECONDS = 86_400;

export type ReadErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_a_stored_file';

export interface ReadError {
  code: ReadErrorCode;
  message: string;
}

const STATUS_BY_CODE: Record<ReadErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  not_a_stored_file: 400,
};

/**
 * Where an asset version's bytes live: its owning workspace, that workspace's
 * permanent R2 bucket name, its kind, and the object key. A link version (or any
 * version without stored bytes) has a null r2_key and cannot be signed.
 */
export interface AssetVersionLocator {
  workspaceId: string;
  bucket: string | null;
  kind: string;
  r2Key: string | null;
  /** Version mime type; drives the download filename's extension. Optional. */
  mimeType?: string | null;
  /** Original upload filename from the parent asset. Optional. */
  filename?: string | null;
  /** Human label from the parent asset (backfilled from post title). Optional. */
  displayName?: string | null;
}

/**
 * The two server-side reads the worker needs. Kept as an interface so tests
 * inject a fake and exercise the authorization branching without a network.
 */
export interface AssetReadStore {
  /** Locate a version by id alone (no workspace scope; the worker authorizes). */
  findVersion(assetVersionId: string): Promise<AssetVersionLocator | null>;
  /** True iff the user has an active membership in the workspace. */
  isActiveMember(input: { userId: string; workspaceId: string }): Promise<boolean>;
}

/** Mints a presigned GET URL for an object. Implemented by R2StorageClient. */
export interface PresignedUrlSigner {
  presignGetUrl(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
    /** When set, the URL forces a Content-Disposition: attachment download. */
    downloadFilename?: string;
  }): Promise<string>;
}

/** Requested disposition for the signed URL. Defaults to inline. */
export type Disposition = 'inline' | 'attachment';

/** Common mime types mapped to the extension a saved file should carry. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/zip': 'zip',
};

/** Last path segment of an R2 key, stripped of the version prefix where present. */
function keyBasename(key: string): string {
  const segment = key.split('/').pop() ?? key;
  return segment.replace(/^v\d+-/, '');
}

/** The extension on a filename (lowercased), or '' when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Build the filename the browser should save under: the asset's display name (or
 * original filename, or key basename), carrying the correct extension for its
 * mime type. The mime-derived extension wins; otherwise the existing extension
 * is kept.
 */
export function buildDownloadFilename(version: AssetVersionLocator): string {
  const fallback =
    version.r2Key !== null && version.r2Key !== '' ? keyBasename(version.r2Key) : 'download';
  const base = (version.displayName ?? '').trim() || (version.filename ?? '').trim() || fallback;
  const mimeExt = version.mimeType ? EXTENSION_BY_MIME[version.mimeType.toLowerCase()] : undefined;
  const ext = mimeExt ?? (extensionOf(base) || extensionOf(fallback));
  if (ext === '') return base;
  const stem = base.lastIndexOf('.') > 0 ? base.slice(0, base.lastIndexOf('.')) : base;
  return `${stem}.${ext}`;
}

export interface AuthorizeDeps {
  store: AssetReadStore;
  signer: PresignedUrlSigner;
}

export interface SignedUrlResult {
  url: string;
  expires_at: string;
}

/**
 * Authorize the caller for the asset version, then mint the signed URL. The
 * order is fixed: not-found before forbidden, the membership gate always runs
 * before anything is signed, and the stored-file check runs only after the
 * caller is proven a member. Crashes loudly if a located version is missing its
 * workspace - that is a data-integrity fault, not a 404. A link version (or any
 * version with a null r2_key) has no bytes to sign and is a domain error.
 */
export async function authorizeAndSign(
  deps: AuthorizeDeps,
  input: { userId: string; assetVersionId: string; disposition?: Disposition },
): Promise<Result<SignedUrlResult, ReadError>> {
  const version = await deps.store.findVersion(input.assetVersionId);
  if (!version) {
    return err({ code: 'not_found', message: 'Asset version not found.' });
  }
  if (!version.workspaceId) {
    throw new Error(`asset_version ${input.assetVersionId} is missing workspace_id`);
  }

  const member = await deps.store.isActiveMember({
    userId: input.userId,
    workspaceId: version.workspaceId,
  });
  if (!member) {
    return err({ code: 'forbidden', message: 'Not a member of this workspace.' });
  }

  if (version.kind === 'link' || version.r2Key === null) {
    return err({ code: 'not_a_stored_file', message: 'Asset version has no stored file to sign.' });
  }
  if (version.bucket === null) {
    throw new Error(`workspace ${version.workspaceId} is missing asset_bucket`);
  }

  const url = await deps.signer.presignGetUrl({
    bucket: version.bucket,
    key: version.r2Key,
    expiresInSeconds: URL_TTL_SECONDS,
    // Inline (default) leaves the signing path byte-identical; attachment adds
    // the response-content-disposition override so the browser saves the file.
    ...(input.disposition === 'attachment'
      ? { downloadFilename: buildDownloadFilename(version) }
      : {}),
  });
  const expires_at = new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString();
  return ok({ url, expires_at });
}

/** Path to a Supabase project's published JWKS (asymmetric signing keys). */
const JWKS_PATH = '/auth/v1/.well-known/jwks.json';

/**
 * Lazily-built remote JWKS resolver. Supabase signs user access tokens with
 * ES256 and publishes the verifying public keys at {@link JWKS_PATH}; jose
 * fetches and caches them inside this instance. It is built on first request,
 * never at module eval - constructing it (or doing any I/O) at global scope
 * trips Cloudflare error 10021. One instance per isolate is reused so keys are
 * fetched at most once.
 */
let jwksCache: JWTVerifyGetKey | undefined;

export function getSupabaseJwks(env: { SUPABASE_URL: string }): JWTVerifyGetKey {
  jwksCache ??= createRemoteJWKSet(new URL(JWKS_PATH, env.SUPABASE_URL));
  return jwksCache;
}

/**
 * Verify the Bearer token against the project's asymmetric JWKS (ES256) and
 * return the `sub` claim. Any absent/malformed/expired token is an
 * `unauthorized` Result, never a throw.
 */
export async function verifyCaller(
  request: Request,
  getKey: JWTVerifyGetKey,
): Promise<Result<string, ReadError>> {
  const header = request.headers.get('Authorization') ?? request.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (token === '') {
    return err({ code: 'unauthorized', message: 'Missing bearer token.' });
  }
  try {
    const { payload } = await jwtVerify(token, getKey, {
      algorithms: ['ES256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      return err({ code: 'unauthorized', message: 'Token has no subject.' });
    }
    return ok(payload.sub);
  } catch {
    return err({ code: 'unauthorized', message: 'Invalid or expired token.' });
  }
}

/** The configured allowlist, falling back to the known site origins. */
function allowedOrigins(env: AssetReadEnv): readonly string[] {
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
function resolveAllowedOrigin(request: Request, env: AssetReadEnv): string | null {
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
function preflightResponse(request: Request, env: AssetReadEnv): Response {
  const acao =
    resolveAllowedOrigin(request, env) ?? allowedOrigins(env)[0] ?? DEFAULT_ALLOWED_ORIGINS[0];
  const headers = new Headers({
    'Access-Control-Allow-Origin': acao,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

function fail(error: ReadError, traceId: string, acao: string | null): Response {
  return json(STATUS_BY_CODE[error.code], { error }, traceId, acao);
}

/** The parsed read request: the required version id plus the chosen disposition. */
export interface ReadRequest {
  assetVersionId: string;
  disposition: Disposition;
}

/**
 * Pull the required `asset_version_id` and the optional `disposition` from the
 * JSON body. disposition defaults to 'inline'; any value other than 'inline' or
 * 'attachment' is a bad_request, matching the existing strict body parsing.
 */
async function readRequestBody(request: Request): Promise<Result<ReadRequest, ReadError>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err({ code: 'bad_request', message: 'Body must be JSON.' });
  }
  const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  const id = obj?.asset_version_id;
  if (typeof id !== 'string' || id === '') {
    return err({ code: 'bad_request', message: 'asset_version_id is required.' });
  }
  const rawDisposition = obj?.disposition;
  let disposition: Disposition = 'inline';
  if (rawDisposition !== undefined) {
    if (rawDisposition !== 'inline' && rawDisposition !== 'attachment') {
      return err({ code: 'bad_request', message: 'disposition must be inline or attachment.' });
    }
    disposition = rawDisposition;
  }
  return ok({ assetVersionId: id, disposition });
}

/**
 * Service-role-backed store. The service role bypasses RLS; the worker is the
 * only caller and never exposes this key. supabase-js is a stateless HTTP
 * client (no pooled connection to close); it is built per request and discarded
 * when this function returns.
 */
export function createSupabaseAssetReadStore(env: {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
}): AssetReadStore {
  const client: SupabaseClient<Database> = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  return {
    async findVersion(assetVersionId) {
      const { data, error } = await client
        .from('asset_versions')
        .select(
          'workspace_id,kind,r2_key,mime_type,workspaces(asset_bucket),assets!asset_id(filename,display_name)',
        )
        .eq('id', assetVersionId)
        .maybeSingle();
      if (error) {
        throw error;
      }
      if (!data) {
        return null;
      }
      // The embedded workspace carries the bucket and the embedded asset carries
      // the human name; supabase-js types both as to-one objects via their FKs.
      const workspace = data.workspaces as { asset_bucket: string | null } | null;
      const asset = data.assets as { filename: string | null; display_name: string | null } | null;
      return {
        workspaceId: data.workspace_id,
        bucket: workspace?.asset_bucket ?? null,
        kind: data.kind,
        r2Key: data.r2_key,
        mimeType: data.mime_type,
        filename: asset?.filename ?? null,
        displayName: asset?.display_name ?? null,
      };
    },

    async isActiveMember({ userId, workspaceId }) {
      const { data, error } = await client
        .from('workspace_members')
        .select('id')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data !== null;
    },
  };
}

async function handlePost(
  request: Request,
  env: AssetReadEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return fail(caller.error, traceId, acao);
  }

  const parsed = await readRequestBody(request);
  if (!parsed.ok) {
    return fail(parsed.error, traceId, acao);
  }

  const result = await authorizeAndSign(
    {
      store: createSupabaseAssetReadStore(env),
      signer: new R2StorageClient(
        {
          CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
          CLOUDFLARE_R2_ACCESS_KEY_ID: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
          CLOUDFLARE_R2_SECRET_ACCESS_KEY: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
        },
        tracedFetch,
      ),
    },
    {
      userId: caller.value,
      assetVersionId: parsed.value.assetVersionId,
      disposition: parsed.value.disposition,
    },
  );
  if (!result.ok) {
    if (result.error.code === 'forbidden') {
      logger.warn('asset read denied: caller not a workspace member', {
        asset_version_id: parsed.value.assetVersionId,
      });
    }
    return fail(result.error, traceId, acao);
  }
  return json(200, result.value, traceId, acao);
}

export default {
  async fetch(request: Request, env: AssetReadEnv): Promise<Response> {
    const traceId = extractTraceId(request);
    logger.setTraceId(traceId);
    const acao = resolveAllowedOrigin(request, env);
    try {
      if (request.method === 'OPTIONS') {
        return preflightResponse(request, env);
      }
      if (request.method !== 'POST') {
        return fail({ code: 'bad_request', message: 'Use POST.' }, traceId, acao);
      }
      return await handlePost(request, env, traceId, acao);
    } catch (error) {
      const errName = error instanceof Error ? error.name : 'UnknownError';
      const errMsg = error instanceof Error ? error.message : String(error);
      const errStack =
        error instanceof Error && error.stack ? (error.stack.split('\n')[1]?.trim() ?? '') : '';
      logger.error(`asset read failed: ${errName}: ${errMsg} ${errStack}`.trim());
      return json(
        500,
        { error: { code: 'internal_error', message: 'Failed to sign URL.' } },
        traceId,
        acao,
      );
    } finally {
      logger.clearTraceId();
    }
  },
};
