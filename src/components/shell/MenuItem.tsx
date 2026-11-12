import { cn } from '@/lib/cn';
import { SHEET_ROW_ICON_PHONE, SHEET_ROW_PHONE } from '@/components/ui/layout';
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
      className={cn(
        'flex items-center gap-3 px-3 text-base text-fg-2 hover:text-fg mv-tint',
        SHEET_ROW_PHONE,
      )}
    >
      {icon !== undefined ? (
        <span className={cn('flex shrink-0 text-fg-3', SHEET_ROW_ICON_PHONE)}>
          {trayIcon(icon)}
        </span>
      ) : null}
      <span>{label}</span>
    </PressableRow>
  );
}
