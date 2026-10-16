// catchup-unsubscribe request handling, kept apart from the Deno.serve entry
// (index.ts) so it unit-tests under Node with an injected env reader + client
// factory. Self-contained: NO @srtdio/* imports (the Deno edge bundler rejects
// the packages' extensionless relative imports), so the token verify below is a
// copy of packages/inbox/src/unsubscribe-token.ts; both suites assert the same
// UNSUBSCRIBE_TEST_VECTOR.
//
// API (contract: packages/inbox/src/catchup-contracts.ts):
//   GET  ?u&t                                   -> 200 {subscribed} | 404. Never writes.
//   POST ?u&t, form body List-Unsubscribe=One-Click (RFC 8058), urlencoded or
//        multipart/form-data                    -> 200 empty | 404.
//   POST JSON {u, t, action}                    -> 200 {subscribed} | 404.
// Malformed body or unknown content type -> 400 empty. Errors carry no detail.
//
// The only write is users.email_opt_in for the one user the token was signed
// for, with this function's own service-role client. The signed token is the
// auth boundary (verify_jwt is off: mail clients POST without a session).

import type { createClient } from '@supabase/supabase-js';

const TRACE_ID_HEADER = 'X-Trace-Id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ONE_CLICK_KEY = 'List-Unsubscribe';
const ONE_CLICK_VALUE = 'One-Click';

/** What the handler needs from the runtime; index.ts passes the edge runtime's. */
export interface CatchupUnsubscribeDeps {
  env: (name: string) => string | undefined;
  createClient: typeof createClient;
}

type JsonAction = 'unsubscribe' | 'resubscribe';

// Time-ordered UUID v7, generated inline (no dependency).
function uuidv7(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- token verify (copy of packages/inbox/src/unsubscribe-token.ts) ---------

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signToken(userId: string, secret: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(userId));
  return toBase64Url(new Uint8Array(signature));
}

/** Constant-time string compare: walks the full length, never exits early. */
function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** True only for a token signed for this user id. Never throws. */
export async function verifyToken(
  userId: string | null,
  token: string | null,
  secret: string,
): Promise<boolean> {
  if (!userId || !token || !secret) return false;
  try {
    return timingSafeEqual(await signToken(userId, secret), token);
  } catch {
    return false;
  }
}

// --- responses --------------------------------------------------------------

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, apikey, x-client-info, content-type, x-trace-id',
    'Access-Control-Expose-Headers': TRACE_ID_HEADER,
    'Access-Control-Max-Age': '86400',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin.replace(/\/$/, '');
  return headers;
}

function baseHeaders(origin: string | null, traceId: string): Record<string, string> {
  return { [TRACE_ID_HEADER]: traceId, 'Cache-Control': 'no-store', ...corsHeaders(origin) };
}

function empty(status: number, origin: string | null, traceId: string): Response {
  return new Response(null, { status, headers: baseHeaders(origin, traceId) });
}

function status(subscribed: boolean, origin: string | null, traceId: string): Response {
  return new Response(JSON.stringify({ subscribed }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...baseHeaders(origin, traceId) },
  });
}

// --- body parsing -----------------------------------------------------------

function mediaType(req: Request): string {
  return (req.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** RFC 8058: the form holds exactly one field, List-Unsubscribe=One-Click. */
function isOneClickEntries(entries: Array<[string, unknown]>): boolean {
  return (
    entries.length === 1 && entries[0]?.[0] === ONE_CLICK_KEY && entries[0]?.[1] === ONE_CLICK_VALUE
  );
}

/**
 * Reads an RFC 8058 one-click body, urlencoded or multipart/form-data. Returns
 * null when the content type is neither, else whether the body is valid.
 */
async function readOneClickBody(req: Request, type: string): Promise<boolean | null> {
  if (type === 'application/x-www-form-urlencoded') {
    try {
      return isOneClickEntries(Array.from(new URLSearchParams(await req.text()).entries()));
    } catch {
      return false;
    }
  }
  if (type === 'multipart/form-data') {
    try {
      const entries: Array<[string, unknown]> = [];
      (await req.formData()).forEach((value, key) => {
        entries.push([key, value]);
      });
      return isOneClickEntries(entries);
    } catch {
      return false;
    }
  }
  return null;
}

function parseJsonRequest(value: unknown): { u: string; t: string; action: JsonAction } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { u, t, action } = record;
  // Empty strings are well-formed: verifyToken rejects them as a bad token (404).
  if (typeof u !== 'string' || typeof t !== 'string') return null;
  if (action !== 'unsubscribe' && action !== 'resubscribe') return null;
  return { u, t, action };
}

// --- handler ----------------------------------------------------------------

export async function handleCatchupUnsubscribe(
  req: Request,
  deps: CatchupUnsubscribeDeps,
): Promise<Response> {
  // Echo an inbound trace id only when it is a well-formed uuid; else mint one.
  const inboundTraceId = req.headers.get(TRACE_ID_HEADER);
  const traceId = inboundTraceId && UUID_PATTERN.test(inboundTraceId) ? inboundTraceId : uuidv7();
  // Reflect the caller's Origin (the unsubscribe page on the app); the signed
  // token is the boundary, not CORS. Fall back to APP_BASE_URL.
  const origin = req.headers.get('Origin') ?? deps.env('APP_BASE_URL') ?? null;

  if (req.method === 'OPTIONS') return empty(204, origin, traceId);
  if (req.method !== 'GET' && req.method !== 'POST') return empty(405, origin, traceId);

  try {
    const requireEnv = (name: string): string => {
      const value = deps.env(name);
      if (!value) throw new Error(`missing required env ${name}`);
      return value;
    };
    const secret = requireEnv('UNSUBSCRIBE_SIGNING_SECRET');
    const admin = () =>
      deps.createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    const query = new URL(req.url).searchParams;

    if (req.method === 'GET') {
      const userId = query.get('u');
      if (!(await verifyToken(userId, query.get('t'), secret)) || !userId) {
        return empty(404, origin, traceId);
      }
      const row = await admin().from('users').select('email_opt_in').eq('id', userId).maybeSingle();
      if (row.error) throw new Error(row.error.message);
      if (!row.data) return empty(404, origin, traceId);
      return status(Boolean(row.data.email_opt_in), origin, traceId);
    }

    const type = mediaType(req);

    const oneClick = await readOneClickBody(req, type);
    if (oneClick !== null) {
      if (!oneClick) return empty(400, origin, traceId);
      const userId = query.get('u');
      if (!(await verifyToken(userId, query.get('t'), secret)) || !userId) {
        return empty(404, origin, traceId);
      }
      const updated = await admin().from('users').update({ email_opt_in: false }).eq('id', userId);
      if (updated.error) throw new Error(updated.error.message);
      return empty(200, origin, traceId);
    }

    if (type === 'application/json') {
      let body: { u: string; t: string; action: JsonAction } | null;
      try {
        body = parseJsonRequest(await req.json());
      } catch {
        body = null;
      }
      if (!body) return empty(400, origin, traceId);
      if (!(await verifyToken(body.u, body.t, secret))) return empty(404, origin, traceId);
      const updated = await admin()
        .from('users')
        .update({ email_opt_in: body.action === 'resubscribe' })
        .eq('id', body.u)
        .select('email_opt_in')
        .maybeSingle();
      if (updated.error) throw new Error(updated.error.message);
      if (!updated.data) return empty(404, origin, traceId);
      return status(Boolean(updated.data.email_opt_in), origin, traceId);
    }

    return empty(400, origin, traceId);
  } catch (err) {
    console.error(traceId, err instanceof Error ? err.message : String(err));
    return empty(500, origin, traceId);
  }
}
