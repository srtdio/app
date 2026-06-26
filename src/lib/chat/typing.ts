// Live-only typing signals, driven entirely by the Agora SDK and carried as
// command (`cmd`) messages so nothing touches Postgres, the mirror, or the
// schema. This mirrors thread.ts's ethos: the SDK connection and message
// factory are injected, so every branch is unit-tested under the node test job
// with the SDK fully mocked and no DOM.
//
// Agora type names are taken verbatim from the installed agora-chat 1.3.1
// typings (`import type { AgoraChat }`): a command message is built with
// `message.create({ type: 'cmd', chatType, to, action })`, sent via
// `connection.send(MessageBody)`, and received on the `onCmdMessage(CmdMsgBody)`
// event. The factory is injected as `createCmd` so this module stays SDK-free.

import type { AgoraChat } from 'agora-chat';
import type { ChatConnection } from '@/lib/chat/types';
import type { ChannelTarget, ThreadChatType } from '@/lib/chat/thread';
import { userIdFromAgoraUsername } from '@/lib/chat/agora-identity';

/** Our own SDK event-handler id, distinct from the thread/Foundation handlers. */
export const TYPING_EVENT_HANDLER_ID = 'chat-typing';

/** The `action` value our typing command messages carry. */
export const TYPING_ACTION = 'typing';

/**
 * The connection surface typing drives: the Foundation ChatConnection plus the
 * `send` member it does not expose. Extends ChatConnection so the Foundation
 * client casts to it structurally, without `unknown` or `any`.
 */
export interface TypingConnection extends ChatConnection {
  send(message: AgoraChat.MessageBody): Promise<AgoraChat.SendMsgResult>;
}

/** Injected `AgoraChat.message.create` for command messages; keeps the SDK out. */
export type CreateCmdMessage = (options: {
  chatType: ThreadChatType;
  type: 'cmd';
  to: string;
  action: string;
}) => AgoraChat.MessageBody;

/** Whether a live command message belongs to the open channel. */
export function cmdBelongsToTarget(msg: AgoraChat.CmdMsgBody, target: ChannelTarget): boolean {
  if (target.chatType === 'groupChat') {
    return msg.chatType === 'groupChat' && msg.to === target.targetId;
  }
  return (
    msg.chatType === 'singleChat' && (msg.from === target.targetId || msg.to === target.targetId)
  );
}

/** Build a typing command for the channel and send it via the SDK. */
export function sendTyping(params: {
  connection: TypingConnection;
  target: ChannelTarget;
  createCmd: CreateCmdMessage;
}): Promise<AgoraChat.SendMsgResult> {
  const message = params.createCmd({
    chatType: params.target.chatType,
    type: 'cmd',
    to: params.target.targetId,
    action: TYPING_ACTION,
  });
  return params.connection.send(message);
}

/**
 * Subscribe to live typing commands for one channel and return the teardown.
 * Registers the 'chat-typing' handler (distinct from the thread handler) and
 * removes exactly it on teardown, so leaving a channel or unmounting leaves
 * nothing dangling. Own echoes and unmappable senders are ignored.
 */
export function subscribeTyping(params: {
  connection: TypingConnection;
  target: ChannelTarget;
  currentUserId: string;
  onTypingFrom: (userId: string) => void;
}): () => void {
  const { connection, target, currentUserId, onTypingFrom } = params;
  connection.addEventHandler(TYPING_EVENT_HANDLER_ID, {
    onCmdMessage: (msg) => {
      if (msg.action !== TYPING_ACTION) return;
      if (!cmdBelongsToTarget(msg, target)) return;
      if (msg.from === undefined) return;
      const mapped = userIdFromAgoraUsername(msg.from);
      if (mapped.ok && mapped.userId !== currentUserId) onTypingFrom(mapped.userId);
    },
  });
  return () => connection.removeEventHandler(TYPING_EVENT_HANDLER_ID);
}
