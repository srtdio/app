// The single place a message object is built from the real agora-chat SDK,
// isolating the SDK value import the way connection.ts isolates the Connection
// constructor. thread.ts and typing.ts stay SDK-free by taking these as
// injected factories.

import websdk from 'agora-chat';
import type { CreateTextMessage } from '@/lib/chat/thread';
import type { CreateCmdMessage } from '@/lib/chat/typing';

/**
 * Bind `AgoraChat.message.create` to the text-message option shape. Plain text
 * passes no `ext`; a send from the chat thread passes the content extension
 * (attachments, shared posts, reply) plus the Sorted ids on the SDK's own `ext`
 * extension field, which the receiver reads back to dedupe against the record.
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
 * carrier for typing, reaction and read signals. Command messages hold no body
 * and are never recorded; they exist only for the open session.
 */
export const createCmdMessage: CreateCmdMessage = (options) =>
  websdk.message.create({
    chatType: options.chatType,
    type: options.type,
    to: options.to,
    action: options.action,
    ...(options.ext !== undefined ? { ext: options.ext } : {}),
  });
