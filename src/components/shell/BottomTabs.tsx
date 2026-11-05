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
import { useNudgeOnRise } from '@/lib/motion';
import { unreadCommentsLabel, usePlanItemsUnreadTotal } from '@/lib/inbox/unread-entities';
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
 * The floating row: 12px from both sides and the bottom, each past the safe
 * area (home indicator; the notch and rounded corners in landscape).
 */
export const PHONE_BAR_OFFSETS =
  'left-[calc(12px+env(safe-area-inset-left))] right-[calc(12px+env(safe-area-inset-right))] bottom-[calc(12px+env(safe-area-inset-bottom))]';

/** The Plan tab's accessible name: the label, plus its unread comments. Pure. */
export function planTabLabel(label: string, unread: number): string {
  return unread > 0 ? `${label}, ${unreadCommentsLabel(unread)}` : label;
}

/** The Chat circle's accessible name: "Chat", plus the unread count. Pure. */
export function chatTabLabel(unread: number): string {
  return unread > 0 ? `Chat, ${unread} unread` : 'Chat';
}

/**
 * A pill tab: inactive is the icon alone in a 44x44 target; active is icon and
 * label on the solid ink fill (bg-accent, lit-pill: the one picked look).
 */
function tabClass(active: boolean): string {
  return cn(
    'relative flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-full focus-visible:lit-focus mv-tint',
    active ? 'gap-1.5 bg-accent pl-3 pr-2.5 text-accent-fg lit-pill' : 'w-11 text-fg',
  );
}

/** One pill tab of the primary nav (Pipeline, Briefs, Assets, Plan). */
function PillTab(props: { item: (typeof PILL_NAV)[number]; planUnread: number }) {
  const { item, planUnread } = props;
  const active = useMatch({ path: item.to, end: false }) !== null;
  return (
    <NavLink
      to={item.to}
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
              className="absolute -right-2 -top-1.5 border-2 border-surface-top"
            />
          ) : null}
        </span>
      ) : (
        <item.Icon size={ICON_SIZE.control} />
      )}
      <TabLabel active={active} label={item.label} />
    </NavLink>
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
  const planUnread = usePlanItemsUnreadTotal();
  const { pathname } = useLocation();
  const activityActive = onNotifications(pathname);
  const activityNudgeRef = useNudgeOnRise(unreadCount);
  const chatNudgeRef = useNudgeOnRise(total);
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
          className="flex h-[60px] min-w-0 flex-1 items-center justify-between rounded-full border bg-panel p-1 lit-raised"
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
            <span className="relative">
              <span ref={activityNudgeRef} className="inline-flex">
                <IconNotifications size={ICON_SIZE.control} />
              </span>
              {unreadCount > 0 ? (
                <CountBadge
                  count={unreadCount}
                  className="absolute -right-2 -top-1.5 border-2 border-surface-top"
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
            // Opaque in every state, so the chat rows never show through the
            // circle on /chat. Active is the one picked look: the solid ink fill.
            className={({ isActive }) =>
              cn(
                'relative flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full border focus-visible:lit-focus mv-tint',
                isActive
                  ? 'border-transparent bg-accent text-accent-fg lit-pill'
                  : 'bg-panel lit-raised text-fg',
              )
            }
          >
            {() => (
              <>
                <span ref={chatNudgeRef} className="relative inline-flex">
                  <CHAT_NAV.Icon size={ICON_SIZE.tray} />
                </span>
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
