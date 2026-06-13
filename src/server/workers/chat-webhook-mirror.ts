// Cloudflare Worker: Agora Chat webhook mirror (compliance mirror only).
//
// POST application/json  (Agora post-delivery webhook payload)
//   -> verifies the Agora webhook signature, then records the event to the DB
//      via the public.chat_webhook_ingest proc. This is a write-only compliance
//      mirror: it is NEVER on any chat read path (the frontend reads live from
//      the Agora SDK; this worker only persists a durable copy).
//
// Connection follows the inbox-writer precedent: a bare service-role supabase-js
// client (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). This worker is not
// member-attributed, so no member JWT is minted; it calls chat_webhook_ingest via
// .rpc() and, for group messages, a single service-role SELECT on chat_channels
// to resolve Agora's group id to our channel_id. No direct Postgres connection is
// opened.
//
// Idempotency is the proc's job: webhook_events has a unique (source,
// source_event_id) index and chat_messages a unique (agora_event_id,
// created_at) index, so duplicate deliveries are deduped race-free in the DB.
// The worker adds no KV dedupe of its own.
//
// Acking policy (so Agora does not retry-storm): the raw event is always
// recorded by the proc before any message work, so success/skipped/failure all
// ack 200 (a failure outcome is captured and retriable by the reconciliation
// cron, but is logged loudly). Only a signature failure (401) or a thrown /
// unreachable-DB error (500) returns non-2xx.

import { createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { logger } from '@/server/logger';
// Reverse-map the Agora sender username back to the Supabase user id. Reused
// verbatim from the chat-token worker so the two cannot drift.
import { fromAgoraUsername } from './agora-identity';

export interface ChatWebhookMirrorEnv {
  SUPABASE_URL: string;
  /** Service role: the worker bypasses RLS and only calls chat_webhook_ingest. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Shared secret for the Agora webhook signature (md5 of callId+secret+timestamp). */
  AGORA_WEBHOOK_SECRET: string;
}

/** The exact argument shape of public.chat_webhook_ingest. */
export interface ChatWebhookIngestParams {
  p_source_event_id: string;
  p_event_type: string;
  p_signature_verified: boolean;
  p_raw_payload: Record<string, unknown>;
  p_channel_id: string | null;
  p_message_id: string | null;
  p_agora_event_id: string | null;
  p_sender_user_id: string | null;
  p_body: string | null;
  p_mentions: unknown;
  p_attachment_asset_ids: string[] | null;
  p_created_at: string | null;
  p_trace_id: string;
}

/** The jsonb the proc returns. */
export interface ChatWebhookIngestResult {
  webhook_event_id: string | null;
  message_stored: boolean;
  outcome: 'success' | 'skipped' | 'failure' | string;
}

/** The chat_channels lookup chain used to resolve a group's channel_id. */
export interface ChatChannelsQuery {
  select(columns: 'channel_id'): {
    eq(
      column: 'agora_group_id',
      value: string,
    ): {
      maybeSingle(): Promise<{
        data: { channel_id: string } | null;
        error: { message?: string } | null;
      }>;
    };
  };
}

/** The minimal supabase-js surface the worker needs; injected for tests. */
export interface ChatIngestClient {
  rpc(
    fn: 'chat_webhook_ingest',
    params: ChatWebhookIngestParams,
  ): Promise<{ data: ChatWebhookIngestResult | null; error: { message?: string } | null }>;
  /** Resolve a group message's agora_group_id to our channel_id (service_role). */
  from(table: 'chat_channels'): ChatChannelsQuery;
}

export type CreateChatIngestClient = (env: ChatWebhookMirrorEnv) => ChatIngestClient;

/** Bare service-role client (no acting member), per the inbox-writer precedent. */
const defaultCreateClient: CreateChatIngestClient = (env) =>
  createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as ChatIngestClient;

/**
 * Render any thrown value into a stable log string. PostgREST surfaces failures
 * as plain objects (not Error instances). Logging only; never returned.
 */
export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    return JSON.stringify({ code: e.code, message: e.message, details: e.details, hint: e.hint });
  }
  return String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** First non-empty string among the candidates, else null. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Verify the Agora post-delivery callback signature. Agora signs each callback
 * with security = md5Hex(callId + secret + timestamp); a request that omits any
 * of those or whose digest does not match is rejected. The compare is
 * constant-time and length-guarded.
 */
export function verifyAgoraSignature(payload: Record<string, unknown>, secret: string): boolean {
  const callId = payload.callId;
  const timestamp = payload.timestamp;
  const security = payload.security;
  if (typeof callId !== 'string' || typeof security !== 'string') {
    return false;
  }
  if (typeof timestamp !== 'number' && typeof timestamp !== 'string') {
    return false;
  }
  if (typeof secret !== 'string' || secret === '') {
    return false;
  }
  const expected = createHash('md5').update(`${callId}${secret}${timestamp}`, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(security.toLowerCase(), 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * True when a message event is a group message. Agora carries the chat type as
 * `chat_type`; group chats report a value containing "group" (e.g. "groupchat").
 * DM ("chat"/"singlechat") messages return false and keep their existing
 * channel_id handling.
 */
export function isGroupMessage(payload: Record<string, unknown>): boolean {
  const chatType = firstString(payload.chat_type);
  return chatType !== null && chatType.toLowerCase().includes('group');
}

/**
 * Resolve a group message's Agora group id to our channel_id via the service-role
 * SELECT on chat_channels.agora_group_id. Returns null when the group is not yet
 * synced (no row), so the proc records the raw event and marks it skipped - its
 * existing behavior for an unknown channel. A query error is logged and treated
 * as unresolved rather than thrown, so the raw event is still captured.
 */
async function resolveGroupChannelId(
  client: ChatIngestClient,
  agoraGroupId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('chat_channels')
    .select('channel_id')
    .eq('agora_group_id', agoraGroupId)
    .maybeSingle();
  if (error) {
    logger.warn('chat webhook group channel resolution failed', {
      agora_group_id: agoraGroupId,
      error: serializeError(error),
    });
    return null;
  }
  return data?.channel_id ?? null;
}

/** Reverse-map the Agora sender username to a Supabase user id, or null. */
function reverseSender(from: unknown): string | null {
  if (typeof from !== 'string') {
    return null;
  }
  try {
    return fromAgoraUsername(from);
  } catch {
    // System / admin senders (and any non-u_ username) have no Supabase user.
    return null;
  }
}

/** Concatenated text of all txt bodies, or null (voice notes etc. have none). */
function extractBody(msgPayload: Record<string, unknown>): string | null {
  const bodies = msgPayload.bodies;
  if (!Array.isArray(bodies)) {
    return null;
  }
  const texts: string[] = [];
  for (const entry of bodies) {
    const body = asRecord(entry);
    if (body.type === 'txt' && typeof body.msg === 'string') {
      texts.push(body.msg);
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/**
 * Asset ids carried on the message extension. Model A: assets are imported via
 * the asset pipeline elsewhere; the worker records the references as given.
 */
function extractAssetIds(ext: Record<string, unknown>): string[] | null {
  const raw = ext.attachment_asset_ids ?? ext.asset_ids;
  if (!Array.isArray(raw)) {
    return null;
  }
  const ids = raw.filter((value): value is string => typeof value === 'string');
  return ids.length > 0 ? ids : null;
}

/** Agora delivers the timestamp as epoch milliseconds; map it to an ISO string. */
function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return new Date(Number(value)).toISOString();
  }
  return null;
}

/**
 * Map an Agora payload to chat_webhook_ingest arguments. A message event is
 * detected by the presence of msg_id; non-message events pass null for every
 * message/agora_event_id field so the proc records only the raw event. Agora's
 * msg_id is both the message id and the message dedupe key.
 */
export function buildIngestParams(
  payload: Record<string, unknown>,
  traceId: string,
  signatureVerified: boolean,
): ChatWebhookIngestParams {
  const msgId = firstString(payload.msg_id);
  const isMessage = msgId !== null;
  const msgPayload = asRecord(payload.payload);
  const ext = asRecord(msgPayload.ext);
  return {
    p_source_event_id: firstString(payload.callId) ?? '',
    p_event_type:
      firstString(payload.eventType, payload.event, payload.callback, payload.chat_type) ??
      'unknown',
    p_signature_verified: signatureVerified,
    p_raw_payload: payload,
    p_channel_id: isMessage ? firstString(payload.group_id, payload.to) : null,
    p_message_id: isMessage ? msgId : null,
    p_agora_event_id: isMessage ? msgId : null,
    p_sender_user_id: isMessage ? reverseSender(payload.from) : null,
    p_body: isMessage ? extractBody(msgPayload) : null,
    p_mentions: isMessage ? (ext.mentions ?? null) : null,
    p_attachment_asset_ids: isMessage ? extractAssetIds(ext) : null,
    p_created_at: isMessage ? toIsoTimestamp(payload.timestamp) : null,
    p_trace_id: traceId,
  };
}

function jsonResponse(status: number, body: unknown, traceId: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(TRACE_ID_HEADER, traceId);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The request pipeline, with the client factory injected so tests can assert
 * the rpc arguments without a database.
 */
export async function handle(
  request: Request,
  env: ChatWebhookMirrorEnv,
  createClientFn: CreateChatIngestClient = defaultCreateClient,
): Promise<Response> {
  const traceId = extractTraceId(request);
  logger.setTraceId(traceId);
  try {
    if (request.method !== 'POST') {
      return jsonResponse(405, { error: 'method_not_allowed' }, traceId);
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonResponse(400, { error: 'invalid_payload' }, traceId);
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return jsonResponse(400, { error: 'invalid_json' }, traceId);
    }

    // Verify BEFORE any processing; a bad signature never reaches the proc.
    if (!verifyAgoraSignature(payload, env.AGORA_WEBHOOK_SECRET)) {
      logger.warn('chat webhook signature verification failed', {
        call_id: typeof payload.callId === 'string' ? payload.callId : null,
      });
      return jsonResponse(401, { error: 'invalid_signature' }, traceId);
    }

    // Args assembled as a value (explicit p_trace_id), mirroring @srtdio/rpc and
    // the inbox-writer service-role rpc precedent.
    const client = createClientFn(env);
    const params = buildIngestParams(payload, traceId, true);

    // A group message's webhook carries Agora's group id, not our channel_id, so
    // resolve it to our channel_id before ingesting. DM messages keep the
    // channel_id buildIngestParams already derived; an unresolved group id passes
    // null, so the proc records the raw event and marks it skipped.
    if (params.p_message_id !== null && isGroupMessage(payload)) {
      const agoraGroupId = firstString(payload.group_id, payload.to);
      params.p_channel_id = agoraGroupId ? await resolveGroupChannelId(client, agoraGroupId) : null;
    }

    const { data, error } = await client.rpc('chat_webhook_ingest', params);

    if (error) {
      // The proc threw or the database was unreachable; the raw event may not be
      // recorded, so signal a retryable failure to Agora.
      logger.error('chat_webhook_ingest rpc errored', {
        source_event_id: params.p_source_event_id,
        error: serializeError(error),
      });
      return jsonResponse(500, { error: 'ingest_failed' }, traceId);
    }

    const outcome = data?.outcome ?? 'unknown';
    if (outcome === 'failure') {
      // The raw webhook_events row + processing attempt were still recorded, so
      // the event is captured and retriable by the reconciliation cron. Ack 200
      // so Agora does not retry-storm, but log loudly.
      logger.error('chat_webhook_ingest returned a failure outcome', {
        source_event_id: params.p_source_event_id,
        result: data,
      });
    } else {
      logger.info('chat_webhook_ingest recorded', {
        source_event_id: params.p_source_event_id,
        outcome,
        message_stored: data?.message_stored ?? false,
      });
    }
    return jsonResponse(
      200,
      { outcome, webhook_event_id: data?.webhook_event_id ?? null },
      traceId,
    );
  } catch (error) {
    logger.error(`chat webhook mirror failed: ${serializeError(error)}`);
    return jsonResponse(500, { error: 'internal_error' }, traceId);
  } finally {
    logger.clearTraceId();
  }
}

export default {
  fetch(request: Request, env: ChatWebhookMirrorEnv): Promise<Response> {
    return handle(request, env);
  },
};
