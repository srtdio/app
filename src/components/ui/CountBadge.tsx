import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { pop, rollDigit } from '@/lib/motion';

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
 *
 * Motion (small touches): the first paint never moves. When the count changes
 * on screen the digits roll one step on Y (rollDigit, 160 ms; up when it grew,
 * down when it fell), clipped by the pill; a badge that appears from zero pops
 * from .9 (ease-pop). The digits sit in their own span only once the count has
 * changed, so the first paint is the plain pill.
 */
export function CountBadge({ count, className }: CountBadgeProps) {
  const badge = useRef<HTMLSpanElement>(null);
  const digits = useRef<HTMLSpanElement>(null);
  // The count at the last commit, and whether it has changed since mount.
  const shown = useRef(count);
  const changed = useRef(false);
  if (count !== shown.current) changed.current = true;

  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = count;
    if (before === count || !(count > 0)) return;
    if (!(before > 0)) {
      pop(badge.current);
      return;
    }
    if (countBadgeText(before) === countBadgeText(count)) return;
    rollDigit(digits.current, count > before ? 1 : -1);
  }, [count]);

  if (!(count > 0)) return null;
  const text = countBadgeText(count);
  return (
    <span
      ref={badge}
      data-count-badge=""
      className={cn(
        'lit-badge inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent px-1 text-xs font-semibold leading-none text-accent-fg',
        className,
      )}
    >
      {changed.current ? (
        <span ref={digits} className="inline-block">
          {text}
        </span>
      ) : (
        text
      )}
    </span>
  );
}
