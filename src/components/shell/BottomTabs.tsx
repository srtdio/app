import { NavLink } from 'react-router-dom';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { selectTotalUnread } from '@/lib/chat/chat-store';
import { cn } from '@/lib/cn';

export function BottomTabs() {
  const { state } = useChatStore();
  const total = selectTotalUnread(state);
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 flex border-t border-border bg-panel">
      {PRIMARY_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            cn(
              'flex flex-1 flex-col items-center justify-center gap-1 min-h-[56px] text-[11px] font-medium transition-colors',
              isActive ? 'text-accent' : 'text-fg-3',
            )
          }
        >
          <span className="relative">
            <item.Icon size={20} />
            {item.showChatBadge && total > 0 ? (
              <span className="absolute -right-2 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-panel bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg">
                {total > 99 ? '99+' : total}
              </span>
            ) : null}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
