// Postgres writes for chat, through the SECURITY DEFINER procs that are the
// only write paths: chat_message_send (the record, called BEFORE Agora),
// chat_reaction_add / chat_reaction_remove, and chat_read_cursor_set. The actor
// is auth.uid() server-side (never passed), and the trace id is the explicit
// p_trace_id parameter of every proc (minted with uuid_v7 at the user action,
// never inferred). The Supabase client is injected so each proc call is
// unit-tested against a recording fake with no database.
//
// The args object is typed against the generated proc signature and built ahead
// of the `.rpc()` call, the same way @srtdio/rpc's callProc passes its args: the
// trace parameter these procs declare is `p_trace_id`, carried explicitly.

import type { Client } from '@srtdio/rpc';
import type { Database, Json } from '@srtdio/schemas';
import type { ChatMessageRow } from '@/lib/chat/thread';

type Functions = Database['public']['Functions'];

/** The record write is abandoned (and the bubble marked failed) after this long. */
export const SEND_TIMEOUT_MS = 10_000;

export interface SendRecordParams {
  client: Client;
  /** Client-generated uuid_v7; a retry passes the SAME id (the proc is idempotent). */
  id: string;
  channelId: string;
  traceId: string;
  body: string;
  attachmentAssetIds: readonly string[];
  mentions?: Json;
  /** Override for tests; defaults to SEND_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type SendRecordResult =
  | { ok: true; row: ChatMessageRow }
  | { ok: false; reason: 'timeout' | 'error'; message: string };

/**
 * Write the message to the record via chat_message_send with an abort timeout.
 * An empty body is omitted (the row's body is nullable and CHECKed non-empty
 * when present) and so is an empty attachment list, matching the proc's
 * defaults. Never throws: a timeout, transport error or proc exception resolves
 * to { ok: false } so the caller can mark the bubble failed and offer Retry.
 */
export async function sendMessageRecord(params: SendRecordParams): Promise<SendRecordResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? SEND_TIMEOUT_MS);
  const body = params.body.trim();
  const args: Functions['chat_message_send']['Args'] = {
    p_id: params.id,
    p_channel_id: params.channelId,
    p_trace_id: params.traceId,
    ...(body !== '' ? { p_body: body } : {}),
    ...(params.attachmentAssetIds.length > 0
      ? { p_attachment_asset_ids: [...params.attachmentAssetIds] }
      : {}),
    ...(params.mentions !== undefined ? { p_mentions: params.mentions } : {}),
  };
  const reason = (): 'timeout' | 'error' => (controller.signal.aborted ? 'timeout' : 'error');
  try {
    const { data, error } = await params.client
      .rpc('chat_message_send', args)
      .abortSignal(controller.signal);
    if (error) return { ok: false, reason: reason(), message: error.message };
    if (data === null || data === undefined) {
      return { ok: false, reason: 'error', message: 'chat_message_send returned no row' };
    }
    return { ok: true, row: data as ChatMessageRow };
  } catch (error) {
    return { ok: false, reason: reason(), message: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** A void proc outcome; the message is the raw error for logging. */
export type WriteResult = { ok: true } | { ok: false; message: string };

async function voidProc<
  N extends 'chat_reaction_add' | 'chat_reaction_remove' | 'chat_read_cursor_set',
>(client: Client, fn: N, args: Functions[N]['Args']): Promise<WriteResult> {
  try {
    const { error } = await client.rpc(fn, args);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

export interface ReactionRecordParams {
  client: Client;
  channelId: string;
  messageId: string;
  emoji: string;
  traceId: string;
}

/** Record the caller's reaction (ON CONFLICT DO NOTHING server-side). */
export function addReactionRecord(params: ReactionRecordParams): Promise<WriteResult> {
  return voidProc(params.client, 'chat_reaction_add', {
    p_channel_id: params.channelId,
    p_message_id: params.messageId,
    p_emoji: params.emoji,
    p_trace_id: params.traceId,
  });
}

/** Remove the caller's own reaction. */
export function removeReactionRecord(params: ReactionRecordParams): Promise<WriteResult> {
  return voidProc(params.client, 'chat_reaction_remove', {
    p_channel_id: params.channelId,
    p_message_id: params.messageId,
    p_emoji: params.emoji,
    p_trace_id: params.traceId,
  });
}

export interface ReadCursorParams {
  client: Client;
  channelId: string;
  messageId: string;
  traceId: string;
}

/** Move the caller's read cursor to a message (forward-only server-side). */
export function setReadCursorRecord(params: ReadCursorParams): Promise<WriteResult> {
  return voidProc(params.client, 'chat_read_cursor_set', {
    p_channel_id: params.channelId,
    p_message_id: params.messageId,
    p_trace_id: params.traceId,
  });
}
