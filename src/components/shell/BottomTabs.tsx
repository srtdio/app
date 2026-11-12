import { NavLink, useLocation, useMatch } from 'react-router-dom';
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
import { MOVE_CLASS, useNudgeOnRise } from '@/lib/motion';
import {
  planTabHref,
  unreadCommentsLabel,
  useNewestPlanUnread,
  usePlanItemsUnreadTotal,
} from '@/lib/inbox/unread-entities';
import { cn } from '@/lib/cn';
import { activityPrefetchProps, navPrefetchProps } from '@/lib/route-prefetch';
import { IconNotifications, ICON_SIZE } from '@/components/ui/icons';
import { INDUCTION_KEYS } from '@/lib/induction';
import { bottomAnchorProps } from '@/lib/bottom-inset';

/** The phone pill: every PRIMARY_NAV item but Chat, in order, then Activity. */
const PILL_NAV = PRIMARY_NAV.filter((item) => item.showChatBadge !== true);
/** Chat: its own circle right of the pill. */
const CHAT_NAV = PRIMARY_NAV.find((item) => item.showChatBadge === true);

/**
 * The floating row: centred, only as wide as its tabs (never edge to edge),
 * 16px above the bottom past the safe area (home indicator).
 */
export const PHONE_BAR_OFFSETS =
  'left-1/2 -translate-x-1/2 bottom-[calc(16px+env(safe-area-inset-bottom))]';

/** The Plan tab's accessible name: the label, plus its unread comments. Pure. */
export function planTabLabel(label: string, unread: number): string {
  return unread > 0 ? `${label}, ${unreadCommentsLabel(unread)}` : label;
}

/** The Chat circle's accessible name: "Chat", plus the unread count. Pure. */
export function chatTabLabel(unread: number): string {
  return unread > 0 ? `Chat, ${unread} unread` : 'Chat';
}

/**
 * A pill tab, always a 44x44 target or wider: inactive is the icon alone in
 * fg-2; active is the panel-3 fill in fg ink with its name. Flat: no ink fill,
 * no pill light.
 */
export function tabClass(active: boolean): string {
  return cn(
    'relative flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full focus-visible:lit-focus',
    MOVE_CLASS.dock,
    active ? 'bg-panel-3 text-fg gap-2 px-3' : 'w-11 text-fg-2',
  );
}

/** The badge ring matches what is behind it: the active tab's fill, else the bar. */
function badgeRing(active: boolean): string {
  return active ? 'border-2 border-panel-3' : 'border-2 border-surface-top';
}

/** The open tab's name; nothing on any other tab. */
function TabLabel({ show, label }: { show: boolean; label: string }) {
  return show ? (
    <span data-tab-name="" className="shrink-0 whitespace-nowrap text-md font-medium">
      {label}
    </span>
  ) : null;
}

/** One pill tab of the primary nav (Pipeline, Briefs, Assets, Plan). */
function PillTab(props: { item: (typeof PILL_NAV)[number]; planUnread: number }) {
  const { item, planUnread } = props;
  const active = useMatch({ path: item.to, end: false }) !== null;
  // Plan with unread comments: the tap lands on the newest one (jump to latest).
  const newest = useNewestPlanUnread();
  const to = item.showPlanBadge === true && planUnread > 0 ? planTabHref(item.to, newest) : item.to;
  return (
    <NavLink
      to={to}
      data-selected={active ? 'true' : undefined}
      aria-label={item.showPlanBadge === true ? planTabLabel(item.label, planUnread) : item.label}
      {...navPrefetchProps(item.to)}
      className={() => tabClass(active)}
    >
      {item.showPlanBadge === true ? (
        // Plan: the icon carries the unread plan comments badge.
        <span className="relative inline-flex">
          <item.Icon size={ICON_SIZE.control} />
          {planUnread > 0 ? (
            <CountBadge
              count={planUnread}
              className={cn('absolute -right-2 -top-2', badgeRing(active))}
            />
          ) : null}
        </span>
      ) : (
        <item.Icon size={ICON_SIZE.control} />
      )}
      <TabLabel show={active} label={item.label} />
    </NavLink>
  );
}

/**
 * Phone nav (below md): a centred floating pill (Pipeline, Briefs, Assets,
 * Plan, Activity) and a separate Chat circle, 16px above the bottom, only as
 * wide as its tabs. Only the open tab shows its name (Chat too: an ink pill);
 * every other tab is a 44 icon slot. Flat: hairline edge, no shadow. Always
 * 52; it changes only on a tab change (MOVE_CLASS.dock). A fade strip behind
 * it keeps content that sits under the bar readable. Badges read the chat and inbox stores the
 * shell already holds: no read, no effect, no measuring.
 */
export function BottomTabs() {
  const { state } = useChatStore();
  const total = selectTotalUnread(state);
  const { unreadCount } = useInboxStore();
  const planUnread = usePlanItemsUnreadTotal();
  const { pathname } = useLocation();
  const activityActive = onNotifications(pathname);
  const activityNudgeRef = useNudgeOnRise(unreadCount);
  const chatNudgeRef = useNudgeOnRise(total);
  return (
    <>
      <div
        aria-hidden
        className="md:hidden pointer-events-none fixed inset-x-0 bottom-0 z-sticky h-24 bg-gradient-to-t from-bg to-bg/0"
      />
      <nav
        {...bottomAnchorProps}
        aria-label="Primary"
        className={cn(
          'md:hidden fixed z-nav flex items-center gap-2 select-none [-webkit-touch-callout:none]',
          PHONE_BAR_OFFSETS,
          MOVE_CLASS.dock,
        )}
      >
        <div
          data-tab-pill=""
          className={cn(
            'flex shrink-0 items-center rounded-full border border-border bg-panel',
            MOVE_CLASS.dock,
            'h-13 px-1',
          )}
        >
          {PILL_NAV.map((item) => (
            <PillTab key={item.to} item={item} planUnread={planUnread} />
          ))}
          {/* Activity: last in the pill on phone (the top bar's button is laptop only). */}
          <NavLink
            to={NOTIFICATIONS_PATH}
            aria-label={notificationsLabel(unreadCount)}
            data-activity-tab=""
            data-induction={INDUCTION_KEYS.activityTab}
            {...(activityActive ? { 'aria-current': 'page' as const } : {})}
            {...activityPrefetchProps()}
            data-selected={activityActive ? 'true' : undefined}
            className={tabClass(activityActive)}
          >
            <span className="relative inline-flex">
              <span ref={activityNudgeRef} className="inline-flex">
                <IconNotifications size={ICON_SIZE.control} />
              </span>
              {unreadCount > 0 ? (
                <CountBadge
                  count={unreadCount}
                  className={cn('absolute -right-2 -top-2', badgeRing(activityActive))}
                />
              ) : null}
            </span>
            <TabLabel show={activityActive} label={NOTIFICATIONS_TITLE} />
          </NavLink>
        </div>
        {CHAT_NAV !== undefined ? (
          <NavLink
            to={CHAT_NAV.to}
            aria-label={chatTabLabel(total)}
            data-chat-tab=""
            data-induction={INDUCTION_KEYS.chatTab}
            {...navPrefetchProps(CHAT_NAV.to)}
            // Opaque in every state, so the chat rows never show through the
            // circle on /chat. Open it is the ink pill with its name.
            className={({ isActive }) =>
              cn(
                'relative flex shrink-0 items-center justify-center rounded-full border focus-visible:lit-focus',
                MOVE_CLASS.dock,
                isActive ? 'h-13 gap-2 px-4' : 'h-13 w-13',
                isActive
                  ? 'border-transparent bg-accent text-accent-fg'
                  : 'border-border bg-panel text-fg-2',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span ref={chatNudgeRef} className="relative inline-flex">
                  <CHAT_NAV.Icon size={ICON_SIZE.tray} />
                </span>
                <TabLabel show={isActive} label={CHAT_NAV.label} />
                {total > 0 ? (
                  <CountBadge
                    count={total}
                    className="absolute right-0 top-0 border-2 border-surface-top"
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
