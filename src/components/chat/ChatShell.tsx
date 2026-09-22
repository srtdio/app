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

/** The banner copy for a live-delivery gap; '' when there is nothing to say. */
export function connectionBannerText(status: ChatStatus): string {
  if (status === 'connecting') return 'Connecting to live chat';
  if (status === 'reconnecting') return 'Reconnecting to live chat';
  return '';
}

/**
 * Thin status strip above the chat surface while live delivery is down. History
 * and sends keep working against Postgres underneath it, so nothing unmounts.
 * Token colours only, so light and dark stay at parity.
 */
export function ConnectionBanner({ status }: { status: ChatStatus }): ReactElement | null {
  const text = connectionBannerText(status);
  if (text === '') return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-border bg-panel-2 px-4 py-1.5 text-xs text-fg-2"
    >
      <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn" />
      <span>{text}</span>
    </div>
  );
}

/**
 * Status dispatcher for the chat surface. Hookless on purpose: the branches
 * render without touching React state, so they are unit-testable by calling
 * this function directly. ChatConnected stays mounted through 'connecting' and
 * 'reconnecting' (Postgres is the record, so reading and sending work with no
 * live connection) under a thin status banner; it unmounts only on
 * 'unavailable', which the controller reaches after ten consecutive failures,
 * on signout, or when the availability gate is closed.
 */
export function ChatShell(props: ChatShellProps): ReactElement {
  if (props.status === 'unavailable') {
    return <ChatUnavailable />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConnectionBanner status={props.status} />
      <div className="min-h-0 flex-1">
        <ChatConnected
          client={props.client}
          status={props.status}
          workspaceId={props.workspaceId}
          currentUserId={props.currentUserId}
        />
      </div>
    </div>
  );
}
