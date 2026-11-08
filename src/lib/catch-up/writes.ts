// Catch up's writes. Each is idempotent and carries its own trace id (minted
// by the caller at the tap). Mark as read: the entry (inbox_mark_read_ids),
// plus the chat's own read point for a chat card (a thread: chat_thread_read_set
// to the newest reply; the main chat: the read cursor at the message). Undo of
// a read: the entry back to unread (inbox_mark_unread_ids) and the same
// message unread in the chat (chat_thread_mark_unread / chat_mark_unread).
// Keep unread writes nothing. The caller is optimistic; a failure here is a
// toast and the card stays.

import type { Client } from '@srtdio/rpc';
import { inboxMarkAllRead } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import type { ActivityItem } from '@/components/pages/activity/data';
import { setReadCursorRecord } from '@/lib/chat/record';
import { markChatUnread, markThreadUnread, setThreadRead } from '@/lib/chat/thread-signals';
import { catchUpCardKind } from '@/lib/catch-up/copy';

type Functions = Database['public']['Functions'];

/** A write's outcome; the message is the raw error, for the log only. */
export type CatchUpWrite = { ok: true } | { ok: false; message: string };

/** The chat point a chat card writes: its chat, thread root and message. Null for a non-chat card. */
export interface ChatPoint {
  channelId: string;
  /** The thread's root; null for a main-chat mention. */
  rootId: string | null;
  /** The message the entry is about. */
  messageId: string;
}

/** The chat point an entry names, or null (a non-chat card or a row missing its ids). Pure. */
export function chatPointOf(item: ActivityItem): ChatPoint | null {
  const kind = catchUpCardKind(item);
  if (kind !== 'chat-thread' && kind !== 'chat-main' && kind !== 'thread-started') return null;
  if (item.entityId === null || item.messageId === null) return null;
  return {
    channelId: item.entityId,
    rootId: kind === 'chat-main' ? null : (item.threadRootId ?? null),
    messageId: item.messageId,
  };
}

async function entryProc(
  client: Client,
  fn: 'inbox_mark_read_ids' | 'inbox_mark_unread_ids',
  workspaceId: string,
  ids: string[],
  traceId: string,
): Promise<CatchUpWrite> {
  const args: Functions[typeof fn]['Args'] = {
    p_workspace_id: workspaceId,
    p_ids: ids,
    p_trace_id: traceId,
  };
  try {
    const { error } = await client.rpc(fn, args);
    return error ? { ok: false, message: error.message } : { ok: true };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

function both(a: CatchUpWrite, b: CatchUpWrite): CatchUpWrite {
  if (!a.ok) return a;
  return b;
}

/**
 * Mark one entry read, and its chat point for a chat card. `latestReplyId` is
 * the newest reply the card read (a thread is read to it); the message itself
 * when unknown.
 */
export async function markCatchUpRead(
  client: Client,
  input: { workspaceId: string; item: ActivityItem; latestReplyId?: string | null; traceId: string },
): Promise<CatchUpWrite> {
  const point = chatPointOf(input.item);
  const [entry, chat] = await Promise.all([
    entryProc(client, 'inbox_mark_read_ids', input.workspaceId, [input.item.id], input.traceId),
    point === null
      ? Promise.resolve<CatchUpWrite>({ ok: true })
      : point.rootId !== null
        ? setThreadRead({
            client,
            channelId: point.channelId,
            rootId: point.rootId,
            messageId: input.latestReplyId ?? point.messageId,
            traceId: input.traceId,
          })
        : setReadCursorRecord({
            client,
            channelId: point.channelId,
            messageId: point.messageId,
            traceId: input.traceId,
          }),
  ]);
  return both(entry, chat);
}

/** Undo a Mark as read: the entry unread again, and the same message unread in its chat. */
export async function undoCatchUpRead(
  client: Client,
  input: { workspaceId: string; item: ActivityItem; traceId: string },
): Promise<CatchUpWrite> {
  const point = chatPointOf(input.item);
  const [entry, chat] = await Promise.all([
    entryProc(client, 'inbox_mark_unread_ids', input.workspaceId, [input.item.id], input.traceId),
    point === null
      ? Promise.resolve<CatchUpWrite>({ ok: true })
      : point.rootId !== null
        ? markThreadUnread({
            client,
            channelId: point.channelId,
            rootId: point.rootId,
            messageId: point.messageId,
            traceId: input.traceId,
          })
        : markChatUnread({
            client,
            channelId: point.channelId,
            messageId: point.messageId,
            traceId: input.traceId,
          }),
  ]);
  return both(entry, chat);
}

/** Long-press Mark as read: every unread entry of the workspace read (inbox_mark_all_read). */
export async function markAllCatchUpRead(
  client: Client,
  input: { workspaceId: string; traceId: string },
): Promise<CatchUpWrite> {
  const res = await inboxMarkAllRead(client, {
    p_workspace_id: input.workspaceId,
    p_trace_id: input.traceId,
  });
  return res.ok ? { ok: true } : { ok: false, message: res.error.message };
}
