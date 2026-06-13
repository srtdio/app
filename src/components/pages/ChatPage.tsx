import type { ReactElement } from 'react';
import { ChatProvider, useChat } from '@/lib/chat';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { ChatShell } from '@/components/chat/ChatShell';

/**
 * Reads the live connection from the Foundation context and renders the shell.
 * Kept inside ChatProvider so it has a connection; when there is no workspace or
 * session the connection is 'unavailable' and the shell shows that panel.
 */
function ChatScreen(): ReactElement {
  const { status, client } = useChat();
  const { workspaceId } = useWorkspace();
  const { session } = useSession();
  const currentUserId = session?.user.id ?? null;

  // 'connected' implies a workspace and session (the connection needs both), but
  // guard so the connected branch never receives an empty id.
  if (status === 'connected' && (workspaceId === null || currentUserId === null)) {
    return <ChatShell status="unavailable" client={null} workspaceId="" currentUserId="" />;
  }
  return (
    <ChatShell
      status={status}
      client={client}
      workspaceId={workspaceId ?? ''}
      currentUserId={currentUserId ?? ''}
    />
  );
}

/**
 * Mounts ChatProvider so the Agora connection lives only while /chat is open and
 * tears down on navigate-away via the Foundation hook's cleanup. The provider is
 * deliberately NOT mounted in App.tsx: chat-down must never affect other pages.
 */
export function ChatPage(): ReactElement {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <ChatProvider>
          <ChatScreen />
        </ChatProvider>
      </div>
    </div>
  );
}
