import type { ReactNode } from 'react';
import { PressableRow } from '@/components/ui/PressableRow';
import { trayIcon } from '@/components/ui/ActionRow';

interface MenuItemProps {
  label: string;
  onClick: () => void;
  /** An icon from ui/icons.tsx; rendered at ICON_SIZE.tray (the menu-row size). */
  icon?: ReactNode;
}

export function MenuItem({ label, onClick, icon }: MenuItemProps) {
  return (
    <PressableRow
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-3 px-3 text-base text-fg-2 hover:text-fg transition-colors"
    >
      {icon !== undefined ? <span className="text-fg-3 shrink-0">{trayIcon(icon)}</span> : null}
      <span>{label}</span>
    </PressableRow>
  );
}
