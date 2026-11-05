import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { pop, rollDigit } from '@/lib/motion';

type CountBadgeProps =
  | {
      /** 'unread' (default): the accent pill for unread or pending counts. */
      tone?: 'unread';
      count: number;
      /** Placement only (the nav's absolute corner and panel ring); never size or colour. */
      className?: string;
    }
  | {
      /**
       * 'section': a section's item count on a grey surface (chat open-items
       * drawer headers). Neutral pill, mono digits; takes a ratio like "1/5".
       */
      tone: 'section';
      count: number | string;
      className?: string;
    };

const UNREAD_CLASS =
  'lit-badge inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent px-1 text-xs font-semibold leading-none text-accent-fg';
const SECTION_CLASS =
  'lit-pill inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-panel-2 px-2 text-center font-mono text-sm font-medium tabular-nums text-fg';

/** Display text for a count: capped at "99+". */
export function countBadgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * The one count pill. tone 'unread' (default): unread or pending counts: tab bar, sidebar, topbar Activity,
 * chat list rows, Activity rows. One size and colour, capped at 99+. Renders
 * nothing at zero or below. Filter chip counts are plain text, never this.
 *
 * Motion (small touches): the first paint never moves. When the count changes
 * on screen the digits roll one step on Y (rollDigit, 160 ms; up when it grew,
 * down when it fell), clipped by the pill; a badge that appears from zero pops
 * from .9 (ease-pop). The digits sit in their own span only once the count has
 * changed, so the first paint is the plain pill. tone 'section': a neutral
 * pill (lit-pill, panel-2, border-strong edge, mono digits) for a section's
 * count on a grey drawer; always shown, never moves.
 */
export function CountBadge(props: CountBadgeProps) {
  if (props.tone === 'section') {
    const { count, className } = props;
    // A section count does not move; it paints as given ("3", "1/5").
    const text = typeof count === 'number' ? countBadgeText(count) : count;
    return (
      <span data-count-badge="section" className={cn(SECTION_CLASS, className)}>
        {text}
      </span>
    );
  }
  return <UnreadBadge count={props.count} className={props.className} />;
}

function UnreadBadge({ count, className }: { count: number; className?: string | undefined }) {
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
    <span ref={badge} data-count-badge="" className={cn(UNREAD_CLASS, className)}>
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
