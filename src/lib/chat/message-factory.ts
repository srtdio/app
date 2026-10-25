// The single place a message object is built from the real agora-chat SDK,
// isolating the SDK value import the way connection.ts isolates the Connection
// constructor. thread.ts and typing.ts stay SDK-free by taking these as
// injected factories. The SDK itself is the lazily loaded module from
// connection.ts: a message is only built for a live connection, which exists
// only once that load resolved.

import { agoraSdk, loadAgoraSdk } from '@/lib/chat/connection';
import type { CreateTextMessage } from '@/lib/chat/thread';
import type { CreateCmdMessage } from '@/lib/chat/typing';

// Start the SDK chunk as soon as chat code is on the page; the connection
// awaits the same load, so this only warms it. A failure is retried there.
void loadAgoraSdk().catch(() => undefined);

/**
 * Bind `AgoraChat.message.create` to the text-message option shape. Plain text
 * passes no `ext`; a send from the chat thread passes the content extension
 * (attachments, shared posts, reply) plus the Sorted ids on the SDK's own `ext`
 * extension field, which the receiver reads back to dedupe against the record.
 */
export const createTextMessage: CreateTextMessage = (options) =>
  agoraSdk().message.create({
    chatType: options.chatType,
    type: options.type,
    to: options.to,
    msg: options.msg,
    ...(options.ext !== undefined ? { ext: options.ext } : {}),
  });

/**
 * Bind `AgoraChat.message.create` to the command-message option shape, the live
 * carrier for typing, reaction and read signals. Command messages hold no body,
 * but by the SDK default (deliverOnlineOnly false) Agora queues them for an
 * offline recipient and delivers them on reconnect. A caller passes
 * deliverOnlineOnly: true to drop them for offline recipients instead.
 */
export const createCmdMessage: CreateCmdMessage = (options) =>
  agoraSdk().message.create({
    chatType: options.chatType,
    type: options.type,
    to: options.to,
    action: options.action,
    ...(options.ext !== undefined ? { ext: options.ext } : {}),
    ...(options.deliverOnlineOnly !== undefined
      ? { deliverOnlineOnly: options.deliverOnlineOnly }
      : {}),
  });
