import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { IconChevronRight } from '@/components/ui/icons';

interface ActionRowProps {
  icon: ReactNode;
  label: string;
  sub?: string;
  onClick: () => void;
  danger?: boolean;
  chevron?: boolean;
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
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
        'hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        danger ? 'text-bad' : 'text-fg',
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center',
          danger ? 'text-bad' : 'text-fg-2',
        )}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium leading-snug">{label}</span>
        {sub !== undefined ? (
          <span className="truncate text-xs leading-snug text-fg-3">{sub}</span>
        ) : null}
      </span>
      {chevron ? (
        <span className="ml-auto shrink-0 text-fg-3">
          <IconChevronRight />
        </span>
      ) : null}
    </button>
  );
}
