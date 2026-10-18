// The bell: a 44x44 button in the top bar on every main screen (TopbarBell is
// its one mount). The accent badge counts unread items in Now. It opens the
// Notifications surface: the bottom Sheet on touch, a popover anchored to the
// bell on a laptop. BellButton renders nothing outside a BellProvider.

import { useRef } from 'react';
import type { ReactElement } from 'react';
import { IconBell } from '@/components/ui/icons';
import { useChatLayout } from '@/components/chat/chat-type';
import { BellProvider, useBellOptional } from '@/components/chat/BellContext';
import {
  NotificationsSheets,
  NotificationsSurface,
  NOTIFICATIONS_TITLE,
} from '@/components/chat/NotificationsPanel';
import { bellBadgeText } from '@/lib/chat/bell';
import type { NameOf } from '@/lib/chat/mentions';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';

const NO_ROSTER: readonly never[] = [];
const NO_MESSAGES: readonly never[] = [];
const NO_NAMES: NameOf = () => undefined;

/** The bell's accessible name: "Notifications" plus the unread count. Pure. */
export function bellLabel(unread: number): string {
  return unread > 0 ? `${NOTIFICATIONS_TITLE}, ${unread} unread` : NOTIFICATIONS_TITLE;
}

export function BellButton(): ReactElement | null {
  const bell = useBellOptional();
  const layout = useChatLayout();
  const ref = useRef<HTMLButtonElement>(null);
  if (bell === null) return null;
  const unread = bell.status === 'ready' ? bell.unread : 0;
  return (
    <>
      <button
        ref={ref}
        type="button"
        data-bell-button=""
        aria-label={bellLabel(unread)}
        aria-haspopup="dialog"
        aria-expanded={bell.open}
        onClick={() => bell.setOpen(!bell.open)}
        className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors duration-fast hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <IconBell size={20} />
        {unread > 0 ? (
          <span
            data-bell-badge=""
            aria-hidden="true"
            className="absolute right-1 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none tabular-nums text-accent-fg"
          >
            {bellBadgeText(unread)}
          </span>
        ) : null}
      </button>
      <NotificationsSurface layout={layout} anchorRef={ref} />
    </>
  );
}

/**
 * The top bar's bell: its own BellProvider (the primary one, owning ?bell=1),
 * the button with its unread badge, and the sheets it opens. Names resolve
 * through the shared people registry; chat titles read "Chat" off the roster.
 */
export function TopbarBell(): ReactElement | null {
  const { workspaceId } = useWorkspace();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  if (workspaceId === null || userId === null) return null;
  return (
    <BellProvider
      key={`${workspaceId}:${userId}`}
      primary
      workspaceId={workspaceId}
      currentUserId={userId}
      roster={NO_ROSTER}
      openChannelId={null}
      messages={NO_MESSAGES}
      nameOf={NO_NAMES}
    >
      <BellButton />
      <NotificationsSheets />
    </BellProvider>
  );
}
