import { NavLink } from 'react-router-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconChevronDown } from '@/components/ui/icons';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { dispatchSorted } from '@/lib/events';
import { cn } from '@/lib/cn';

interface SidebarProps {
  workspaceName: string;
}

export function Sidebar({ workspaceName }: SidebarProps) {
  return (
    <aside className="hidden md:flex md:flex-col w-[244px] shrink-0 border-r border-border bg-panel">
      <div className="p-2.5">
        <button
          type="button"
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          className="flex w-full items-center gap-2.5 min-h-[44px] px-2 rounded-lg hover:bg-panel-2 transition-colors text-left"
        >
          <Avatar name={workspaceName} size="lg" />
          <span className="flex-1 font-semibold text-sm truncate">{workspaceName}</span>
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
                isActive ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-panel-2 hover:text-fg',
              )
            }
          >
            <item.Icon size={18} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
