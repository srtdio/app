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
 * One tappable row for a bottom sheet: left icon, label, an optional muted sub
 * line, and an optional trailing chevron. Full width, at least 44px tall so it
 * clears the minimum touch target. Colour comes only through token-backed
 * Tailwind classes, so light and dark parity is automatic.
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
        'w-full min-h-[44px] flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors',
        'hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line',
        danger ? 'text-bad' : 'text-fg',
      )}
    >
      <span
        className={cn(
          'shrink-0 flex items-center justify-center',
          danger ? 'text-bad' : 'text-fg-2',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium truncate">{label}</span>
        {sub !== undefined ? <span className="block text-xs text-fg-3 truncate">{sub}</span> : null}
      </span>
      {chevron ? <IconChevronRight className="shrink-0 text-fg-3" /> : null}
    </button>
  );
}
