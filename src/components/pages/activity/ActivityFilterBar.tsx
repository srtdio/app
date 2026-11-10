import { useEffect, useRef, useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import type { ActivityState } from '@/components/pages/activity/data';

/** The chips the bar shows (Snoozed is gone; a kept 'snoozed' reads as All). */
export type ActivityChip = Exclude<ActivityState, 'snoozed'>;

// The only chips, single-select, in this order (no separate scope row, no search).
// Brief, plan, task and idea bank rows have no chip: All and Unread show them.
export const STATE_CHIPS: readonly { key: ActivityChip; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'mentions', label: 'Mentions' },
];

/**
 * The chip a kept chip value shows: a retired chip ('snoozed', 'briefs',
 * 'plans') or anything unknown is All. Pure.
 */
export function activityChip(kept: string): ActivityChip {
  return kept === 'unread' || kept === 'mentions' ? kept : 'all';
}

/**
 * The chip's count: the live unread or mention count for the two counted chips
 * (ui/Chip shows it only when above 0); the other chips carry none.
 */
function chipCount(
  item: { key: ActivityState },
  totalUnread: number,
  mentionCount: number,
): { count?: number } {
  if (item.key === 'unread') return { count: totalUnread };
  if (item.key === 'mentions') return { count: mentionCount };
  return {};
}

// Edge-cut fade shown only while more chips remain to the right; alpha-based so
// it is colour-agnostic and correct in light and dark with no token.
const OVERFLOW_MASK = 'linear-gradient(to right, #000 0, #000 calc(100% - 26px), transparent 100%)';

/** Whether chips remain past the right edge of a scrolled row (2px slack). Pure. */
export function moreToRight(row: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): boolean {
  return row.scrollWidth - row.clientWidth - row.scrollLeft > 2;
}

interface ActivityFilterBarProps {
  state: ActivityChip;
  onStateChange: (state: ActivityChip) => void;
  totalUnread: number;
  mentionCount: number;
}

export function ActivityFilterBar({
  state,
  onStateChange,
  totalUnread,
  mentionCount,
}: ActivityFilterBarProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState(false);

  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const measure = () => setFade(moreToRight(row));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    row.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      row.removeEventListener('scroll', measure);
    };
  }, []);

  const mask = fade ? OVERFLOW_MASK : 'none';

  return (
    // The chips only: shell/ListScreen's chip row draws the frame (its top
    // gap, side pads and the gutter at the end). This line scrolls sideways
    // inside it and fades at its right edge while chips remain past it.
    <div
      ref={rowRef}
      data-activity-chips=""
      className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ WebkitMaskImage: mask, maskImage: mask }}
    >
      {STATE_CHIPS.map((item) => (
        <Chip
          key={item.key}
          label={item.label}
          {...chipCount(item, totalUnread, mentionCount)}
          selected={state === item.key}
          size="tap"
          className="flex-none whitespace-nowrap"
          onClick={() => onStateChange(item.key)}
        />
      ))}
    </div>
  );
}
