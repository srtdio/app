// Cloudflare Worker: avatar upload.
//
// POST multipart/form-data { file }
//   -> verifies the caller's Bearer token, validates the image, stores it in the
//      public R2 bucket, and returns a stable public CDN URL:
//      { avatar_url }.
//
// This worker is deliberately SIMPLER than asset-upload: an avatar belongs to a
// PERSON, not a workspace. So there is NO workspace_id, NO membership check, NO
// database access, and NO service-role key. The worker only proves who the
// caller is (verified token `sub`), validates the bytes, PUTs them, and returns
// the URL. The acting user id comes from the verified token's `sub` claim only,
// never from the request body, so a caller can only ever write their own avatar.
// The frontend later takes avatar_url and calls user_profile_update; this worker
// never touches the users table.
//
// No EXIF strip or virus scan: input is PNG-only (magic-byte checked), size
// capped at 5 MiB, and self-produced by the in-app cropper's canvas.toBlob, so
// there is no untrusted container to sanitize. SVG is rejected outright (it can
// carry script); only a real PNG is accepted.

import {
  R2StorageClient,
  computeSha256,
  verifyMagicBytes,
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
export type AvatarResponseCode =
  | 'missing_file'
  | 'empty_file'
  | 'too_large'
  | 'unsupported_format'
  | 'unauthorized'
  | 'method_not_allowed'
  | 'internal_error';

const STATUS_BY_CODE: Record<AvatarResponseCode, number> = {
  missing_file: 400,
  empty_file: 400,
  too_large: 413,
  unsupported_format: 415,
  unauthorized: 401,
  method_not_allowed: 405,
  internal_error: 500,
};

/**
 * The injected dependencies the handler needs. The default export builds the
 * real ones from env; tests pass fakes so they never touch R2 or the network.
 */
export interface AvatarUploadDeps {
  /** Stores the avatar bytes. Only putObject is used. */
  storage: Pick<StorageClient, 'putObject'>;
  /** Verifies the Bearer token and returns the caller's `sub`, or an error. */
  verifyToken: (request: Request) => Promise<Result<string, ReadError>>;
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
function preflightResponse(request: Request, env: AvatarUploadEnv): Response {
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

function fail(
  code: AvatarResponseCode,
  message: string,
  traceId: string,
  acao: string | null,
): Response {
  return json(STATUS_BY_CODE[code], { error: { code, message } }, traceId, acao);
}

/** Render any thrown value into a stable log string. Never returned to the client. */
function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  return String(error);
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

  const sha256 = await computeSha256(bytes);
  // Hash in the key busts CDN caches when the photo changes; the userId folder
  // isolates each person. The URL path must equal this key exactly.
  const key = `${userId}/${sha256}.png`;
  await deps.storage.putObject({
    bucket: env.AVATAR_BUCKET,
    key,
    body: bytes,
    contentType: 'image/png',
    traceId,
  });

  return json(200, { avatar_url: publicUrl(env.AVATAR_PUBLIC_BASE, key) }, traceId, acao);
}

function buildDeps(env: AvatarUploadEnv): AvatarUploadDeps {
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
        return await handleAvatarUpload(request, env, buildDeps(env), traceId, acao);
      }
      return fail('method_not_allowed', 'Use POST.', traceId, acao);
    } catch (error) {
      logger.error(`avatar upload failed: ${serializeError(error)}`);
      return fail('internal_error', 'Upload failed.', traceId, acao);
    } finally {
      logger.clearTraceId();
    }
  },
};
