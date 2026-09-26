import type { ReactElement } from 'react';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';
import { useChat } from '@/lib/chat/chat-context';
import { ChatConnected } from '@/components/chat/ChatConnected';
import { ChatUnavailable } from '@/components/chat/ChatUnavailable';

interface ChatShellProps {
  status: ChatStatus;
  client: ChatConnection | null;
  workspaceId: string;
  currentUserId: string;
}

/**
 * The banner copy for a live-delivery state; '' when there is nothing to say.
 * "Reconnecting live delivery" (the loop is working on it, messages still
 * send and load) is deliberately distinct from "Chat unavailable" (the token
 * endpoint refused us or could not be reached) and from a kick.
 */
export function connectionBannerText(status: ChatStatus): string {
  if (status === 'connecting') return 'Connecting live delivery';
  if (status === 'reconnecting') return 'Reconnecting live delivery';
  if (status === 'unavailable') return 'Chat unavailable. Messages still send and load.';
  if (status === 'kicked') return 'Signed in on another device';
  return '';
}

/** The tap label for a banner that needs the user to act; '' when none. */
export function connectionBannerAction(status: ChatStatus): string {
  if (status === 'unavailable') return 'Retry';
  if (status === 'kicked') return 'Reconnect';
  return '';
}

/**
 * Thin status strip above the chat surface while live delivery is down. History
 * and sends keep working against Postgres underneath it, so nothing unmounts.
 * The unavailable and kicked states carry a 44px tap target that restarts the
 * connection. Token colours only, so light and dark stay at parity.
 */
export function ConnectionBanner({
  status,
  onRetry,
}: {
  status: ChatStatus;
  onRetry?: () => void;
}): ReactElement | null {
  const text = connectionBannerText(status);
  if (text === '') return null;
  const action = connectionBannerAction(status);
  const pulsing = status === 'connecting' || status === 'reconnecting';
  return (
    <div
      role="status"
      className="flex min-h-[32px] shrink-0 items-center justify-center gap-2 border-b border-border bg-panel-2 px-4 py-1 text-xs text-fg-2"
    >
      <span
        aria-hidden="true"
        className={
          pulsing
            ? 'h-2 w-2 shrink-0 animate-pulse rounded-full bg-warn'
            : 'h-2 w-2 shrink-0 rounded-full bg-bad'
        }
      />
      <span>{text}</span>
      {action !== '' && onRetry !== undefined ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[44px] min-w-[44px] rounded-md px-2 text-xs font-medium text-accent hover:bg-panel-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {action}
        </button>
      ) : null}
    </div>
  );
}

/** The banner wired to the shared connection's retry (the tap reconnects). */
export function ChatStatusBanner({ status }: { status: ChatStatus }): ReactElement | null {
  const { retry } = useChat();
  return <ConnectionBanner status={status} onRetry={retry} />;
}

/**
 * Status dispatcher for the chat surface. Hookless on purpose: the branches
 * render without touching React state, so they are unit-testable by calling
 * this function directly. ChatConnected stays mounted in every state that has a
 * workspace and a user (Postgres is the record, so the thread list, history and
 * sending work with no live connection) under a thin status banner. Only when
 * there is no workspace or user to show does the full unavailable panel render.
 */
export function ChatShell(props: ChatShellProps): ReactElement {
  if (props.status === 'unavailable' && (props.workspaceId === '' || props.currentUserId === '')) {
    return <ChatUnavailable />;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatStatusBanner status={props.status} />
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
