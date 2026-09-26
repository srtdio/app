// Postgres reads for chat: public.chat_messages is the record and the only
// history read path (Agora is never read for history). Every read is an
// RLS-scoped SELECT through the injected client (mirroring src/lib/chat-reads.ts),
// so these helpers are unit-tested against a recording fake with no database.
//
// Pagination is keyset on (created_at, id), the exact order of the
// chat_messages_channel_created_idx index: the latest page is
// ORDER BY created_at DESC, id DESC LIMIT 50, "load older" continues from the
// oldest loaded (created_at, id) with a PostgREST or-filter for the compound
// cursor, and catch-up after a reconnect reads everything newer than the newest
// loaded pair. Reactions come as one IN query over the loaded ids, never one
// per message.

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import type { ChatMessageRow, MessageCursor, MessageReaction } from '@/lib/chat/thread';

/** History page size; also the "has more" probe (a full page means keep paging). */
export const HISTORY_PAGE_SIZE = 50;

/** Upper bound on one catch-up read; a longer gap is caught up on the next page. */
export const CATCH_UP_LIMIT = 200;

/** Bounded read behind the conversation previews (latest message per channel). */
export const PREVIEW_SCAN_LIMIT = 200;

type ChatReactionRow = Database['public']['Tables']['chat_reactions']['Row'];
type ChatReadCursorRow = Database['public']['Tables']['chat_read_cursors']['Row'];
type UnreadCountRow = Database['public']['Functions']['chat_unread_counts']['Returns'][number];

const MESSAGE_COLUMNS =
  'id, channel_id, workspace_id, sender_user_id, body, mentions, attachment_asset_ids, shared_post_ids, reply_to_message_id, attachment_meta, agora_event_id, created_at, edited_at, deleted_at';

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

/** The newest page of a channel (50 rows, returned oldest-first). */
export async function loadLatestMessages(
  client: Client,
  channelId: string,
): Promise<Result<HistoryPage>> {
  const res = await client
    .from('chat_messages')
    .select(MESSAGE_COLUMNS)
    .eq('channel_id', channelId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(HISTORY_PAGE_SIZE);
  if (res.error) return fail(`loadLatestMessages: ${res.error.message}`);
  return { ok: true, data: toPage((res.data ?? []) as ChatMessageRow[]) };
}

/** The page before `cursor` (the oldest loaded row), returned oldest-first. */
export async function loadOlderMessages(
  client: Client,
  channelId: string,
  cursor: MessageCursor,
): Promise<Result<HistoryPage>> {
  const res = await client
    .from('chat_messages')
    .select(MESSAGE_COLUMNS)
    .eq('channel_id', channelId)
    .is('deleted_at', null)
    .or(olderThanFilter(cursor))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(HISTORY_PAGE_SIZE);
  if (res.error) return fail(`loadOlderMessages: ${res.error.message}`);
  return { ok: true, data: toPage((res.data ?? []) as ChatMessageRow[]) };
}

/** Everything recorded after `cursor` (the newest loaded row), oldest-first. */
export async function loadNewerMessages(
  client: Client,
  channelId: string,
  cursor: MessageCursor,
): Promise<Result<ChatMessageRow[]>> {
  const res = await client
    .from('chat_messages')
    .select(MESSAGE_COLUMNS)
    .eq('channel_id', channelId)
    .is('deleted_at', null)
    .or(newerThanFilter(cursor))
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(CATCH_UP_LIMIT);
  if (res.error) return fail(`loadNewerMessages: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []) as ChatMessageRow[] };
}

/** One row looked up by id: found, or absent (never recorded, deleted, or not visible under RLS). */
export type MessageLookup = { found: true; row: ChatMessageRow } | { found: false };

/**
 * One chat_messages row by its Sorted id, RLS-scoped. Used to verify a live
 * Agora message against the record before it renders: only a row the caller
 * can read is shown.
 */
export async function loadMessageById(
  client: Client,
  messageId: string,
): Promise<Result<MessageLookup>> {
  const res = await client
    .from('chat_messages')
    .select(MESSAGE_COLUMNS)
    .eq('id', messageId)
    .is('deleted_at', null)
    .maybeSingle();
  if (res.error) return fail(`loadMessageById: ${res.error.message}`);
  const row = res.data as ChatMessageRow | null;
  return { ok: true, data: row === null ? { found: false } : { found: true, row } };
}

/** Rows for a batch of ids (quoted messages of replies); one IN query, empty in, empty out. */
export async function loadMessagesByIds(
  client: Client,
  messageIds: readonly string[],
): Promise<Result<ChatMessageRow[]>> {
  if (messageIds.length === 0) return { ok: true, data: [] };
  const res = await client
    .from('chat_messages')
    .select(MESSAGE_COLUMNS)
    .in('id', [...messageIds])
    .is('deleted_at', null);
  if (res.error) return fail(`loadMessagesByIds: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []) as ChatMessageRow[] };
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
): Promise<Result<Map<string, MessageReaction[]>>> {
  if (messageIds.length === 0) return { ok: true, data: new Map() };
  const res = await client
    .from('chat_reactions')
    .select('message_id, emoji, user_id')
    .in('message_id', [...messageIds]);
  if (res.error) return fail(`loadReactions: ${res.error.message}`);
  const rows = (res.data ?? []) as Pick<ChatReactionRow, 'message_id' | 'emoji' | 'user_id'>[];
  return { ok: true, data: aggregateReactions(rows, currentUserId) };
}

/** The peer's read position in a DM, when they have one. */
export type PeerReadCursor =
  | { found: true; lastReadMessageId: string; lastReadAt: string }
  | { found: false };

/** One select for the DM peer's cursor; drives the seen ticks on own bubbles. */
export async function loadPeerReadCursor(
  client: Client,
  channelId: string,
  peerUserId: string,
): Promise<Result<PeerReadCursor>> {
  const res = await client
    .from('chat_read_cursors')
    .select('last_read_message_id, last_read_at')
    .eq('channel_id', channelId)
    .eq('user_id', peerUserId)
    .maybeSingle();
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
export async function loadUnreadCounts(
  client: Client,
  workspaceId: string,
): Promise<Result<UnreadCount[]>> {
  const args: Database['public']['Functions']['chat_unread_counts']['Args'] = {
    p_workspace_id: workspaceId,
  };
  const { data, error } = await client.rpc('chat_unread_counts', args);
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

/** The latest recorded message of one channel, for the conversation card line. */
export interface ConversationPreview {
  channelId: string;
  messageId: string;
  senderUserId: string | null;
  body: string;
  hasAttachments: boolean;
  createdAt: string;
}

/** Reduce a newest-first scan to the first (latest) row per channel. */
export function latestPerChannel(
  rows: readonly Pick<
    ChatMessageRow,
    'id' | 'channel_id' | 'sender_user_id' | 'body' | 'attachment_asset_ids' | 'created_at'
  >[],
): ConversationPreview[] {
  const seen = new Set<string>();
  const previews: ConversationPreview[] = [];
  for (const row of rows) {
    if (seen.has(row.channel_id)) continue;
    seen.add(row.channel_id);
    previews.push({
      channelId: row.channel_id,
      messageId: row.id,
      senderUserId: row.sender_user_id,
      body: row.body ?? '',
      hasAttachments: (row.attachment_asset_ids ?? []).length > 0,
      createdAt: row.created_at,
    });
  }
  return previews;
}

/**
 * One bounded read (newest PREVIEW_SCAN_LIMIT rows the caller can see in the
 * workspace) reduced to the latest message per channel. A channel whose last
 * message is older than the scan window simply gets no preview line; its
 * ordering and badge still come from chat_unread_counts.
 */
export async function loadConversationPreviews(
  client: Client,
  workspaceId: string,
): Promise<Result<ConversationPreview[]>> {
  const res = await client
    .from('chat_messages')
    .select('id, channel_id, sender_user_id, body, attachment_asset_ids, created_at')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(PREVIEW_SCAN_LIMIT);
  if (res.error) return fail(`loadConversationPreviews: ${res.error.message}`);
  const rows = (res.data ?? []) as Pick<
    ChatMessageRow,
    'id' | 'channel_id' | 'sender_user_id' | 'body' | 'attachment_asset_ids' | 'created_at'
  >[];
  return { ok: true, data: latestPerChannel(rows) };
}
