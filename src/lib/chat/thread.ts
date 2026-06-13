// Framework-agnostic live-thread logic for the chat shell. The React hook is a
// thin adapter over this, so the SDK calls (history fetch, incoming-message
// subscription, text send) can be unit-tested with agora-chat fully mocked and
// no DOM, mirroring how the Foundation split runChatConnection from its hook.
//
// The live thread reads ONLY from the Agora SDK here. The Postgres mirror
// (src/lib/chat-reads.ts listMessages) is never on this path.

import websdk from 'agora-chat';
import type { AgoraChat } from 'agora-chat';
import type { ChatConnection } from '@/lib/chat/types';
import type { ChatChannelRow } from '@/lib/chat-reads';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

/**
 * A separate handler id from the Foundation's CHAT_EVENT_HANDLER_ID. The shell
 * adds this for incoming thread messages and removes it on cleanup; it never
 * touches or replaces the Foundation handler.
 */
export const THREAD_EVENT_HANDLER_ID = 'chat-thread';

/** Default history page size. Agora caps getHistoryMessages at 50. */
export const HISTORY_PAGE_SIZE = 50;

/**
 * The slice of the agora-chat Connection the thread drives, on top of the
 * Foundation's narrower ChatConnection. The real Connection satisfies it
 * structurally; the shell casts the Foundation client to this at the boundary.
 */
export interface ThreadConnection extends ChatConnection {
  getHistoryMessages(options: {
    targetId: string;
    chatType: AgoraChat.ChatType;
    pageSize?: number;
    cursor?: number | string | null;
    searchDirection?: 'up' | 'down';
  }): Promise<AgoraChat.HistoryMessages>;
  send(message: AgoraChat.MessageBody): Promise<AgoraChat.SendMsgResult>;
}

/** Where a channel's messages live in Agora: a peer user (DM) or a group. */
export interface ThreadTarget {
  targetId: string;
  chatType: 'singleChat' | 'groupChat';
}

/** A text message reduced to what a bubble renders. */
export interface ThreadMessage {
  id: string;
  /** The sender's Agora username (msg.from); mapped to a Sorted user by the hook. */
  senderUsername: string;
  body: string;
  /** Unix epoch milliseconds, as Agora reports. */
  time: number;
}

/**
 * Resolve the Agora target for a registry channel, or empty when it cannot be
 * addressed yet (a group still awaiting its Agora group id, or a DM row missing
 * a peer). DM peer = whichever side is not the current user.
 */
export function channelTarget(channel: ChatChannelRow, currentUserId: string): ThreadTarget | null {
  if (channel.channel_type === 'group') {
    if (channel.agora_group_id === null) return null;
    return { targetId: channel.agora_group_id, chatType: 'groupChat' };
  }
  const peer = channel.dm_user_a === currentUserId ? channel.dm_user_b : channel.dm_user_a;
  if (peer === null) return null;
  return { targetId: toAgoraUsername(peer), chatType: 'singleChat' };
}

function isTextBody(msg: AgoraChat.MessagesType): msg is AgoraChat.TextMsgBody {
  return msg.type === 'txt';
}

function toThreadMessage(msg: AgoraChat.TextMsgBody): ThreadMessage {
  return { id: msg.id, senderUsername: msg.from ?? '', body: msg.msg, time: msg.time };
}

/** Whether an incoming text message belongs to the open thread. */
function belongsToTarget(msg: AgoraChat.TextMsgBody, target: ThreadTarget): boolean {
  if (target.chatType === 'groupChat') {
    return msg.chatType === 'groupChat' && msg.to === target.targetId;
  }
  return (
    msg.chatType === 'singleChat' && (msg.from === target.targetId || msg.to === target.targetId)
  );
}

export interface OpenThreadParams {
  client: ThreadConnection;
  target: ThreadTarget;
  /** Called once with the channel history, oldest first. */
  onHistory: (messages: ThreadMessage[]) => void;
  /** Called for each live incoming message that belongs to the target. */
  onIncoming: (message: ThreadMessage) => void;
}

/**
 * Open a live thread: fetch history from the SDK and subscribe to incoming text
 * messages under THREAD_EVENT_HANDLER_ID. Returns a teardown that drops the
 * handler and ignores any in-flight history. A failed history fetch resolves to
 * an empty list rather than throwing, so chat-down never breaks the shell.
 */
export function openThread(params: OpenThreadParams): () => void {
  const { client, target, onHistory, onIncoming } = params;
  let cancelled = false;

  client.addEventHandler(THREAD_EVENT_HANDLER_ID, {
    onTextMessage: (msg) => {
      if (!cancelled && belongsToTarget(msg, target)) onIncoming(toThreadMessage(msg));
    },
  });

  client
    .getHistoryMessages({
      targetId: target.targetId,
      chatType: target.chatType,
      pageSize: HISTORY_PAGE_SIZE,
    })
    .then((history) => {
      if (cancelled) return;
      onHistory(history.messages.filter(isTextBody).map(toThreadMessage).reverse());
    })
    .catch(() => {
      if (!cancelled) onHistory([]);
    });

  return () => {
    cancelled = true;
    client.removeEventHandler(THREAD_EVENT_HANDLER_ID);
  };
}

export interface SendTextParams {
  client: ThreadConnection;
  target: ThreadTarget;
  text: string;
}

/** Send a plain text message to the target via the SDK's create + send. */
export function sendText(params: SendTextParams): Promise<AgoraChat.SendMsgResult> {
  const message = websdk.message.create({
    type: 'txt',
    chatType: params.target.chatType,
    to: params.target.targetId,
    msg: params.text,
  });
  return params.client.send(message);
}
