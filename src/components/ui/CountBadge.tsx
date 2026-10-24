import { cn } from '@/lib/cn';

interface CountBadgeProps {
  count: number;
  /** Extra classes appended last (e.g. the nav's absolute placement and panel ring). */
  className?: string;
}

/** Display text for a count: capped at "99+". */
export function countBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** The unread count pill shared by the nav badges and the chat list rows. */
export function CountBadge({ count, className }: CountBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold leading-none text-accent-fg',
        className,
      )}
    >
      {countBadgeText(count)}
    </span>
  );
}
