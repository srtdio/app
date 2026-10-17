// book-call-send request handling, kept apart from the Deno.serve entry
// (index.ts) so it unit-tests under Node with an injected env reader + client
// factory. Self-contained: NO @srtdio/* imports (see index.ts for why).
//
// The actor is the caller's bearer (auth.getUser()); their email and display
// name are read server-side, never from the body. Membership, workspace name
// and platform are service-role reads. The Resend Idempotency-Key hashes
// (user, workspace, slot instant), so a retried request never sends twice.

import type { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requestEmailBody, sha256Hex } from './mail.ts';

const TRACE_ID_HEADER = 'X-Trace-Id';
const TEMPLATE_KEY = 'book_call';

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const inputSchema = z.object({
  workspace_id: z.string().uuid(),
  slot_at: z.string().datetime({ offset: true }),
  tz: z.string().min(1).refine(isTimeZone),
});

/** What the handler needs from the runtime; index.ts passes the edge runtime's. */
export interface BookCallSendDeps {
  env: (name: string) => string | undefined;
  createClient: typeof createClient;
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
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin.replace(/\/$/, ''),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, apikey, x-client-info, content-type, x-trace-id, x-device-fingerprint',
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

/** The slot in the caller's zone, like "Mon 20 Oct, 11:00" (en-GB, 24h). */
export function formatSlot(slot: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  }).formatToParts(slot);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}, ${part('hour')}:${part('minute')}`;
}

/** "YYYY-MM-DD HH:mm UTC". */
export function formatSlotUtc(slot: Date): string {
  const iso = slot.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "Call request: <workspace name> · <slot in tz>". */
export function bookCallSubject(workspaceName: string, slot: Date, tz: string): string {
  return `Call request: ${workspaceName} · ${formatSlot(slot, tz)}`;
}

/** One key per (caller, workspace, slot instant): a retry reuses it. */
export function bookCallIdempotencyKey(
  userId: string,
  workspaceId: string,
  slot: Date,
): Promise<string> {
  return sha256Hex([userId, workspaceId, slot.toISOString()]);
}

// Resend via fetch (NOT the npm SDK, which pulls node: internals that break the
// edge bundler). Returns the provider message id.
async function sendViaResend(opts: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}): Promise<string> {
  // globalThis.fetch (not the bare global) satisfies the ESLint fetch guard;
  // this edge function has no src/lib/fetch wrapper to reach for.
  const response = await globalThis.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': opts.idempotencyKey,
    },
    body: JSON.stringify({
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });
  if (!response.ok) {
    throw new Error(`resend send failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { id?: string };
  if (!data.id) throw new Error('resend response did not include an id');
  return data.id;
}

export async function handleBookCallSend(req: Request, deps: BookCallSendDeps): Promise<Response> {
  const { createClient } = deps;
  const requireEnv = (name: string): string => {
    const value = deps.env(name);
    if (!value) throw new Error(`missing required env ${name}`);
    return value;
  };
  const traceId = req.headers.get(TRACE_ID_HEADER) ?? uuidv7();
  // Reflect the caller's Origin (see invite-send); auth is the boundary, not CORS.
  // No env is read before the try, so a missing one still answers a JSON 500.
  const allowedOrigin = req.headers.get('Origin') ?? '*';
  const fail = (code: string, status: number): Response =>
    json({ error: { code } }, status, allowedOrigin, traceId);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
  }
  if (req.method !== 'POST') return fail('method_not_allowed', 405);

  try {
    const url = requireEnv('SUPABASE_URL');
    const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;
    const callerClient = createClient(url, requireEnv('SUPABASE_ANON_KEY'), {
      ...noPersist,
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });

    // In-function auth gate, before anything is read, written or sent.
    const caller = await callerClient.auth.getUser();
    if (caller.error || !caller.data?.user) {
      console.error(traceId, caller.error?.message ?? 'no authenticated user');
      return fail('unauthorized', 401);
    }
    const userId = caller.data.user.id;
    const userEmail = caller.data.user.email ?? '';

    let parsed: z.infer<typeof inputSchema>;
    try {
      parsed = inputSchema.parse(await req.json());
    } catch {
      return fail('invalid_payload', 400);
    }
    const slot = new Date(parsed.slot_at);
    if (slot.getTime() <= Date.now()) return fail('slot_in_past', 400);

    const adminClient = createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), noPersist);
    const [member, workspace, profile] = await Promise.all([
      adminClient
        .from('workspace_members')
        .select('id')
        .eq('workspace_id', parsed.workspace_id)
        .eq('user_id', userId)
        .eq('active', true)
        .maybeSingle(),
      adminClient
        .from('workspaces')
        .select('name, platform')
        .eq('id', parsed.workspace_id)
        .is('deleted_at', null)
        .maybeSingle(),
      adminClient.from('users').select('display_name').eq('id', userId).maybeSingle(),
    ]);
    const lookupError = member.error ?? workspace.error ?? profile.error;
    if (lookupError) {
      console.error(traceId, lookupError.message);
      return fail('internal', 500);
    }
    if (!member.data || !workspace.data) return fail('not_member', 403);
    const workspaceName = workspace.data.name as string;
    const platform = workspace.data.platform as string;
    const displayName = ((profile.data?.display_name as string | undefined) ?? '').trim();

    const attempt = await adminClient
      .from('delivery_attempts')
      .insert({
        workspace_id: parsed.workspace_id,
        user_id: userId,
        channel: 'email',
        template_key: TEMPLATE_KEY,
        provider: 'resend',
        status: 'queued',
        email_thread_id: null,
      })
      .select('id')
      .single();
    if (attempt.error || !attempt.data) {
      console.error(traceId, attempt.error?.message ?? 'delivery_attempts insert returned no row');
      return fail('delivery_record_failed', 500);
    }

    let providerMessageId: string | null = null;
    let sendError: string | null = null;
    const resendKey = deps.env('RESEND_API_KEY');
    const fromAddress = deps.env('INVITE_FROM_ADDRESS');
    const toAddress = deps.env('BOOK_CALL_TO_ADDRESS');
    if (!resendKey || !fromAddress || !toAddress) {
      sendError = 'resend_not_configured';
    } else {
      const subject = bookCallSubject(workspaceName, slot, parsed.tz);
      const body = requestEmailBody({
        heading: subject,
        rows: [
          { label: 'Name', value: displayName },
          { label: 'Email', value: userEmail },
          { label: 'Workspace', value: `${workspaceName} · ${platform}` },
          { label: 'Slot (tz)', value: `${formatSlot(slot, parsed.tz)} (${parsed.tz})` },
          { label: 'Slot (UTC)', value: formatSlotUtc(slot) },
        ],
      });
      try {
        providerMessageId = await sendViaResend({
          apiKey: resendKey,
          from: fromAddress,
          to: toAddress,
          subject,
          html: body.html,
          text: body.text,
          idempotencyKey: await bookCallIdempotencyKey(userId, parsed.workspace_id, slot),
        });
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
      }
    }
    if (sendError) console.error(traceId, sendError);

    await adminClient
      .from('delivery_attempts')
      .update({
        status: sendError ? 'failed' : 'sent',
        provider_message_id: providerMessageId,
        error: sendError,
        sent_at: sendError ? null : new Date().toISOString(),
      })
      .eq('id', attempt.data.id);

    if (sendError) return fail('send_failed', 502);
    return json({ ok: true }, 200, allowedOrigin, traceId);
  } catch (err) {
    console.error(traceId, err instanceof Error ? err.message : String(err));
    return fail('internal', 500);
  }
}
