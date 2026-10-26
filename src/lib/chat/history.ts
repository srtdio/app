// Postgres reads for chat: public.chat_messages is the record and the only
// history read path (Agora is never read for history). Every read is
// RLS-scoped through the injected client (mirroring src/lib/chat-reads.ts), so
// these helpers are unit-tested against a recording fake with no database.
//
// A chat open is ONE chat_open_bundle RPC (readChatOpenBundle, at the bottom
// of this file; SECURITY INVOKER, so RLS applies): the latest page, its quoted
// and thread root rows, its reactions, the channel's read cursors, reply
// counts, marks, the viewer's scheduled rows, open posts, open briefs and the
// shared plan ids, in one round trip. With p_since it is also the reopen
// revalidation (every row from the remembered page's contiguous end). It
// replaced the separate per-open reads (latest page prefetch, quoted ids,
// reactions, read positions, marks, open posts, briefs, plan ids). The
// per-table SELECTs below remain for everything after the open: load older,
// thread pages, jump, live verification, retry and fallback reads.
//
// Pagination is keyset on (created_at, id), the exact order of the
// chat_messages_channel_created_idx index: a latest page is
// ORDER BY created_at DESC, id DESC LIMIT 50, "load older" continues from the
// oldest loaded (created_at, id) with a PostgREST or-filter for the compound
// cursor, and a newer read takes everything after the newest loaded pair.
// Reactions outside the bundle come as one IN query over the loaded ids, never
// one per message.
//
// Deleted rows: RLS returns them to members with every content column nulled.
// The reads that feed the thread (latest, older, catch-up, jump, quoted ids)
// keep them so they render as tombstones. The live verifier (loadMessageById,
// which also gates the store's unread bumps) and the conversation previews
// keep the deleted_at filter: a deleted message is never counted or shown as
// a chat's last line.
//
// Partition bounds: chat_messages is RANGE (created_at) partitioned by month,
// so every list read (latest, older, catch-up, thread pages, previews) carries
// a lower AND an upper created_at bound and Postgres opens only the months it
// covers. Pages walk back through bounded windows (bounded-window.ts): 30 days
// from the page's edge, widening backwards until the page is full or the
// channel's oldest row (read once, cached) is reached, so no older message is
// ever hidden.
//
// Every read here is bounded by withReadTimeout (5s): a hang resolves to a
// failed Result, so no caller can wait forever on one, and the request is
// aborted on the wire (.abortSignal). The raw readers (read*) are unbounded
// for callers that let a late answer win (withLateRead).

import { withTraceHeader, type Client, type Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable, withLinkedSignal, withReadTimeout } from '@/lib/chat-reads';
import {
  ceilingNowMs,
  OldestCache,
  readBoundedPage,
  SERVER_NOW_MARGIN_MS,
  upperFromNow,
  type TimeBounds,
} from '@/lib/chat/bounded-window';
import {
  classifyAttachment,
  parseAttachmentMeta,
  type AttachmentKind,
  type MessageAttachment,
} from '@/lib/chat/attachments';
import type { ChatMessageRow, MessageCursor, MessageReaction } from '@/lib/chat/thread';
import type { ReadCursorRow } from '@/lib/chat/read-receipts';
import { THREAD_COUNT_ROOT_LIMIT } from '@/lib/chat/thread-rail';
import { rowToMark, type ChatMark } from '@/lib/chat/marks';
import { soonestFirst, type ScheduledRow } from '@/lib/chat/scheduled';
import type { OpenBriefRow } from '@/lib/chat/use-status-counts';
import type { OpenPostRow } from '../../../packages/posts/src/reads';

/** History page size; also the "has more" probe (a full page means keep paging). */
export const HISTORY_PAGE_SIZE = 50;

/** Upper bound on one catch-up read; a longer gap is caught up on the next page. */
export const CATCH_UP_LIMIT = 200;

/** Bounded read behind the conversation previews (latest message per channel). */
const PREVIEW_SCAN_LIMIT = 200;

type ChatReactionRow = Database['public']['Tables']['chat_reactions']['Row'];
type ChatReadCursorRow = Database['public']['Tables']['chat_read_cursors']['Row'];
type UnreadCountRow = Database['public']['Functions']['chat_unread_counts']['Returns'][number];
/** The 4-arg (p_since) chat_thread_reply_counts; the 3-arg one is pending removal. */
type ThreadReplyCountsArgs = Extract<
  Database['public']['Functions']['chat_thread_reply_counts'],
  { Args: { p_since: string } }
>['Args'];
type ThreadReplyCountRow =
  Database['public']['Functions']['chat_thread_reply_counts']['Returns'][number];

const MESSAGE_COLUMNS =
  'id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids, shared_post_ids, shared_brief_ids, shared_plan_ids, reply_to_message_id, forwarded_from_message_id, attachment_meta, agora_event_id, created_at, edited_at, deleted_at, thread_root_message_id, removed_files';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/**
 * PostgREST or-filter selecting rows strictly BEFORE a (created_at, id) cursor in
 * the DESC, DESC order. Values are double-quoted, the PostgREST syntax for values
 * carrying reserved characters (a timestamptz holds '.', ':' and '+').
 */
export function olderThanFilter(cursor: MessageCursor): string {
  return `created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lt."${cursor.id}")`;
}

/** PostgREST or-filter selecting rows strictly AFTER a (created_at, id) cursor. */
export function newerThanFilter(cursor: MessageCursor): string {
  return `created_at.gt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.gt."${cursor.id}")`;
}

/** One history page, oldest-first, plus whether an older page may exist. */
export interface HistoryPage {
  rows: ChatMessageRow[];
  hasMore: boolean;
}

function toPage(rows: ChatMessageRow[]): HistoryPage {
  return { rows: [...rows].reverse(), hasMore: rows.length >= HISTORY_PAGE_SIZE };
}

/** Each channel's oldest created_at, read once per session (the paging floor). */
const oldestByChannel = new OldestCache<string>();

/** Each workspace's oldest chat message time, read once per session (the preview scan's floor). */
const oldestByWorkspace = new OldestCache<string>();

/**
 * A channel's oldest created_at, deleted rows included (they still render as
 * tombstones), or null for an empty channel. One ordered LIMIT 1 read, cached.
 */
function readChannelOldest(
  client: Client,
  channelId: string,
  signal?: AbortSignal,
): Promise<Result<string | null>> {
  return oldestByChannel.read(channelId, async () => {
    const res = await abortable(
      client
        .from('chat_messages')
        .select('created_at')
        .eq('channel_id', channelId)
        .order('created_at', { ascending: true })
        .limit(1),
      signal,
    );
    if (res.error) return fail(`readChannelOldest: ${res.error.message}`);
    const first = ((res.data ?? []) as Pick<ChatMessageRow, 'created_at'>[])[0];
    return { ok: true, data: first !== undefined ? first.created_at : null };
  });
}

/**
 * One newest-first history page of a channel (optionally one thread), read
 * through partition-bounded windows. `before` continues from the oldest
 * loaded row; without it the page starts at the server's now (upperFromNow).
 */
async function readHistoryPage(
  client: Client,
  channelId: string,
  opts: {
    before?: MessageCursor | undefined;
    threadRootId?: string | undefined;
    signal?: AbortSignal | undefined;
    label: string;
  },
): Promise<Result<HistoryPage>> {
  const { before, threadRootId, signal, label } = opts;
  const res = await readBoundedPage<ChatMessageRow>({
    pageSize: HISTORY_PAGE_SIZE,
    upper: before !== undefined ? before.createdAt : upperFromNow(),
    upperInclusive: before !== undefined,
    openEnded: before === undefined,
    oldest: () => readChannelOldest(client, channelId, signal),
    read: async (bounds: TimeBounds, limit: number) => {
      const base = client
        .from('chat_messages')
        .select(MESSAGE_COLUMNS)
        .eq('channel_id', channelId)
        .gte('created_at', bounds.from);
      const capped =
        bounds.to === null
          ? base
          : bounds.toInclusive
            ? base.lte('created_at', bounds.to)
            : base.lt('created_at', bounds.to);
      const threaded =
        threadRootId !== undefined ? capped.eq('thread_root_message_id', threadRootId) : capped;
      const keyed = before !== undefined ? threaded.or(olderThanFilter(before)) : threaded;
      const page = await abortable(
        keyed
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit),
        signal,
      );
      if (page.error) return fail(`${label}: ${page.error.message}`);
      return { ok: true, data: (page.data ?? []) as ChatMessageRow[] };
    },
  });
  if (!res.ok) return res;
  return { ok: true, data: toPage(res.data) };
}

/** The newest page of a channel (50 rows, returned oldest-first). 5s timeout. */
export function loadLatestMessages(
  client: Client,
  channelId: string,
): Promise<Result<HistoryPage>> {
  return withReadTimeout((signal) => queryLatestMessages(client, channelId, signal));
}

/** Forget every paging floor (sign-out, user or workspace change). */
export function clearMessagePrefetch(): void {
  oldestByChannel.clear();
  oldestByWorkspace.clear();
}

/** The latest-page read itself (partition-bounded, no timeout); `signal` cancels it. */
function queryLatestMessages(
  client: Client,
  channelId: string,
  signal?: AbortSignal,
): Promise<Result<HistoryPage>> {
  return readHistoryPage(client, channelId, { signal, label: 'loadLatestMessages' });
}

/**
 * The page before `cursor` (the oldest loaded row), returned oldest-first. A
 * `signal` cancels the request (.abortSignal); an aborted read is a failure.
 */
export function loadOlderMessages(
  client: Client,
  channelId: string,
  cursor: MessageCursor,
  signal?: AbortSignal,
): Promise<Result<HistoryPage>> {
  return withReadTimeout((deadline) =>
    withLinkedSignal(deadline, signal, (s) =>
      readHistoryPage(client, channelId, { before: cursor, signal: s, label: 'loadOlderMessages' }),
    ),
  );
}

/**
 * Everything recorded after `cursor` (the newest loaded row), oldest-first.
 * Bounded from the cursor up to the server's now (or the cursor, if later)
 * plus a minute, so only the months since the cursor are opened; before the
 * server clock is known, bounded below only.
 */
export function loadNewerMessages(
  client: Client,
  channelId: string,
  cursor: MessageCursor,
  signal?: AbortSignal,
): Promise<Result<ChatMessageRow[]>> {
  return withReadTimeout(async (deadline) => {
    const ceiling = catchUpCeiling(cursor);
    const base = client
      .from('chat_messages')
      .select(MESSAGE_COLUMNS)
      .eq('channel_id', channelId)
      .gte('created_at', cursor.createdAt);
    const query = (ceiling !== null ? base.lt('created_at', ceiling) : base)
      .or(newerThanFilter(cursor))
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(CATCH_UP_LIMIT);
    const res = await withLinkedSignal(deadline, signal, async (s) => abortable(query, s));
    if (res.error) return fail(`loadNewerMessages: ${res.error.message}`);
    return { ok: true, data: (res.data ?? []) as ChatMessageRow[] };
  });
}

/**
 * The catch-up read's upper bound: the latest of the device clock, the server
 * estimate and the cursor (ceilingNowMs, then the cursor), plus
 * SERVER_NOW_MARGIN_MS; null (no upper bound) before the server clock is known.
 */
function catchUpCeiling(cursor: MessageCursor): string | null {
  const now = ceilingNowMs();
  if (now === null) return null;
  const at = Date.parse(cursor.createdAt);
  return new Date(Math.max(now, Number.isNaN(at) ? now : at) + SERVER_NOW_MARGIN_MS).toISOString();
}

/** One row looked up by id: found, or absent (never recorded, deleted, or not visible under RLS). */
export type MessageLookup = { found: true; row: ChatMessageRow } | { found: false };

/**
 * One chat_messages row by its Sorted id, RLS-scoped. Used to verify a live
 * Agora message against the record before it renders: only a row the caller
 * can read is shown.
 */
export function loadMessageById(client: Client, messageId: string): Promise<Result<MessageLookup>> {
  return withReadTimeout(async (signal) => {
    const res = await abortable(
      client
        .from('chat_messages')
        .select(MESSAGE_COLUMNS)
        .eq('id', messageId)
        .is('deleted_at', null),
      signal,
    ).maybeSingle();
    if (res.error) return fail(`loadMessageById: ${res.error.message}`);
    const row = res.data as ChatMessageRow | null;
    return { ok: true, data: row === null ? { found: false } : { found: true, row } };
  });
}

/**
 * Rows for a batch of ids (quoted messages of replies); one IN query, empty in,
 * empty out. Deleted rows are included so a quote reads "Message deleted".
 */
export async function loadMessagesByIds(
  client: Client,
  messageIds: readonly string[],
  signal?: AbortSignal,
): Promise<Result<ChatMessageRow[]>> {
  if (messageIds.length === 0) return { ok: true, data: [] };
  return withReadTimeout(async (deadline) => {
    const query = client
      .from('chat_messages')
      .select(MESSAGE_COLUMNS)
      .in('id', [...messageIds]);
    const res = await withLinkedSignal(deadline, signal, async (s) => abortable(query, s));
    if (res.error) return fail(`loadMessagesByIds: ${res.error.message}`);
    return { ok: true, data: (res.data ?? []) as ChatMessageRow[] };
  });
}

/**
 * One page of a thread: the replies whose thread_root_message_id is `rootId`
 * (newest first from `before`, or the newest page), returned oldest-first,
 * plus whether an older page may exist. The (channel_id,
 * thread_root_message_id, created_at) index serves it; the page size is the
 * history page size. Deleted replies are kept (they render as tombstones).
 */
export function loadThreadPage(
  client: Client,
  channelId: string,
  rootId: string,
  before?: MessageCursor,
): Promise<Result<HistoryPage>> {
  return withReadTimeout((signal) =>
    readHistoryPage(client, channelId, {
      before,
      threadRootId: rootId,
      signal,
      label: 'loadThreadPage',
    }),
  );
}

/** The live replies of one thread root. */
export interface ThreadReplyCount {
  count: number;
}

/**
 * Reply counts for thread roots in one call to chat_thread_reply_counts
 * (SECURITY INVOKER: chat_messages RLS applies; deleted replies are not
 * counted). Only the first 200 ids are sent. `traceId` is minted with
 * uuid_v7 at the user action (the page load) and passed as p_trace_id. A
 * root with no live reply is absent from the result. 5s timeout.
 *
 * p_since bounds the read below (chat_messages is partitioned by month on
 * created_at): a reply is never older than its root, so the earliest
 * created_at among the sent roots (`createdAtOf`) loses nothing. Only when a
 * sent root's created_at is unknown is it '-infinity' (unbounded below).
 */
export function loadThreadReplyCounts(
  client: Client,
  channelId: string,
  rootIds: readonly string[],
  traceId: string,
  createdAtOf: (rootId: string) => string | undefined,
): Promise<Result<Map<string, ThreadReplyCount>>> {
  const ids = [...new Set(rootIds)].slice(0, THREAD_COUNT_ROOT_LIMIT);
  if (ids.length === 0) return Promise.resolve({ ok: true, data: new Map() });
  return withReadTimeout(async (signal) => {
    const args: ThreadReplyCountsArgs = {
      p_trace_id: traceId,
      p_channel_id: channelId,
      p_root_ids: ids,
      p_since: earliestCreatedAt(ids, createdAtOf) ?? '-infinity',
    };
    const { data, error } = await abortable(client.rpc('chat_thread_reply_counts', args), signal);
    if (error) return fail(`loadThreadReplyCounts: ${error.message}`);
    const rows = (data ?? []) as ThreadReplyCountRow[];
    return {
      ok: true,
      data: new Map(rows.map((row) => [row.root_id, { count: Number(row.reply_count) }])),
    };
  });
}

/** The earliest created_at of the roots; null when any root's created_at is unknown. */
export function earliestCreatedAt(
  rootIds: readonly string[],
  createdAtOf: (rootId: string) => string | undefined,
): string | null {
  let earliest: { at: string; ms: number } | null = null;
  for (const id of rootIds) {
    const at = createdAtOf(id);
    const ms = at === undefined ? Number.NaN : Date.parse(at);
    if (at === undefined || Number.isNaN(ms)) return null;
    if (earliest === null || ms < earliest.ms) earliest = { at, ms };
  }
  return earliest?.at ?? null;
}

/** Aggregate reaction rows per message: one entry per emoji with count + mine. */
export function aggregateReactions(
  rows: readonly Pick<ChatReactionRow, 'message_id' | 'emoji' | 'user_id'>[],
  currentUserId: string,
): Map<string, MessageReaction[]> {
  const byId = new Map<string, MessageReaction[]>();
  for (const row of rows) {
    const list = byId.get(row.message_id) ?? [];
    const existing = list.find((r) => r.emoji === row.emoji);
    if (existing === undefined) {
      list.push({ emoji: row.emoji, count: 1, mine: row.user_id === currentUserId });
    } else {
      existing.count += 1;
      existing.mine = existing.mine || row.user_id === currentUserId;
    }
    byId.set(row.message_id, list);
  }
  return byId;
}

/**
 * Reactions for a batch of message ids, keyed by message id. One IN query for
 * the whole page; an empty id list returns an empty Map without a round-trip.
 */
export async function loadReactions(
  client: Client,
  messageIds: readonly string[],
  currentUserId: string,
  signal?: AbortSignal,
): Promise<Result<Map<string, MessageReaction[]>>> {
  if (messageIds.length === 0) return { ok: true, data: new Map() };
  return withReadTimeout(async (deadline) => {
    const query = client
      .from('chat_reactions')
      .select('message_id, emoji, user_id')
      .in('message_id', [...messageIds]);
    const res = await withLinkedSignal(deadline, signal, async (s) => abortable(query, s));
    if (res.error) return fail(`loadReactions: ${res.error.message}`);
    const rows = (res.data ?? []) as Pick<ChatReactionRow, 'message_id' | 'emoji' | 'user_id'>[];
    return { ok: true, data: aggregateReactions(rows, currentUserId) };
  });
}

/** The peer's read position in a DM, when they have one. */
export type PeerReadCursor =
  | { found: true; lastReadMessageId: string; lastReadAt: string }
  | { found: false };

/** One select for the DM peer's cursor; drives the seen ticks on own bubbles. */
export function loadPeerReadCursor(
  client: Client,
  channelId: string,
  peerUserId: string,
): Promise<Result<PeerReadCursor>> {
  return withReadTimeout((signal) => readPeerCursor(client, channelId, peerUserId, signal));
}

async function readPeerCursor(
  client: Client,
  channelId: string,
  peerUserId: string,
  signal: AbortSignal,
): Promise<Result<PeerReadCursor>> {
  const res = await abortable(
    client
      .from('chat_read_cursors')
      .select('last_read_message_id, last_read_at')
      .eq('channel_id', channelId)
      .eq('user_id', peerUserId),
    signal,
  ).maybeSingle();
  if (res.error) return fail(`loadPeerReadCursor: ${res.error.message}`);
  const row = res.data as Pick<ChatReadCursorRow, 'last_read_message_id' | 'last_read_at'> | null;
  if (row === null) return { ok: true, data: { found: false } };
  return {
    ok: true,
    data: {
      found: true,
      lastReadMessageId: row.last_read_message_id,
      lastReadAt: row.last_read_at,
    },
  };
}

/**
 * Every member's read cursor in one channel: one select (RLS lets any channel
 * member read every member's cursor). Feeds the Seen line, Read by and the
 * first-unread divider. 5s timeout.
 */
export function loadChannelReadCursors(
  client: Client,
  channelId: string,
): Promise<Result<ReadCursorRow[]>> {
  return withReadTimeout(async (signal) => {
    const res = await abortable(
      client
        .from('chat_read_cursors')
        .select('user_id, last_read_message_id, last_read_at, read_at')
        .eq('channel_id', channelId),
      signal,
    );
    if (res.error) return fail(`loadChannelReadCursors: ${res.error.message}`);
    const rows = (res.data ?? []) as Pick<
      ChatReadCursorRow,
      'user_id' | 'last_read_message_id' | 'last_read_at' | 'read_at'
    >[];
    return {
      ok: true,
      data: rows.map((row) => ({
        userId: row.user_id,
        lastReadMessageId: row.last_read_message_id,
        lastReadAt: row.last_read_at,
        readAt: row.read_at,
      })),
    };
  });
}

/** The channel's cursors plus each cursor message's created_at (ms), where readable. */
export interface ReadPositionsRead {
  rows: ReadCursorRow[];
  times: Map<string, number>;
}

/**
 * The cursors (one select) and their messages' created_at (one IN select over
 * the distinct cursor ids), inside one 5s budget. A cursor whose message is not
 * readable keeps no time (resolvePositions falls back to last_read_at).
 */
export function loadReadPositions(
  client: Client,
  channelId: string,
): Promise<Result<ReadPositionsRead>> {
  return withReadTimeout(async () => {
    const cursors = await loadChannelReadCursors(client, channelId);
    if (!cursors.ok) return cursors;
    const ids = [...new Set(cursors.data.map((row) => row.lastReadMessageId))];
    const looked = await loadMessagesByIds(client, ids);
    if (!looked.ok) return looked;
    const times = new Map<string, number>();
    for (const row of looked.data) {
      const ms = Date.parse(row.created_at);
      if (!Number.isNaN(ms)) times.set(row.id, ms);
    }
    return { ok: true, data: { rows: cursors.data, times } };
  });
}

/** One reaction on one message: who and which emoji. */
export interface ReactorRow {
  userId: string;
  emoji: string;
  createdAt: string;
}

/** Every reaction row on one message (who reacted), one select. 5s timeout. */
export function loadMessageReactors(
  client: Client,
  messageId: string,
  signal?: AbortSignal,
): Promise<Result<ReactorRow[]>> {
  return withReadTimeout(async (deadline) => {
    const query = client
      .from('chat_reactions')
      .select('user_id, emoji, created_at')
      .eq('message_id', messageId)
      .order('created_at', { ascending: true });
    const res = await withLinkedSignal(deadline, signal, async (s) => abortable(query, s));
    if (res.error) return fail(`loadMessageReactors: ${res.error.message}`);
    const rows = (res.data ?? []) as Pick<ChatReactionRow, 'user_id' | 'emoji' | 'created_at'>[];
    return {
      ok: true,
      data: rows.map((row) => ({
        userId: row.user_id,
        emoji: row.emoji,
        createdAt: row.created_at,
      })),
    };
  });
}

/** One channel's unread count and last message time, as chat_unread_counts reports. */
export interface UnreadCount {
  channelId: string;
  unread: number;
  lastMessageAt: string;
}

/**
 * Per-channel unread + last message time for the workspace, from the
 * chat_unread_counts proc (SECURITY INVOKER: RLS on chat_messages and
 * chat_read_cursors does the gating). The proc takes no trace parameter (it is a
 * read, not a write), so its args are built ahead of the call.
 */
export function loadUnreadCounts(
  client: Client,
  workspaceId: string,
): Promise<Result<UnreadCount[]>> {
  return withReadTimeout((signal) => readUnreadCounts(client, workspaceId, signal));
}

/** The unread-counts read itself, unbounded; `signal` cancels it. */
export async function readUnreadCounts(
  client: Client,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Result<UnreadCount[]>> {
  const args: Database['public']['Functions']['chat_unread_counts']['Args'] = {
    p_workspace_id: workspaceId,
  };
  const { data, error } = await abortable(client.rpc('chat_unread_counts', args), signal);
  if (error) return fail(`loadUnreadCounts: ${error.message}`);
  const rows = (data ?? []) as UnreadCountRow[];
  return {
    ok: true,
    data: rows.map((row) => ({
      channelId: row.channel_id,
      unread: row.unread,
      lastMessageAt: row.last_message_at,
    })),
  };
}

/**
 * What a list line is made from: the body, plus what the message carries when
 * it has no text (the line then names the first of: Post, Brief, Photo, File,
 * Voice message). One shape for the live path, the reload and own sends.
 */
export interface PreviewContent {
  body: string;
  /** Any attachment or share at all (the 'Attachment' fallback when nothing finer is known). */
  hasAttachments: boolean;
  /** Each attachment's kind (see attachmentPreviewKind). */
  attachmentKinds?: readonly AttachmentKind[];
  sharedPostCount?: number;
  sharedBriefCount?: number;
  sharedPlanCount?: number;
}

/** The columns a preview line reads from a chat_messages row. */
export type PreviewRow = Pick<
  ChatMessageRow,
  'body' | 'attachment_asset_ids' | 'attachment_meta' | 'shared_post_ids' | 'shared_brief_ids'
> &
  Partial<Pick<ChatMessageRow, 'shared_plan_ids'>>;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif']);
// No 'webm': a .webm with no mime and no recorded length may be a video; a
// voice note always carries its length (durationMs), which decides it first.
const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'ogg', 'oga', 'wav', 'aac', 'opus']);

/**
 * What an attachment is for its list line, from its own kind first: a voice
 * note (it has a recorded length or a transcript) is audio whatever its mime,
 * then the mime, and with no mime its name's extension; anything else is a
 * file. Pure.
 */
export function attachmentPreviewKind(
  attachment: Pick<MessageAttachment, 'mime' | 'name' | 'durationMs' | 'transcript'>,
): AttachmentKind {
  if (attachment.durationMs !== undefined || attachment.transcript !== undefined) return 'audio';
  if (attachment.mime !== '') return classifyAttachment(attachment.mime);
  const ext = attachment.name.toLowerCase().split('.').pop() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'file';
}

/** A recorded row's preview content (live verify, the reload scan). Pure. */
export function rowPreviewContent(row: PreviewRow): PreviewContent {
  const assetIds = row.attachment_asset_ids ?? [];
  const sharedPostCount = (row.shared_post_ids ?? []).length;
  const sharedBriefCount = (row.shared_brief_ids ?? []).length;
  const sharedPlanCount = (row.shared_plan_ids ?? []).length;
  return {
    body: row.body ?? '',
    hasAttachments:
      assetIds.length > 0 || sharedPostCount > 0 || sharedBriefCount > 0 || sharedPlanCount > 0,
    attachmentKinds: parseAttachmentMeta(row.attachment_meta, assetIds).map(attachmentPreviewKind),
    sharedPostCount,
    sharedBriefCount,
    ...(sharedPlanCount > 0 ? { sharedPlanCount } : {}),
  };
}

/** The latest recorded message of one channel, for the conversation card line. */
export interface ConversationPreview extends PreviewContent {
  channelId: string;
  messageId: string;
  senderUserId: string | null;
  createdAt: string;
}

/** The columns the preview scan selects. */
const PREVIEW_COLUMNS =
  'id, channel_id, sender_user_id, body, attachment_asset_ids, attachment_meta, shared_post_ids, shared_brief_ids, shared_plan_ids, created_at';

type PreviewScanRow = Pick<ChatMessageRow, 'id' | 'channel_id' | 'sender_user_id' | 'created_at'> &
  Partial<PreviewRow>;

/** Reduce a newest-first scan to the first (latest) row per channel. */
export function latestPerChannel(rows: readonly PreviewScanRow[]): ConversationPreview[] {
  const seen = new Set<string>();
  const previews: ConversationPreview[] = [];
  for (const row of rows) {
    if (seen.has(row.channel_id)) continue;
    seen.add(row.channel_id);
    previews.push({
      channelId: row.channel_id,
      messageId: row.id,
      senderUserId: row.sender_user_id,
      ...rowPreviewContent({
        body: row.body ?? null,
        attachment_asset_ids: row.attachment_asset_ids ?? null,
        attachment_meta: row.attachment_meta ?? null,
        shared_post_ids: row.shared_post_ids ?? null,
        shared_brief_ids: row.shared_brief_ids ?? null,
        shared_plan_ids: row.shared_plan_ids ?? null,
      }),
      createdAt: row.created_at,
    });
  }
  return previews;
}

/**
 * One bounded read (newest PREVIEW_SCAN_LIMIT rows the caller can see in the
 * workspace, through partition-bounded windows) reduced to the latest message
 * per channel. A channel whose last
 * message is older than the scan window simply gets no preview line; its
 * ordering and badge still come from chat_unread_counts.
 */
export function loadConversationPreviews(
  client: Client,
  workspaceId: string,
): Promise<Result<ConversationPreview[]>> {
  return withReadTimeout((signal) => readConversationPreviews(client, workspaceId, signal));
}

/** The preview scan itself, unbounded; `signal` cancels it. */
export async function readConversationPreviews(
  client: Client,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Result<ConversationPreview[]>> {
  const res = await readBoundedPage<PreviewScanRow>({
    pageSize: PREVIEW_SCAN_LIMIT,
    upper: upperFromNow(),
    upperInclusive: false,
    openEnded: true,
    oldest: () => readWorkspaceOldest(client, workspaceId, signal),
    read: async (bounds: TimeBounds, limit: number) => {
      const base = client
        .from('chat_messages')
        .select(PREVIEW_COLUMNS)
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .gte('created_at', bounds.from);
      const capped = bounds.to === null ? base : base.lt('created_at', bounds.to);
      const page = await abortable(
        capped.order('created_at', { ascending: false }).limit(limit),
        signal,
      );
      if (page.error) return fail(`loadConversationPreviews: ${page.error.message}`);
      return { ok: true, data: (page.data ?? []) as PreviewScanRow[] };
    },
  });
  if (!res.ok) return res;
  return { ok: true, data: latestPerChannel(res.data) };
}

/** A workspace's oldest live chat message created_at, or null. One ordered LIMIT 1 read, cached. */
function readWorkspaceOldest(
  client: Client,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Result<string | null>> {
  return oldestByWorkspace.read(workspaceId, async () => {
    const res = await abortable(
      client
        .from('chat_messages')
        .select('created_at')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(1),
      signal,
    );
    if (res.error) return fail(`loadConversationPreviews: ${res.error.message}`);
    const first = ((res.data ?? []) as Pick<ChatMessageRow, 'created_at'>[])[0];
    return { ok: true, data: first !== undefined ? first.created_at : null };
  });
}

// ---------------------------------------------------------------------------
// The chat open bundle: one chat_open_bundle call per open
// ---------------------------------------------------------------------------

type ChatOpenBundleArgs = Database['public']['Functions']['chat_open_bundle']['Args'];
type ChatMarkRow = Database['public']['Tables']['chat_message_marks']['Row'];
type JsonValue = ChatMessageRow['removed_files'];

/** Rows one cold open returns at most (the newest; more is has_more). */
export const OPEN_BUNDLE_PAGE_SIZE = HISTORY_PAGE_SIZE;

/** Rows one catch-up (p_since) open returns at most (more is a gap). */
export const OPEN_BUNDLE_SINCE_LIMIT = CATCH_UP_LIMIT;

/**
 * Everything a chat open paints, from one chat_open_bundle call, in the
 * shapes the store already holds. Plan bundles are never in it (a separate
 * read, started once this lands).
 */
export interface ChatOpenBundle {
  /** The server's now when the bundle was read. */
  serverNow: string;
  /**
   * The messages, oldest first. Cold open: the latest 50, hasMore strictly
   * when more exist. Catch-up (p_since): every row at or after p_since, at
   * most 200; hasMore then means a gap.
   */
  page: HistoryPage;
  /** Quoted and thread root rows not on the page (deleted rows kept). */
  quoted: ChatMessageRow[];
  /** Every reaction on the page's rows. */
  reactions: Array<Pick<ChatReactionRow, 'message_id' | 'emoji' | 'user_id'>>;
  /** The channel's read cursors and their messages' times (ms). */
  readPositions: ReadPositionsRead;
  /** Live replies per page root, within the page's window. */
  replyCounts: Map<string, ThreadReplyCount>;
  marks: ChatMark[];
  /** The viewer's scheduled messages in the chat, soonest first. */
  scheduled: ScheduledRow[];
  openPosts: OpenPostRow[];
  openPostCount: number;
  /** The workspace's current shared plan ids (ending soonest first). */
  sharedPlanIds: string[];
  openBriefs: OpenBriefRow[];
  openBriefCount: number;
}

/** A shape problem in the bundle: the whole bundle is refused (all or nothing). */
class BundleShapeError extends Error {}

function shape(at: string, what: string): never {
  throw new BundleShapeError(`${at}: ${what}`);
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return shape(at, 'not an object');
  }
  return value as Record<string, unknown>;
}

/** A required key: present (null allowed only where the reader allows it). */
function need(record: Record<string, unknown>, key: string, at: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return shape(at, `missing ${key}`);
  return record[key];
}

function asArray(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) return shape(at, 'not a list');
  return value;
}

function asString(value: unknown, at: string): string {
  if (typeof value !== 'string') return shape(at, 'not a string');
  return value;
}

function asStringOrNull(value: unknown, at: string): string | null {
  return value === null || value === undefined ? null : asString(value, at);
}

function asNumber(value: unknown, at: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return shape(at, 'not a number');
  return n;
}

function asNumberOrNull(value: unknown, at: string): number | null {
  return value === null || value === undefined ? null : asNumber(value, at);
}

function asStringsOrNull(value: unknown, at: string): string[] | null {
  if (value === null || value === undefined) return null;
  return asArray(value, at).map((v, i) => asString(v, `${at}[${i}]`));
}

/** A json column: whatever JSON the row holds (absent reads as null). */
function asJson(value: unknown): JsonValue {
  return (value === undefined ? null : value) as JsonValue;
}

function messageRow(value: unknown, at: string): ChatMessageRow {
  const o = asRecord(value, at);
  return {
    id: asString(need(o, 'id', at), `${at}.id`),
    channel_id: asString(need(o, 'channel_id', at), `${at}.channel_id`),
    workspace_id: asString(need(o, 'workspace_id', at), `${at}.workspace_id`),
    created_at: asString(need(o, 'created_at', at), `${at}.created_at`),
    sender_user_id: asStringOrNull(o.sender_user_id, `${at}.sender_user_id`),
    body: asStringOrNull(o.body, `${at}.body`),
    mentions: asJson(o.mentions),
    attachment_asset_ids: asStringsOrNull(o.attachment_asset_ids, `${at}.attachment_asset_ids`),
    shared_post_ids: asStringsOrNull(o.shared_post_ids, `${at}.shared_post_ids`),
    shared_brief_ids: asStringsOrNull(o.shared_brief_ids, `${at}.shared_brief_ids`),
    shared_plan_ids: asStringsOrNull(o.shared_plan_ids, `${at}.shared_plan_ids`),
    reply_to_message_id: asStringOrNull(o.reply_to_message_id, `${at}.reply_to_message_id`),
    forwarded_from_message_id: asStringOrNull(
      o.forwarded_from_message_id,
      `${at}.forwarded_from_message_id`,
    ),
    attachment_meta: asJson(o.attachment_meta),
    agora_event_id: asStringOrNull(o.agora_event_id, `${at}.agora_event_id`),
    edited_at: asStringOrNull(o.edited_at, `${at}.edited_at`),
    deleted_at: asStringOrNull(o.deleted_at, `${at}.deleted_at`),
    thread_root_message_id: asStringOrNull(
      o.thread_root_message_id,
      `${at}.thread_root_message_id`,
    ),
    removed_files:
      o.removed_files === undefined || o.removed_files === null ? [] : asJson(o.removed_files),
  };
}

function markRow(value: unknown, at: string): ChatMarkRow {
  const o = asRecord(value, at);
  return {
    message_id: asString(need(o, 'message_id', at), `${at}.message_id`),
    channel_id: asString(need(o, 'channel_id', at), `${at}.channel_id`),
    workspace_id: asString(need(o, 'workspace_id', at), `${at}.workspace_id`),
    mark_type: asString(need(o, 'mark_type', at), `${at}.mark_type`),
    marked_at: asString(need(o, 'marked_at', at), `${at}.marked_at`),
    marked_by: asStringOrNull(o.marked_by, `${at}.marked_by`),
    priority: asNumberOrNull(o.priority, `${at}.priority`),
    resolved_at: asStringOrNull(o.resolved_at, `${at}.resolved_at`),
    resolved_by: asStringOrNull(o.resolved_by, `${at}.resolved_by`),
  };
}

function scheduledRow(value: unknown, at: string): ScheduledRow {
  const o = asRecord(value, at);
  return {
    id: asString(need(o, 'id', at), `${at}.id`),
    channel_id: asString(need(o, 'channel_id', at), `${at}.channel_id`),
    workspace_id: asString(need(o, 'workspace_id', at), `${at}.workspace_id`),
    sender_user_id: asString(need(o, 'sender_user_id', at), `${at}.sender_user_id`),
    send_at: asString(need(o, 'send_at', at), `${at}.send_at`),
    status: asString(need(o, 'status', at), `${at}.status`),
    created_at: asString(need(o, 'created_at', at), `${at}.created_at`),
    updated_at: asString(need(o, 'updated_at', at), `${at}.updated_at`),
    body: asStringOrNull(o.body, `${at}.body`),
    mentions: asJson(o.mentions),
    attachment_asset_ids: asStringsOrNull(o.attachment_asset_ids, `${at}.attachment_asset_ids`),
    attachment_meta: asJson(o.attachment_meta),
    shared_post_ids: asStringsOrNull(o.shared_post_ids, `${at}.shared_post_ids`),
    shared_brief_ids: asStringsOrNull(o.shared_brief_ids, `${at}.shared_brief_ids`),
    reply_to_message_id: asStringOrNull(o.reply_to_message_id, `${at}.reply_to_message_id`),
    failure_reason: asStringOrNull(o.failure_reason, `${at}.failure_reason`),
    sent_at: asStringOrNull(o.sent_at, `${at}.sent_at`),
  };
}

function list<T>(
  record: Record<string, unknown>,
  key: string,
  row: (value: unknown, at: string) => T,
): T[] {
  return asArray(need(record, key, 'bundle'), key).map((v, i) => row(v, `${key}[${i}]`));
}

/**
 * Map chat_open_bundle's jsonb to the store's shapes, once. Pure. Every key
 * must be present and well formed: a missing key or a malformed row refuses
 * the whole bundle (a failed Result), so the open shows its failed-load state
 * rather than a part read wrong. Only a mark of an unknown type is skipped
 * (as the marks read does).
 */
export function parseChatOpenBundle(data: unknown): Result<ChatOpenBundle> {
  try {
    const o = asRecord(data, 'bundle');
    const serverNow = asString(need(o, 'server_now', 'bundle'), 'server_now');
    const hasMore = need(o, 'has_more', 'bundle');
    if (typeof hasMore !== 'boolean') return shape('has_more', 'not a boolean');
    const rows = list(o, 'messages', messageRow);
    const quoted = list(o, 'quoted', messageRow);
    const reactions = list(o, 'reactions', (v, at) => {
      const r = asRecord(v, at);
      return {
        message_id: asString(need(r, 'message_id', at), `${at}.message_id`),
        emoji: asString(need(r, 'emoji', at), `${at}.emoji`),
        user_id: asString(need(r, 'user_id', at), `${at}.user_id`),
      };
    });
    const cursors = list(o, 'read_cursors', (v, at): ReadCursorRow => {
      const r = asRecord(v, at);
      return {
        userId: asString(need(r, 'user_id', at), `${at}.user_id`),
        lastReadMessageId: asString(
          need(r, 'last_read_message_id', at),
          `${at}.last_read_message_id`,
        ),
        lastReadAt: asString(need(r, 'last_read_at', at), `${at}.last_read_at`),
        readAt: asStringOrNull(r.read_at, `${at}.read_at`),
      };
    });
    const times = new Map<string, number>();
    for (const c of list(o, 'cursor_messages', (v, at) => {
      const r = asRecord(v, at);
      return {
        id: asString(need(r, 'id', at), `${at}.id`),
        createdAt: asString(need(r, 'created_at', at), `${at}.created_at`),
      };
    })) {
      const ms = Date.parse(c.createdAt);
      if (!Number.isNaN(ms)) times.set(c.id, ms);
    }
    const replyCounts = new Map<string, ThreadReplyCount>();
    for (const c of list(o, 'reply_counts', (v, at) => {
      const r = asRecord(v, at);
      return {
        rootId: asString(need(r, 'root_id', at), `${at}.root_id`),
        count: asNumber(need(r, 'reply_count', at), `${at}.reply_count`),
      };
    })) {
      replyCounts.set(c.rootId, { count: c.count });
    }
    const marks: ChatMark[] = [];
    for (const row of list(o, 'marks', markRow)) {
      const mark = rowToMark(row);
      if (mark !== undefined) marks.push(mark);
    }
    const scheduled = soonestFirst(list(o, 'scheduled', scheduledRow));
    const openPosts = list(o, 'open_posts', (v, at): OpenPostRow => {
      const r = asRecord(v, at);
      return {
        id: asString(need(r, 'id', at), `${at}.id`),
        number: asNumber(need(r, 'number', at), `${at}.number`),
        title: asString(need(r, 'title', at), `${at}.title`),
        format: asString(need(r, 'format', at), `${at}.format`),
        target_date: asStringOrNull(r.target_date, `${at}.target_date`),
        stage_entered_at: asString(need(r, 'stage_entered_at', at), `${at}.stage_entered_at`),
        thumbnailAssetVersionId: asStringOrNull(
          r.thumbnail_asset_version_id,
          `${at}.thumbnail_asset_version_id`,
        ),
      };
    });
    const openPostCount = asNumber(need(o, 'open_post_count', 'bundle'), 'open_post_count');
    const planIds = need(o, 'shared_plan_ids', 'bundle');
    // An empty uuid[] may come back as null: no plans.
    const sharedPlanIds =
      planIds === null
        ? []
        : asArray(planIds, 'shared_plan_ids').map((v, i) => asString(v, `shared_plan_ids[${i}]`));
    const openBriefs = list(o, 'open_briefs', (v, at): OpenBriefRow => {
      const r = asRecord(v, at);
      return {
        id: asString(need(r, 'id', at), `${at}.id`),
        number: asNumberOrNull(r.number, `${at}.number`),
        title: asString(need(r, 'title', at), `${at}.title`),
        created_at: asString(need(r, 'created_at', at), `${at}.created_at`),
      };
    });
    const openBriefCount = asNumber(need(o, 'open_brief_count', 'bundle'), 'open_brief_count');
    return {
      ok: true,
      data: {
        serverNow,
        page: { rows, hasMore },
        quoted,
        reactions,
        readPositions: { rows: cursors, times },
        replyCounts,
        marks,
        scheduled,
        openPosts,
        openPostCount,
        sharedPlanIds,
        openBriefs,
        openBriefCount,
      },
    };
  } catch (error) {
    if (error instanceof BundleShapeError) return fail(`chat_open_bundle: ${error.message}`);
    return fail(`chat_open_bundle: ${String(error)}`);
  }
}

/** What one chat_open_bundle call is asked for. */
export interface ChatOpenBundleInput {
  /** uuid v7, minted at the open (the user action). */
  traceId: string;
  workspaceId: string;
  channelId: string;
  /** Catch-up: every row at or after this created_at (max 200). Absent: the latest 50. */
  since?: string | null;
}

/**
 * One chat_open_bundle call (SECURITY INVOKER: RLS decides every part),
 * mapped once by parseChatOpenBundle. The proc raises 'workspace_member_only'
 * when the chat is not visible: a failed Result with that code. Unbounded;
 * `signal` cancels it. Never throws.
 */
export async function readChatOpenBundle(
  client: Client,
  input: ChatOpenBundleInput,
  signal?: AbortSignal,
): Promise<Result<ChatOpenBundle>> {
  try {
    const args: ChatOpenBundleArgs = {
      p_trace_id: input.traceId,
      p_workspace_id: input.workspaceId,
      p_channel_id: input.channelId,
      ...(input.since !== undefined && input.since !== null ? { p_since: input.since } : {}),
    };
    const { data, error } = await abortable(
      withTraceHeader(client.rpc('chat_open_bundle', args), args.p_trace_id),
      signal,
    );
    if (error) {
      return {
        ok: false,
        error: {
          code: error.message === 'workspace_member_only' ? 'workspace_member_only' : 'unknown',
          message: `chat_open_bundle: ${error.message}`,
        },
      };
    }
    return parseChatOpenBundle(data);
  } catch (error) {
    return fail(`chat_open_bundle: ${String(error)}`);
  }
}

/** Every plan id shared on these rows, in row order, deduped. Pure. */
export function rowPlanIds(rows: readonly Pick<ChatMessageRow, 'shared_plan_ids'>[]): string[] {
  return [...new Set(rows.flatMap((row) => row.shared_plan_ids ?? []))];
}
