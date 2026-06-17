// Supabase Edge Function: POST /member-invite
//
// One operation: invite a person to a workspace. The function is short-lived and
// stateless: no connection caching, no background work. Each call is independent
// and safe to retry because the membership step is idempotent on the pending
// natural key (workspace_id, user_id) where the row is not yet accepted/removed.
//
// Two clients, and the distinction is load-bearing:
//   - adminClient (service role): auth admin calls + the delivery_attempts log
//     insert only. delivery_attempts is a system log table written from server
//     context, so the direct service-role write is intentional.
//   - callerClient (anon key + forwarded caller bearer): every member_invite RPC
//     and the dedup read. member_invite reads auth.uid(); calling it with the
//     service role would null that out and fail with workspace_member_only.
//
// trace_id is read from X-Trace-Id (or a fresh uuidv7) and echoed on every
// response. Secrets come from the function environment, never the client.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { buildAcceptUrl, mapInviteRpcError, parseInviteInput, uuidv7 } from './lib.ts';

const TRACE_HEADER = 'X-Trace-Id';

class HandledError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Trace-Id',
    Vary: 'Origin',
  };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// Guarantee the invitee has an auth.users row and return its id. type=invite
// provisions the row when the email is new (the users_create_profile_on_signup
// trigger then creates the public.users profile, so we never insert one); an
// already-registered email surfaces as an error, in which case a magiclink
// resolves the existing user id without creating anything.
async function resolveInviteeUserId(
  admin: SupabaseClient,
  email: string,
  redirectTo: string,
): Promise<string> {
  const invited = await admin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo },
  });
  if (!invited.error && invited.data?.user) {
    return invited.data.user.id;
  }
  const existing = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  });
  if (!existing.error && existing.data?.user) {
    return existing.data.user.id;
  }
  throw new HandledError('invalid_payload', 400);
}

// Natural-key idempotency: a pending (active=false, not accepted, not removed)
// membership for this invitee is reused instead of issuing a second invite.
async function findPendingInviteId(
  caller: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await caller
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .eq('active', false)
    .is('accepted_at', null)
    .is('removed_at', null)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new HandledError('internal_error', 500);
  }
  if (data && typeof data.id === 'string') {
    return data.id;
  }
  return null;
}

async function createMembership(
  caller: SupabaseClient,
  workspaceId: string,
  email: string,
  role: string,
  traceId: string,
): Promise<string> {
  // Passed as a named object (not an inline literal) so the value is built once;
  // trace_id is propagated explicitly as p_trace_id, never inferred.
  const params = {
    p_workspace_id: workspaceId,
    p_email: email,
    p_role: role,
    p_trace_id: traceId,
  };
  const { data, error } = await caller.rpc('member_invite', params);
  if (error) {
    const mapped = mapInviteRpcError(error.message ?? '');
    throw new HandledError(mapped.code, mapped.status);
  }
  if (typeof data !== 'string') {
    throw new HandledError('internal_error', 500);
  }
  return data;
}

async function recordDeliveryAttempt(
  admin: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('delivery_attempts')
    .insert({
      channel: 'email',
      template_key: 'member_invite',
      provider: 'resend',
      status: 'queued',
      workspace_id: workspaceId,
      user_id: userId,
      email_thread_id: null,
    })
    .select('id')
    .single();
  if (error || !data || typeof data.id !== 'string') {
    return null;
  }
  return data.id;
}

async function patchDelivery(
  admin: SupabaseClient,
  id: string,
  patch: Record<string, string | null>,
): Promise<void> {
  await admin.from('delivery_attempts').update(patch).eq('id', id);
}

// Send the invite via Resend and stamp the delivery row. Failures degrade the
// row to status='failed' but never fail the invite: the membership already
// exists and the call is safe to retry.
async function sendInviteEmail(
  admin: SupabaseClient,
  deliveryId: string,
  to: string,
  from: string,
  acceptUrl: string,
  apiKey: string,
): Promise<boolean> {
  const subject = 'You have been invited to a Sorted workspace';
  const html =
    `<p>You have been invited to collaborate in Sorted.</p>` +
    `<p><a href="${acceptUrl}">Accept your invite</a></p>` +
    `<p>${acceptUrl}</p>`;
  try {
    // globalThis.fetch (not the bare global) is used deliberately; this function
    // runs in Deno and is outside the src/lib/fetch.ts trace wrapper.
    const response = await globalThis.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!response.ok) {
      const detail = await response.text();
      await patchDelivery(admin, deliveryId, {
        status: 'failed',
        error: `resend ${response.status}: ${detail}`.slice(0, 500),
      });
      return false;
    }
    const payload: unknown = await response.json().catch(() => null);
    let providerMessageId: string | null = null;
    if (payload && typeof payload === 'object' && 'id' in payload) {
      const id = (payload as { id: unknown }).id;
      if (typeof id === 'string') {
        providerMessageId = id;
      }
    }
    await patchDelivery(admin, deliveryId, {
      status: 'sent',
      provider_message_id: providerMessageId,
      sent_at: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    await patchDelivery(admin, deliveryId, {
      status: 'failed',
      error: (error instanceof Error ? error.message : 'send failed').slice(0, 500),
    });
    return false;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const appUrl = Deno.env.get('APP_URL') ?? '';
  const traceId = req.headers.get(TRACE_HEADER) ?? uuidv7();
  const baseHeaders = { ...corsHeaders(appUrl), [TRACE_HEADER]: traceId };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed', trace_id: traceId }, 405, baseHeaders);
  }

  const authorization = req.headers.get('Authorization');
  if (!authorization) {
    return jsonResponse({ error: 'unauthorized', trace_id: traceId }, 401, baseHeaders);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_payload', trace_id: traceId }, 400, baseHeaders);
  }
  const parsed = parseInviteInput(raw);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_payload', trace_id: traceId }, 400, baseHeaders);
  }
  const input = parsed.data;

  try {
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;
    // Service-role client: auth admin + delivery_attempts log only.
    const admin = createClient(supabaseUrl, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), noPersist);
    // Caller client: member_invite + dedup run as the inviter (auth.uid()).
    const caller = createClient(supabaseUrl, requireEnv('SUPABASE_ANON_KEY'), {
      ...noPersist,
      global: { headers: { Authorization: authorization } },
    });

    const acceptRedirect = `${appUrl.replace(/\/+$/, '')}/invite/accept`;
    const inviteeUserId = await resolveInviteeUserId(admin, input.email, acceptRedirect);

    const pendingId = await findPendingInviteId(caller, input.workspace_id, inviteeUserId);
    const inviteId =
      pendingId ??
      (await createMembership(caller, input.workspace_id, input.email, input.role, traceId));

    const acceptUrl = buildAcceptUrl(appUrl, inviteId);

    const deliveryId = await recordDeliveryAttempt(admin, input.workspace_id, inviteeUserId);
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    let emailed = false;
    if (resendApiKey && deliveryId) {
      emailed = await sendInviteEmail(
        admin,
        deliveryId,
        input.email,
        requireEnv('INVITE_FROM_EMAIL'),
        acceptUrl,
        resendApiKey,
      );
    }

    return jsonResponse(
      {
        invite_id: inviteId,
        invited_user_id: inviteeUserId,
        accept_url: acceptUrl,
        emailed,
        trace_id: traceId,
      },
      200,
      baseHeaders,
    );
  } catch (error) {
    if (error instanceof HandledError) {
      return jsonResponse({ error: error.code, trace_id: traceId }, error.status, baseHeaders);
    }
    return jsonResponse({ error: 'internal_error', trace_id: traceId }, 500, baseHeaders);
  }
});
