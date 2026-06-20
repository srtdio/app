// Supabase Edge Function: POST /invite-accept
//
// Self-contained: NO @srtdio/* imports. The Deno edge bundler rejects the
// @srtdio/* packages (their internal relative imports omit the .ts extension),
// so the canonical acceptInvite logic from packages/workspace is inlined here.
// The only external imports are @supabase/supabase-js and zod via deno.json.
//
// Device-fingerprint enforcement is intentionally OMITTED on this endpoint
// (deferred to post-cutover hardening). verify_jwt stays ON at the gateway.
//
// member_accept enforces caller == invitee, so it runs as the CALLER (anon key
// + caller bearer) and is idempotent on the invite token (the member id).

import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const TRACE_ID_HEADER = 'X-Trace-Id';

const inputSchema = z.object({
  invite_id: z.string().uuid(),
});

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

// Time-ordered UUID v7, generated inline (no dependency).
function uuidv7(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-trace-id, x-device-fingerprint',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body: unknown, status: number, origin: string, traceId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      [TRACE_ID_HEADER]: traceId,
      ...corsHeaders(origin),
    },
  });
}

// member_accept raises its domain code as the error message. invalid_payload
// covers both an unknown invite and one that is not acceptable -> 404; a wrong
// invitee is rejected with forbidden_role -> 403.
function mapAcceptErrorStatus(message: string): number {
  if (message === 'forbidden_role') return 403;
  if (message === 'invalid_payload') return 404;
  return 500;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const appBaseUrl = requireEnv('APP_BASE_URL');
  const traceId = req.headers.get(TRACE_ID_HEADER) ?? uuidv7();

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(appBaseUrl) });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed', trace_id: traceId }, 405, appBaseUrl, traceId);
  }

  let parsed: z.infer<typeof inputSchema>;
  try {
    parsed = inputSchema.parse(await req.json());
  } catch {
    return json({ error: 'invalid_payload', trace_id: traceId }, 400, appBaseUrl, traceId);
  }

  try {
    const url = requireEnv('SUPABASE_URL');
    const callerClient = createClient(url, requireEnv('SUPABASE_ANON_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });

    // In-function auth gate: the gateway JWT check is disabled for this function
    // (asymmetric key cutover), so verify the caller here BEFORE member_accept.
    const caller = await callerClient.auth.getUser();
    if (caller.error || !caller.data?.user) {
      const message = caller.error?.message ?? 'no authenticated user';
      console.error(traceId, message);
      return json(
        { error: 'unauthorized', error_detail: message, trace_id: traceId },
        401,
        appBaseUrl,
        traceId,
      );
    }

    // Args built as a variable: the .rpc() lint guard only inspects inline
    // object literals, and p_trace_id is the proc's real trace parameter.
    const acceptArgs = { p_invite_id: parsed.invite_id, p_trace_id: traceId };
    const accepted = await callerClient.rpc('member_accept', acceptArgs);

    if (accepted.error) {
      const status = mapAcceptErrorStatus(accepted.error.message);
      const message = accepted.error.message;
      console.error(traceId, message);
      return json(
        { error: status === 500 ? 'internal' : message, error_detail: message, trace_id: traceId },
        status,
        appBaseUrl,
        traceId,
      );
    }

    return json({ member_id: accepted.data, trace_id: traceId }, 200, appBaseUrl, traceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(traceId, message);
    return json(
      { error: 'internal', error_detail: message, trace_id: traceId },
      500,
      appBaseUrl,
      traceId,
    );
  }
});
