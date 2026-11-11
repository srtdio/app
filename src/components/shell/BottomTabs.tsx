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
import { useEffect, useState } from 'react';
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

/** Scrolled less than this from the top, the dock is always at rest. */
const DOCK_TOP_PX = 24;
/** A scroll step past this flips the dock (down shrinks, up grows). */
const DOCK_STEP_PX = 8;

/**
 * The dock's next state from one scroll step (iOS 26 tabBarMinimizeBehavior
 * .onScrollDown): near the top it rests; a step down past 8 shrinks, a step up
 * past 8 grows; smaller steps keep the state. Pure.
 */
export function dockShrinkNext(shrunk: boolean, prevTop: number, top: number): boolean {
  if (top <= DOCK_TOP_PX) return false;
  if (top - prevTop > DOCK_STEP_PX) return true;
  if (top - prevTop < -DOCK_STEP_PX) return false;
  return shrunk;
}

/** The scrollTop of a scroll event's target: the window's scroller or an inner one. */
function scrollTopOf(target: EventTarget | null): { el: object; top: number } | null {
  if (target instanceof Document) {
    const root = target.scrollingElement ?? target.documentElement;
    return { el: root, top: root.scrollTop };
  }
  if (target instanceof Element) return { el: target, top: target.scrollTop };
  return null;
}

/**
 * The phone dock shrinks while a page scrolls down and grows on scroll up or
 * near the top. One passive capture 'scroll' listener on document covers the
 * window and every inner scroller (a horizontal chip row never changes
 * scrollTop, so it never flips the dock). It reads scrollTop only, keeps the
 * last one per element in a WeakMap and sets state only on a flip. No await,
 * no timer, no measuring.
 */
export function useDockShrunk(): boolean {
  const [shrunk, setShrunk] = useState(false);
  useEffect(() => {
    const last = new WeakMap<object, number>();
    let current = false;
    const onScroll = (event: Event): void => {
      const read = scrollTopOf(event.target);
      if (read === null) return;
      const prev = last.get(read.el) ?? read.top;
      last.set(read.el, read.top);
      const next = dockShrinkNext(current, prev, read.top);
      if (next !== current) {
        current = next;
        setShrunk(next);
      }
    };
    const options: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener('scroll', onScroll, options);
    return () => document.removeEventListener('scroll', onScroll, options);
  }, []);
  return shrunk;
}

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
 * fg-2; active is the panel-3 fill in fg ink with its name (the name hides
 * and the tab is 44 again while the dock is shrunk). Flat: no ink fill, no
 * pill light.
 */
export function tabClass(active: boolean, shrunk = false): string {
  return cn(
    'relative flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full focus-visible:lit-focus',
    MOVE_CLASS.dock,
    active ? 'bg-panel-3 text-fg' : 'w-11 text-fg-2',
    active && (shrunk ? 'w-11' : 'gap-2 px-3'),
  );
}

/** The badge ring matches what is behind it: the active tab's fill, else the bar. */
function badgeRing(active: boolean): string {
  return active ? 'border-2 border-panel-3' : 'border-2 border-surface-top';
}

/** The open tab's name; nothing on any other tab or while the dock is shrunk. */
function TabLabel({ show, label }: { show: boolean; label: string }) {
  return show ? (
    <span data-tab-name="" className="shrink-0 whitespace-nowrap text-md font-medium">
      {label}
    </span>
  ) : null;
}

/** One pill tab of the primary nav (Pipeline, Briefs, Assets, Plan). */
function PillTab(props: { item: (typeof PILL_NAV)[number]; planUnread: number; shrunk: boolean }) {
  const { item, planUnread, shrunk } = props;
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
      className={() => tabClass(active, shrunk)}
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
      <TabLabel show={active && !shrunk} label={item.label} />
    </NavLink>
  );
}

/**
 * Phone nav (below md): a centred floating pill (Pipeline, Briefs, Assets,
 * Plan, Activity) and a separate Chat circle, 16px above the bottom, only as
 * wide as its tabs. Only the open tab shows its name (Chat too: an ink pill);
 * every other tab is a 44 icon slot. Flat: hairline edge, no shadow. 52 at
 * rest, 44 while scrolling down (every name hides, icons stay), back at rest
 * on scroll up or near the top (useDockShrunk, MOVE_CLASS.dock). A fade strip behind it keeps content that
 * scrolls under the bar readable. Badges read the chat and inbox stores the
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
  const shrunk = useDockShrunk();
  return (
    <>
      <div
        aria-hidden
        className="md:hidden pointer-events-none fixed inset-x-0 bottom-0 z-sticky h-24 bg-gradient-to-t from-bg to-bg/0"
      />
      <nav
        {...bottomAnchorProps}
        aria-label="Primary"
        data-dock={shrunk ? 'shrunk' : 'rest'}
        className={cn(
          'md:hidden fixed z-nav flex items-center gap-2 select-none [-webkit-touch-callout:none]',
          PHONE_BAR_OFFSETS,
          MOVE_CLASS.dock,
          shrunk && 'translate-y-1',
        )}
      >
        <div
          data-tab-pill=""
          className={cn(
            'flex shrink-0 items-center rounded-full border border-border bg-panel',
            MOVE_CLASS.dock,
            shrunk ? 'h-11' : 'h-13 px-1',
          )}
        >
          {PILL_NAV.map((item) => (
            <PillTab key={item.to} item={item} planUnread={planUnread} shrunk={shrunk} />
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
            className={tabClass(activityActive, shrunk)}
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
            <TabLabel show={activityActive && !shrunk} label={NOTIFICATIONS_TITLE} />
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
            // circle on /chat. Open at rest it is the ink pill with its name;
            // shrunk it is the 44 circle again.
            className={({ isActive }) =>
              cn(
                'relative flex shrink-0 items-center justify-center rounded-full border focus-visible:lit-focus',
                MOVE_CLASS.dock,
                shrunk ? 'h-11 w-11' : isActive ? 'h-13 gap-2 px-4' : 'h-13 w-13',
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
                <TabLabel show={isActive && !shrunk} label={CHAT_NAV.label} />
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
