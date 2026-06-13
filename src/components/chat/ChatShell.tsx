import type { ReactElement } from 'react';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';
import { ChatConnected } from '@/components/chat/ChatConnected';
import { ChatUnavailable } from '@/components/chat/ChatUnavailable';

interface ChatShellProps {
  status: ChatStatus;
  client: ChatConnection | null;
  workspaceId: string;
  currentUserId: string;
}

/**
 * Status dispatcher for the chat surface. Hookless on purpose: the
 * 'connecting'/'unavailable' branches render without touching React state, so
 * they are unit-testable by calling this function directly, and the heavy
 * ChatConnected (which loads channels and opens the live thread) mounts only
 * once the connection is 'connected'.
 */
export function ChatShell(props: ChatShellProps): ReactElement {
  if (props.status === 'connecting') {
    return (
      <div className="flex items-center justify-center px-6 py-14 text-sm text-fg-3 min-h-[320px]">
        Connecting to chat
      </div>
    );
  }
  if (props.status === 'unavailable') {
    return <ChatUnavailable />;
  }
  return (
    <ChatConnected
      client={props.client}
      workspaceId={props.workspaceId}
      currentUserId={props.currentUserId}
    />
  );
}
