import { NavLink } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconChevronDown } from '@/components/ui/icons';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { selectTotalUnread } from '@/lib/chat/chat-store';
import { dispatchSorted } from '@/lib/events';
import { CountBadge } from '@/components/ui/CountBadge';
import { cn } from '@/lib/cn';
import { INDUCTION_KEYS } from '@/lib/induction';

interface SidebarProps {
  /** The active workspace's display name ("<Brand> - <Platform>"). */
  workspaceName: string | null;
  /** The brand name alone, for the avatar's initials. */
  clientName?: string | null;
}

export function Sidebar({ workspaceName, clientName = null }: SidebarProps) {
  const { state } = useChatStore();
  const total = selectTotalUnread(state);
  return (
    <aside className="hidden md:flex md:flex-col w-[244px] shrink-0 border-r border-border bg-panel">
      <div className="p-2.5">
        <button
          type="button"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          className="flex w-full items-center gap-2.5 min-h-[44px] px-2 rounded-lg hover:bg-panel-2 transition-colors text-left"
        >
          {workspaceName !== null ? (
            <Avatar name={clientName ?? workspaceName} size="lg" />
          ) : (
            <Avatar size="lg" />
          )}
          {workspaceName === null ? (
            <span className="flex-1 h-4 rounded bg-panel-3 animate-pulse" aria-hidden />
          ) : (
            // "<Brand> - <Platform>": wrap (up to three lines) rather than clip the platform.
            <span className="flex-1 min-w-0 font-semibold text-base leading-tight line-clamp-3 break-words">
              {workspaceName}
            </span>
          )}
          <IconChevronDown size={16} className="text-fg-3 shrink-0" />
        </button>
      </div>
      <nav className="flex flex-col gap-0.5 px-2.5">
        {PRIMARY_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            {...(item.showChatBadge === true ? { 'data-induction': INDUCTION_KEYS.chatTab } : {})}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 min-h-[44px] px-3 rounded-lg text-base font-medium transition-colors',
                isActive
                  ? 'bg-accent-soft text-accent'
                  : 'text-fg-2 hover:bg-panel-2 hover:text-fg',
              )
            }
          >
            <span className="relative">
              <item.Icon size={18} />
              {item.showChatBadge && total > 0 ? (
                <CountBadge
                  count={total}
                  className="absolute -right-2 -top-1.5 border-2 border-panel"
                />
              ) : null}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
