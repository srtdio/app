import { cn } from '@/lib/cn';

interface CountBadgeProps {
  count: number;
  /** Placement only (the nav's absolute corner and panel ring); never size or colour. */
  className?: string;
}

/** Display text for a count: capped at "99+". */
export function countBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * The one unread or pending count pill: tab bar, sidebar, topbar Activity,
 * chat list rows, Activity rows. One size and colour, capped at 99+. Renders
 * nothing at zero or below. Filter chip counts are plain text, never this.
 */
export function CountBadge({ count, className }: CountBadgeProps) {
  if (!(count > 0)) return null;
  return (
    <span
      data-count-badge=""
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold leading-none text-accent-fg',
        className,
      )}
    >
      {countBadgeText(count)}
    </span>
  );
}
