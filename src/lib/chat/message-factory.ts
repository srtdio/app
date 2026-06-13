// The single place a message object is built from the real agora-chat SDK,
// isolating the SDK value import the way connection.ts isolates the Connection
// constructor. thread.ts stays SDK-free by taking this as an injected factory.

import websdk from 'agora-chat';
import type { CreateTextMessage } from '@/lib/chat/thread';

/** Bind `AgoraChat.message.create` to the text-message option shape. */
export const createTextMessage: CreateTextMessage = (options) => websdk.message.create(options);
