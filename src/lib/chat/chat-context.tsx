// Context wrapper exposing { status, client } to later PRs. A foundation PR:
// it renders only {children} with no visuals and is not mounted anywhere yet.

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useChatClient } from '@/lib/chat/use-chat-client';
import type { ChatContextValue } from '@/lib/chat/types';

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const value = useChatClient();
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return ctx;
}
