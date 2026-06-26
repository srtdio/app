// Framework-agnostic live message-thread logic, driven entirely by the Agora
// SDK. The Postgres mirror is never read here. This mirrors the Foundation
// controller's shape: the SDK connection is injected, so every branch is
// unit-tested under the node test job with the SDK fully mocked and no DOM.
//
// Agora type names are taken verbatim from the installed agora-chat 1.3.1
// typings (`import type { AgoraChat }`): the connection exposes
// `send(MessageBody)` and `getHistoryMessages({ targetId, chatType, ... })`, and
// incoming text arrives on the `onTextMessage(TextMsgBody)` event. The message
// factory (`message.create`) is injected as `createMessage` so this module has
// no runtime dependency on the SDK and stays pure.

import type { AgoraChat } from 'agora-chat';
import type { ChatConnection } from '@/lib/chat/types';
import { toAgoraUsername, userIdFromAgoraUsername } from '@/lib/chat/agora-identity';
import type { ChannelSummary } from '@/lib/chat-reads';
import {
  buildMessageExt,
  parseAttachments,
  parseSharedPostIds,
  type MessageAttachment,
  type MessageExt,
} from '@/lib/chat/attachments';

/** Our own SDK event-handler id, separate from the Foundation's 'sorted-chat'. */
export const THREAD_EVENT_HANDLER_ID = 'chat-thread';

/** Default history page size; the SDK caps this at 50. */
const HISTORY_PAGE_SIZE = 50;

export type ThreadChatType = 'singleChat' | 'groupChat';

/** Delivery/read state of an own message, advanced monotonically by live receipts. */
export type MessageStatus = 'sent' | 'delivered' | 'read';

/** Where a channel's messages live on the Agora side. */
export interface ChannelTarget {
  targetId: string;
  chatType: ThreadChatType;
}

/** One emoji reaction on a message, aggregated across users by the SDK. */
export interface MessageReaction {
  emoji: string;
  count: number;
  /** True when the current user is among the reactors (tap again to remove). */
  mine: boolean;
}

/** A message as the thread UI renders it: sender mapped back to a Sorted id. */
export interface ThreadMessage {
  id: string;
  /** Sorted user id, or null when the Agora username could not be mapped. */
  senderUserId: string | null;
  body: string;
  time: number;
  /** True when the current user sent it (own bubble). */
  mine: boolean;
  /** Asset attachments read off the SDK message `ext`; empty when there are none. */
  attachments: MessageAttachment[];
  /** Shared post uuids read off the SDK message `ext`; empty when there are none. */
  sharedPostIds: string[];
  /** Delivery/read state; rendered as ticks for own DM messages only. */
  status: MessageStatus;
  /** Emoji reactions on this message; empty when there are none. */
  reactions: MessageReaction[];
}

/**
 * The connection surface the thread drives: the Foundation ChatConnection plus
 * the two messaging members it does not expose. It extends ChatConnection so the
 * Foundation client casts to it structurally, without `unknown` or `any`.
 */
export interface ThreadConnection extends ChatConnection {
  send(message: AgoraChat.MessageBody): Promise<AgoraChat.SendMsgResult>;
  getHistoryMessages(options: {
    targetId: string;
    chatType: 'singleChat' | 'groupChat' | 'chatRoom';
    pageSize?: number;
    searchDirection?: 'up' | 'down';
  }): Promise<AgoraChat.HistoryMessages>;
  addReaction(params: { messageId: string; reaction: string }): Promise<void>;
  deleteReaction(params: { messageId: string; reaction: string }): Promise<void>;
  getReactionlist(params: {
    chatType: 'singleChat' | 'groupChat';
    messageId: string[];
    groupId?: string;
  }): Promise<AgoraChat.AsyncResult<AgoraChat.GetReactionListResult[]>>;
}

/** Injected `AgoraChat.message.create` for text; keeps the SDK out of this module. */
export type CreateTextMessage = (options: {
  chatType: ThreadChatType;
  type: 'txt';
  to: string;
  msg: string;
  /**
   * Custom extension carried on the message. Present only when the send has
   * attachments and/or shared posts; plain text sends omit it, so text behaviour
   * is unchanged.
   */
  ext?: MessageExt;
}) => AgoraChat.MessageBody;

/**
 * Resolve a channel to its Agora target. Group channels message the synced Agora
 * group id; DM channels message the peer's derived Agora username. Returns null
 * when the channel cannot be opened yet (group not synced, peer unknown), which
 * the UI renders as an empty thread rather than crashing.
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

function isTextMessage(message: AgoraChat.MessagesType): message is AgoraChat.TextMsgBody {
  return message.type === 'txt';
}

/** Map one SDK text message to the rendered shape. */
export function mapTextMessage(raw: AgoraChat.TextMsgBody, currentUserId: string): ThreadMessage {
  const mapped =
    raw.from !== undefined ? userIdFromAgoraUsername(raw.from) : ({ ok: false } as const);
  const senderUserId = mapped.ok ? mapped.userId : null;
  return {
    id: raw.id,
    senderUserId,
    body: raw.msg,
    time: raw.time,
    mine: senderUserId !== null && senderUserId === currentUserId,
    // `ext` is the SDK's custom-extension field carried on the message; the
    // sender wrote the attachment ids + render metadata and shared post ids there.
    attachments: parseAttachments(raw.ext),
    sharedPostIds: parseSharedPostIds(raw.ext),
    // Incoming status is never rendered; ticks render for own messages only.
    status: 'sent',
    // Reactions arrive separately (history fetch + live onReactionChange event).
    reactions: [],
  };
}

/** Map the live onReactionChange payload's reactions to the rendered shape. */
export function parseEventReactions(reactions: AgoraChat.Reaction[]): MessageReaction[] {
  return reactions.map((r) => ({
    emoji: r.reaction,
    count: r.count,
    mine: r.isAddedBySelf ?? false,
  }));
}

/** Map a history getReactionlist result's items to the rendered shape. */
export function parseReactionListItems(items: AgoraChat.ReactionListItem[]): MessageReaction[] {
  return items.map((i) => ({
    emoji: i.reaction,
    count: i.userCount,
    mine: i.isAddedBySelf,
  }));
}

/** Replace the matching message's reactions with the new full list; others unchanged. */
export function applyReactionChange(
  messages: ThreadMessage[],
  messageId: string,
  reactions: MessageReaction[],
): ThreadMessage[] {
  return messages.map((m) => (m.id === messageId ? { ...m, reactions } : m));
}

/** Set reactions for messages present in the map; messages absent from it are unchanged. */
export function mergeHistoryReactions(
  messages: ThreadMessage[],
  byId: Map<string, MessageReaction[]>,
): ThreadMessage[] {
  return messages.map((m) => {
    const reactions = byId.get(m.id);
    return reactions !== undefined ? { ...m, reactions } : m;
  });
}

/**
 * Fetch reactions for a batch of message ids and key them by message id. Returns
 * an empty Map without calling the SDK when there are no ids, and swallows any
 * SDK error (reactions disabled for the account) to an empty Map so history load
 * always succeeds.
 */
export async function fetchReactions(params: {
  connection: ThreadConnection;
  target: ChannelTarget;
  messageIds: string[];
}): Promise<Map<string, MessageReaction[]>> {
  const byId = new Map<string, MessageReaction[]>();
  if (params.messageIds.length === 0) return byId;
  try {
    const res = await params.connection.getReactionlist({
      chatType: params.target.chatType,
      messageId: params.messageIds,
      ...(params.target.chatType === 'groupChat' ? { groupId: params.target.targetId } : {}),
    });
    for (const result of res.data ?? []) {
      byId.set(result.msgId, parseReactionListItems(result.reactionList));
    }
    return byId;
  } catch {
    return byId;
  }
}

/** Add the current user's reaction to a message via the SDK. */
export async function addMessageReaction(params: {
  connection: ThreadConnection;
  messageId: string;
  emoji: string;
}): Promise<void> {
  await params.connection.addReaction({ messageId: params.messageId, reaction: params.emoji });
}

/** Remove the current user's reaction from a message via the SDK. */
export async function removeMessageReaction(params: {
  connection: ThreadConnection;
  messageId: string;
  emoji: string;
}): Promise<void> {
  await params.connection.deleteReaction({ messageId: params.messageId, reaction: params.emoji });
}

/** Monotonic ordering of statuses; a receipt can only advance, never downgrade. */
const STATUS_RANK: Record<MessageStatus, number> = { sent: 0, delivered: 1, read: 2 };

/** The acked message id carried on a delivery receipt: `mid`, falling back to `ackId`. */
export function deliveredMessageId(msg: AgoraChat.DeliveryMsgBody): string | undefined {
  return msg.mid ?? msg.ackId;
}

/**
 * Mark the own message whose id matches the delivery ack as 'delivered'. Pure and
 * monotonic: only a mine message currently ranked below 'delivered' advances;
 * non-mine and already-further messages are returned unchanged.
 */
export function markDelivered(messages: ThreadMessage[], ackedId: string): ThreadMessage[] {
  return messages.map((m) =>
    m.id === ackedId && m.mine && STATUS_RANK[m.status] < STATUS_RANK.delivered
      ? { ...m, status: 'delivered' }
      : m,
  );
}

/**
 * Mark every own message sent at or before the conversation read time as 'read'.
 * Pure and monotonic: only mine messages ranked below 'read' advance; non-mine
 * and later messages are unchanged.
 */
export function markReadUpTo(messages: ThreadMessage[], readTimeMs: number): ThreadMessage[] {
  return messages.map((m) =>
    m.mine && m.time <= readTimeMs && STATUS_RANK[m.status] < STATUS_RANK.read
      ? { ...m, status: 'read' }
      : m,
  );
}

/** Whether a live text message belongs to the open channel. */
export function belongsToTarget(raw: AgoraChat.TextMsgBody, target: ChannelTarget): boolean {
  if (target.chatType === 'groupChat') {
    return raw.chatType === 'groupChat' && raw.to === target.targetId;
  }
  return (
    raw.chatType === 'singleChat' && (raw.from === target.targetId || raw.to === target.targetId)
  );
}

/**
 * Fetch the channel's recent history from the SDK, oldest-first. Non-text
 * messages (system, command) are dropped; this PR renders text only.
 */
export async function loadHistory(params: {
  connection: ThreadConnection;
  target: ChannelTarget;
  currentUserId: string;
}): Promise<ThreadMessage[]> {
  const result = await params.connection.getHistoryMessages({
    targetId: params.target.targetId,
    chatType: params.target.chatType,
    pageSize: HISTORY_PAGE_SIZE,
  });
  return result.messages
    .filter(isTextMessage)
    .map((raw) => mapTextMessage(raw, params.currentUserId))
    .sort((a, b) => a.time - b.time);
}

/**
 * Subscribe to live incoming text for one channel and return the teardown.
 * Registers the 'chat-thread' handler (separate from the Foundation handler) and
 * removes exactly it on teardown, so leaving a channel or unmounting leaves
 * nothing dangling.
 */
export function subscribeIncoming(params: {
  connection: ThreadConnection;
  target: ChannelTarget;
  currentUserId: string;
  onMessage: (message: ThreadMessage) => void;
  /** A delivery receipt arrived for one of our sent messages (DM only). */
  onDelivered: (ackedId: string) => void;
  /** The peer read the conversation up to this epoch-ms time (DM only). */
  onConversationRead: (readTimeMs: number) => void;
  /** A message's reaction list changed; carries the full updated list. */
  onReaction: (messageId: string, reactions: MessageReaction[]) => void;
}): () => void {
  const {
    connection,
    target,
    currentUserId,
    onMessage,
    onDelivered,
    onConversationRead,
    onReaction,
  } = params;
  connection.addEventHandler(THREAD_EVENT_HANDLER_ID, {
    onTextMessage: (raw) => {
      if (belongsToTarget(raw, target)) {
        onMessage(mapTextMessage(raw, currentUserId));
      }
    },
    onDeliveredMessage: (msg) => {
      const id = deliveredMessageId(msg);
      if (id !== undefined) onDelivered(id);
    },
    onChannelMessage: (msg) => {
      if (target.chatType === 'singleChat' && msg.from === target.targetId) {
        onConversationRead(msg.time);
      }
    },
    onReactionChange: (msg) => onReaction(msg.messageId, parseEventReactions(msg.reactions)),
  });
  return () => connection.removeEventHandler(THREAD_EVENT_HANDLER_ID);
}

/**
 * Send a message to the channel via the SDK's send method. Text-only sends pass
 * no `ext` (behaviour unchanged); a send carrying attachments and/or shared posts
 * adds the attachment ids + render metadata and the shared post ids to `ext`,
 * which the receiver reads back and the webhook mirror persists via raw_payload.
 */
export function sendText(params: {
  connection: ThreadConnection;
  target: ChannelTarget;
  text: string;
  attachments: readonly MessageAttachment[];
  sharedPostIds: readonly string[];
  createMessage: CreateTextMessage;
}): Promise<AgoraChat.SendMsgResult> {
  const hasExt = params.attachments.length > 0 || params.sharedPostIds.length > 0;
  const message = params.createMessage({
    chatType: params.target.chatType,
    type: 'txt',
    to: params.target.targetId,
    msg: params.text,
    ...(hasExt
      ? {
          ext: buildMessageExt({
            attachments: params.attachments,
            sharedPostIds: params.sharedPostIds,
          }),
        }
      : {}),
  });
  return params.connection.send(message);
}

/**
 * Build the local echo for a just-sent message. The SDK does not deliver a
 * sender its own message via onTextMessage, so the thread appends this directly
 * using the server id returned by send.
 */
export function echoMessage(params: {
  result: AgoraChat.SendMsgResult;
  text: string;
  currentUserId: string;
  time: number;
  attachments: MessageAttachment[];
  sharedPostIds: string[];
}): ThreadMessage {
  return {
    id: params.result.serverMsgId,
    senderUserId: params.currentUserId,
    body: params.text,
    time: params.time,
    mine: true,
    attachments: params.attachments,
    sharedPostIds: params.sharedPostIds,
    status: 'sent',
    reactions: [],
  };
}

/** Append a message, ignoring a duplicate id (own echo vs a redelivered event). */
export function appendMessage(messages: ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  return messages.some((m) => m.id === message.id) ? messages : [...messages, message];
}
