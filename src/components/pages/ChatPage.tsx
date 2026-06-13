import { ChatProvider } from '@/lib/chat';
import { ChatShell } from '@/components/chat/ChatShell';

/**
 * Mounts the Foundation ChatProvider around the chat shell so the Agora
 * connection lives only while /chat is open and tears down on navigate-away via
 * the Foundation hook's cleanup. The connection is never mounted app-wide, so a
 * chat outage cannot affect the rest of Sorted.
 */
export function ChatPage() {
  return (
    <ChatProvider>
      <ChatShell />
    </ChatProvider>
  );
}
