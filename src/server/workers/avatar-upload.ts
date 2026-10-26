// Cloudflare Worker: avatar upload.
//
// POST / multipart/form-data { file }
//   -> verifies the caller's Bearer token, validates the image, stores it in the
//      public R2 bucket, and returns a stable public CDN URL:
//      { avatar_url }.
// POST /avatar/cleanup JSON { old_url }
//   -> deletes the caller's replaced avatar object once their profile no longer
//      references it: { deleted: boolean }.
//
// This worker is deliberately SIMPLER than asset-upload: a user avatar belongs to
// a PERSON, not a workspace. So there is NO workspace_id, NO membership check, NO
// database writes, and NO service-role key anywhere. The upload route only proves
// who the caller is (verified token `sub`), validates the bytes, PUTs them, and
// returns the URL; it reads no profile and schedules no background work. The
// acting user id comes from the verified token's `sub` claim only, never from the
// request body, so a caller can only ever write their own avatar. The frontend
// later takes avatar_url and calls user_profile_update.
//
// Old-avatar cleanup is a separate call the frontend makes only AFTER its
// user_profile_update succeeded (a new photo or a cleared one), passing the
// previously saved URL. The worker never writes the profile: user_profile_update
// is the one save per avatar change. The cleanup route maps old_url to a key
// only when it is this caller's own `<sub>/<sha256>.png` on the public base
// (never another user's, never groups/, never a foreign host or a path trick),
// then reads the caller's own profile ONCE, AS the caller (their Bearer JWT
// forwarded to PostgREST, so RLS applies). Only when that read succeeds and no
// longer shows old_url is the object deleted. Every other outcome, including a
// failed read or delete (logged), answers 200 { deleted: false } and leaves the
// object in place. R2 deletes are idempotent, so a repeated call is harmless.
//
// Group photos ride the same route: form fields target_kind=group + target_id
// store the bytes under groups/<group id>/ instead of <user id>/. The actor is
// still the verified `sub`; the worker then checks, AS that caller (their own
// Bearer JWT forwarded to PostgREST, so auth.uid() is the verified user and RLS
// applies), the same rule group_avatar_set enforces: the group's creator or an
// active workspace owner/admin. Any failed or hidden read denies. The frontend
// then calls group_avatar_set, which re-checks the rule itself.
//
// No EXIF strip or virus scan: input is PNG-only (magic-byte checked), size
// capped at 5 MiB, and self-produced by the in-app cropper's canvas.toBlob, so
// there is no untrusted container to sanitize. SVG is rejected outright (it can
// carry script); only a real PNG is accepted.

import {
  R2StorageClient,
  computeSha256,
  verifyMagicBytes,
  type MultipartStorage,
  type StorageClient,
} from '@srtdio/storage';
import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';
import { type Result } from '@/server/assets/types';
// Reuse asset-read's verified-token primitives verbatim so the workers cannot
// drift: same ES256 JWKS verification. This cross-worker import is the precedent
// set by asset-upload.ts.
import { getSupabaseJwks, verifyCaller, type ReadError } from './asset-read';
import { serializeError } from './lib/serialize-error';
import { isPreviewOrigin } from '@/server/preview-origin';

/** Largest avatar accepted: 5 MiB. The cropper emits a small canvas PNG. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export interface AvatarUploadEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  /** Project URL for JWKS verification only (the public project URL). */
  SUPABASE_URL: string;
  /** Public CDN base the returned avatar_url is built on, e.g. https://cdn.srtd.io. */
  AVATAR_PUBLIC_BASE: string;
  /** Pre-provisioned public R2 bucket name, e.g. user-avatars. */
  AVATAR_BUCKET: string;
  /**
   * Public (publishable) Supabase key, sent as `apikey` when the worker reads the
   * caller's profile as the caller on the cleanup route. Not a secret; synced by
   * avatar-upload-deploy from VITE_SUPABASE_PUBLISHABLE_KEY. When unset, the
   * request's own `apikey` header is used; with neither, the old avatar is left
   * in place.
   */
  SUPABASE_PUBLISHABLE_KEY?: string;
  /**
   * Comma-separated list of browser origins allowed to call this Worker
   * cross-origin. Operator sets it as a Worker var; when unset the code falls
   * back to {@link DEFAULT_ALLOWED_ORIGINS}.
   */
  ALLOWED_ORIGINS?: string;
}

/**
 * Known site origin (the production domain srtd.io) used when ALLOWED_ORIGINS is
 * unset. The sole entry is treated as the primary origin. Mirrors asset-upload so
 * the workers' CORS surface cannot drift.
 */
const DEFAULT_ALLOWED_ORIGINS = ['https://srtd.io'] as const;

/** Preflight cache lifetime: 24 hours. */
const CORS_MAX_AGE_SECONDS = 86_400;

/** Every code the worker can return, including the auth/transport layer. */
type AvatarResponseCode =
  | 'missing_file'
  | 'empty_file'
  | 'too_large'
  | 'unsupported_format'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_target'
  | 'invalid_body'
  | 'method_not_allowed'
  | 'internal_error';

const STATUS_BY_CODE: Record<AvatarResponseCode, number> = {
  missing_file: 400,
  empty_file: 400,
  too_large: 413,
  unsupported_format: 415,
  unauthorized: 401,
  forbidden: 403,
  invalid_target: 400,
  invalid_body: 400,
  method_not_allowed: 405,
  internal_error: 500,
};

/**
 * The injected dependencies the handler needs. The default export builds the
 * real ones from env; tests pass fakes so they never touch R2 or the network.
 */
export interface AvatarUploadDeps {
  /** Stores the avatar bytes; deletes a replaced one on the cleanup route. */
  storage: Pick<StorageClient, 'putObject'> & Pick<MultipartStorage, 'deleteObject'>;
  /** The caller's own profile, read AS the caller (cleanup route only). */
  profile: ProfileAvatarStore;
  /** Verifies the Bearer token and returns the caller's `sub`, or an error. */
  verifyToken: (request: Request) => Promise<Result<string, ReadError>>;
  /**
   * Whether the verified caller may set this group's photo (creator, or an
   * active workspace owner/admin). Runs as the caller, never as service role.
   */
  canManageGroup: (request: Request, groupId: string, userId: string) => Promise<boolean>;
}

/** The caller's saved profile fields the avatar replacement needs. */
export interface SavedProfile {
  displayName: string;
  avatarUrl: string | null;
}

/** Reads the caller's own profile row, always as the caller. Never writes. */
export interface ProfileAvatarStore {
  /** The caller's saved profile, or null when it cannot be read. */
  read(request: Request, userId: string): Promise<SavedProfile | null>;
}

/** A stored user avatar key: `<user id>/<sha256>.png`, nothing else. */
const USER_AVATAR_KEY_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{64}\.png$/;

/**
 * The R2 key behind a saved avatar_url, or null unless the URL sits on this
 * worker's public base AND names an object under this user's own prefix. A
 * URL anywhere else (another host, a group photo, another user's folder, a path
 * with extra segments) yields null, so it is never deleted. Pure.
 */
export function ownAvatarKey(
  avatarUrl: string | null,
  publicBase: string,
  userId: string,
): string | null {
  if (avatarUrl === null || avatarUrl === '') return null;
  const prefix = `${publicBase.replace(/\/+$/, '')}/`;
  if (!avatarUrl.startsWith(prefix)) return null;
  const key = avatarUrl.slice(prefix.length);
  const match = USER_AVATAR_KEY_RE.exec(key);
  if (match === null || match[1] !== userId.toLowerCase()) return null;
  return key;
}

/** The `apikey` for a call made as the caller: the configured key, else the request's. */
function callerApiKey(
  request: Request,
  env: Pick<AvatarUploadEnv, 'SUPABASE_PUBLISHABLE_KEY'>,
): string | null {
  const configured = env.SUPABASE_PUBLISHABLE_KEY ?? '';
  if (configured !== '') return configured;
  const sent = request.headers.get('apikey') ?? '';
  return sent === '' ? null : sent;
}

/**
 * The profile store over PostgREST AS the caller: their Bearer JWT is forwarded,
 * so the read is RLS-scoped. Any failed or malformed response reads as null
 * (nothing gets deleted).
 */
export function createCallerProfileStore(
  env: Pick<AvatarUploadEnv, 'SUPABASE_URL' | 'SUPABASE_PUBLISHABLE_KEY'>,
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
): ProfileAvatarStore {
  const base = `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`;
  const headersFor = (request: Request): Record<string, string> | null => {
    const authorization = request.headers.get('Authorization');
    const apikey = callerApiKey(request, env);
    if (authorization === null || apikey === null) return null;
    return { Authorization: authorization, apikey, Accept: 'application/json' };
  };
  return {
    async read(request, userId) {
      const headers = headersFor(request);
      if (headers === null) return null;
      const res = await fetcher(
        `${base}/users?select=display_name,avatar_url&id=eq.${userId}&limit=1`,
        { method: 'GET', headers },
      );
      if (!res.ok) return null;
      const body: unknown = await res.json().catch(() => null);
      const row: unknown = Array.isArray(body) ? (body as unknown[])[0] : undefined;
      if (typeof row !== 'object' || row === null) return null;
      const { display_name: displayName, avatar_url: avatarUrl } = row as Record<string, unknown>;
      if (typeof displayName !== 'string') return null;
      return { displayName, avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null };
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles that may manage any group in their workspace, mirroring group_avatar_set. */
const GROUP_MANAGER_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/**
 * group_avatar_set's rule, read through PostgREST AS the caller: their Bearer
 * JWT and the public apikey header are forwarded from the inbound request, so
 * the reads are RLS-scoped to auth.uid(). Returns false on any failed, empty or
 * malformed read (fail closed). Only the verified `userId` is compared.
 */
export async function canManageGroupAsCaller(
  request: Request,
  groupId: string,
  userId: string,
  env: Pick<AvatarUploadEnv, 'SUPABASE_URL'>,
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
): Promise<boolean> {
  const authorization = request.headers.get('Authorization');
  const apikey = request.headers.get('apikey');
  if (authorization === null || apikey === null || apikey === '') return false;
  const headers = { Authorization: authorization, apikey, Accept: 'application/json' };
  const base = `${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1`;

  const readRows = async (url: string): Promise<Record<string, unknown>[] | null> => {
    const res = await fetcher(url, { method: 'GET', headers });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    return Array.isArray(body) ? (body as Record<string, unknown>[]) : null;
  };

  const groups = await readRows(
    `${base}/groups?select=workspace_id,created_by&id=eq.${groupId}&deleted_at=is.null`,
  );
  const group = groups?.[0];
  if (group === undefined || typeof group.workspace_id !== 'string') return false;
  if (group.created_by === userId) return true;

  const members = await readRows(
    `${base}/workspace_members?select=role&workspace_id=eq.${group.workspace_id}` +
      `&user_id=eq.${userId}&active=eq.true`,
  );
  return (members ?? []).some(
    (row) => typeof row.role === 'string' && GROUP_MANAGER_ROLES.has(row.role),
  );
}

/** The configured allowlist, falling back to the known site origins. */
function allowedOrigins(env: AvatarUploadEnv): readonly string[] {
  const list = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  return list.length > 0 ? list : DEFAULT_ALLOWED_ORIGINS;
}

/**
 * The Access-Control-Allow-Origin value to echo back, or null when the request
 * carries no Origin or an origin outside the allowlist. Never `*`: requests carry
 * Authorization, so the origin is reflected only when explicitly allowed.
 */
function resolveAllowedOrigin(request: Request, env: AvatarUploadEnv): string | null {
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
function preflightResponse(request: Request, env: AvatarUploadEnv): Response {
  const acao =
    resolveAllowedOrigin(request, env) ?? allowedOrigins(env)[0] ?? DEFAULT_ALLOWED_ORIGINS[0];
  const headers = new Headers({
    'Access-Control-Allow-Origin': acao,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': `authorization, content-type, apikey, ${TRACE_ID_HEADER.toLowerCase()}`,
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

function fail(
  code: AvatarResponseCode,
  message: string,
  traceId: string,
  acao: string | null,
): Response {
  return json(STATUS_BY_CODE[code], { error: { code, message } }, traceId, acao);
}

/** Join the CDN base and key with exactly one slash so the path equals the key. */
function publicUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key}`;
}

/**
 * Verify the caller, validate the image, store it, and return its public URL.
 * Validation order is fixed: presence, then size (empty before too-large), then a
 * magic-byte PNG check. The R2 key derives from the verified token's `sub`, so a
 * caller can only ever write their own avatar; the request body never supplies an
 * id.
 */
export async function handleAvatarUpload(
  request: Request,
  env: AvatarUploadEnv,
  deps: AvatarUploadDeps,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await deps.verifyToken(request);
  if (!caller.ok) {
    return fail('unauthorized', caller.error.message, traceId, acao);
  }
  const userId = caller.value;

  // Idempotency-Key is accepted but needs no dedicated storage: the R2 key is the
  // content hash, so a retry of identical bytes overwrites the same object and is
  // inherently idempotent. We surface the key in logs only. Mirrors asset-upload.
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (idempotencyKey !== null && idempotencyKey !== '') {
    logger.info('avatar upload carries idempotency key', { idempotency_key: idempotencyKey });
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return fail('missing_file', 'Missing file part.', traceId, acao);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) {
    return fail('empty_file', 'File is empty.', traceId, acao);
  }
  if (bytes.length > MAX_AVATAR_BYTES) {
    return fail('too_large', 'File exceeds the 5 MiB avatar limit.', traceId, acao);
  }
  // PNG only. The magic-byte check is the gate: SVG and every other type fail it,
  // so a renamed file cannot ride in under image/png.
  if (!verifyMagicBytes(bytes, 'image/png')) {
    return fail('unsupported_format', 'Avatar must be a PNG image.', traceId, acao);
  }

  // Target: the caller's own avatar (default, unchanged), or a group's photo.
  const targetKind = form.get('target_kind');
  let folder = userId;
  if (targetKind !== null && targetKind !== 'user') {
    const targetId = form.get('target_id');
    if (targetKind !== 'group' || typeof targetId !== 'string' || !UUID_RE.test(targetId)) {
      return fail('invalid_target', 'Unknown upload target.', traceId, acao);
    }
    if (!(await deps.canManageGroup(request, targetId, userId))) {
      return fail('forbidden', "You can't change this group's photo.", traceId, acao);
    }
    folder = `groups/${targetId.toLowerCase()}`;
  }

  const sha256 = await computeSha256(bytes);
  // Hash in the key busts CDN caches when the photo changes; the userId (or
  // groups/<group id>) folder isolates each owner. The URL path must equal this
  // key exactly.
  const key = `${folder}/${sha256}.png`;
  await deps.storage.putObject({
    bucket: env.AVATAR_BUCKET,
    key,
    body: bytes,
    contentType: 'image/png',
    traceId,
  });
  const avatarUrl = publicUrl(env.AVATAR_PUBLIC_BASE, key);
  return json(200, { avatar_url: avatarUrl }, traceId, acao);
}

/** The caller's saved profile, or null on any failure (logged, never thrown). */
async function readProfile(
  request: Request,
  userId: string,
  deps: AvatarUploadDeps,
  traceId: string,
): Promise<SavedProfile | null> {
  try {
    return await deps.profile.read(request, userId);
  } catch (error) {
    logger.warn('avatar profile read failed', { trace_id: traceId, error: serializeError(error) });
    return null;
  }
}

/** The `old_url` from a JSON body, or null when the body is not { old_url: string }. */
async function readOldUrl(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const oldUrl = (body as { old_url?: unknown }).old_url;
  return typeof oldUrl === 'string' && oldUrl !== '' ? oldUrl : null;
}

/**
 * Delete the caller's replaced avatar once their profile no longer references
 * it. Called by the frontend only after a successful user_profile_update.
 * Answers 200 { deleted } for every authorised, well-formed call: anything
 * that is not provably this caller's own, now-unreferenced object is kept.
 */
export async function handleAvatarCleanup(
  request: Request,
  env: AvatarUploadEnv,
  deps: AvatarUploadDeps,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await deps.verifyToken(request);
  if (!caller.ok) {
    return fail('unauthorized', caller.error.message, traceId, acao);
  }
  const userId = caller.value;

  const oldUrl = await readOldUrl(request);
  if (oldUrl === null) {
    return fail('invalid_body', 'Body must be JSON { old_url }.', traceId, acao);
  }

  const kept = (): Response => json(200, { deleted: false }, traceId, acao);

  // Only this caller's own `<sub>/<sha256>.png` on the public base; never another
  // user's, never a group photo, never a foreign host or a path trick.
  const oldKey = ownAvatarKey(oldUrl, env.AVATAR_PUBLIC_BASE, userId);
  if (oldKey === null) return kept();

  const current = await readProfile(request, userId, deps, traceId);
  if (current === null) {
    logger.warn('avatar cleanup skipped: profile unreadable', { trace_id: traceId });
    return kept();
  }
  if (current.avatarUrl === oldUrl) return kept();

  try {
    await deps.storage.deleteObject(env.AVATAR_BUCKET, oldKey, traceId);
  } catch (error) {
    logger.warn('previous avatar delete failed', {
      trace_id: traceId,
      key: oldKey,
      error: serializeError(error),
    });
    return kept();
  }
  logger.info('previous avatar deleted', { trace_id: traceId, key: oldKey });
  return json(200, { deleted: true }, traceId, acao);
}

/** Whether the request targets the cleanup route (also under a path prefix). */
function isCleanupPath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname.replace(/\/+$/, '').endsWith('/avatar/cleanup');
}

function buildDeps(env: AvatarUploadEnv, traceId: string): AvatarUploadDeps {
  return {
    storage: new R2StorageClient(
      {
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_R2_ACCESS_KEY_ID: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
      tracedFetch,
    ),
    verifyToken: (request) => verifyCaller(request, getSupabaseJwks(env)),
    profile: createCallerProfileStore(env, (input, init) => tracedFetch(input, init, traceId)),
    canManageGroup: (request, groupId, userId) =>
      canManageGroupAsCaller(request, groupId, userId, env, (input, init) =>
        tracedFetch(input, init, extractTraceId(request)),
      ),
  };
}

export default {
  async fetch(request: Request, env: AvatarUploadEnv): Promise<Response> {
    const traceId = extractTraceId(request);
    logger.setTraceId(traceId);
    const acao = resolveAllowedOrigin(request, env);
    try {
      if (request.method === 'OPTIONS') {
        return preflightResponse(request, env);
      }
      if (request.method === 'POST') {
        const deps = buildDeps(env, traceId);
        return isCleanupPath(request)
          ? await handleAvatarCleanup(request, env, deps, traceId, acao)
          : await handleAvatarUpload(request, env, deps, traceId, acao);
      }
      return fail('method_not_allowed', 'Use POST.', traceId, acao);
    } catch (error) {
      logger.error(`avatar request failed: ${serializeError(error)}`);
      return fail('internal_error', 'Request failed.', traceId, acao);
    } finally {
      logger.clearTraceId();
    }
  },
};
