// Postgres writes for chat, through the SECURITY DEFINER procs that are the
// only write paths: chat_message_send (the record, called BEFORE Agora),
// chat_reaction_add / chat_reaction_remove, chat_read_cursor_set,
// chat_mark_set / chat_mark_resolve / chat_mark_reopen, chat_message_edit,
// chat_message_delete and
// chat_channel_clear (delete a chat for the caller only). The actor
// is auth.uid() server-side (never passed), and the trace id is the explicit
// p_trace_id parameter of every proc (minted with uuid_v7 at the user action,
// never inferred). The Supabase client is injected so each proc call is
// unit-tested against a recording fake with no database.
//
// The args object is typed against the generated proc signature and built ahead
// of the `.rpc()` call, the same way @srtdio/rpc's callProc passes its args: the
// trace parameter these procs declare is `p_trace_id`, carried explicitly.

import type { Client } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import type { ChatMessageRow } from '@/lib/chat/thread';
import type { AttachmentMetaMap } from '@/lib/chat/attachments';

type Functions = Database['public']['Functions'];

/**
 * The record write is abandoned after this long; for a send that is a
 * transient failure (the outbox retries it), for an edit a failed edit.
 */
export const SEND_TIMEOUT_MS = 10_000;

export interface SendRecordParams {
  client: Client;
  /** Client-generated uuid_v7; a retry passes the SAME id (the proc is idempotent). */
  id: string;
  channelId: string;
  traceId: string;
  body: string;
  attachmentAssetIds: readonly string[];
  /** Mentioned user uuids; omitted when empty (a forward never carries any). */
  mentions?: readonly string[];
  /** Post uuids shared into the message; persisted so history renders the cards. */
  sharedPostIds?: readonly string[];
  /** Brief uuids shared into the message; persisted so history renders the cards. */
  sharedBriefIds?: readonly string[];
  /** The quoted message's id when this is a reply. */
  replyToMessageId?: string | null;
  /** Render metadata per attachment id (mime, name, size, duration, transcript). */
  attachmentMeta?: AttachmentMetaMap;
  /** The source message's id when this send forwards it. */
  forwardedFromMessageId?: string | null;
  /** Override for tests; defaults to SEND_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * A failed record write. `code` is the PostgREST error code (a SQLSTATE or
 * PGRSTxxx) and `status` the HTTP status (0: no answer), when the client got
 * that far; send-errors.ts reads them to tell a refusal from a network problem.
 */
export interface RecordFailed {
  ok: false;
  reason: 'timeout' | 'error';
  message: string;
  code?: string;
  status?: number;
}

export type SendRecordResult = { ok: true; row: ChatMessageRow } | RecordFailed;

/**
 * Write the message to the record via chat_message_send with an abort timeout.
 * An empty body is omitted (the row's body is nullable and CHECKed non-empty
 * when present) and so are an empty attachment list, empty shared posts, no
 * reply and empty attachment meta, matching the proc's defaults. A shared-posts
 * or shared-briefs only send (no body) is valid: the proc accepts body,
 * attachments, posts or briefs. Never throws: a timeout, transport error or proc exception resolves
 * to { ok: false } (with the error code and HTTP status when known) so the
 * caller can classify it: retry a network problem, show Retry on a refusal.
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
    ...(params.mentions !== undefined && params.mentions.length > 0
      ? { p_mentions: [...params.mentions] }
      : {}),
    ...(params.sharedPostIds !== undefined && params.sharedPostIds.length > 0
      ? { p_shared_post_ids: [...params.sharedPostIds] }
      : {}),
    ...(params.sharedBriefIds !== undefined && params.sharedBriefIds.length > 0
      ? { p_shared_brief_ids: [...params.sharedBriefIds] }
      : {}),
    ...(params.replyToMessageId != null && params.replyToMessageId !== ''
      ? { p_reply_to_message_id: params.replyToMessageId }
      : {}),
    ...(params.attachmentMeta !== undefined && Object.keys(params.attachmentMeta).length > 0
      ? { p_attachment_meta: params.attachmentMeta }
      : {}),
    ...(params.forwardedFromMessageId != null && params.forwardedFromMessageId !== ''
      ? { p_forwarded_from_message_id: params.forwardedFromMessageId }
      : {}),
  };
  const reason = (): 'timeout' | 'error' => (controller.signal.aborted ? 'timeout' : 'error');
  try {
    const { data, error, status } = await params.client
      .rpc('chat_message_send', args)
      .abortSignal(controller.signal);
    if (error) {
      return {
        ok: false,
        reason: reason(),
        message: error.message,
        ...(typeof error.code === 'string' && error.code !== '' ? { code: error.code } : {}),
        ...(typeof status === 'number' ? { status } : {}),
      };
    }
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

interface EditRecordParams {
  client: Client;
  channelId: string;
  messageId: string;
  /** The new body; sent as typed (the proc refuses an empty one on a text-only message). */
  body: string;
  /**
   * The COMPLETE current mention list (user uuids), empty when none. The proc
   * treats an omitted or null list as "clear all", so every edit sends it.
   */
  mentions: readonly string[];
  traceId: string;
  /** Override for tests; defaults to SEND_TIMEOUT_MS. */
  timeoutMs?: number;
}

type EditRecordResult = SendRecordResult;

/**
 * Edit the body of an own message via chat_message_edit with an abort timeout.
 * The proc enforces owner, the 15 minute window, not marked and not deleted,
 * and returns the updated row (edited_at set). Never throws: a timeout,
 * transport error or proc exception resolves to { ok: false } with the raw
 * message, which {@link editFailureCopy} maps for the user.
 */
export async function editMessageRecord(params: EditRecordParams): Promise<EditRecordResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? SEND_TIMEOUT_MS);
  const args: Functions['chat_message_edit']['Args'] = {
    p_message_id: params.messageId,
    p_channel_id: params.channelId,
    p_body: params.body.trim(),
    p_mentions: [...params.mentions],
    p_trace_id: params.traceId,
  };
  const reason = (): 'timeout' | 'error' => (controller.signal.aborted ? 'timeout' : 'error');
  try {
    const { data, error } = await params.client
      .rpc('chat_message_edit', args)
      .abortSignal(controller.signal);
    if (error) return { ok: false, reason: reason(), message: error.message };
    if (data === null || data === undefined) {
      return { ok: false, reason: 'error', message: 'chat_message_edit returned no row' };
    }
    return { ok: true, row: data as ChatMessageRow };
  } catch (error) {
    return { ok: false, reason: reason(), message: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** User-facing copy for a failed edit, mapped from the proc's exception text. */
export function editFailureCopy(message: string): string {
  if (/edit window has closed/i.test(message)) return 'Edit window has closed (15 min)';
  // Also matches its own copy, so mapping twice is harmless.
  if (/marked messages (cannot|can't) be edited/i.test(message)) {
    return "Marked messages can't be edited";
  }
  return "Couldn't edit. Try again.";
}

/** User-facing copy for a failed mark; the raw proc text is only ever logged. */
export const MARK_FAILED_COPY = "Couldn't mark. Try again.";

/**
 * User-facing copy for a failed delete, mapped from the proc's exception text
 * the same way edits are. Anything else (transport errors included) reads the
 * generic line, so raw error text never reaches a toast.
 */
export function deleteFailureCopy(message: string): string {
  if (/from the last 30 minutes can be deleted/i.test(message)) {
    return 'Delete window has closed (30 min)';
  }
  if (/marked messages cannot be deleted/i.test(message)) return "Marked messages can't be deleted";
  return "Couldn't delete. Try again.";
}

/**
 * The toast for a chunked delete that stopped at a failing chunk: how many of
 * the selection were deleted, or the mapped failure when none were.
 */
export function deleteOutcomeCopy(deleted: number, total: number, message: string): string {
  if (deleted === 0) return deleteFailureCopy(message);
  return `Couldn't delete ${total - deleted} of ${total}. Try again.`;
}

/** A void proc outcome; the message is the raw error for logging. */
export type WriteResult = { ok: true } | { ok: false; message: string };

async function voidProc<
  N extends
    | 'chat_reaction_add'
    | 'chat_reaction_remove'
    | 'chat_read_cursor_set'
    | 'chat_mark_set'
    | 'chat_mark_resolve'
    | 'chat_mark_reopen'
    | 'chat_message_delete'
    | 'chat_message_remove_files',
>(client: Client, fn: N, args: Functions[N]['Args']): Promise<WriteResult> {
  try {
    const { error } = await client.rpc(fn, args);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

interface ReactionRecordParams {
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

interface ReadCursorParams {
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

export type MarkType = 'commitment' | 'decision' | 'pending';

/** Pending priority: 1 (P1), 2 (P2), or null (unranked). */
export type MarkPriority = 1 | 2 | null;

interface MarkSetParams {
  client: Client;
  channelId: string;
  messageId: string;
  type: MarkType;
  /** Pending only; always null for commitment and decision. */
  priority: MarkPriority;
  traceId: string;
}

/**
 * Mark a message, or (same type 'pending' on an already pending message) change
 * its priority: the proc inserts the first mark and updates priority after.
 * The generated Args type declares p_priority as a plain number because the
 * SQL smallint parameter has no default; SQL NULL (unranked) is valid there, so
 * the args are built with the nullable shape and narrowed once for the call.
 */
export function setMarkRecord(params: MarkSetParams): Promise<WriteResult> {
  const args: Omit<Functions['chat_mark_set']['Args'], 'p_priority'> & {
    p_priority: number | null;
  } = {
    p_message_id: params.messageId,
    p_channel_id: params.channelId,
    p_mark_type: params.type,
    p_priority: params.type === 'pending' ? params.priority : null,
    p_trace_id: params.traceId,
  };
  return voidProc(params.client, 'chat_mark_set', args as Functions['chat_mark_set']['Args']);
}

interface MarkResolveParams {
  client: Client;
  channelId: string;
  messageId: string;
  traceId: string;
}

/** Stamp an open mark of any type (the row stays as history). */
export function resolveMarkRecord(params: MarkResolveParams): Promise<WriteResult> {
  return voidProc(params.client, 'chat_mark_resolve', {
    p_message_id: params.messageId,
    p_channel_id: params.channelId,
    p_trace_id: params.traceId,
  });
}

/** Return a stamped mark to open (resolver and resolved time cleared). */
export function reopenMarkRecord(params: MarkResolveParams): Promise<WriteResult> {
  return voidProc(params.client, 'chat_mark_reopen', {
    p_message_id: params.messageId,
    p_channel_id: params.channelId,
    p_trace_id: params.traceId,
  });
}

/** The proc's per-call cap on chat_message_delete ids. */
const DELETE_CHUNK_SIZE = 100;

/** Split ids into consecutive chunks of at most `size` (order kept). */
export function chunkIds(ids: readonly string[], size: number = DELETE_CHUNK_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

interface DeleteMessagesParams {
  client: Client;
  channelId: string;
  messageIds: readonly string[];
  traceId: string;
  /** Called after each chunk the record accepted, with that chunk's ids. */
  onChunkDeleted?: (ids: string[]) => void;
}

/** Deleted ids so far, plus the proc's message when a chunk failed. */
type DeleteMessagesResult =
  | { ok: true; deleted: string[] }
  | { ok: false; deleted: string[]; message: string };

/**
 * Soft-delete own messages for everyone through chat_message_delete, chunked at
 * DELETE_CHUNK_SIZE ids per call and run in order. The first failing chunk stops
 * the run; the chunks already accepted stay deleted and are reported.
 */
export async function deleteMessagesRecord(
  params: DeleteMessagesParams,
): Promise<DeleteMessagesResult> {
  const deleted: string[] = [];
  for (const chunk of chunkIds(params.messageIds)) {
    const result = await voidProc(params.client, 'chat_message_delete', {
      p_message_ids: chunk,
      p_channel_id: params.channelId,
      p_trace_id: params.traceId,
    });
    if (!result.ok) return { ok: false, deleted, message: result.message };
    deleted.push(...chunk);
    params.onChunkDeleted?.(chunk);
  }
  return { ok: true, deleted };
}

interface ClearChannelParams {
  client: Client;
  channelId: string;
  traceId: string;
  /** Override for tests; defaults to SEND_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Delete a chat for the caller only through chat_channel_clear: the proc
 * upserts the caller's cleared_at, and the read policy then hides every row at
 * or before it. Other members keep their copy; the channel row stays. Aborted
 * after SEND_TIMEOUT_MS. Never throws: any failure resolves to { ok: false }.
 */
export async function clearChannelRecord(params: ClearChannelParams): Promise<WriteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? SEND_TIMEOUT_MS);
  const args: Functions['chat_channel_clear']['Args'] = {
    p_channel_id: params.channelId,
    p_trace_id: params.traceId,
  };
  try {
    const { error } = await params.client
      .rpc('chat_channel_clear', args)
      .abortSignal(controller.signal);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Upper bound of asset ids per chat_message_remove_files call (the proc refuses more). */
export const REMOVE_FILES_CHUNK_SIZE = 100;

/** One file to remove: its message and its asset id. */
export interface RemoveFileTarget {
  messageId: string;
  assetId: string;
}

interface RemoveFilesParams {
  client: Client;
  channelId: string;
  files: readonly RemoveFileTarget[];
  traceId: string;
  /** Called after each chunk the record accepted, with that chunk's files. */
  onChunkRemoved?: (files: RemoveFileTarget[]) => void;
}

/** Removed files so far, plus the proc's message when a chunk failed. */
type RemoveFilesResult =
  | { ok: true; removed: RemoveFileTarget[] }
  | { ok: false; removed: RemoveFileTarget[]; message: string };

/**
 * Remove own files from their messages through chat_message_remove_files,
 * chunked at REMOVE_FILES_CHUNK_SIZE asset ids per call and run in order. Each
 * call names the messages of its own files. The first failing chunk stops the
 * run; the chunks already accepted stay removed and are reported.
 */
export async function removeFilesRecord(params: RemoveFilesParams): Promise<RemoveFilesResult> {
  const removed: RemoveFileTarget[] = [];
  for (let i = 0; i < params.files.length; i += REMOVE_FILES_CHUNK_SIZE) {
    const chunk = params.files.slice(i, i + REMOVE_FILES_CHUNK_SIZE);
    const result = await voidProc(params.client, 'chat_message_remove_files', {
      p_channel_id: params.channelId,
      p_message_ids: [...new Set(chunk.map((f) => f.messageId))],
      p_asset_ids: chunk.map((f) => f.assetId),
      p_trace_id: params.traceId,
    });
    if (!result.ok) return { ok: false, removed, message: result.message };
    removed.push(...chunk);
    params.onChunkRemoved?.(chunk);
  }
  return { ok: true, removed };
}
