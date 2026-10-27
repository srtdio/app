import { NavLink, useLocation } from 'react-router-dom';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { useInboxStore } from '@/components/shell/InboxStoreProvider';
import {
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_TITLE,
  notificationsLabel,
  onNotifications,
} from '@/components/shell/NotificationsButton';
import { selectTotalUnread } from '@/lib/chat/chat-store';
import { CountBadge } from '@/components/ui/CountBadge';
import { cn } from '@/lib/cn';
import { activityPrefetchProps, navPrefetchProps } from '@/lib/route-prefetch';
import { IconNotifications, ICON_SIZE } from '@/components/ui/icons';
import { INDUCTION_KEYS } from '@/lib/induction';
import { bottomAnchorProps } from '@/lib/bottom-inset';

/** The phone pill: every PRIMARY_NAV item but Chat, in order, then Activity. */
const PILL_NAV = PRIMARY_NAV.filter((item) => item.showChatBadge !== true);
/** Chat: its own circle right of the pill. */
const CHAT_NAV = PRIMARY_NAV.find((item) => item.showChatBadge === true);

/** The floating row: 12px from both sides and the bottom (above the home indicator). */
export const PHONE_BAR_OFFSETS = 'left-3 right-3 bottom-[calc(12px+env(safe-area-inset-bottom))]';

/** The Chat circle's accessible name: "Chat", plus the unread count. Pure. */
export function chatTabLabel(unread: number): string {
  return unread > 0 ? `Chat, ${unread} unread` : 'Chat';
}

/**
 * A pill tab: inactive is the icon alone in a 44x44 target; active is icon and
 * label in an accent-soft capsule. The switch is instant (no width animation).
 */
function tabClass(active: boolean): string {
  return cn(
    'relative flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-full',
    active ? 'gap-1.5 bg-accent-soft pl-3 pr-2.5 text-accent' : 'w-11 text-fg-2',
  );
}

function TabLabel({ active, label }: { active: boolean; label: string }) {
  return active ? <span className="whitespace-nowrap text-md font-semibold">{label}</span> : null;
}

/**
 * Phone nav (below md): a floating pill (Pipeline, Briefs, Assets, Plan,
 * Activity) and a separate Chat circle, 12px from the sides and bottom; only
 * the active tab shows its label. A fade strip behind it keeps content that
 * scrolls under the bar readable. Badges read the chat and inbox stores the
 * shell already holds: no read, no effect, no measuring.
 */
export function BottomTabs() {
  const { state } = useChatStore();
  const total = selectTotalUnread(state);
  const { unreadCount } = useInboxStore();
  const { pathname } = useLocation();
  const activityActive = onNotifications(pathname);
  return (
    <>
      <div
        aria-hidden
        className="md:hidden pointer-events-none fixed inset-x-0 bottom-0 z-20 h-[120px] bg-gradient-to-t from-bg to-bg/0"
      />
      <nav
        {...bottomAnchorProps}
        aria-label="Primary"
        className={cn(
          'md:hidden fixed z-30 flex items-center gap-2 select-none [-webkit-touch-callout:none]',
          PHONE_BAR_OFFSETS,
        )}
      >
        <div
          data-tab-pill=""
          className="flex h-[60px] min-w-0 flex-1 items-center justify-between rounded-full border border-border bg-panel p-1 shadow-[var(--shadow-card)]"
        >
          {PILL_NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              aria-label={item.label}
              {...navPrefetchProps(item.to)}
              className={({ isActive }) => tabClass(isActive)}
            >
              {({ isActive }) => (
                <>
                  <item.Icon size={ICON_SIZE.control} />
                  <TabLabel active={isActive} label={item.label} />
                </>
              )}
            </NavLink>
          ))}
          {/* Activity: last in the pill on phone (the top bar's button is laptop only). */}
          <NavLink
            to={NOTIFICATIONS_PATH}
            aria-label={notificationsLabel(unreadCount)}
            data-activity-tab=""
            data-induction={INDUCTION_KEYS.activityTab}
            {...(activityActive ? { 'aria-current': 'page' as const } : {})}
            {...activityPrefetchProps()}
            className={tabClass(activityActive)}
          >
            <span className="relative">
              <IconNotifications size={ICON_SIZE.control} />
              {unreadCount > 0 ? (
                <CountBadge
                  count={unreadCount}
                  className="absolute -right-2 -top-1.5 border-2 border-panel"
                />
              ) : null}
            </span>
            <TabLabel active={activityActive} label={NOTIFICATIONS_TITLE} />
          </NavLink>
        </div>
        {CHAT_NAV !== undefined ? (
          <NavLink
            to={CHAT_NAV.to}
            aria-label={chatTabLabel(total)}
            data-chat-tab=""
            data-induction={INDUCTION_KEYS.chatTab}
            {...navPrefetchProps(CHAT_NAV.to)}
            // bg-panel in every state: accent-soft is translucent, so on its own
            // the chat rows would show through the circle on /chat.
            className={({ isActive }) =>
              cn(
                'relative flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full border border-border bg-panel shadow-[var(--shadow-card)]',
                isActive ? 'text-accent' : 'text-fg',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? (
                  <span
                    aria-hidden
                    data-chat-tab-tint=""
                    className="pointer-events-none absolute inset-0 rounded-full bg-accent-soft"
                  />
                ) : null}
                <span className="relative">
                  <CHAT_NAV.Icon size={ICON_SIZE.tray} />
                </span>
                {total > 0 ? (
                  <CountBadge
                    count={total}
                    className="absolute right-0 top-0 border-2 border-panel"
                  />
                ) : null}
              </>
            )}
          </NavLink>
        ) : null}
      </nav>
    </>
  );
}
