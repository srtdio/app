import type { ReactElement } from 'react';
import { useChat } from '@/lib/chat';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { ChatShell } from '@/components/chat/ChatShell';

/**
 * Reads the live connection from the shell-level ChatProvider (mounted once in
 * App.tsx) and renders the shell; when there is no workspace or session the
 * connection is 'unavailable' and the shell shows that panel.
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
 * Renders the chat screen against the shared connection. ChatProvider is no
 * longer mounted here: it lives at the workspace shell (App.tsx), so the Agora
 * connection opens once per session and stays warm across route changes,
 * tearing down only on signout or workspace switch via the connection hook's
 * existing cleanup.
 */
export function ChatPage(): ReactElement {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <ChatScreen />
      </div>
    </div>
  );
}
