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
// A chat-origin version is gated by chat membership instead: one extra
// service-role RPC (chat_attachment_readable) per presign, on chat files only.
// A caller it rejects gets the exact non-member 403, so a chat file's existence
// is never revealed. Library versions keep the workspace-member check.
//
// Two additive modes, each authorized exactly as above on the PARENT version:
//   { asset_version_id, rendition: 'thumbnail' } -> the version's thumbnail
//     rendition presigned inline (900 s), or 404 { error: 'no_rendition' };
//   { asset_version_id, stream: true } -> a PDF, Word (docx) or Excel (xlsx)
//     version's bytes piped through this Worker (never buffered), Range/206
//     passed through, so the in-app viewer never depends on per-bucket
//     storage CORS. Any other version (pptx included) is a 400.
// A body without either field is handled byte-for-byte as before.
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
import { err, ok, type AssetOrigin, type Result } from '@/server/assets/types';
import {
  createSupabaseRenditionStore,
  type RenditionRef,
  type RenditionRole,
} from '@/server/assets/repository';
import { extractTraceId } from '@/server/trace';
import { logger } from '@/server/logger';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { isPreviewOrigin } from '@/server/preview-origin';

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
  /** The parent asset's origin; 'chat' switches the gate to chat membership. */
  origin: AssetOrigin;
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
  /**
   * True iff the user may read this chat attachment (its uploader, or a member of
   * a chat holding a live message with it, after their clear point). Throws on
   * an RPC error so the worker answers 5xx and never signs.
   */
  isChatAttachmentReadable(input: { userId: string; assetVersionId: string }): Promise<boolean>;
}

/** The single forbidden error for every denied read, chat or library alike. */
const FORBIDDEN: ReadError = { code: 'forbidden', message: 'Not a member of this workspace.' };

/**
 * The onboarding sample week's files (photos, PDFs) ship with the app under
 * public/induction-sample/ and are served by Pages from the caller's own site.
 * A version whose r2_key carries this prefix is never in any workspace's
 * bucket, so it uses none of the workspace's storage; it reads through the
 * same membership gate as every other version.
 */
export const SAMPLE_KEY_PREFIX = 'induction-sample/';

export function isSampleKey(key: string | null): boolean {
  return key !== null && key.startsWith(SAMPLE_KEY_PREFIX);
}

/** The small copy of a sample file: thumb/<name>, a PDF's being its cover image. */
export function sampleThumbKey(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1).replace(/\.pdf$/i, '.jpg');
  return `${SAMPLE_KEY_PREFIX}thumb/${name}`;
}

/** Signs sample keys as the site's own static URL; everything else goes to the inner signer. */
export function withSampleFiles(inner: PresignedUrlSigner, siteOrigin: string): PresignedUrlSigner {
  return {
    presignGetUrl: (input) =>
      isSampleKey(input.key)
        ? Promise.resolve(`${siteOrigin.replace(/\/$/, '')}/${input.key}`)
        : inner.presignGetUrl(input),
  };
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

/** A version the caller may read, with the stored bytes' location resolved. */
export interface ReadableVersion {
  version: AssetVersionLocator;
  bucket: string;
  r2Key: string;
}

/**
 * Authorize the caller for the asset version. The order is fixed: not-found
 * before forbidden, the membership gate always runs before anything is
 * signed or streamed, and the stored-file check runs only after the caller is
 * proven a member. Crashes loudly if a located version is missing its
 * workspace - that is a data-integrity fault, not a 404. A link version (or any
 * version with a null r2_key) has no bytes to sign and is a domain error.
 */
export async function authorizeVersion(
  store: AssetReadStore,
  input: { userId: string; assetVersionId: string },
): Promise<Result<ReadableVersion, ReadError>> {
  const version = await store.findVersion(input.assetVersionId);
  if (!version) {
    return err({ code: 'not_found', message: 'Asset version not found.' });
  }
  if (!version.workspaceId) {
    throw new Error(`asset_version ${input.assetVersionId} is missing workspace_id`);
  }

  const allowed =
    version.origin === 'chat'
      ? await store.isChatAttachmentReadable({
          userId: input.userId,
          assetVersionId: input.assetVersionId,
        })
      : await store.isActiveMember({
          userId: input.userId,
          workspaceId: version.workspaceId,
        });
  if (!allowed) {
    return err(FORBIDDEN);
  }

  if (version.kind === 'link' || version.r2Key === null) {
    return err({ code: 'not_a_stored_file', message: 'Asset version has no stored file to sign.' });
  }
  if (isSampleKey(version.r2Key)) {
    return ok({ version, bucket: version.bucket ?? '', r2Key: version.r2Key });
  }
  if (version.bucket === null) {
    throw new Error(`workspace ${version.workspaceId} is missing asset_bucket`);
  }
  return ok({ version, bucket: version.bucket, r2Key: version.r2Key });
}

/**
 * Authorize the caller for the asset version, then mint the signed URL (see
 * {@link authorizeVersion} for the gate's order).
 */
export async function authorizeAndSign(
  deps: AuthorizeDeps,
  input: { userId: string; assetVersionId: string; disposition?: Disposition },
): Promise<Result<SignedUrlResult, ReadError>> {
  const readable = await authorizeVersion(deps.store, input);
  if (!readable.ok) {
    return readable;
  }
  const { version, bucket, r2Key } = readable.value;

  const url = await deps.signer.presignGetUrl({
    bucket,
    key: r2Key,
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

/** Reads a version's rendition (service role; asset_renditions has no client SELECT). */
export interface RenditionReader {
  findRendition(assetVersionId: string, role: RenditionRole): Promise<RenditionRef | null>;
}

/**
 * The thumbnail mode: authorize the PARENT version exactly as a plain read,
 * then presign its thumbnail rendition inline for 900 s. A version without
 * one is the 'no_rendition' miss (404).
 */
export async function authorizeAndSignRendition(
  deps: AuthorizeDeps & { renditions: RenditionReader },
  input: { userId: string; assetVersionId: string },
): Promise<Result<SignedUrlResult, ReadError | 'no_rendition'>> {
  const readable = await authorizeVersion(deps.store, input);
  if (!readable.ok) {
    return readable;
  }
  // A sample file's thumbnail is its small copy (induction-sample/thumb/), kept light
  // for slow networks; every other version uses its stored rendition.
  const rendition = isSampleKey(readable.value.r2Key)
    ? { r2Key: sampleThumbKey(readable.value.r2Key) }
    : await deps.renditions.findRendition(input.assetVersionId, 'thumbnail');
  if (rendition === null) {
    return err('no_rendition');
  }
  const url = await deps.signer.presignGetUrl({
    bucket: readable.value.bucket,
    key: rendition.r2Key,
    expiresInSeconds: URL_TTL_SECONDS,
  });
  const expires_at = new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString();
  return ok({ url, expires_at });
}

/** The kinds the stream mode serves, each with the one mime it must carry. */
const STREAM_MIME_BY_KIND: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The Content-Type a stream pins for a stored version, or null when it has no stream. */
function streamMime(version: AssetVersionLocator): string | null {
  const mime = STREAM_MIME_BY_KIND[version.kind];
  return mime !== undefined && (version.mimeType ?? '').toLowerCase() === mime ? mime : null;
}

/** Fetches an object's bytes from a presigned URL; Range passes through. */
export type ObjectFetcher = (url: string, range: string | null) => Promise<Response>;

/** Upstream headers a stream passes back to the browser. */
const STREAM_PASS_HEADERS = ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'] as const;

/**
 * The stream mode: authorize the PARENT version exactly as a plain read, then
 * fetch the file server-side and pipe its body back (never buffered), passing
 * a Range request and a 206 through. Content-Type is pinned to the version's
 * own pdf, docx or xlsx mime (kind and mime must agree) with nosniff and no
 * caching. Any other version is a 400.
 */
export async function authorizeAndStream(
  deps: { store: AssetReadStore; signer: PresignedUrlSigner; fetchObject: ObjectFetcher },
  input: { userId: string; assetVersionId: string; range: string | null },
): Promise<Result<Response, ReadError>> {
  const readable = await authorizeVersion(deps.store, input);
  if (!readable.ok) {
    return readable;
  }
  const contentType = streamMime(readable.value.version);
  if (contentType === null) {
    return err({ code: 'bad_request', message: 'stream is only for PDF, Word and Excel files.' });
  }
  const url = await deps.signer.presignGetUrl({
    bucket: readable.value.bucket,
    key: readable.value.r2Key,
    expiresInSeconds: URL_TTL_SECONDS,
  });
  const upstream = await deps.fetchObject(url, input.range);
  if (upstream.status !== 200 && upstream.status !== 206) {
    // Release the upstream body before failing (nothing is piped).
    await upstream.body?.cancel();
    if (upstream.status === 416) {
      return err({ code: 'bad_request', message: 'Range not satisfiable.' });
    }
    throw new Error(`object fetch failed with status ${upstream.status}`);
  }
  const headers = new Headers({
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  for (const name of STREAM_PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return ok(new Response(upstream.body, { status: upstream.status, headers }));
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
  /** 'sign' (as before), 'thumbnail' (rendition) or 'stream' (PDF bytes). */
  mode: 'sign' | 'thumbnail' | 'stream';
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
  const rendition = obj?.rendition;
  const stream = obj?.stream;
  if (rendition !== undefined && rendition !== 'thumbnail') {
    return err({ code: 'bad_request', message: 'rendition must be thumbnail.' });
  }
  if (stream !== undefined && typeof stream !== 'boolean') {
    return err({ code: 'bad_request', message: 'stream must be a boolean.' });
  }
  const streaming = stream === true;
  // A rendition or a stream is inline by nature and one mode at a time.
  if ((rendition !== undefined || streaming) && rawDisposition !== undefined) {
    return err({ code: 'bad_request', message: 'disposition applies to a plain read only.' });
  }
  if (rendition !== undefined && streaming) {
    return err({ code: 'bad_request', message: 'Ask for a rendition or a stream, not both.' });
  }
  const mode = rendition !== undefined ? 'thumbnail' : streaming ? 'stream' : 'sign';
  return ok({ assetVersionId: id, disposition, mode });
}

/**
 * Service-role-backed store. The service role bypasses RLS; the worker is the
 * only caller and never exposes this key. supabase-js is a stateless HTTP
 * client (no pooled connection to close); it is built per request and discarded
 * when this function returns. When a traceId is given every call carries it as
 * X-Trace-Id.
 */
export function createSupabaseAssetReadStore(
  env: {
    SUPABASE_URL: string;
    SUPABASE_SECRET_KEY: string;
  },
  traceId?: string,
): AssetReadStore {
  const client: SupabaseClient<Database> = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      ...(traceId !== undefined ? { global: { headers: { [TRACE_ID_HEADER]: traceId } } } : {}),
    },
  );

  return {
    async findVersion(assetVersionId) {
      const { data, error } = await client
        .from('asset_versions')
        .select(
          'workspace_id,kind,r2_key,mime_type,workspaces(asset_bucket),assets!asset_id(filename,display_name,origin)',
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
      const asset = data.assets as {
        filename: string | null;
        display_name: string | null;
        origin: string;
      } | null;
      // Fail closed: anything but an explicit 'library' parent is gated as chat.
      const origin: AssetOrigin = asset?.origin === 'library' ? 'library' : 'chat';
      return {
        workspaceId: data.workspace_id,
        bucket: workspace?.asset_bucket ?? null,
        origin,
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

    async isChatAttachmentReadable({ userId, assetVersionId }) {
      // chat_attachment_readable takes no _trace_id (service_role-only read); the
      // trace rides this client's X-Trace-Id header instead.
      // eslint-disable-next-line no-restricted-syntax
      const { data, error } = await client.rpc('chat_attachment_readable', {
        p_asset_version_id: assetVersionId,
        p_user_id: userId,
      });
      if (error) {
        throw error;
      }
      return data === true;
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

  const store = createSupabaseAssetReadStore(env, traceId);
  const signer = withSampleFiles(
    new R2StorageClient(
      {
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_R2_ACCESS_KEY_ID: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
      tracedFetch,
    ),
    acao ?? allowedOrigins(env)[0] ?? DEFAULT_ALLOWED_ORIGINS[0],
  );
  const target = { userId: caller.value, assetVersionId: parsed.value.assetVersionId };
  const denied = (error: ReadError): Response => {
    if (error.code === 'forbidden') {
      logger.warn('asset read denied', {
        asset_version_id: parsed.value.assetVersionId,
      });
    }
    return fail(error, traceId, acao);
  };

  if (parsed.value.mode === 'thumbnail') {
    const result = await authorizeAndSignRendition(
      { store, signer, renditions: createSupabaseRenditionStore(env, traceId) },
      target,
    );
    if (!result.ok) {
      return result.error === 'no_rendition'
        ? json(404, { error: 'no_rendition' }, traceId, acao)
        : denied(result.error);
    }
    return json(200, result.value, traceId, acao);
  }

  if (parsed.value.mode === 'stream') {
    const result = await authorizeAndStream(
      {
        store,
        signer,
        fetchObject: (url, range) =>
          tracedFetch(url, range !== null ? { headers: { Range: range } } : {}, traceId),
      },
      { ...target, range: request.headers.get('Range') },
    );
    if (!result.ok) {
      return denied(result.error);
    }
    const response = result.value;
    response.headers.set(TRACE_ID_HEADER, traceId);
    applyCors(response.headers, acao);
    if (acao !== null) {
      response.headers.set(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Range, Accept-Ranges',
      );
    }
    return response;
  }

  const result = await authorizeAndSign(
    { store, signer },
    {
      userId: caller.value,
      assetVersionId: parsed.value.assetVersionId,
      disposition: parsed.value.disposition,
    },
  );
  if (!result.ok) {
    return denied(result.error);
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
