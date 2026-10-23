// resend-webhook request handling, kept apart from the Deno.serve entry
// (index.ts) so it unit-tests under Node with an injected env reader + client
// factory. Self-contained: NO @srtdio/* imports (see index.ts for why).
//
// Resend signs webhooks the Svix way: headers svix-id, svix-timestamp and
// svix-signature ("v1,<base64>" entries, space-separated). The signature is
// HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>" keyed with the
// base64 part of RESEND_WEBHOOK_SECRET ("whsec_<base64>"). Any v1 entry may
// match; timestamps more than 300 s from now are refused (replay window).
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
const SECRET_PREFIX = 'whsec_';
const TOLERANCE_SECONDS = 300;
const HANDLED_TYPES = new Set(['email.delivered', 'email.bounced', 'email.complained']);

/** What the handler needs from the runtime; index.ts passes the edge runtime's. */
export interface ResendWebhookDeps {
  env: (name: string) => string | undefined;
  createClient: typeof createClient;
  /** Current time in ms; tests pin it. */
  now?: () => number;
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

// --- Svix signature verify ---------------------------------------------------

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Constant-time for equal lengths; a length mismatch is not secret.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return new Uint8Array(signature);
}

export async function verifySvixSignature(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs: number;
}): Promise<boolean> {
  const { id, timestamp, signature } = input;
  if (!id || !timestamp || !signature) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const encodedKey = input.secret.startsWith(SECRET_PREFIX)
    ? input.secret.slice(SECRET_PREFIX.length)
    : input.secret;
  const key = fromBase64(encodedKey);
  if (!key || key.length === 0) return false;

  const expected = await hmacSha256(key, `${id}.${timestamp}.${input.body}`);
  let matched = false;
  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const candidate = fromBase64(value);
    // No early exit: every entry is compared.
    if (candidate && timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched;
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
  const verified = await verifySvixSignature({
    secret,
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
    body,
    nowMs: (deps.now ?? Date.now)(),
  });
  if (!verified) {
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
