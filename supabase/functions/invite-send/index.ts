// Supabase Edge Function: POST /invite-send
//
// Authenticated entry point for inviting a member. The fingerprint middleware
// (PR 7, @srtdio/auth) verifies the bearer access token and binds the device
// fingerprint before any work runs; inviteMember (PR 8, @srtdio/workspace) wraps
// member_invite and records the Resend send. trace_id is read from the inbound
// X-Trace-Id header and threaded to the RPC as an explicit parameter.
//
// Secrets (RESEND_API_KEY, SUPABASE_SERVICE_ROLE_KEY) come from the function's
// environment, never the client.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { fingerprintMiddleware } from '@srtdio/auth';
import { createResendSender, inviteMember, type MemberRole } from '@srtdio/workspace';

const TRACE_ID_HEADER = 'X-Trace-Id';
const ROLES: readonly MemberRole[] = ['admin', 'agency', 'client'];

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  // PR 7: verifies the JWT, enforces the session_devices fingerprint gate, and
  // returns the verified access token (or a ready-made rejection Response).
  const guard = await fingerprintMiddleware(req);
  if (!guard.ok) return guard.response;

  const traceId = req.headers.get(TRACE_ID_HEADER) ?? crypto.randomUUID();

  let body: { workspaceId?: string; email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_payload', trace_id: traceId }, { status: 400 });
  }
  const { workspaceId, email, role } = body;
  if (!workspaceId || !email || !role || !ROLES.includes(role as MemberRole)) {
    return Response.json({ error: 'invalid_payload', trace_id: traceId }, { status: 400 });
  }

  const url = requireEnv('SUPABASE_URL');
  const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;
  // Authenticated client: member_invite runs as the caller (auth.uid()).
  const auth = createClient(url, requireEnv('SUPABASE_ANON_KEY'), {
    ...noPersist,
    global: { headers: { Authorization: `Bearer ${guard.accessToken}` } },
  });
  // Service-role client: records the send on the tenant email tables.
  const service = createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), noPersist);

  const result = await inviteMember(
    {
      auth,
      service,
      sender: createResendSender({ apiKey: requireEnv('RESEND_API_KEY') }),
      appBaseUrl: requireEnv('APP_BASE_URL'),
      fromAddress: requireEnv('INVITE_FROM_ADDRESS'),
    },
    { workspaceId, email, role: role as MemberRole, traceId },
  );

  if (!result.ok) {
    const status = result.error.code === 'forbidden_role' ? 403 : 400;
    return Response.json({ error: result.error.code, trace_id: traceId }, { status });
  }
  return Response.json({ ...result.data, trace_id: traceId }, { status: 200 });
});
