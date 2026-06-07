// Supabase Edge Function: POST /invite-send
//
// Authenticated entry point for inviting a member. The fingerprint middleware
// (PR 7, @srtdio/auth) verifies the bearer access token and binds the device
// fingerprint before any work runs. member_invite requires the invitee to exist
// in auth.users (it never creates them), so this function resolves that first:
//
//   1. Lower-case the email and probe auth.users via auth.admin.generateLink.
//   2. New invitee  -> type=invite link is minted (and the auth.users row with
//      it); embed that action_link in the email.
//   3. Existing user -> reuse a workspace deep-link instead of a magic link.
//   4. inviteMember (PR 8, @srtdio/workspace) then runs member_invite, sends the
//      branded Resend email, and records the send in delivery_attempts.
//
// trace_id is read from X-Trace-Id and threaded to the RPC. Secrets come from the
// function environment, never the client.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { fingerprintMiddleware } from '@srtdio/auth';
import { createResendSender, inviteMember, type MemberRole } from '@srtdio/workspace';

const TRACE_ID_HEADER = 'X-Trace-Id';
const ROLES: readonly MemberRole[] = ['admin', 'agency', 'client'];

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

// Resolve the link to embed in the invite email and guarantee the invitee has an
// auth.users row before member_invite runs. generateLink type=invite both mints
// the user (if absent) and returns the action link; an already-registered email
// surfaces as an error, in which case we fall back to a workspace deep-link.
async function resolveInviteLink(
  service: SupabaseClient,
  email: string,
  appBaseUrl: string,
  workspaceId: string,
): Promise<string> {
  const { data, error } = await service.auth.admin.generateLink({ type: 'invite', email });
  if (!error && data?.properties?.action_link) {
    return data.properties.action_link;
  }
  // Existing user (or invite already issued): deep-link into the workspace.
  return `${appBaseUrl}/w/${workspaceId}`;
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
  const { workspaceId, role } = body;
  const email = body.email?.trim().toLowerCase();
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
  // Service-role client: mints the invite link and records the send.
  const service = createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), noPersist);

  const inviteLink = await resolveInviteLink(
    service,
    email,
    requireEnv('APP_BASE_URL'),
    workspaceId,
  );

  const result = await inviteMember(
    {
      auth,
      service,
      sender: createResendSender({ apiKey: requireEnv('RESEND_API_KEY') }),
      fromAddress: requireEnv('INVITE_FROM_ADDRESS'),
    },
    { workspaceId, email, role: role as MemberRole, traceId, inviteLink },
  );

  if (!result.ok) {
    const status = result.error.code === 'forbidden_role' ? 403 : 400;
    return Response.json({ error: result.error.code, trace_id: traceId }, { status });
  }
  return Response.json({ ...result.data, trace_id: traceId }, { status: 200 });
});
