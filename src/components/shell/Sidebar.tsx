import { NavLink, useMatch } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconActivity, IconChevronDown, ICON_SIZE } from '@/components/ui/icons';
import { useInboxStore } from '@/components/shell/InboxStoreProvider';
import {
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_TITLE,
  notificationsLabel,
} from '@/components/shell/NotificationsButton';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { selectTotalUnread } from '@/lib/chat/chat-store';
import { dispatchSorted } from '@/lib/events';
import { CountBadge } from '@/components/ui/CountBadge';
import {
  planTabHref,
  useNewestPlanUnread,
  usePlanItemsUnreadTotal,
} from '@/lib/inbox/unread-entities';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';
import { navPrefetchProps } from '@/lib/route-prefetch';
import { INDUCTION_KEYS } from '@/lib/induction';
import { Bone, useNudgeOnRise } from '@/lib/motion';

/** A nav item's count badge: on the icon's corner, cut out of the panel by a 2 ring. */
const NAV_BADGE_CLASS = 'absolute -right-2 -top-2 border-2 border-panel';

interface SidebarProps {
  /** The active workspace's display name ("<Brand> - <Platform>"). */
  workspaceName: string | null;
  /** The brand name alone, for the avatar's initials. */
  clientName?: string | null;
}

export function Sidebar({ workspaceName, clientName = null }: SidebarProps) {
  const { state } = useChatStore();
  const total = selectTotalUnread(state);
  const planUnread = usePlanItemsUnreadTotal();
  return (
    // Positioning only. Pinned while the document scrolls (page mode on a touch
    // tablet, src/lib/scroll-mode.ts): sticky to the window at one viewport
    // tall, the status bar strip covered by top padding on this same lit
    // surface (--shell-safe-top, 0 everywhere else). In the locked 100svh
    // shell (laptop, Chat) this is the same box as before: the full shell
    // height, nothing scrolls past it, padding 0.
    <aside className="hidden md:flex md:flex-col md:sticky md:top-0 md:h-[100svh] md:self-start pt-[var(--shell-safe-top,0px)] w-60 shrink-0 border-r bg-panel lit-side">
      <div className="p-3">
        <PressableRow
          type="button"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          className="flex items-center gap-3 px-3 mv-tint"
        >
          {workspaceName !== null ? (
            <Avatar name={clientName ?? workspaceName} role="header" kind="group" />
          ) : (
            <Avatar role="header" kind="group" />
          )}
          {workspaceName === null ? (
            <Bone lit="flat" className="flex-1 h-4 rounded" />
          ) : (
            // "<Brand> - <Platform>": wrap (up to three lines) rather than clip the platform.
            <span className={textRole('title', 'min-w-0 flex-1 line-clamp-3 break-words')}>
              {workspaceName}
            </span>
          )}
          <IconChevronDown size={ICON_SIZE.inline} className="text-fg-3 shrink-0" />
        </PressableRow>
      </div>
      <nav aria-label="Primary" className="flex flex-col gap-1 px-3">
        {PRIMARY_NAV.map((item) => (
          <SideNavItem key={item.to} item={item} chatUnread={total} planUnread={planUnread} />
        ))}
        <ActivityNavItem />
      </nav>
    </aside>
  );
}

/**
 * One sidebar nav item. Active is the one picked look: the solid ink fill
 * (bg-accent, lit-pill); hover is the lit-hover overlay. The Chat icon nudges when
 * its unread count rises.
 */
function SideNavItem(props: {
  item: (typeof PRIMARY_NAV)[number];
  chatUnread: number;
  planUnread: number;
}) {
  const { item, chatUnread, planUnread } = props;
  const active = useMatch({ path: item.to, end: false }) !== null;
  const nudgeRef = useNudgeOnRise(item.showChatBadge === true ? chatUnread : 0);
  // Plan with unread comments: the tap lands on the newest one (jump to latest).
  const newest = useNewestPlanUnread();
  const to = item.showPlanBadge === true && planUnread > 0 ? planTabHref(item.to, newest) : item.to;
  return (
    <NavLink
      to={to}
      data-selected={active ? 'true' : undefined}
      {...navPrefetchProps(item.to)}
      {...(item.showChatBadge === true ? { 'data-induction': INDUCTION_KEYS.chatTab } : {})}
      className={() =>
        cn(
          'flex items-center gap-3 min-h-11 px-3 rounded-lg border text-base font-medium mv-tint focus-visible:lit-focus',
          active
            ? 'border-transparent bg-accent text-accent-fg lit-pill'
            : 'border-transparent text-fg-2 lit-hover hover:text-fg',
        )
      }
    >
      <span className="relative">
        <span ref={nudgeRef} className="inline-flex">
          <item.Icon size={ICON_SIZE.nav} />
        </span>
        {item.showChatBadge === true && chatUnread > 0 ? (
          <CountBadge count={chatUnread} className={NAV_BADGE_CLASS} />
        ) : null}
        {item.showPlanBadge === true && planUnread > 0 ? (
          <CountBadge count={planUnread} className={NAV_BADGE_CLASS} />
        ) : null}
      </span>
      <span>{item.label}</span>
    </NavLink>
  );
}

/**
 * Activity, the sidebar's last item after Chat (10 Nov 2026): the same look as
 * every item (min-h-11, active = the ink fill), IconActivity with the inbox
 * unread count, active on /notifications. It replaces the laptop top bar's
 * Activity button; the phone keeps it in the floating tab bar.
 */
function ActivityNavItem() {
  const { unreadCount } = useInboxStore();
  const active = useMatch({ path: NOTIFICATIONS_PATH, end: false }) !== null;
  const nudgeRef = useNudgeOnRise(unreadCount);
  return (
    <NavLink
      to={NOTIFICATIONS_PATH}
      data-sidebar-activity=""
      data-selected={active ? 'true' : undefined}
      aria-label={notificationsLabel(unreadCount)}
      data-induction={INDUCTION_KEYS.activityTab}
      {...navPrefetchProps(NOTIFICATIONS_PATH)}
      className={() =>
        cn(
          'flex items-center gap-3 min-h-11 px-3 rounded-lg border text-base font-medium mv-tint focus-visible:lit-focus',
          active
            ? 'border-transparent bg-accent text-accent-fg lit-pill'
            : 'border-transparent text-fg-2 lit-hover hover:text-fg',
        )
      }
    >
      <span className="relative">
        <span ref={nudgeRef} className="inline-flex">
          <IconActivity size={ICON_SIZE.nav} />
        </span>
        {unreadCount > 0 ? <CountBadge count={unreadCount} className={NAV_BADGE_CLASS} /> : null}
      </span>
      <span>{NOTIFICATIONS_TITLE}</span>
    </NavLink>
  );
}
