// Public surface of the chat foundation. Later PRs import from here.

export { ChatProvider, useChat } from '@/lib/chat/chat-context';
export { useChatClient } from '@/lib/chat/use-chat-client';
export { fetchChatToken } from '@/lib/chat/chat-token';
export type { ChatTokenRequest } from '@/lib/chat/chat-token';
export { runChatConnection } from '@/lib/chat/controller';
export type { RunChatConnectionParams } from '@/lib/chat/controller';
export { createAgoraConnection } from '@/lib/chat/connection';
export { CHAT_EVENT_HANDLER_ID } from '@/lib/chat/types';
export type {
  ChatConnection,
  ChatContextValue,
  ChatStatus,
  ChatTokenResult,
  CreateConnection,
} from '@/lib/chat/types';
