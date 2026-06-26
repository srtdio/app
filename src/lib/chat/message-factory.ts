// The single place a message object is built from the real agora-chat SDK,
// isolating the SDK value import the way connection.ts isolates the Connection
// constructor. thread.ts stays SDK-free by taking this as an injected factory.

import websdk from 'agora-chat';
import type { CreateTextMessage } from '@/lib/chat/thread';
import type { CreateCmdMessage } from '@/lib/chat/typing';

/**
 * Bind `AgoraChat.message.create` to the text-message option shape. Plain text
 * passes no `ext` (unchanged); a send with attachments passes the attachment ids
 * + render metadata on the SDK's own `ext` extension field, which the receiver
 * reads back off the message and the webhook mirror persists.
 */
export const createTextMessage: CreateTextMessage = (options) =>
  websdk.message.create({
    chatType: options.chatType,
    type: options.type,
    to: options.to,
    msg: options.msg,
    ...(options.ext !== undefined ? { ext: options.ext } : {}),
  });

/**
 * Bind `AgoraChat.message.create` to the command-message option shape, the live
 * carrier for typing signals. Command messages hold no body and are never
 * mirrored; they exist only for the open session.
 */
export const createCmdMessage: CreateCmdMessage = (options) =>
  websdk.message.create({
    chatType: options.chatType,
    type: options.type,
    to: options.to,
    action: options.action,
  });
