import type { ReactNode } from 'react';

interface MenuItemProps {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
}

export function MenuItem({ label, onClick, icon }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 min-h-[44px] px-3 rounded-md text-sm text-fg-2 hover:bg-panel-2 hover:text-fg transition-colors text-left"
    >
      {icon !== undefined ? <span className="text-fg-3 shrink-0">{icon}</span> : null}
      <span>{label}</span>
    </button>
  );
}
