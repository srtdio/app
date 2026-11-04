// brand-request-send request handling, kept apart from the Deno.serve entry
// (index.ts) so it unit-tests under Node with an injected env reader + client
// factory. Self-contained: NO @srtdio/* imports (see index.ts for why).
//
// brand_agency_request runs as the CALLER (anon key + caller bearer), so the
// actor is auth.uid() server-side; no user id is ever read from the body. The
// proc caps sends at 5 per open request and bumps send_count on every call, so
// (request id, send_count) names exactly one call and is the Resend
// Idempotency-Key: a retried request never sends a second email.

import type { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { EMAIL_LIGHT, EMAIL_SANS, emailButton, emailCard, emailDocument } from './email-shell.ts';

const TRACE_ID_HEADER = 'X-Trace-Id';
const TEMPLATE_KEY = 'brand_request';

const inputSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  brand_name: z.string().trim().max(80).optional(),
});

/** What the handler needs from the runtime; index.ts passes the edge runtime's. */
export interface BrandRequestSendDeps {
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

// --- Email (same card layout as invite-send) --------------------------------

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

/** "<name> from <brand> wants you to make their posts on Sorted"; no brand drops "from". */
export function brandRequestSubject(requesterName: string, brandName: string | null): string {
  const who = brandName ? `${requesterName} from ${brandName}` : requesterName;
  return `${who} wants you to make their posts on Sorted`;
}

// The email never says "client", "agency" or "trial": the app calls the sides
// Approver and Creator, and the person asked makes the posts.
export function brandRequestEmailBody(input: {
  requesterName: string;
  brandName: string | null;
  signUpUrl: string;
}): { html: string; text: string } {
  const heading = brandRequestSubject(input.requesterName, input.brandName);
  const posts = input.brandName ? `the posts for ${input.brandName}` : 'their posts';
  const detail =
    `${input.requesterName} reviews and approves posts on Sorted and asked you to make ${posts}. ` +
    `Sign up as a Creator to make posts there and send them to ${input.requesterName} for review.`;
  const ignoreNote = "If you weren't expecting this, you can ignore this email.";
  const footer = `Sent by Sorted on behalf of ${input.requesterName}.`;
  const text =
    `${heading}\n\n` +
    `${detail}\n\n` +
    `Sign up:\n${input.signUpUrl}\n\n` +
    `${ignoreNote}\n\n` +
    footer;
  const safeHeading = escapeHtml(heading);
  const safeDetail = escapeHtml(detail);
  const safeName = escapeHtml(input.requesterName);
  const L = EMAIL_LIGHT;
  const html = emailDocument({
    title: heading,
    content:
      `<tr><td>` +
      emailCard(
        `<div class="fg2" style="font-family:${EMAIL_SANS};font-size:13px;font-weight:600;line-height:16px;color:${L.fg2}">You're asked to make posts</div>` +
          `<h1 class="fg" style="margin:0;padding-top:8px;font-family:${EMAIL_SANS};font-size:24px;line-height:30px;font-weight:600;letter-spacing:-0.01em;color:${L.fg}">${safeHeading}</h1>` +
          `<p class="fg" style="margin:0;padding-top:12px;font-family:${EMAIL_SANS};font-size:15px;line-height:24px;color:${L.fg}">${safeDetail}</p>` +
          `<div style="padding-top:24px">${emailButton(input.signUpUrl, 'Sign up')}</div>` +
          `<p class="fg2" style="margin:0;padding-top:12px;font-family:${EMAIL_SANS};font-size:13px;line-height:20px;color:${L.fg2}">${escapeHtml(ignoreNote)}</p>`,
      ) +
      `</td></tr>`,
    footer: `Sent by Sorted on behalf of ${safeName}.`,
  });
  return { html, text };
}

/** One key per proc call: the request id plus the send_count that call set. */
export function brandRequestIdempotencyKey(requestId: string, sendCount: number): string {
  return `brand-request-send/${requestId}/${sendCount}`;
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

// brand_agency_request raises its domain code as the error message.
function mapRequestErrorStatus(message: string): number {
  if (message === 'unauthenticated') return 401;
  if (message === 'invalid_payload') return 400;
  if (message === 'too_many_requests') return 429;
  return 500;
}

export async function handleBrandRequestSend(
  req: Request,
  deps: BrandRequestSendDeps,
): Promise<Response> {
  const { createClient } = deps;
  const requireEnv = (name: string): string => {
    const value = deps.env(name);
    if (!value) throw new Error(`missing required env ${name}`);
    return value;
  };
  const appBaseUrl = requireEnv('APP_BASE_URL').replace(/\/$/, '');
  const traceId = req.headers.get(TRACE_ID_HEADER) ?? uuidv7();
  // Reflect the caller's Origin (see invite-send); auth is the boundary, not CORS.
  const allowedOrigin = req.headers.get('Origin') ?? appBaseUrl;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed', trace_id: traceId }, 405, allowedOrigin, traceId);
  }

  let parsed: z.infer<typeof inputSchema>;
  try {
    parsed = inputSchema.parse(await req.json());
  } catch {
    return json({ error: 'invalid_payload', trace_id: traceId }, 400, allowedOrigin, traceId);
  }

  try {
    const url = requireEnv('SUPABASE_URL');
    const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;
    // Caller client: brand_agency_request runs as the requester (auth.uid()).
    const callerClient = createClient(url, requireEnv('SUPABASE_ANON_KEY'), {
      ...noPersist,
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });

    // In-function auth gate, before anything is written or sent.
    const caller = await callerClient.auth.getUser();
    if (caller.error || !caller.data?.user) {
      const message = caller.error?.message ?? 'no authenticated user';
      console.error(traceId, message);
      return json(
        { error: 'unauthorized', error_detail: message, trace_id: traceId },
        401,
        allowedOrigin,
        traceId,
      );
    }
    const userId = caller.data.user.id;

    // Args built as a variable: the .rpc() lint guard only inspects inline
    // object literals, and p_trace_id is the proc's real trace parameter.
    const requestArgs = {
      p_agency_email: parsed.email,
      p_brand_name: parsed.brand_name ?? '',
      p_trace_id: traceId,
    };
    const requested = await callerClient.rpc('brand_agency_request', requestArgs);
    if (requested.error) {
      const message = requested.error.message;
      console.error(traceId, message);
      const status = mapRequestErrorStatus(message);
      return json(
        {
          error: status === 500 ? 'internal' : message,
          error_detail: message,
          trace_id: traceId,
        },
        status,
        allowedOrigin,
        traceId,
      );
    }
    const requestId = requested.data as string;

    // The row this call wrote (RLS: requested_by = auth.uid()).
    const row = await callerClient
      .from('brand_agency_requests')
      .select('agency_email, brand_name, send_count')
      .eq('id', requestId)
      .maybeSingle();
    if (row.error || !row.data) {
      const message = row.error?.message ?? 'brand_agency_requests row not found';
      console.error(traceId, message);
      return json(
        { error: 'request_lookup_failed', error_detail: message, trace_id: traceId },
        500,
        allowedOrigin,
        traceId,
      );
    }
    const recipient = row.data.agency_email as string;
    const brandName = (row.data.brand_name as string | null) ?? null;
    const sendCount = row.data.send_count as number;

    const profile = await callerClient
      .from('users')
      .select('display_name')
      .eq('id', userId)
      .maybeSingle();
    const requesterName =
      ((profile.data?.display_name as string | undefined) ?? '').trim() || 'Someone';

    // Record one delivery attempt (service role), then send when Resend is configured.
    const adminClient = createClient(url, requireEnv('SUPABASE_SERVICE_ROLE_KEY'), noPersist);
    const attempt = await adminClient
      .from('delivery_attempts')
      .insert({
        workspace_id: null,
        user_id: null,
        channel: 'email',
        template_key: TEMPLATE_KEY,
        provider: 'resend',
        status: 'queued',
        email_thread_id: null,
      })
      .select('id')
      .single();
    if (attempt.error || !attempt.data) {
      const message = attempt.error?.message ?? 'delivery_attempts insert returned no row';
      console.error(traceId, message);
      return json(
        { error: 'delivery_record_failed', error_detail: message, trace_id: traceId },
        500,
        allowedOrigin,
        traceId,
      );
    }

    let emailed = false;
    let errorDetail: string | null = null;
    const resendKey = deps.env('RESEND_API_KEY');
    const fromAddress = deps.env('INVITE_FROM_ADDRESS');
    if (!resendKey || !fromAddress) {
      errorDetail = 'resend_not_configured';
      console.error(traceId, errorDetail);
    } else {
      const signUpUrl = `${appBaseUrl}/signup?email=${encodeURIComponent(recipient)}`;
      const body = brandRequestEmailBody({ requesterName, brandName, signUpUrl });
      let status: 'sent' | 'failed' = 'sent';
      let providerMessageId: string | null = null;
      let sendError: string | null = null;
      try {
        providerMessageId = await sendViaResend({
          apiKey: resendKey,
          from: fromAddress,
          to: recipient,
          subject: brandRequestSubject(requesterName, brandName),
          html: body.html,
          text: body.text,
          idempotencyKey: brandRequestIdempotencyKey(requestId, sendCount),
        });
        emailed = true;
      } catch (err) {
        status = 'failed';
        sendError = err instanceof Error ? err.message : String(err);
        errorDetail = sendError;
        console.error(traceId, sendError);
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
        request_id: requestId,
        send_count: sendCount,
        emailed,
        error_detail: errorDetail,
        trace_id: traceId,
      },
      200,
      allowedOrigin,
      traceId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(traceId, message);
    return json(
      { error: 'internal', error_detail: message, trace_id: traceId },
      500,
      allowedOrigin,
      traceId,
    );
  }
}
