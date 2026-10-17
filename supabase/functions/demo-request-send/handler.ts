// demo-request-send request handling, kept apart from the Deno.serve entry
// (index.ts) so it unit-tests under Node with an injected env reader + client
// factory. Self-contained: NO @srtdio/* or src/ imports (see index.ts for why).
//
// Public: the /demo form on srtd.io posts here with the anon key only, so
// there is no caller and no actor. The request is mailed to the team inbox
// (BOOK_CALL_TO_ADDRESS); the visitor's address is never a recipient. Abuse
// limits live in this module (no database): at most 3 requests per hour per
// email and per client IP, and a filled honeypot gets a silent { ok: true }.

import type { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { requestEmailBody, sha256Hex } from './mail.ts';

const TRACE_ID_HEADER = 'X-Trace-Id';
const TEMPLATE_KEY = 'demo_request';
const SOURCE = 'srtd.io/demo';

// Booking rules: a copy of DEMO in src/components/home/config.ts and of
// isBookable in src/components/home/demo.ts (the source). Change them together.
const DEMO = {
  timeZone: 'Asia/Kolkata',
  timeZoneLabel: 'IST',
  /** IST is UTC+05:30 all year (no DST). */
  utcOffsetMinutes: 330,
  /** First and last bookable day, in days after today (IST). */
  firstDay: 1,
  lastDay: 30,
  slots: ['11:00 am', '12:30 pm', '3:00 pm', '4:30 pm', '6:00 pm'],
} as const;

const DAY_MS = 86_400_000;
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const inputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  mobile: z.string().regex(/^\d{10}$/),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: z.enum(DEMO.slots),
  website: z.string(),
});

type DemoRequest = z.infer<typeof inputSchema>;

/** What the handler needs from the runtime; index.ts passes the edge runtime's. */
export interface DemoRequestSendDeps {
  env: (name: string) => string | undefined;
  createClient: typeof createClient;
  now?: () => Date;
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
      'authorization, apikey, x-client-info, content-type, x-trace-id',
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

const errorBody = (code: string) => ({ error: { code } });

// --- Day and slot rules -----------------------------------------------------

const zoneParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEMO.timeZone,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

/** Today's calendar day in IST at `now`, as UTC midnight ms. */
function todayUtcMs(now: Date): number {
  const parts = zoneParts.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return Date.UTC(part('year'), part('month') - 1, part('day'));
}

/** "YYYY-MM-DD" as UTC midnight ms, or null when it is no real calendar day. */
function dayUtcMs(day: string): number | null {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  const date = new Date(ms);
  const real =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  return real ? ms : null;
}

/** Tomorrow to 30 days ahead (IST), Monday to Friday only. */
export function isBookableDay(day: string, now: Date): boolean {
  const ms = dayUtcMs(day);
  if (ms === null) return false;
  const ahead = Math.round((ms - todayUtcMs(now)) / DAY_MS);
  const wd = new Date(ms).getUTCDay();
  return ahead >= DEMO.firstDay && ahead <= DEMO.lastDay && wd >= 1 && wd <= 5;
}

/** "2026-10-16" + "11:00 am" (IST) -> "2026-10-16 05:30 UTC". */
export function slotUtc(day: string, slot: string): string {
  const [clock = '', meridiem] = slot.split(' ');
  const [h12 = 0, minutes = 0] = clock.split(':').map(Number);
  const hours = (h12 % 12) + (meridiem === 'pm' ? 12 : 0);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d, hours, minutes) - DEMO.utcOffsetMinutes * 60_000);
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// --- Abuse limits (in memory, per function instance) ------------------------

// key ("email:<address>" | "ip:<address>") -> request times (ms) in the window.
const recent = new Map<string, number[]>();

function prune(nowMs: number): void {
  for (const [key, times] of recent) {
    const kept = times.filter((t) => nowMs - t < RATE_WINDOW_MS);
    if (kept.length === 0) recent.delete(key);
    else recent.set(key, kept);
  }
}

/** True (and the request counted under every key) when no key is at the limit. */
function takeSlot(keys: string[], nowMs: number): boolean {
  prune(nowMs);
  if (keys.some((key) => (recent.get(key)?.length ?? 0) >= RATE_LIMIT)) return false;
  for (const key of keys) recent.set(key, [...(recent.get(key) ?? []), nowMs]);
  return true;
}

/** CF-Connecting-IP, else the first X-Forwarded-For hop. */
function clientIp(req: Request): string | null {
  const cf = req.headers.get('CF-Connecting-IP')?.trim();
  if (cf) return cf;
  const first = req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim();
  return first || null;
}

// --- Email ------------------------------------------------------------------

/** "Demo request: <name> · <day> <slot> IST". */
export function demoRequestSubject(input: Pick<DemoRequest, 'name' | 'day' | 'slot'>): string {
  return `Demo request: ${input.name} · ${input.day} ${input.slot} ${DEMO.timeZoneLabel}`;
}

export function demoRequestEmail(input: DemoRequest): { html: string; text: string } {
  return requestEmailBody({
    heading: demoRequestSubject(input),
    rows: [
      { label: 'Name', value: input.name },
      { label: 'Email', value: input.email },
      { label: 'Mobile', value: `+91 ${input.mobile}` },
      { label: 'Slot (IST)', value: `${input.day} ${input.slot} ${DEMO.timeZoneLabel}` },
      { label: 'Slot (UTC)', value: slotUtc(input.day, input.slot) },
      { label: 'Source', value: SOURCE },
    ],
  });
}

/** One key per (email, day, slot): a retried submit never sends a second email. */
export function demoRequestIdempotencyKey(
  input: Pick<DemoRequest, 'email' | 'day' | 'slot'>,
): Promise<string> {
  return sha256Hex([input.email, input.day, input.slot]);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleDemoRequestSend(
  req: Request,
  deps: DemoRequestSendDeps,
): Promise<Response> {
  const traceId = req.headers.get(TRACE_ID_HEADER) ?? uuidv7();
  // Public form: reflect the caller's Origin; the abuse limits are the boundary.
  const origin = req.headers.get('Origin') ?? '*';

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return json(errorBody('method_not_allowed'), 405, origin, traceId);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(errorBody('invalid_payload'), 400, origin, traceId);
  }
  // A filled honeypot is a bot: answer as if sent, send and record nothing.
  const honeypot = (raw as { website?: unknown } | null)?.website;
  if (typeof honeypot === 'string' && honeypot !== '') {
    return json({ ok: true }, 200, origin, traceId);
  }

  const now = deps.now?.() ?? new Date();
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success || !isBookableDay(parsed.data.day, now)) {
    return json(errorBody('invalid_payload'), 400, origin, traceId);
  }
  const input = parsed.data;

  const ip = clientIp(req);
  const keys = [`email:${input.email}`, ...(ip ? [`ip:${ip}`] : [])];
  if (!takeSlot(keys, now.getTime())) {
    return json(errorBody('too_many_requests'), 429, origin, traceId);
  }

  const url = deps.env('SUPABASE_URL');
  const serviceKey = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  const admin =
    url && serviceKey
      ? deps.createClient(url, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

  // The record never blocks the booking: a failed insert is logged and the
  // mail still goes out.
  let attemptId: string | null = null;
  if (admin !== null) {
    try {
      const attempt = await admin
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
        console.error(
          traceId,
          attempt.error?.message ?? 'delivery_attempts insert returned no row',
        );
      } else {
        attemptId = attempt.data.id as string;
      }
    } catch (err) {
      console.error(traceId, errorMessage(err));
    }
  }

  let providerMessageId: string | null = null;
  let sendError: string | null = null;
  const resendKey = deps.env('RESEND_API_KEY');
  const fromAddress = deps.env('INVITE_FROM_ADDRESS');
  const toAddress = deps.env('BOOK_CALL_TO_ADDRESS');
  if (!resendKey || !fromAddress || !toAddress) {
    sendError = 'resend_not_configured';
  } else {
    const body = demoRequestEmail(input);
    try {
      providerMessageId = await sendViaResend({
        apiKey: resendKey,
        from: fromAddress,
        to: toAddress,
        subject: demoRequestSubject(input),
        html: body.html,
        text: body.text,
        idempotencyKey: await demoRequestIdempotencyKey(input),
      });
    } catch (err) {
      sendError = errorMessage(err);
    }
  }
  if (sendError !== null) console.error(traceId, sendError);

  if (admin !== null && attemptId !== null) {
    try {
      const updated = await admin
        .from('delivery_attempts')
        .update({
          status: sendError === null ? 'sent' : 'failed',
          provider_message_id: providerMessageId,
          error: sendError,
          sent_at: sendError === null ? new Date().toISOString() : null,
        })
        .eq('id', attemptId);
      if (updated.error) console.error(traceId, updated.error.message);
    } catch (err) {
      console.error(traceId, errorMessage(err));
    }
  }

  if (sendError !== null) return json(errorBody('send_failed'), 502, origin, traceId);
  return json({ ok: true }, 200, origin, traceId);
}
