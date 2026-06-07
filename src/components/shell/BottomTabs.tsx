import { NavLink } from 'react-router-dom';
import { PRIMARY_NAV } from '@/components/shell/nav';
import { cn } from '@/lib/cn';

export function BottomTabs() {
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
          <item.Icon size={20} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
