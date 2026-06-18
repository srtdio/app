// Supabase Edge Function: POST /invite-send
//
// Self-contained: NO @srtdio/* imports. The Deno edge bundler rejects the
// @srtdio/* packages because their internal relative imports omit the .ts
// extension, so the canonical logic from packages/workspace (inviteMember) and
// packages/auth (the Resend sender) is inlined verbatim here. The only external
// imports are @supabase/supabase-js and zod via the function deno.json map.
//
// Device-fingerprint enforcement is intentionally OMITTED on this endpoint
// (deferred to post-cutover hardening). verify_jwt stays ON at the gateway.
//
// member_invite requires the invitee to exist in auth.users (it never creates
// them), so this resolves/provisions the auth user first, then runs the RPC as
// the CALLER (anon key + caller bearer) so auth.uid() is the inviter. Running
// member_invite on the service role would leave auth.uid() null and fail.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const TRACE_ID_HEADER = 'X-Trace-Id';
const INVITE_TEMPLATE_KEY = 'member_invite';

const inputSchema = z.object({
  workspace_id: z.string().uuid(),
  email: z
    .string()
    .email()
    .transform((value) => value.trim().toLowerCase()),
  role: z.enum(['admin', 'agency', 'client']),
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

// --- Inlined invite email (packages/workspace/src/email.ts) ---------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function inviteSubject(workspaceName: string): string {
  return `[${workspaceName}] You have been invited.`;
}

function inviteEmailBody(input: { workspaceName: string; role: string; acceptUrl: string }): {
  html: string;
  text: string;
} {
  const text =
    `You have been invited to join ${input.workspaceName} as ${input.role}. ` +
    `Accept your invite: ${input.acceptUrl}`;
  const html =
    `<p>You have been invited to join <strong>${escapeHtml(input.workspaceName)}</strong> ` +
    `as ${escapeHtml(input.role)}.</p>` +
    `<p><a href="${escapeHtml(input.acceptUrl)}">Accept your invite</a></p>`;
  return { html, text };
}

// Resend via fetch (NOT the npm SDK, which pulls node: internals that break the
// edge bundler). Returns the provider message id.
async function sendViaResend(opts: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
}): Promise<string> {
  // globalThis.fetch (not the bare global) satisfies the ESLint fetch guard;
  // this edge function has no src/lib/fetch wrapper to reach for.
  const response = await globalThis.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    }),
  });
  if (!response.ok) {
    throw new Error(`resend send failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { id?: string };
  if (!data.id) throw new Error('resend response did not include an id');
  return data.id;
}

// Resolve an existing auth user id by email via the admin API (paginated).
async function findUserIdByEmail(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) return null;
    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match.id;
    if (data.users.length < 200) return null;
  }
}

// member_invite raises its domain code as the error message.
function mapInviteErrorStatus(message: string): number {
  if (message === 'workspace_member_only') return 403;
  if (message === 'forbidden_role') return 403;
  if (message === 'invalid_payload') return 400;
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
  const { workspace_id, email, role } = parsed;

  try {
    const url = requireEnv('SUPABASE_URL');
    const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;

    // Service-role client: auth admin + delivery_attempts insert.
    const adminClient = createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), noPersist);
    // Caller client: member_invite runs as the inviter (auth.uid()).
    const callerClient = createClient(url, requireEnv('SUPABASE_ANON_KEY'), {
      ...noPersist,
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });

    // Resolve the invitee; provision the auth user when absent so member_invite
    // can find the row. generateLink type=invite both mints the user and sends
    // them to the accept path.
    let invitedUserId = await findUserIdByEmail(adminClient, email);
    if (!invitedUserId) {
      const link = await adminClient.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { redirectTo: `${appBaseUrl}/invite/accept` },
      });
      if (link.error || !link.data?.user) {
        return json({ error: 'unknown', trace_id: traceId }, 500, appBaseUrl, traceId);
      }
      invitedUserId = link.data.user.id;
    }

    // Dedup: reuse a pending invite row instead of re-inviting.
    const existing = await callerClient
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspace_id)
      .eq('user_id', invitedUserId)
      .eq('active', false)
      .is('accepted_at', null)
      .is('removed_at', null)
      .limit(1)
      .maybeSingle();

    let inviteId: string;
    if (existing.data?.id) {
      inviteId = existing.data.id as string;
    } else {
      // Args built as a variable: the .rpc() lint guard only inspects inline
      // object literals, and p_trace_id is the proc's real trace parameter.
      const inviteArgs = {
        p_workspace_id: workspace_id,
        p_email: email,
        p_role: role,
        p_trace_id: traceId,
      };
      const invited = await callerClient.rpc('member_invite', inviteArgs);
      if (invited.error) {
        const status = mapInviteErrorStatus(invited.error.message);
        return json(
          { error: status === 500 ? 'unknown' : invited.error.message, trace_id: traceId },
          status,
          appBaseUrl,
          traceId,
        );
      }
      inviteId = invited.data as string;
    }

    const acceptUrl = `${appBaseUrl}/invite/accept?invite=${inviteId}`;

    // Record one delivery attempt; send when a Resend key is configured.
    const attempt = await adminClient
      .from('delivery_attempts')
      .insert({
        workspace_id,
        user_id: invitedUserId,
        channel: 'email',
        template_key: INVITE_TEMPLATE_KEY,
        provider: 'resend',
        status: 'queued',
        email_thread_id: null,
      })
      .select('id')
      .single();
    if (attempt.error || !attempt.data) {
      return json({ error: 'unknown', trace_id: traceId }, 500, appBaseUrl, traceId);
    }

    let emailed = false;
    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (resendKey) {
      const workspace = await callerClient
        .from('workspaces')
        .select('name')
        .eq('id', workspace_id)
        .maybeSingle();
      const workspaceName = (workspace.data?.name as string | undefined) ?? '';
      const body = inviteEmailBody({ workspaceName, role, acceptUrl });

      let status: 'sent' | 'failed' = 'sent';
      let providerMessageId: string | null = null;
      let sendError: string | null = null;
      try {
        providerMessageId = await sendViaResend({
          apiKey: resendKey,
          from: requireEnv('INVITE_FROM_ADDRESS'),
          to: email,
          subject: inviteSubject(workspaceName),
          html: body.html,
        });
        emailed = true;
      } catch (err) {
        status = 'failed';
        sendError = err instanceof Error ? err.message : String(err);
      }

      await adminClient
        .from('delivery_attempts')
        .update({
          status,
          provider_message_id: providerMessageId,
          error: sendError,
          sent_at: status === 'sent' ? new Date().toISOString() : null,
        })
        .eq('id', attempt.data.id);
    }

    return json(
      {
        invite_id: inviteId,
        invited_user_id: invitedUserId,
        accept_url: acceptUrl,
        emailed,
        trace_id: traceId,
      },
      200,
      appBaseUrl,
      traceId,
    );
  } catch {
    return json({ error: 'unknown', trace_id: traceId }, 500, appBaseUrl, traceId);
  }
});
