// Cloudflare Worker: Agora Chat token mint.
//
// POST application/json { workspace_id }
//   -> verifies the caller's Bearer token, confirms they are an active member of
//      workspace_id, ensures the Agora Chat user exists (username derived from the
//      verified token's `sub` via toAgoraUsername, since Agora rejects UUID-shaped
//      names), and returns a freshly minted 24-hour Agora Chat user token:
//      { token, expires_at, agora_username, app_key }.
//
// The Worker is the only holder of the Supabase service-role key and the Agora
// App Certificate; neither is ever shipped to the browser. Caller tokens are
// verified against the project's published asymmetric JWKS (ES256), reusing
// asset-read's primitives so the workers cannot drift. The Agora username is a
// canonical, reversible derivation of the Supabase user id (the verified `sub`),
// never an email or display name - a request-supplied id is never trusted.
// Membership is an explicit service-role read against workspace_members, not an
// RLS side effect.
//
// Token lifetime is fixed at Agora's 24-hour maximum; the frontend renews via
// the SDK's onTokenWillExpire. Revocation is handled by channel ACL removal in a
// later PR, not by token lifetime. Expected failures (missing/invalid token,
// bad workspace_id, non-member) are typed Results mapped to 4xx; system faults
// (Agora REST unreachable, an unexpected register failure) throw and become 500.

import { ChatTokenBuilder } from 'agora-token';
import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';
import { err, ok, type Result } from '@/server/assets/types';
// Reuse asset-read's verified-token + membership primitives verbatim so this
// worker cannot drift from the asset workers: same ES256 JWKS verification, same
// service-role workspace_members read.
import { createSupabaseAssetReadStore, getSupabaseJwks, verifyCaller } from './asset-read';
import { toAgoraUsername } from './agora-identity';

/** Token lifetime: 24 hours, Agora Chat's default and maximum. */
const TOKEN_TTL_SECONDS = 86_400;

export interface ChatTokenEnv {
  /** Agora App ID; pairs with the certificate to sign Chat tokens. */
  AGORA_APP_ID: string;
  /** Agora App Certificate; the signing secret for Chat tokens. Never shipped. */
  AGORA_APP_CERTIFICATE: string;
  /** Agora Chat App Key; the frontend needs it to init the SDK. */
  AGORA_CHAT_APP_KEY: string;
  /** Base URL of the Agora Chat REST API (host + org + app), no trailing /users. */
  AGORA_CHAT_REST_URL: string;
  SUPABASE_URL: string;
  /** Service role: used only for the server-side membership read below. */
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
 * Mirrors the asset workers so the CORS surface cannot drift.
 */
const DEFAULT_ALLOWED_ORIGINS = ['https://srtd.io'] as const;

/** Preflight cache lifetime: 24 hours. */
const CORS_MAX_AGE_SECONDS = 86_400;

/** Every code the worker can return. */
export type ChatTokenResponseCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'method_not_allowed'
  | 'internal_error';

const STATUS_BY_CODE: Record<ChatTokenResponseCode, number> = {
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
 * Render any thrown value into a stable log string. The Agora REST call and
 * PostgREST surface failures as plain objects (not Error instances), so a bare
 * template literal would log '[object Object]' and lose the code/message. Never
 * returned to the client - logging only.
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
function allowedOrigins(env: ChatTokenEnv): readonly string[] {
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
function resolveAllowedOrigin(request: Request, env: ChatTokenEnv): string | null {
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
function preflightResponse(request: Request, env: ChatTokenEnv): Response {
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
  code: ChatTokenResponseCode,
  message: string,
  traceId: string,
  acao: string | null,
): Response {
  return json(STATUS_BY_CODE[code], { error: { code, message } }, traceId, acao);
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
 * Ensure an Agora Chat user exists for `username`. Registration is authenticated
 * with an app token minted from the App ID + App Certificate (no admin password
 * is held here). A 2xx is success; a 400 reporting the user already exists is
 * also success, which makes the call idempotent on repeat mints. Any other
 * non-2xx is a system fault and throws, becoming a 500. The outbound call goes
 * through tracedFetch so it carries X-Trace-Id.
 *
 * The register body needs a password, but these are token-auth users whose
 * password is never used; a fresh random value is sent so none is stored.
 */
async function ensureChatUser(env: ChatTokenEnv, username: string, traceId: string): Promise<void> {
  const appToken = ChatTokenBuilder.buildAppToken(
    env.AGORA_APP_ID,
    env.AGORA_APP_CERTIFICATE,
    TOKEN_TTL_SECONDS,
  );
  const base = env.AGORA_CHAT_REST_URL.replace(/\/+$/, '');
  const response = await tracedFetch(
    `${base}/users`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ username, password: crypto.randomUUID() }),
    },
    traceId,
  );

  if (response.ok) {
    return;
  }

  const text = await response.text();
  // Agora returns 400 duplicate_unique_property_exists when the username is
  // already registered; that is the idempotent success path.
  const lowered = text.toLowerCase();
  if (
    response.status === 400 &&
    (lowered.includes('already exists') || lowered.includes('duplicate_unique_property_exists'))
  ) {
    return;
  }
  throw new Error(`Agora register failed: ${response.status} ${text}`);
}

interface ChatTokenResult {
  token: string;
  expires_at: string;
  agora_username: string;
  app_key: string;
}

async function handlePost(
  request: Request,
  env: ChatTokenEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return fail('unauthorized', caller.error.message, traceId, acao);
  }

  const parsed = await readJsonObject(request);
  if (!parsed.ok) {
    return fail('bad_request', parsed.error, traceId, acao);
  }
  const workspaceId = parsed.value.workspace_id;
  if (typeof workspaceId !== 'string' || !isUuid(workspaceId)) {
    return fail('bad_request', 'Invalid workspace_id.', traceId, acao);
  }

  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('chat token denied: caller not a workspace member', { workspace_id: workspaceId });
    return fail('forbidden', 'Not a member of this workspace.', traceId, acao);
  }

  // Agora rejects UUID-shaped usernames, so the verified Supabase user id (the
  // sub, never an email or display name) is run through toAgoraUsername to a
  // canonical, reversible, non-UUID form. Every place that needs the username -
  // the register body, the user-token subject, and the returned field - uses
  // this single value so they cannot diverge.
  const agoraUsername = toAgoraUsername(caller.value);
  await ensureChatUser(env, agoraUsername, traceId);

  const token = ChatTokenBuilder.buildUserToken(
    env.AGORA_APP_ID,
    env.AGORA_APP_CERTIFICATE,
    agoraUsername,
    TOKEN_TTL_SECONDS,
  );
  const result: ChatTokenResult = {
    token,
    expires_at: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
    agora_username: agoraUsername,
    app_key: env.AGORA_CHAT_APP_KEY,
  };
  return json(200, result, traceId, acao);
}

export default {
  async fetch(request: Request, env: ChatTokenEnv): Promise<Response> {
    const traceId = extractTraceId(request);
    logger.setTraceId(traceId);
    const acao = resolveAllowedOrigin(request, env);
    try {
      if (request.method === 'OPTIONS') {
        return preflightResponse(request, env);
      }
      if (request.method !== 'POST') {
        return fail('method_not_allowed', 'Use POST.', traceId, acao);
      }
      return await handlePost(request, env, traceId, acao);
    } catch (error) {
      logger.error(`chat token mint failed: ${serializeError(error)}`);
      return fail('internal_error', 'Failed to mint chat token.', traceId, acao);
    } finally {
      logger.clearTraceId();
    }
  },
};
