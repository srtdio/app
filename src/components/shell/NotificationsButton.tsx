// The top bar's Notifications button: a 44x44 icon button on every main screen
// (phone and laptop), where the bell used to sit. Its badge is the merged
// unread count (every inbox row the Notifications page counts as unread), from
// the shell's inbox store. It opens /notifications and stays tinted while that
// page is on screen. A press (pointerdown, touchstart) prefetches the page's
// chunk and first reads (src/lib/route-prefetch.ts).

import type { ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useInboxStore } from '@/components/shell/InboxStoreProvider';
import { CountBadge } from '@/components/ui/CountBadge';
import { IconButton } from '@/components/ui/IconButton';
import { IconNotifications, ICON_SIZE } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { INDUCTION_KEYS } from '@/lib/induction';
import { activityPrefetchProps } from '@/lib/route-prefetch';

/** The Notifications page's route. */
export const NOTIFICATIONS_PATH = '/notifications';

/** The page's title and the button's name (the surface is called Activity). */
export const NOTIFICATIONS_TITLE = 'Activity';

/** The button's accessible name and tooltip: "Activity", plus the unread count. Pure. */
export function notificationsLabel(unread: number): string {
  return unread > 0 ? `${NOTIFICATIONS_TITLE}, ${unread} unread` : NOTIFICATIONS_TITLE;
}

/** Whether a pathname is the Notifications page (the button's active tint). Pure. */
export function onNotifications(pathname: string): boolean {
  return pathname === NOTIFICATIONS_PATH || pathname.startsWith(`${NOTIFICATIONS_PATH}/`);
}

export function NotificationsButton(): ReactElement {
  const { unreadCount } = useInboxStore();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = onNotifications(pathname);
  return (
    <IconButton
      type="button"
      label={notificationsLabel(unreadCount)}
      data-notifications-button=""
      data-induction={INDUCTION_KEYS.activityTab}
      {...(active ? { 'aria-current': 'page' as const } : {})}
      onClick={() => navigate(NOTIFICATIONS_PATH)}
      // A press starts the Activity chunk and its first reads before the tap lands.
      {...activityPrefetchProps()}
      className={cn('relative shrink-0', active && 'bg-accent-soft')}
    >
      {/* The active tint rides on the icon so the button keeps its own colours. */}
      <span className={cn('inline-flex', active && 'text-accent')}>
        <IconNotifications size={ICON_SIZE.control} />
      </span>
      {unreadCount > 0 ? (
        <CountBadge
          count={unreadCount}
          className="absolute right-0.5 top-0.5 border-2 border-panel"
        />
      ) : null}
    </IconButton>
  );
}
