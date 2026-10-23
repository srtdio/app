// resend-webhook request handling, kept apart from the Deno.serve entry
// (index.ts) so it unit-tests under Node with an injected env reader + client
// factory. Self-contained: NO @srtdio/* imports (see index.ts for why).
//
// Resend signs webhooks with Svix (headers svix-id, svix-timestamp,
// svix-signature; secret RESEND_WEBHOOK_SECRET, "whsec_<base64>"). The check
// is the svix library's Webhook.verify (signature, constant-time compare, 5 min
// timestamp window), bound in index.ts and passed in as deps.verifySignature,
// so this handler still unit-tests under Node where svix is not installed.
//
// Each event is ONE guarded UPDATE of public.delivery_attempts (provider
// 'resend', provider_message_id = data.email_id) on the service-role client.
// The guards make replays and out-of-order events change nothing further:
//   email.delivered  -> delivered, delivered_at  only from queued / sent
//   email.bounced    -> bounced, bounced_at      unless complained
//   email.complained -> complained
// Any other type, or no matching row: 200 {ok:true, ignored:true}.

import type { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const TRACE_ID_HEADER = 'X-Trace-Id';
const SVIX_HEADERS = ['svix-id', 'svix-timestamp', 'svix-signature'] as const;
const HANDLED_TYPES = new Set(['email.delivered', 'email.bounced', 'email.complained']);

/** What the handler needs from the runtime; index.ts passes the edge runtime's. */
export interface ResendWebhookDeps {
  env: (name: string) => string | undefined;
  createClient: typeof createClient;
  /** Throws when the signature does not verify (svix Webhook.verify in index.ts). */
  verifySignature: (secret: string, body: string, headers: Record<string, string>) => void;
}

const eventSchema = z.object({
  type: z.string(),
  created_at: z.string().datetime({ offset: true }),
  data: z.object({ email_id: z.string().min(1) }).passthrough(),
});

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

function json(body: unknown, status: number, traceId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', [TRACE_ID_HEADER]: traceId },
  });
}

// --- handler -----------------------------------------------------------------

export async function handleResendWebhook(
  req: Request,
  deps: ResendWebhookDeps,
): Promise<Response> {
  const traceId = req.headers.get(TRACE_ID_HEADER) ?? uuidv7();
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed', trace_id: traceId }, 405, traceId);
  }

  const secret = deps.env('RESEND_WEBHOOK_SECRET');
  if (!secret) {
    console.error(traceId, 'missing required env RESEND_WEBHOOK_SECRET');
    return json({ error: 'not_configured', trace_id: traceId }, 500, traceId);
  }

  const body = await req.text();
  const headers: Record<string, string> = {};
  for (const name of SVIX_HEADERS) headers[name] = req.headers.get(name) ?? '';
  try {
    deps.verifySignature(secret, body, headers);
  } catch {
    return json({ error: 'invalid_signature', trace_id: traceId }, 401, traceId);
  }

  let event: z.infer<typeof eventSchema>;
  try {
    event = eventSchema.parse(JSON.parse(body));
  } catch {
    return json({ error: 'invalid_payload', trace_id: traceId }, 400, traceId);
  }

  if (!HANDLED_TYPES.has(event.type)) {
    return json({ ok: true, ignored: true, trace_id: traceId }, 200, traceId);
  }

  try {
    const url = deps.env('SUPABASE_URL');
    const serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) throw new Error('missing required env SUPABASE_URL or service key');
    const admin = deps.createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const rows = () =>
      admin
        .from('delivery_attempts')
        .update(changeFor(event))
        .eq('provider', 'resend')
        .eq('provider_message_id', event.data.email_id);

    let result: { data: unknown[] | null; error: { message: string } | null };
    if (event.type === 'email.delivered') {
      result = await rows().in('status', ['queued', 'sent']).select('id');
    } else if (event.type === 'email.bounced') {
      result = await rows().neq('status', 'complained').select('id');
    } else {
      result = await rows().select('id');
    }

    if (result.error) {
      console.error(traceId, result.error.message);
      return json({ error: 'internal', trace_id: traceId }, 500, traceId);
    }
    if (!result.data || result.data.length === 0) {
      return json({ ok: true, ignored: true, trace_id: traceId }, 200, traceId);
    }
    return json({ ok: true, trace_id: traceId }, 200, traceId);
  } catch (err) {
    console.error(traceId, err instanceof Error ? err.message : String(err));
    return json({ error: 'internal', trace_id: traceId }, 500, traceId);
  }
}

// The column change for a handled event type (unhandled types never reach the UPDATE).
function changeFor(event: z.infer<typeof eventSchema>): Record<string, string> {
  if (event.type === 'email.delivered') {
    return { status: 'delivered', delivered_at: event.created_at };
  }
  if (event.type === 'email.bounced') {
    return { status: 'bounced', bounced_at: event.created_at };
  }
  return { status: 'complained' };
}
