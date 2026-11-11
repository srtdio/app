// Work-chat threads (Slack way, 8 Nov 2026): every reply is a thread. The
// main chat shows only top-level messages; a root carries a replies row (up to
// 3 latest repliers, "N replies", the last reply's time, an unread dot). This module holds the four thread procs' client wrappers and the pure
// rules every surface reads: which rows are top level, the replies row data,
// the open rule (B), the participant rule for alerts, the chat list and alert
// copy, and the per-device thread read point that places the "New" line.
// Framework-free, so every rule is unit-tested without a DOM.

import { stripFormat } from '@srtdio/comments';
import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable, withReadTimeout } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import { resolveMentionText } from '@/lib/chat/mentions';

type Functions = Database['public']['Functions'];
type ThreadForMeRow = Functions['chat_threads_for_me']['Returns'][number];

/** One thread I am in (chat_threads_for_me): unread first, newest reply first, max 50. */
export interface ThreadForMe {
  rootId: string;
  replyCount: number;
  lastReplyAt: string;
  lastReplyId: string;
  lastReplySender: string | null;
  lastReplyBody: string;
  unread: boolean;
}

/** A row from the proc as the client's shape. Pure. */
export function toThreadForMe(row: ThreadForMeRow): ThreadForMe {
  return {
    rootId: row.root_message_id,
    replyCount: Number(row.reply_count),
    lastReplyAt: row.last_reply_at,
    lastReplyId: row.last_reply_id,
    lastReplySender: row.last_reply_sender ?? null,
    lastReplyBody: row.last_reply_body ?? '',
    unread: row.unread === true,
  };
}

/**
 * Threads launched 8 Nov 2026 (the schema day). Before it every reply showed in the main chat,
 * where reading the chat read it, and no thread read point exists for it: a
 * thread whose newest reply is older than the launch starts read, so no chat
 * opens onto the Threads sheet for history.
 */
export const THREADS_SINCE_MS = Date.parse('2026-11-08T00:00:00Z');

/** A thread whose newest reply predates the launch reads as read. Pure. */
export function readBeforeLaunch(thread: ThreadForMe): ThreadForMe {
  const at = Date.parse(thread.lastReplyAt);
  return thread.unread && !Number.isNaN(at) && at < THREADS_SINCE_MS
    ? { ...thread, unread: false }
    : thread;
}

/**
 * The threads I am in for a chat: one call, started in parallel with the first
 * history page (never awaited before the first paint). 5s timeout.
 */
export function loadThreadsForMe(
  client: Client,
  channelId: string,
  traceId: string,
): Promise<Result<ThreadForMe[]>> {
  return withReadTimeout(async (signal) => {
    const args: Functions['chat_threads_for_me']['Args'] = {
      p_channel_id: channelId,
      p_trace_id: traceId,
    };
    const { data, error } = await abortable(client.rpc('chat_threads_for_me', args), signal);
    if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
    return {
      ok: true,
      data: ((data ?? []) as ThreadForMeRow[]).map(toThreadForMe).map(readBeforeLaunch),
    };
  });
}

type ThreadForMeAllRow = Functions['chat_threads_for_me_all']['Returns'][number];

/** One thread I am in, anywhere in the workspace (chat_threads_for_me_all): its chat too. */
export interface ThreadForMeAll extends ThreadForMe {
  channelId: string;
}

/**
 * Every thread I am in across the workspace's chats (Activity's Threads
 * button): one call, unread first, newest reply first, max 50, pre-launch
 * threads read (readBeforeLaunch). Started after the first paint, never
 * awaited before it. 5s timeout.
 */
export function loadThreadsForMeAll(
  client: Client,
  workspaceId: string,
  traceId: string,
): Promise<Result<ThreadForMeAll[]>> {
  return withReadTimeout(async (signal) => {
    const args: Functions['chat_threads_for_me_all']['Args'] = {
      p_workspace_id: workspaceId,
      p_trace_id: traceId,
    };
    const { data, error } = await abortable(client.rpc('chat_threads_for_me_all', args), signal);
    if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
    return {
      ok: true,
      data: ((data ?? []) as ThreadForMeAllRow[]).map((row) => ({
        ...readBeforeLaunch(toThreadForMe(row)),
        channelId: row.channel_id,
      })),
    };
  });
}

/** A void proc outcome; the message is the raw error for logging. */
export type ThreadWriteResult = { ok: true } | { ok: false; message: string };

async function voidThreadProc<
  N extends 'chat_thread_read_set' | 'chat_thread_mark_unread' | 'chat_mark_unread',
>(client: Client, fn: N, args: Functions[N]['Args']): Promise<ThreadWriteResult> {
  try {
    const { error } = await client.rpc(fn, args);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

/** Forward-only thread read mark at `messageId` (the root or a reply of it). */
export function setThreadRead(params: {
  client: Client;
  channelId: string;
  rootId: string;
  messageId: string;
  traceId: string;
}): Promise<ThreadWriteResult> {
  return voidThreadProc(params.client, 'chat_thread_read_set', {
    p_channel_id: params.channelId,
    p_root_id: params.rootId,
    p_message_id: params.messageId,
    p_trace_id: params.traceId,
  });
}

/** L11 on a thread reply: the thread's read point moves to just before it. */
export function markThreadUnread(params: {
  client: Client;
  channelId: string;
  rootId: string;
  messageId: string;
  traceId: string;
}): Promise<ThreadWriteResult> {
  return voidThreadProc(params.client, 'chat_thread_mark_unread', {
    p_channel_id: params.channelId,
    p_root_id: params.rootId,
    p_message_id: params.messageId,
    p_trace_id: params.traceId,
  });
}

/** L11 on a main-chat message: my chat cursor moves to just before it; my counter is recomputed. */
export function markChatUnread(params: {
  client: Client;
  channelId: string;
  messageId: string;
  traceId: string;
}): Promise<ThreadWriteResult> {
  return voidThreadProc(params.client, 'chat_mark_unread', {
    p_channel_id: params.channelId,
    p_message_id: params.messageId,
    p_trace_id: params.traceId,
  });
}

/**
 * Whether a message belongs in the main chat: not a thread reply. A recorded
 * reply carries its root (the server trigger); an own reply not recorded yet
 * carries its quote (every reply targets a root). Pure.
 */
export function isTopLevel(message: Pick<ThreadMessage, 'threadRootId' | 'reply'>): boolean {
  if (typeof message.threadRootId === 'string') return false;
  return message.reply === null;
}

/** The root a reply belongs to: its recorded root, else its quote's root or quote. Pure. */
export function threadRootOf(
  message: Pick<ThreadMessage, 'id' | 'threadRootId' | 'reply'>,
): string {
  if (typeof message.threadRootId === 'string') return message.threadRootId;
  if (message.reply !== null) return message.reply.rootId ?? message.reply.id;
  return message.id;
}

/** The main chat's rows: top-level messages only (thread replies never show there). Pure. */
export function mainChatMessages<T extends Pick<ThreadMessage, 'threadRootId' | 'reply'>>(
  messages: readonly T[],
): T[] {
  return messages.filter(isTopLevel);
}

/** A root's replies row, from the loaded rows (and the threads-for-me unread flag). */
export interface RepliesInfo {
  count: number;
  /** Up to 3 latest distinct repliers, oldest of them first: the latest replier is last (next to the count). */
  repliers: string[];
  /** The latest live reply. */
  last: ThreadMessage | null;
  unread: boolean;
}

/** The replies row's most photos. */
export const REPLIES_ROW_PHOTOS = 3;

/**
 * Every loaded root's replies row: one pass over the loaded rows (loaded
 * history is contiguous back to the oldest page, so a loaded root has every
 * reply loaded too). Deleted replies are not counted. `unreadOf` reads the
 * threads-for-me flag. Pure.
 */
export function repliesInfoByRoot(
  messages: readonly ThreadMessage[],
  unreadOf: (rootId: string) => boolean = () => false,
): Map<string, RepliesInfo> {
  const byRoot = new Map<string, ThreadMessage[]>();
  for (const m of messages) {
    // A refused (failed) reply never counts, like localReplyCounts.
    if (isTopLevel(m) || m.deleted === true || m.state === 'failed') continue;
    const root = threadRootOf(m);
    const list = byRoot.get(root);
    if (list === undefined) byRoot.set(root, [m]);
    else list.push(m);
  }
  const out = new Map<string, RepliesInfo>();
  for (const [root, replies] of byRoot) {
    const sorted = [...replies].sort((a, b) => a.time - b.time);
    const repliers: string[] = [];
    for (let i = sorted.length - 1; i >= 0 && repliers.length < REPLIES_ROW_PHOTOS; i -= 1) {
      const sender = sorted[i]?.senderUserId;
      if (sender != null && !repliers.includes(sender)) repliers.push(sender);
    }
    // Collected newest first; drawn with the latest replier last (right-most).
    repliers.reverse();
    out.set(root, {
      count: sorted.length,
      repliers,
      last: sorted[sorted.length - 1] ?? null,
      unread: unreadOf(root),
    });
  }
  return out;
}

/** "1 reply" / "N replies". Pure. */
export function repliesLabel(count: number): string {
  return count === 1 ? '1 reply' : `${count} replies`;
}

/** An unknown mention's name in a one-line preview: never a raw code. */
export const UNKNOWN_MENTION_NAME = 'someone';

/**
 * A body's first line for one-line previews: each @[uuid] reads "@Name" from
 * the caller's in-memory lookup ("@someone" when unknown), format stripped,
 * trimmed. Pure.
 */
export function firstLineOf(
  body: string,
  nameOf: (userId: string) => string | undefined = () => undefined,
): string {
  const named = resolveMentionText(body, (id) => nameOf(id) || UNKNOWN_MENTION_NAME);
  const line =
    stripFormat(named)
      .split('\n')
      .find((l) => l.trim() !== '') ?? '';
  return line.trim();
}

/** L5 (2): the chat list preview when the newest message is a thread reply. Pure. */
export function threadPreviewLine(
  name: string,
  body: string,
  nameOf?: (userId: string) => string | undefined,
): string {
  return `${name} in thread: ${firstLineOf(body, nameOf)}`;
}

/** L5 (1): the in-app alert text for a thread reply. Pure. */
export function threadAlertText(name: string, body: string): string {
  return `${name} replied in thread: ${firstLineOf(body)}`;
}

/** Chats of this many members or fewer: every member is in every thread. */
export const SMALL_CHAT_MEMBERS = 6;

/**
 * L5 participant rule: whether `userId` hears about a thread reply. In a chat
 * of 6 or fewer members everyone does; else the root sender, anyone who
 * replied, and anyone @mentioned in the root or a reply. Mirrors
 * chat_threads_for_me. Pure.
 */
export function isThreadParticipant(input: {
  userId: string;
  memberCount: number;
  root: Pick<ThreadMessage, 'senderUserId' | 'mentions'> | null;
  replies: readonly Pick<ThreadMessage, 'senderUserId' | 'mentions'>[];
}): boolean {
  if (input.memberCount <= SMALL_CHAT_MEMBERS) return true;
  const named = (m: Pick<ThreadMessage, 'senderUserId' | 'mentions'>): boolean =>
    m.senderUserId === input.userId || (m.mentions ?? []).includes(input.userId);
  if (input.root !== null && named(input.root)) return true;
  return input.replies.some(named);
}

/**
 * L6b open rule (B). Unread top-level messages (not mine, after my cursor)
 * open at the "New" line; else unread threads open straight onto the Threads
 * sheet, but only when the threads-for-me call landed before the first paint
 * (a late answer shows the strip item only, never a sheet popping in); else
 * the chat opens as today. Pure.
 */
export type OpenTarget = 'new-line' | 'threads' | 'chat';

export function chatOpenTarget(input: {
  unreadTopLevel: number;
  /** null while the threads-for-me call has not landed. */
  threads: readonly Pick<ThreadForMe, 'unread'>[] | null;
  painted: boolean;
}): OpenTarget {
  if (input.unreadTopLevel > 0) return 'new-line';
  if (input.threads === null || input.painted) return 'chat';
  return input.threads.some((t) => t.unread) ? 'threads' : 'chat';
}

/** Top-level messages after my cursor that are not mine (the open rule's first test). Pure. */
export function unreadTopLevelCount(
  messages: readonly Pick<ThreadMessage, 'threadRootId' | 'reply' | 'mine' | 'createdAt'>[],
  cursorAt: string | null,
): number {
  if (cursorAt === null) return 0;
  const at = Date.parse(cursorAt);
  return messages.filter(
    (m) => isTopLevel(m) && !m.mine && m.createdAt !== '' && Date.parse(m.createdAt) > at,
  ).length;
}

/** L5 (4): the status strip item "N threads", or null with none unread. Pure. */
export function threadsStripLabel(threads: readonly Pick<ThreadForMe, 'unread'>[]): string | null {
  const n = threads.filter((t) => t.unread).length;
  if (n === 0) return null;
  return n === 1 ? '1 thread' : `${n} threads`;
}

/** Mark one thread read in the threads-for-me list (a local patch after opening it). Pure. */
export function withThreadRead(threads: readonly ThreadForMe[], rootId: string): ThreadForMe[] {
  return threads.map((t) => (t.rootId === rootId ? { ...t, unread: false } : t));
}

/** Mark one thread unread in the list (Mark unread on a reply). Pure. */
export function withThreadUnread(threads: readonly ThreadForMe[], rootId: string): ThreadForMe[] {
  return threads.map((t) => (t.rootId === rootId ? { ...t, unread: true } : t));
}

// The per-device thread read point (the server's chat_thread_reads is reachable
// only through its procs, which return nothing): where the "New" line sits
// when an unread thread opens. localStorage, wrapped: a blocked store falls
// back to "after my last own reply".
const READ_KEY = 'srtdio.chat.threadRead';

function readStore(): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(READ_KEY);
    const parsed: unknown = raw != null ? JSON.parse(raw) : {};
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** The time I last read a thread to on this device; null when never. */
export function localThreadReadAt(rootId: string): number | null {
  const at = readStore()[rootId];
  return typeof at === 'number' ? at : null;
}

/** Remember reading a thread to `timeMs` (forward only; `force` moves it back for Mark unread). */
export function rememberThreadRead(rootId: string, timeMs: number, force = false): void {
  try {
    const store = readStore();
    const was = store[rootId];
    if (!force && typeof was === 'number' && was >= timeMs) return;
    store[rootId] = timeMs;
    const keys = Object.keys(store);
    // Bounded: the 300 newest marks only.
    if (keys.length > 300) {
      keys
        .sort((a, b) => (store[a] ?? 0) - (store[b] ?? 0))
        .slice(0, keys.length - 300)
        .forEach((k) => delete store[k]);
    }
    globalThis.localStorage?.setItem(READ_KEY, JSON.stringify(store));
  } catch {
    // A blocked store keeps no mark; the fallback rule places the line.
  }
}

/**
 * L4/L7: the reply the thread's "New" line sits above: the first reply not
 * mine after my read point (this device's, else my last own reply in the
 * thread, else the root). Null when the thread is not unread. Pure.
 */
export function firstUnreadReply(
  replies: readonly Pick<ThreadMessage, 'id' | 'mine' | 'time'>[],
  input: { unread: boolean; readAt: number | null },
): string | null {
  if (!input.unread) return null;
  let after = input.readAt;
  if (after === null) {
    const ownTimes = replies.filter((r) => r.mine).map((r) => r.time);
    after = ownTimes.length > 0 ? Math.max(...ownTimes) : Number.NEGATIVE_INFINITY;
  }
  const first = replies.find((r) => !r.mine && r.time > (after ?? Number.NEGATIVE_INFINITY));
  return first?.id ?? null;
}
