// The top bar's Notifications button: a 44x44 icon button on every main screen
// (phone and laptop), where the bell used to sit. Its badge is the merged
// unread count (every inbox row the Notifications page counts as unread), from
// the shell's inbox store. It opens /notifications and stays tinted while that
// page is on screen.

import type { ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useInboxStore } from '@/components/shell/InboxStoreProvider';
import { CountBadge } from '@/components/ui/CountBadge';
import { IconButton } from '@/components/ui/IconButton';
import { IconNotifications, ICON_SIZE } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { INDUCTION_KEYS } from '@/lib/induction';

/** The Notifications page's route. */
export const NOTIFICATIONS_PATH = '/notifications';

/** The page's title and the button's name. */
export const NOTIFICATIONS_TITLE = 'Notifications';

/** The button's accessible name: "Notifications", plus the unread count. Pure. */
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
      className={cn(
        'relative shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        active && 'bg-accent-soft !text-accent hover:!bg-accent-soft hover:!text-accent',
      )}
    >
      <IconNotifications size={ICON_SIZE.control} />
      {unreadCount > 0 ? (
        <CountBadge
          count={unreadCount}
          className="absolute right-0.5 top-0.5 border-2 border-panel"
        />
      ) : null}
    </IconButton>
  );
}
