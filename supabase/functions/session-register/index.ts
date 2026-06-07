// Edge function: register the calling device's long-lived session.
//
// POST only. The caller's JWT (Authorization: Bearer) resolves auth.uid()
// server-side - the user id is never read from the request body. Device
// identity comes from X-Device-Fingerprint; we coarsen the request IP to a /24
// or /48 and capture the user agent, then idempotently upsert a session_devices
// row through the service role (the table grants no authenticated INSERT).
//
// Responses: 204 on success, 400 on a malformed fingerprint, 401 without a
// verifiable identity, 405 for non-POST, 500 on misconfiguration. Every response
// echoes X-Trace-Id, generated at entry when the caller did not supply one.

import { createClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { HttpError } from '../../../packages/auth/src/errors.ts';
import { FINGERPRINT_HEADER } from '../../../packages/auth/src/fingerprint.ts';
import { ipSubnet } from '../../../packages/auth/src/ip.ts';
import { registerSession } from '../../../packages/auth/src/register.ts';

const TRACE_HEADER = 'X-Trace-Id';

/** First hop the request was seen from, preferring proxy-set client headers. */
function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Real-IP');
}

function jsonError(message: string, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  const traceId = request.headers.get(TRACE_HEADER) ?? crypto.randomUUID();
  const baseHeaders: Record<string, string> = { [TRACE_HEADER]: traceId };

  if (request.method !== 'POST') {
    return jsonError('Method not allowed.', 405, baseHeaders);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonError('Server is misconfigured.', 500, baseHeaders);
  }

  const authHeader = request.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return jsonError('Missing bearer token.', 401, baseHeaders);
  }

  // Resolve auth.uid() from the verified JWT via a user-scoped client.
  const userClient = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(jwt);
  if (userError || !userData.user) {
    return jsonError('Invalid or expired token.', 401, baseHeaders);
  }

  const admin = createClient<Database>(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    await registerSession(admin, {
      userId: userData.user.id,
      fingerprintHash: request.headers.get(FINGERPRINT_HEADER) ?? '',
      userAgent: request.headers.get('User-Agent'),
      ipSubnet: ipSubnet(clientIp(request)),
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonError(error.message, error.status, baseHeaders);
    }
    return jsonError('Could not register session.', 500, baseHeaders);
  }

  return new Response(null, { status: 204, headers: baseHeaders });
});
