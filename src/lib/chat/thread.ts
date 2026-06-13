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

/** Our own SDK event-handler id, separate from the Foundation's 'sorted-chat'. */
export const THREAD_EVENT_HANDLER_ID = 'chat-thread';

/** Default history page size; the SDK caps this at 50. */
const HISTORY_PAGE_SIZE = 50;

export type ThreadChatType = 'singleChat' | 'groupChat';

/** Where a channel's messages live on the Agora side. */
export interface ChannelTarget {
  targetId: string;
  chatType: ThreadChatType;
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
}

/** Injected `AgoraChat.message.create` for text; keeps the SDK out of this module. */
export type CreateTextMessage = (options: {
  chatType: ThreadChatType;
  type: 'txt';
  to: string;
  msg: string;
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
  };
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
}): () => void {
  const { connection, target, currentUserId, onMessage } = params;
  connection.addEventHandler(THREAD_EVENT_HANDLER_ID, {
    onTextMessage: (raw) => {
      if (belongsToTarget(raw, target)) {
        onMessage(mapTextMessage(raw, currentUserId));
      }
    },
  });
  return () => connection.removeEventHandler(THREAD_EVENT_HANDLER_ID);
}

/** Send plain text to the channel via the SDK's send method. */
export function sendText(params: {
  connection: ThreadConnection;
  target: ChannelTarget;
  text: string;
  createMessage: CreateTextMessage;
}): Promise<AgoraChat.SendMsgResult> {
  const message = params.createMessage({
    chatType: params.target.chatType,
    type: 'txt',
    to: params.target.targetId,
    msg: params.text,
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
}): ThreadMessage {
  return {
    id: params.result.serverMsgId,
    senderUserId: params.currentUserId,
    body: params.text,
    time: params.time,
    mine: true,
  };
}

/** Append a message, ignoring a duplicate id (own echo vs a redelivered event). */
export function appendMessage(messages: ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  return messages.some((m) => m.id === message.id) ? messages : [...messages, message];
}
