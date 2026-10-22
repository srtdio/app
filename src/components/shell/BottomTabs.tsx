import { NavLink } from 'react-router-dom';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { selectTotalUnread } from '@/lib/chat/chat-store';
import { CountBadge } from '@/components/ui/CountBadge';
import { cn } from '@/lib/cn';
import { INDUCTION_KEYS } from '@/lib/induction';

export function BottomTabs() {
  const { state } = useChatStore();
  const total = selectTotalUnread(state);
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 flex border-t border-border bg-panel pb-[env(safe-area-inset-bottom)]">
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
          {/* The guide boxes the icon and its label, not the whole 56px cell: the
              whole cell meets the screen's edge and the box would be cut there. */}
          <span
            {...(item.showChatBadge === true ? { 'data-induction': INDUCTION_KEYS.chatTab } : {})}
            className="flex flex-col items-center gap-1 rounded-lg px-1.5 py-0.5"
          >
            <span className="relative">
              <item.Icon size={20} />
              {item.showChatBadge && total > 0 ? (
                <CountBadge
                  count={total}
                  className="absolute -right-2 -top-1.5 border-2 border-panel"
                />
              ) : null}
            </span>
            <span>{item.label}</span>
          </span>
        </NavLink>
      ))}
    </nav>
  );
}
