import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ICON_SIZE, IconChevronRight } from '@/components/ui/icons';
import { PressableRow } from '@/components/ui/PressableRow';

interface ActionRowProps {
  /** An icon from ui/icons.tsx; the row renders it at ICON_SIZE.tray, whatever size it carries. */
  icon: ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
  danger?: boolean;
  chevron?: boolean;
}

/** A menu row's icon at the one menu-row size (ICON_SIZE.tray). */
export function trayIcon(icon: ReactNode): ReactNode {
  return isValidElement(icon)
    ? cloneElement(icon as ReactElement<{ size?: number }>, { size: ICON_SIZE.tray })
    : icon;
}

/**
 * One tappable row for bottom sheets: left icon + label, an optional muted sub
 * line, and an optional right chevron. Full width, at least a 44px touch
 * target, keyboard focusable. Colour comes only through token-backed Tailwind
 * classes (no hardcoded hex), so light and dark mode track src/index.css.
 */
export function ActionRow({
  icon,
  label,
  sub,
  onClick,
  danger = false,
  chevron = false,
}: ActionRowProps) {
  return (
    <PressableRow
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 px-3 py-2 transition-colors',
        danger ? 'text-bad' : 'text-fg',
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center',
          danger ? 'text-bad' : 'text-fg-2',
        )}
      >
        {trayIcon(icon)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-base font-medium leading-snug">{label}</span>
        {sub !== undefined ? (
          <span className="truncate text-sm leading-snug text-fg-3">{sub}</span>
        ) : null}
      </span>
      {chevron ? (
        <span className="ml-auto shrink-0 text-fg-3">
          <IconChevronRight />
        </span>
      ) : null}
    </PressableRow>
  );
}
