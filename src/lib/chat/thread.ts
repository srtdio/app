// Framework-agnostic message-thread model. Postgres (public.chat_messages) is
// the chat record and the only history read path; Agora is live delivery only.
// This module holds the pure pieces: the rendered message shape, the mapping
// from a chat_messages row and from a live Agora event, the live `ext` contract
// that carries the Sorted ids on every Agora message, keyset cursors for
// pagination and catch-up, and the pure list transitions (merge, upsert, state,
// reactions, read ticks). The SDK connection and message factory are injected,
// so every branch is unit-tested under the node test job with no SDK and no DOM.
//
// Agora type names are taken verbatim from the installed agora-chat 1.3.1
// typings (`import type { AgoraChat }`): the connection exposes
// `send(MessageBody)`, incoming text arrives on `onTextMessage(TextMsgBody)` and
// incoming command messages on `onCmdMessage(CmdMsgBody)`.

import type { AgoraChat } from 'agora-chat';
import type { Database } from '@srtdio/schemas';
import type { ChatConnection } from '@/lib/chat/types';
import { toAgoraUsername, userIdFromAgoraUsername } from '@/lib/chat/agora-identity';
import type { ChannelSummary } from '@/lib/chat-reads';
import {
  buildMessageExt,
  parseAttachmentMeta,
  parseAttachments,
  parseReply,
  parseSharedPostIds,
  type MessageAttachment,
  type MessageExt,
  type ReplyQuote,
} from '@/lib/chat/attachments';

/** One chat_messages row as PostgREST returns it. */
export type ChatMessageRow = Database['public']['Tables']['chat_messages']['Row'];

/** Our own SDK event-handler id, separate from the Foundation's 'sorted-chat'. */
export const THREAD_EVENT_HANDLER_ID = 'chat-thread';

export type ThreadChatType = 'singleChat' | 'groupChat';

/**
 * Where a message sits on its way to the record. 'sending' is the optimistic
 * bubble before chat_message_send returns, 'sent' means the row exists in
 * Postgres (whatever Agora did), 'failed' means the proc failed or timed out and
 * the bubble offers Retry with the same id.
 */
export type MessageState = 'sending' | 'sent' | 'failed';

/** Read state of an own message, advanced monotonically by the peer's cursor. */
export type MessageStatus = 'sent' | 'read';

/** Where a channel's live messages are delivered on the Agora side. */
export interface ChannelTarget {
  targetId: string;
  chatType: ThreadChatType;
}

/** One emoji reaction on a message, aggregated across users. */
export interface MessageReaction {
  emoji: string;
  count: number;
  /** True when the current user is among the reactors (tap again to remove). */
  mine: boolean;
}

/** A message as the thread UI renders it. */
export interface ThreadMessage {
  /** The Sorted id (client-generated uuid_v7, the chat_messages primary id). */
  id: string;
  /** Sorted user id, or null when the sender is unknown (deleted account, unmappable). */
  senderUserId: string | null;
  body: string;
  /**
   * Server created_at as stored (verbatim string, used for the keyset cursor).
   * For a live message not yet fetched from Postgres it is derived from the
   * Agora server time and `provisionalTime` is true until the next catch-up.
   */
  createdAt: string;
  /** Epoch ms of createdAt, used only for ordering and read-tick comparison. */
  time: number;
  /** True while `createdAt` comes from Agora (or a pending send), not Postgres. */
  provisionalTime: boolean;
  /** True when the current user sent it (own bubble). */
  mine: boolean;
  /** Asset attachments; from the row's ids + attachment_meta, or the live `ext`. */
  attachments: MessageAttachment[];
  /** Shared post uuids (row `shared_post_ids` or live `ext`); empty when there are none. */
  sharedPostIds: string[];
  /** The quoted message when this is a reply; null otherwise. */
  reply: ReplyQuote | null;
  state: MessageState;
  /** Read state; rendered as ticks for own DM messages only. */
  status: MessageStatus;
  /** Emoji reactions on this message; empty when there are none. */
  reactions: MessageReaction[];
}

/**
 * The connection surface the thread drives: the Foundation ChatConnection plus
 * `send`, the one messaging member it does not expose. It extends ChatConnection
 * so the Foundation client casts to it structurally, without `unknown` or `any`.
 */
export interface ThreadConnection extends ChatConnection {
  send(message: AgoraChat.MessageBody): Promise<AgoraChat.SendMsgResult>;
}

/**
 * The `ext` keys every live Agora message carries so receivers can dedupe
 * against the record and route to a channel without an Agora-side lookup.
 */
export const LIVE_MESSAGE_ID_KEY = 'sorted_message_id';
export const LIVE_CHANNEL_ID_KEY = 'sorted_channel_id';
/** The `ext` key naming a live-only signal on a command message. */
export const LIVE_EVENT_KEY = 'sorted_event';

/** The Sorted ids stamped on a live text message. */
export interface LiveMessageIds {
  sorted_message_id: string;
  sorted_channel_id: string;
}

/** The ext carried on a live text message: content + the Sorted ids. */
export type LiveTextExt = MessageExt & LiveMessageIds;

/** Injected `AgoraChat.message.create` for text; keeps the SDK out of this module. */
export type CreateTextMessage = (options: {
  chatType: ThreadChatType;
  type: 'txt';
  to: string;
  msg: string;
  /** Custom extension carried on the message; omitted for a bare text send. */
  ext?: MessageExt | LiveTextExt;
}) => AgoraChat.MessageBody;

/**
 * Resolve a channel to its Agora target. Group channels message the synced Agora
 * group id; DM channels message the peer's derived Agora username. Returns null
 * when the channel cannot be opened yet (group not synced, peer unknown), which
 * the UI renders as a Postgres-only thread (history and sends still work).
 */
export function targetFromSummary(summary: ChannelSummary): ChannelTarget | null {
  if (summary.channelType === 'group') {
    return summary.agoraGroupId !== null
      ? { targetId: summary.agoraGroupId, chatType: 'groupChat' }
      : null;
  }
  return summary.peerUserId !== null
    ? { targetId: toAgoraUsername(summary.peerUserId), chatType: 'singleChat' }
    : null;
}

/** Read the Sorted ids off a live message's `ext`; absent on pre-rewrite clients. */
export function parseLiveIds(ext: unknown): { ok: true; ids: LiveMessageIds } | { ok: false } {
  if (typeof ext !== 'object' || ext === null) return { ok: false };
  const record = ext as Record<string, unknown>;
  const messageId = record[LIVE_MESSAGE_ID_KEY];
  const channelId = record[LIVE_CHANNEL_ID_KEY];
  if (typeof messageId !== 'string' || messageId === '') return { ok: false };
  if (typeof channelId !== 'string' || channelId === '') return { ok: false };
  return { ok: true, ids: { sorted_message_id: messageId, sorted_channel_id: channelId } };
}

/** A live-only signal carried on a command message's `ext`. */
export type LiveEvent =
  | { kind: 'reaction'; messageId: string; emoji: string; op: 'add' | 'remove' }
  | { kind: 'read'; channelId: string; messageId: string }
  | { kind: 'unknown' };

/** Read a live signal off a command message's `ext`; 'unknown' for anything else. */
export function parseLiveEvent(ext: unknown): LiveEvent {
  if (typeof ext !== 'object' || ext === null) return { kind: 'unknown' };
  const record = ext as Record<string, unknown>;
  const event = record[LIVE_EVENT_KEY];
  const messageId = record.message_id;
  if (typeof messageId !== 'string' || messageId === '') return { kind: 'unknown' };
  if (event === 'reaction') {
    const emoji = record.emoji;
    const op = record.op;
    if (typeof emoji !== 'string' || emoji === '') return { kind: 'unknown' };
    if (op !== 'add' && op !== 'remove') return { kind: 'unknown' };
    return { kind: 'reaction', messageId, emoji, op };
  }
  if (event === 'read') {
    const channelId = record.channel_id;
    if (typeof channelId !== 'string' || channelId === '') return { kind: 'unknown' };
    return { kind: 'read', channelId, messageId };
  }
  return { kind: 'unknown' };
}

/** Build the `ext` for a live reaction signal. */
export function reactionEventExt(input: {
  messageId: string;
  emoji: string;
  op: 'add' | 'remove';
}): Record<string, unknown> {
  return {
    [LIVE_EVENT_KEY]: 'reaction',
    message_id: input.messageId,
    emoji: input.emoji,
    op: input.op,
  };
}

/** Build the `ext` for a live read-position signal. */
export function readEventExt(input: {
  channelId: string;
  messageId: string;
}): Record<string, unknown> {
  return { [LIVE_EVENT_KEY]: 'read', channel_id: input.channelId, message_id: input.messageId };
}

/** Sender-side content the row does not carry, kept from the local send. */
export interface LocalMessageContent {
  attachments: readonly MessageAttachment[];
  sharedPostIds: readonly string[];
  reply: ReplyQuote | null;
}

/**
 * Map one chat_messages row to the rendered shape. Attachments come from
 * `attachment_asset_ids` enriched by `attachment_meta` (mime, name, transcript),
 * shared posts from `shared_post_ids`, and a reply from `reply_to_message_id`,
 * so a message read from Postgres renders exactly as it did live. The row keeps
 * only the quoted id, so its quote starts unresolved (empty preview) until
 * {@link hydrateReplies} fills it. Local content (own send echo) wins when set.
 */
export function rowToThreadMessage(
  row: ChatMessageRow,
  currentUserId: string,
  local?: LocalMessageContent,
): ThreadMessage {
  const senderUserId = row.sender_user_id;
  const attachments =
    local !== undefined && local.attachments.length > 0
      ? [...local.attachments]
      : parseAttachmentMeta(row.attachment_meta, row.attachment_asset_ids ?? []);
  const sharedPostIds =
    local !== undefined && local.sharedPostIds.length > 0
      ? [...local.sharedPostIds]
      : [...(row.shared_post_ids ?? [])];
  const reply =
    local?.reply ??
    (row.reply_to_message_id !== null && row.reply_to_message_id !== ''
      ? { id: row.reply_to_message_id, authorUserId: null, preview: '' }
      : null);
  return {
    id: row.id,
    senderUserId,
    body: row.body ?? '',
    createdAt: row.created_at,
    time: Date.parse(row.created_at),
    provisionalTime: false,
    mine: senderUserId !== null && senderUserId === currentUserId,
    attachments,
    sharedPostIds,
    reply,
    state: 'sent',
    status: 'sent',
    reactions: [],
  };
}

/** Longest body snapshot a reply quote carries. */
export const REPLY_PREVIEW_LIMIT = 120;

/** The quote line for a message: its body (clipped), else a label for its content. */
export function replyPreview(
  message: Pick<ThreadMessage, 'body' | 'attachments' | 'sharedPostIds'>,
): string {
  const body = message.body.trim();
  if (body !== '') {
    return body.length > REPLY_PREVIEW_LIMIT ? `${body.slice(0, REPLY_PREVIEW_LIMIT)}…` : body;
  }
  if (message.attachments.length > 0) return 'Attachment';
  if (message.sharedPostIds.length > 0) return 'Shared post';
  return 'Message';
}

/** A reply read from a row whose quote has not been resolved yet. */
function unresolvedReply(message: ThreadMessage): boolean {
  return message.reply !== null && message.reply.preview === '';
}

/** Quoted ids that are unresolved and not in the list (to fetch in one read). */
export function missingReplyIds(messages: readonly ThreadMessage[]): string[] {
  const loaded = new Set(messages.map((m) => m.id));
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.reply !== null && unresolvedReply(m) && !loaded.has(m.reply.id)) ids.add(m.reply.id);
  }
  return [...ids];
}

/**
 * Resolve unresolved reply quotes from the loaded list plus `sources` (quoted
 * rows fetched separately). With `settle`, a quote whose message cannot be
 * found (deleted, not visible) falls back to a generic label instead of staying
 * blank. Resolved quotes are left untouched.
 */
export function hydrateReplies(
  messages: ThreadMessage[],
  sources: readonly ThreadMessage[],
  settle = false,
): ThreadMessage[] {
  if (!messages.some(unresolvedReply)) return messages;
  const byId = new Map<string, ThreadMessage>();
  for (const m of sources) byId.set(m.id, m);
  for (const m of messages) byId.set(m.id, m);
  return messages.map((m) => {
    if (m.reply === null || !unresolvedReply(m)) return m;
    const quoted = byId.get(m.reply.id);
    if (quoted === undefined) {
      return settle ? { ...m, reply: { ...m.reply, preview: 'Message' } } : m;
    }
    return {
      ...m,
      reply: { id: quoted.id, authorUserId: quoted.senderUserId, preview: replyPreview(quoted) },
    };
  });
}

/**
 * Map a live Agora text message to the rendered shape. Messages without the
 * Sorted ids on `ext` are rejected (pre-rewrite clients during the reload
 * window). Time is the Agora SERVER time of the message, never the local clock,
 * and stays provisional until the row is fetched on the next catch-up.
 */
export function mapLiveTextMessage(
  raw: AgoraChat.TextMsgBody,
  currentUserId: string,
): { ok: true; channelId: string; message: ThreadMessage } | { ok: false; reason: 'missing_ids' } {
  const ids = parseLiveIds(raw.ext);
  if (!ids.ok) return { ok: false, reason: 'missing_ids' };
  const mapped =
    raw.from !== undefined ? userIdFromAgoraUsername(raw.from) : ({ ok: false } as const);
  const senderUserId = mapped.ok ? mapped.userId : null;
  return {
    ok: true,
    channelId: ids.ids.sorted_channel_id,
    message: {
      id: ids.ids.sorted_message_id,
      senderUserId,
      body: raw.msg,
      createdAt: new Date(raw.time).toISOString(),
      time: raw.time,
      provisionalTime: true,
      mine: senderUserId !== null && senderUserId === currentUserId,
      attachments: parseAttachments(raw.ext),
      sharedPostIds: parseSharedPostIds(raw.ext),
      reply: parseReply(raw.ext),
      state: 'sent',
      status: 'sent',
      reactions: [],
    },
  };
}

/** Total order on messages: server time, then id (uuid_v7 is time-ordered too). */
export function compareMessages(a: ThreadMessage, b: ThreadMessage): number {
  if (a.time !== b.time) return a.time - b.time;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Fold rows fetched from Postgres into the list. A fetched row replaces a
 * provisional entry with the same id (server time wins) while keeping the
 * richer live content and the local reaction/read state; an id already backed
 * by the record is left alone; new ids are inserted in order.
 */
export function mergeFetched(messages: ThreadMessage[], fetched: ThreadMessage[]): ThreadMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const incoming of fetched) {
    const existing = byId.get(incoming.id);
    if (existing === undefined) {
      byId.set(incoming.id, incoming);
      continue;
    }
    if (!existing.provisionalTime) continue;
    byId.set(incoming.id, {
      ...incoming,
      attachments: existing.attachments.length > 0 ? existing.attachments : incoming.attachments,
      sharedPostIds:
        existing.sharedPostIds.length > 0 ? existing.sharedPostIds : incoming.sharedPostIds,
      reply: existing.reply ?? incoming.reply,
      reactions: existing.reactions,
      status: existing.status,
    });
  }
  return [...byId.values()].sort(compareMessages);
}

/** Append a live message, ignoring a duplicate id (already fetched or echoed). */
export function appendMessage(messages: ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  if (messages.some((m) => m.id === message.id)) return messages;
  return [...messages, message].sort(compareMessages);
}

/** Replace the message with the same id, or append when it is not present. */
export function upsertMessage(messages: ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) return [...messages, message].sort(compareMessages);
  const next = [...messages];
  next[index] = message;
  return next.sort(compareMessages);
}

/** Set one message's delivery state; other messages unchanged. */
export function setMessageState(
  messages: ThreadMessage[],
  id: string,
  state: MessageState,
): ThreadMessage[] {
  return messages.map((m) => (m.id === id ? { ...m, state } : m));
}

/**
 * Build the optimistic own bubble appended at tap time. It orders after the
 * newest loaded message (never by the local clock); the server created_at
 * replaces it when chat_message_send returns.
 */
export function pendingMessage(params: {
  id: string;
  currentUserId: string;
  text: string;
  local: LocalMessageContent;
  after: ThreadMessage[];
}): ThreadMessage {
  const last = params.after[params.after.length - 1];
  const time = last !== undefined ? last.time + 1 : 0;
  return {
    id: params.id,
    senderUserId: params.currentUserId,
    body: params.text,
    createdAt: '',
    time,
    provisionalTime: true,
    mine: true,
    attachments: [...params.local.attachments],
    sharedPostIds: [...params.local.sharedPostIds],
    reply: params.local.reply,
    state: 'sending',
    status: 'sent',
    reactions: [],
  };
}

/** An unrecorded own send as the outbox holds it (structural: see chat-store OutboxEntry). */
export interface UnrecordedSend {
  id: string;
  text: string;
  local: LocalMessageContent;
  state: 'sending' | 'failed';
}

/**
 * Lay a channel's unrecorded sends over its loaded list: each renders as an own
 * bubble in its outbox state ('sending' or 'failed' with Retry), ordered after
 * the newest loaded message. An id the list already holds as recorded is
 * skipped (its row exists, so the send landed).
 */
export function withOutboxBubbles(
  messages: ThreadMessage[],
  entries: readonly UnrecordedSend[],
  currentUserId: string,
): ThreadMessage[] {
  if (entries.length === 0) return messages;
  const recordedIds = new Set(messages.filter((m) => m.state === 'sent').map((m) => m.id));
  const outboxIds = new Set(entries.map((e) => e.id));
  let list = messages.filter((m) => m.state === 'sent' || !outboxIds.has(m.id));
  for (const entry of entries) {
    if (recordedIds.has(entry.id)) continue;
    const bubble = pendingMessage({
      id: entry.id,
      currentUserId,
      text: entry.text,
      local: entry.local,
      after: list,
    });
    list = [...list, { ...bubble, state: entry.state }];
  }
  return list;
}

/** A keyset position: the (created_at, id) pair of one recorded message. */
export interface MessageCursor {
  createdAt: string;
  id: string;
}

/** The record-backed messages only (a pending or Agora-timed one has no cursor). */
function recorded(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.filter((m) => !m.provisionalTime && m.state === 'sent');
}

/** The oldest recorded message's cursor, for "load older"; undefined when none. */
export function oldestCursor(messages: ThreadMessage[]): MessageCursor | undefined {
  const first = recorded(messages)[0];
  return first === undefined ? undefined : { createdAt: first.createdAt, id: first.id };
}

/** The newest recorded message's cursor, for catch-up; undefined when none. */
export function newestCursor(messages: ThreadMessage[]): MessageCursor | undefined {
  const list = recorded(messages);
  const last = list[list.length - 1];
  return last === undefined ? undefined : { createdAt: last.createdAt, id: last.id };
}

/** Apply a live reaction add/remove optimistically; Postgres is truth on next load. */
export function applyReactionOp(
  messages: ThreadMessage[],
  input: { messageId: string; emoji: string; op: 'add' | 'remove'; mine: boolean },
): ThreadMessage[] {
  return messages.map((m) => {
    if (m.id !== input.messageId) return m;
    const existing = m.reactions.find((r) => r.emoji === input.emoji);
    if (input.op === 'add') {
      if (existing === undefined) {
        return {
          ...m,
          reactions: [...m.reactions, { emoji: input.emoji, count: 1, mine: input.mine }],
        };
      }
      if (input.mine && existing.mine) return m;
      return {
        ...m,
        reactions: m.reactions.map((r) =>
          r.emoji === input.emoji ? { ...r, count: r.count + 1, mine: r.mine || input.mine } : r,
        ),
      };
    }
    if (existing === undefined) return m;
    if (input.mine && !existing.mine) return m;
    const count = existing.count - 1;
    return {
      ...m,
      reactions:
        count <= 0
          ? m.reactions.filter((r) => r.emoji !== input.emoji)
          : m.reactions.map((r) =>
              r.emoji === input.emoji ? { ...r, count, mine: input.mine ? false : r.mine } : r,
            ),
    };
  });
}

/** Set reactions for messages present in the map; messages absent from it are unchanged. */
export function mergeReactions(
  messages: ThreadMessage[],
  byId: Map<string, MessageReaction[]>,
): ThreadMessage[] {
  return messages.map((m) => {
    const reactions = byId.get(m.id);
    return reactions !== undefined ? { ...m, reactions } : m;
  });
}

/**
 * Mark every own message sent at or before the peer's read position as 'read'.
 * Pure and monotonic: only mine messages ranked below 'read' advance; non-mine
 * and later messages are unchanged.
 */
export function markReadUpTo(messages: ThreadMessage[], readTimeMs: number): ThreadMessage[] {
  return messages.map((m) =>
    m.mine && m.time <= readTimeMs && m.status !== 'read' ? { ...m, status: 'read' } : m,
  );
}

/**
 * Mark own messages read up to a message id the peer reported reading. The id
 * resolves to its time in the loaded list; an id that is not loaded (older than
 * the window, or newer than anything here) leaves the list unchanged.
 */
export function markReadUpToMessage(messages: ThreadMessage[], messageId: string): ThreadMessage[] {
  const anchor = messages.find((m) => m.id === messageId);
  return anchor === undefined ? messages : markReadUpTo(messages, anchor.time);
}

/**
 * Subscribe to live traffic for one channel and return the teardown. Registers
 * the 'chat-thread' handler (separate from the Foundation handler) and removes
 * exactly it on teardown. Text messages route by the Sorted channel id on their
 * `ext`; a message without the ids is dropped and reported to `onIgnored`.
 * Command messages carry reaction and read signals for the same channel.
 */
export function subscribeIncoming(params: {
  connection: ThreadConnection;
  channelId: string;
  currentUserId: string;
  onMessage: (message: ThreadMessage) => void;
  /** A message arrived without the Sorted ids (pre-rewrite sender). */
  onIgnored: (rawId: string) => void;
  /** A peer added or removed a reaction on a message in this channel. */
  onReaction: (input: {
    messageId: string;
    emoji: string;
    op: 'add' | 'remove';
    fromUserId: string;
  }) => void;
  /** A peer reported reading this channel up to a message id. */
  onRead: (input: { messageId: string; fromUserId: string }) => void;
}): () => void {
  const { connection, channelId, currentUserId, onMessage, onIgnored, onReaction, onRead } = params;
  const senderOf = (from: string | undefined): string | undefined => {
    if (from === undefined) return undefined;
    const mapped = userIdFromAgoraUsername(from);
    return mapped.ok ? mapped.userId : undefined;
  };
  connection.addEventHandler(THREAD_EVENT_HANDLER_ID, {
    onTextMessage: (raw) => {
      const mapped = mapLiveTextMessage(raw, currentUserId);
      if (!mapped.ok) {
        onIgnored(raw.id);
        return;
      }
      if (mapped.channelId === channelId) onMessage(mapped.message);
    },
    onCmdMessage: (raw) => {
      const event = parseLiveEvent(raw.ext);
      if (event.kind === 'unknown') return;
      const fromUserId = senderOf(raw.from);
      if (fromUserId === undefined) return;
      if (event.kind === 'reaction') {
        onReaction({ messageId: event.messageId, emoji: event.emoji, op: event.op, fromUserId });
        return;
      }
      if (event.channelId === channelId) onRead({ messageId: event.messageId, fromUserId });
    },
  });
  return () => connection.removeEventHandler(THREAD_EVENT_HANDLER_ID);
}

/**
 * Publish a message to the channel over Agora for live delivery. A bare text
 * send passes no `ext`; a send carrying attachments, shared posts or a reply
 * adds them to `ext`, and a send stamped with `liveIds` (every send from the
 * chat thread, after the row is recorded) adds the Sorted ids receivers dedupe
 * on. Live delivery only: the record is written by chat_message_send first.
 */
export function sendText(params: {
  connection: ThreadConnection;
  target: ChannelTarget;
  text: string;
  attachments: readonly MessageAttachment[];
  sharedPostIds: readonly string[];
  reply: ReplyQuote | null;
  createMessage: CreateTextMessage;
  liveIds?: LiveMessageIds;
}): Promise<AgoraChat.SendMsgResult> {
  const hasContentExt =
    params.attachments.length > 0 || params.sharedPostIds.length > 0 || params.reply !== null;
  const hasExt = hasContentExt || params.liveIds !== undefined;
  const message = params.createMessage({
    chatType: params.target.chatType,
    type: 'txt',
    to: params.target.targetId,
    msg: params.text,
    ...(hasExt
      ? {
          ext: {
            ...buildMessageExt({
              attachments: params.attachments,
              sharedPostIds: params.sharedPostIds,
              reply: params.reply,
            }),
            ...(params.liveIds !== undefined ? params.liveIds : {}),
          },
        }
      : {}),
  });
  return params.connection.send(message);
}
