import { useEffect, useRef, useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import type { ActivityState } from '@/components/pages/activity/data';

// The only chips, single-select, in this order (no separate scope row).
// Fired reminders, scheduled sends and task alerts have no chip: All and Unread
// show them. Upcoming lists what has not happened yet (scheduled messages not
// sent, pending reminders); it is never counted.
const STATE_CHIPS: { key: ActivityState; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'mentions', label: 'Mentions' },
  { key: 'briefs', label: 'Briefs' },
  { key: 'plans', label: 'Plans' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'snoozed', label: 'Snoozed' },
];

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
  state: ActivityState;
  onStateChange: (state: ActivityState) => void;
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
    // One horizontally scrollable line of chips, never wraps, running to the
    // screen's right edge. A trailing spacer (plus the chip gap) makes the right
    // gutter equal the left one, so the last chip is fully visible at the end.
    <div
      ref={rowRef}
      data-activity-chips=""
      className="mt-3 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 pl-4 md:pl-6"
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
      <span aria-hidden="true" data-activity-chips-end="" className="h-px w-2 flex-none md:w-4" />
    </div>
  );
}
