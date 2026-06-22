import { NavLink } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconChevronDown } from '@/components/ui/icons';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { useInboxStore } from '@/components/shell/InboxStoreProvider';
import { selectTotalUnread } from '@/lib/chat/chat-store';
import { dispatchSorted } from '@/lib/events';
import { cn } from '@/lib/cn';

interface SidebarProps {
  workspaceName: string | null;
}

export function Sidebar({ workspaceName }: SidebarProps) {
  const { state } = useChatStore();
  const total = selectTotalUnread(state);
  const { unreadCount } = useInboxStore();
  return (
    <aside className="hidden md:flex md:flex-col w-[244px] shrink-0 border-r border-border bg-panel">
      <div className="p-2.5">
        <button
          type="button"
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          className="flex w-full items-center gap-2.5 min-h-[44px] px-2 rounded-lg hover:bg-panel-2 transition-colors text-left"
        >
          {workspaceName !== null ? (
            <Avatar name={workspaceName} size="lg" />
          ) : (
            <Avatar size="lg" />
          )}
          {workspaceName === null ? (
            <span className="flex-1 h-4 rounded bg-panel-3 animate-pulse" aria-hidden />
          ) : (
            <span className="flex-1 font-semibold text-sm truncate">{workspaceName}</span>
          )}
          <IconChevronDown size={16} className="text-fg-3 shrink-0" />
        </button>
      </div>
      <nav className="flex flex-col gap-0.5 px-2.5">
        {PRIMARY_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 min-h-[44px] px-3 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent-soft text-accent'
                  : 'text-fg-2 hover:bg-panel-2 hover:text-fg',
              )
            }
          >
            <span className="relative">
              <item.Icon size={18} />
              {item.showChatBadge && total > 0 ? (
                <span className="absolute -right-2 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-panel bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg">
                  {total > 99 ? '99+' : total}
                </span>
              ) : null}
              {item.showActivityBadge && unreadCount > 0 ? (
                <span className="absolute -right-2 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-panel bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              ) : null}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
