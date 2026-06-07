// Supabase Edge Function: POST /invite-accept
//
// Authenticated entry point for accepting an invite. The fingerprint middleware
// (PR 7, @srtdio/auth) verifies the bearer access token and binds the device
// fingerprint; acceptInvite (PR 8, @srtdio/workspace) wraps member_accept and is
// idempotent on the invite token, so a double submit resolves ok. trace_id is
// read from X-Trace-Id and threaded to the RPC.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { fingerprintMiddleware } from '@srtdio/auth';
import { acceptInvite } from '@srtdio/workspace';

const TRACE_ID_HEADER = 'X-Trace-Id';

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  const guard = await fingerprintMiddleware(req);
  if (!guard.ok) return guard.response;

  const traceId = req.headers.get(TRACE_ID_HEADER) ?? crypto.randomUUID();

  let body: { inviteId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_payload', trace_id: traceId }, { status: 400 });
  }
  if (!body.inviteId) {
    return Response.json({ error: 'invalid_payload', trace_id: traceId }, { status: 400 });
  }

  const url = requireEnv('SUPABASE_URL');
  const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;
  const auth = createClient(url, requireEnv('SUPABASE_ANON_KEY'), {
    ...noPersist,
    global: { headers: { Authorization: `Bearer ${guard.accessToken}` } },
  });
  const service = createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), noPersist);

  const result = await acceptInvite({ auth, service }, { inviteId: body.inviteId, traceId });

  if (!result.ok) {
    const status = result.error.code === 'forbidden_role' ? 403 : 400;
    return Response.json({ error: result.error.code, trace_id: traceId }, { status });
  }
  return Response.json({ ...result.data, trace_id: traceId }, { status: 200 });
});
