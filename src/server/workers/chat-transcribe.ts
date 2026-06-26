// Cloudflare Worker: voice-note transcription.
//
// POST <audio bytes> (content type audio/* or application/octet-stream)
//   -> verifies the caller's Supabase session JWT, runs the bytes through
//      Workers AI Whisper, and returns the transcript: { ok: true, transcript }.
//
// Stateless and idempotent: no database, no R2, no service-role key, no caching,
// no background work. The same audio yields the same transcript. There is
// nothing to open or close - the only outbound dependency is env.AI.run, a
// Cloudflare binding with no connection lifecycle to manage.
//
// Auth is reused verbatim from the asset/chat workers: ES256 JWKS verification
// of the Bearer token (getSupabaseJwks + verifyCaller), so this worker cannot
// drift from chat-token's verification. The caller is taken only from the
// verified token; no request-supplied identity is trusted, and unauthenticated
// callers are rejected with 401 before any audio is read. Expected failures
// (missing/invalid token, empty body) map to 4xx; an AI fault or any unexpected
// error throws and becomes a 500. A non-string Whisper result is treated as a
// fault and throws rather than returning a fabricated transcript.

import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { logger } from '@/server/logger';
// Reuse asset-read's verified-token primitives verbatim, exactly as chat-token
// does, so the auth surface cannot drift: same ES256 JWKS verification.
import { getSupabaseJwks, verifyCaller } from './asset-read';

/** The Whisper model id. Multilingual; handles mixed Hindi/English voice notes. */
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** Whisper input: the audio is passed as a base64 string of the raw bytes. */
interface WhisperInput {
  audio: string;
}

/** Whisper output: the transcript text plus model extras we do not consume. */
interface WhisperOutput {
  text: string;
}

/** The Workers AI binding, narrowed to the single model this worker calls. */
interface WorkersAi {
  run(model: typeof WHISPER_MODEL, input: WhisperInput): Promise<WhisperOutput>;
}

export interface ChatTranscribeEnv {
  /** Project URL; the JWKS for ES256 caller verification is published here. */
  SUPABASE_URL: string;
  /** Workers AI binding (declared as [ai] binding = "AI" in wrangler.toml). */
  AI: WorkersAi;
  /**
   * Comma-separated list of browser origins allowed to call this Worker
   * cross-origin. Operator sets it as a Worker var/secret; when unset the code
   * falls back to {@link DEFAULT_ALLOWED_ORIGINS}.
   */
  ALLOWED_ORIGINS?: string;
}

/**
 * Known site origin (the production domain srtd.io) used when ALLOWED_ORIGINS is
 * unset. The sole entry is treated as the primary origin. Mirrors the other
 * workers so the CORS surface cannot drift.
 */
const DEFAULT_ALLOWED_ORIGINS = ['https://srtd.io'] as const;

/** Preflight cache lifetime: 24 hours. */
const CORS_MAX_AGE_SECONDS = 86_400;

/** Every code the worker can return. */
export type ChatTranscribeResponseCode =
  | 'bad_request'
  | 'unauthorized'
  | 'method_not_allowed'
  | 'internal_error';

const STATUS_BY_CODE: Record<ChatTranscribeResponseCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  method_not_allowed: 405,
  internal_error: 500,
};

/**
 * Render any thrown value into a stable log string. Never returned to the
 * client - logging only.
 */
export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  if (typeof error === 'object' && error !== null) {
    return JSON.stringify(error);
  }
  return String(error);
}

/** The configured allowlist, falling back to the known site origins. */
function allowedOrigins(env: ChatTranscribeEnv): readonly string[] {
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
function resolveAllowedOrigin(request: Request, env: ChatTranscribeEnv): string | null {
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
function preflightResponse(request: Request, env: ChatTranscribeEnv): Response {
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
  code: ChatTranscribeResponseCode,
  traceId: string,
  acao: string | null,
): Response {
  return json(STATUS_BY_CODE[code], { ok: false, code }, traceId, acao);
}

/**
 * Base64-encode the raw audio bytes for the Whisper `audio` field. Encodes in
 * fixed chunks so a large note never overflows the argument list of
 * String.fromCharCode. Pure and deterministic - same bytes, same string.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

interface TranscribeResult {
  ok: true;
  transcript: string;
}

async function handlePost(
  request: Request,
  env: ChatTranscribeEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  // Verify the caller first: an unauthenticated request must never reach the
  // AI binding. Identity is the verified `sub`, never anything caller-supplied.
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return fail('unauthorized', traceId, acao);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) {
    return fail('bad_request', traceId, acao);
  }

  const output = await env.AI.run(WHISPER_MODEL, { audio: toBase64(bytes) });
  if (typeof output.text !== 'string') {
    // A malformed model response is a fault, not a transcript: crash to 500
    // rather than return fabricated text.
    throw new Error('Whisper returned no text');
  }

  const result: TranscribeResult = { ok: true, transcript: output.text };
  return json(200, result, traceId, acao);
}

export default {
  async fetch(request: Request, env: ChatTranscribeEnv): Promise<Response> {
    const traceId = extractTraceId(request);
    logger.setTraceId(traceId);
    const acao = resolveAllowedOrigin(request, env);
    try {
      if (request.method === 'OPTIONS') {
        return preflightResponse(request, env);
      }
      if (request.method !== 'POST') {
        return fail('method_not_allowed', traceId, acao);
      }
      return await handlePost(request, env, traceId, acao);
    } catch (error) {
      logger.error(`voice transcription failed: ${serializeError(error)}`);
      return fail('internal_error', traceId, acao);
    } finally {
      logger.clearTraceId();
    }
  },
};
