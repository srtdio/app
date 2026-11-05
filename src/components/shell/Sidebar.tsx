import { NavLink, useMatch } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconChevronDown, ICON_SIZE } from '@/components/ui/icons';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { selectTotalUnread } from '@/lib/chat/chat-store';
import { dispatchSorted } from '@/lib/events';
import { CountBadge } from '@/components/ui/CountBadge';
import { usePlanItemsUnreadTotal } from '@/lib/inbox/unread-entities';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import { navPrefetchProps } from '@/lib/route-prefetch';
import { INDUCTION_KEYS } from '@/lib/induction';
import { Bone, useNudgeOnRise, useSelectionSlide } from '@/lib/motion';

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
    <aside className="hidden md:flex md:flex-col md:sticky md:top-0 md:h-[100svh] md:self-start pt-[var(--shell-safe-top,0px)] w-[244px] shrink-0 border-r bg-panel lit-side">
      <div className="p-2.5">
        <PressableRow
          type="button"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          className="flex items-center gap-2.5 px-2 mv-tint"
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
            <span className="flex-1 min-w-0 font-semibold text-base leading-tight line-clamp-3 break-words">
              {workspaceName}
            </span>
          )}
          <IconChevronDown size={ICON_SIZE.inline} className="text-fg-3 shrink-0" />
        </PressableRow>
      </div>
      <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2.5">
        {PRIMARY_NAV.map((item) => (
          <SideNavItem key={item.to} item={item} chatUnread={total} planUnread={planUnread} />
        ))}
      </nav>
    </aside>
  );
}

/**
 * One sidebar nav item. Active is the one picked look: the solid ink fill
 * (bg-accent, lit-pill), which slides over from the last item
 * (useSelectionSlide); hover is the lit-hover overlay. The Chat icon nudges when
 * its unread count rises.
 */
function SideNavItem(props: {
  item: (typeof PRIMARY_NAV)[number];
  chatUnread: number;
  planUnread: number;
}) {
  const { item, chatUnread, planUnread } = props;
  const active = useMatch({ path: item.to, end: false }) !== null;
  const slideRef = useSelectionSlide(active);
  const nudgeRef = useNudgeOnRise(item.showChatBadge === true ? chatUnread : 0);
  return (
    <NavLink
      ref={slideRef}
      to={item.to}
      data-selected={active ? 'true' : undefined}
      {...navPrefetchProps(item.to)}
      {...(item.showChatBadge === true ? { 'data-induction': INDUCTION_KEYS.chatTab } : {})}
      className={() =>
        cn(
          'flex items-center gap-3 min-h-[44px] px-3 rounded-lg border text-base font-medium mv-tint focus-visible:lit-focus',
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
          <CountBadge
            count={chatUnread}
            className="absolute -right-2 -top-1.5 border-2 border-panel"
          />
        ) : null}
        {item.showPlanBadge === true && planUnread > 0 ? (
          <CountBadge
            count={planUnread}
            className="absolute -right-2 -top-1.5 border-2 border-panel"
          />
        ) : null}
      </span>
      <span>{item.label}</span>
    </NavLink>
  );
}
