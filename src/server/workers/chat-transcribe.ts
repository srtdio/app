// Cloudflare Worker: voice-note transcription.
//
// POST { "url": "<presigned R2 GET url>" } (content type application/json)
//   -> verifies the caller's Supabase session JWT, fetches the audio itself from
//      the presigned R2 URL, runs the bytes through Workers AI Whisper, and
//      returns the transcript: { ok: true, transcript }.
//
// The worker fetches the audio server-side so the browser never downloads it:
// no R2 CORS rule is needed on any per-workspace bucket. The URL is validated
// before any fetch (SSRF guard): https only, hostname exactly
// `${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` (the host R2StorageClient
// signs for), no userinfo, no explicit port. Redirects are never followed. The
// presigned URL carries a signature, so it is never logged in full: host + path.
//
// Called only when a reader taps "Transcribe" on a voice note; the transcript
// stays on that reader's device. No database, no R2 binding, no service-role
// key, no caching of transcripts, no background work. The only state is a
// per-UTC-day byte counter in KV (TRANSCRIBE_USAGE) that caps Workers AI spend
// at DAILY_CAP_BYTES; when the binding is absent the per-request caps still
// apply and the daily cap is off.
//
// Refusals, in order: 405 non-POST, 401 no valid caller, 415 a non-JSON request,
// 400 a body that is not { url: string }, 400 { ok: false, reason: 'bad_url' }
// for a URL outside the guard or an upstream redirect, 400 an upstream non-2xx,
// 415 a non-audio upstream content type, 413 audio over MAX_AUDIO_BYTES
// (Content-Length first, then the bytes actually read), 400 empty audio,
// 429 { ok: false, reason: 'daily_cap' }.
//
// Auth is reused verbatim from the asset/chat workers: ES256 JWKS verification
// of the Bearer token (getSupabaseJwks + verifyCaller), so this worker cannot
// drift from chat-token's verification. The caller is taken only from the
// verified token; no request-supplied identity is trusted, and unauthenticated
// callers are rejected with 401 before the body is read or anything is fetched.
// Expected failures map to 4xx; an AI fault, a fetch timeout, or any unexpected
// error throws and becomes a 500. A non-string Whisper result is treated as a
// fault and throws rather than returning a fabricated transcript.

import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { logger } from '@/server/logger';
import { tracedFetch } from '@/server/traced-fetch';
// Reuse asset-read's verified-token primitives verbatim, exactly as chat-token
// does, so the auth surface cannot drift: same ES256 JWKS verification.
import { getSupabaseJwks, verifyCaller } from './asset-read';
import { serializeError } from './lib/serialize-error';
import { isPreviewOrigin } from '@/server/preview-origin';

/** The Whisper model id. Multilingual; handles mixed Hindi/English voice notes. */
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** Whisper input: the audio is passed as a base64 string of the raw bytes. */
interface WhisperInput {
  audio: string;
}

/** Largest audio accepted: 8 MB. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Audio bytes transcribed per UTC day across all callers: 240 MB (about 150 minutes). */
export const DAILY_CAP_BYTES = 240 * 1024 * 1024;

/** Largest JSON request body accepted; a presigned URL is well under this. */
const MAX_REQUEST_BYTES = 16 * 1024;

/** The upstream audio fetch (headers and body) is aborted after this long. */
export const AUDIO_FETCH_TIMEOUT_MS = 15_000;

/** A day's counter outlives its day by a little, then KV drops it. */
const USAGE_TTL_SECONDS = 2 * 24 * 60 * 60;

/** The slice of a Workers KV namespace the daily counter uses. */
export interface UsageKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
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
  /**
   * Cloudflare account id. The only host the worker fetches audio from is
   * `${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`, the host
   * R2StorageClient presigns for.
   */
  CLOUDFLARE_ACCOUNT_ID: string;
  /** Workers AI binding (declared as [ai] binding = "AI" in wrangler.toml). */
  AI: WorkersAi;
  /** Daily byte counter (declared as [[kv_namespaces]] binding = "TRANSCRIBE_USAGE"). */
  TRANSCRIBE_USAGE?: UsageKv;
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
const DEFAULT_ALLOWED_ORIGINS = ['https://srtd.io', 'https://v2.srtd.io'] as const;

/** Preflight cache lifetime: 24 hours. */
const CORS_MAX_AGE_SECONDS = 86_400;

/** Every code the worker can return. */
type ChatTranscribeResponseCode =
  | 'bad_request'
  | 'unauthorized'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal_error';

const STATUS_BY_CODE: Record<ChatTranscribeResponseCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
};

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

function fail(code: ChatTranscribeResponseCode, traceId: string, acao: string | null): Response {
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

/**
 * Read a body stream, stopping as soon as it passes `max` bytes (a missing or
 * lying Content-Length never buffers more than the cap). Null when too large.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The media type of a content-type header, lowercased, without parameters. */
function mediaType(header: string | null): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The SSRF guard. The URL is accepted only when it parses, is https, carries no
 * userinfo and no explicit port, and its hostname equals the account's R2 host
 * exactly (so an IP literal, a different host, or a host that merely ends with
 * the R2 suffix never matches). Null for anything else.
 */
export function parseAudioUrl(raw: string, accountId: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = `${accountId}.r2.cloudflarestorage.com`.toLowerCase();
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  if (url.hostname !== host) return null;
  return url;
}

/** The request body's `url`, or null when the body is not { url: string }. */
function requestedUrl(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const url = (parsed as { url?: unknown }).url;
  return typeof url === 'string' ? url : null;
}

/** A presigned URL minus its query (the signature): safe to log. */
function loggable(url: URL): string {
  return `${url.host}${url.pathname}`;
}

/** The KV key for a UTC day's byte count: usage:YYYY-MM-DD. */
export function usageKey(now: Date): string {
  return `usage:${now.toISOString().slice(0, 10)}`;
}

/**
 * Count `bytes` against today's cap. False (nothing counted) when they would
 * take the day over DAILY_CAP_BYTES. KV is not transactional, so concurrent
 * calls can overshoot by a request or two; the cap is a spend guard, not a quota.
 */
async function takeDailyBytes(kv: UsageKv, bytes: number, now: Date): Promise<boolean> {
  const key = usageKey(now);
  const used = Number.parseInt((await kv.get(key)) ?? '0', 10);
  const sofar = Number.isFinite(used) && used > 0 ? used : 0;
  if (sofar + bytes > DAILY_CAP_BYTES) return false;
  await kv.put(key, String(sofar + bytes), { expirationTtl: USAGE_TTL_SECONDS });
  return true;
}

async function handlePost(
  request: Request,
  env: ChatTranscribeEnv,
  traceId: string,
  acao: string | null,
): Promise<Response> {
  // Verify the caller first: an unauthenticated request must never trigger a
  // fetch or reach the AI binding. Identity is the verified `sub`, never
  // anything caller-supplied.
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return fail('unauthorized', traceId, acao);
  }

  if (mediaType(request.headers.get('content-type')) !== 'application/json') {
    return fail('unsupported_media_type', traceId, acao);
  }
  const requestBytes = await readCapped(request.body, MAX_REQUEST_BYTES);
  const raw = requestBytes === null ? null : requestedUrl(requestBytes);
  if (raw === null) {
    return fail('bad_request', traceId, acao);
  }
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  if (accountId === '') {
    // Missing config is a fault, not a bad URL: without it no host can match.
    throw new Error('CLOUDFLARE_ACCOUNT_ID is not configured');
  }
  const url = parseAudioUrl(raw, accountId);
  if (url === null) {
    return json(400, { ok: false, reason: 'bad_url' }, traceId, acao);
  }

  // Fetch the audio server-side. Redirects are never followed (a redirect could
  // point anywhere), and the whole fetch, body included, is bounded in time.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIO_FETCH_TIMEOUT_MS);
  let bytes: Uint8Array | null;
  try {
    let upstream: Response;
    try {
      upstream = await tracedFetch(
        url.toString(),
        {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        },
        traceId,
      );
    } catch (error) {
      // Rethrow without the URL: the raw error may echo the signed query.
      const name = error instanceof Error ? error.name : 'Error';
      throw new Error(`audio fetch failed (${name}) for ${loggable(url)}`);
    }
    if (upstream.type === 'opaqueredirect' || (upstream.status >= 300 && upstream.status < 400)) {
      logger.warn(`voice audio fetch redirected for ${loggable(url)}`);
      return json(400, { ok: false, reason: 'bad_url' }, traceId, acao);
    }
    if (!upstream.ok) {
      logger.warn(`voice audio fetch returned ${upstream.status} for ${loggable(url)}`);
      return fail('bad_request', traceId, acao);
    }
    if (!mediaType(upstream.headers.get('content-type')).startsWith('audio/')) {
      return fail('unsupported_media_type', traceId, acao);
    }
    const declared = upstream.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_AUDIO_BYTES) {
      return fail('payload_too_large', traceId, acao);
    }
    bytes = await readCapped(upstream.body, MAX_AUDIO_BYTES);
  } finally {
    clearTimeout(timer);
  }
  if (bytes === null) {
    return fail('payload_too_large', traceId, acao);
  }
  if (bytes.length === 0) {
    return fail('bad_request', traceId, acao);
  }
  if (
    env.TRANSCRIBE_USAGE !== undefined &&
    !(await takeDailyBytes(env.TRANSCRIBE_USAGE, bytes.length, new Date()))
  ) {
    logger.warn('voice transcription daily cap reached');
    return json(429, { ok: false, reason: 'daily_cap' }, traceId, acao);
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
