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
 * The chip label, with the live count appended for the two counted chips exactly
 * as the Unread chip has always done it (count folded into the label text, hidden
 * when zero, no clamp). The Mentions chip mirrors that markup so both read the
 * same in light and dark.
 */
function chipLabel(
  item: { key: ActivityState; label: string },
  totalUnread: number,
  mentionCount: number,
): string {
  if (item.key === 'unread' && totalUnread > 0) return `Unread ${totalUnread}`;
  if (item.key === 'mentions' && mentionCount > 0) return `Mentions ${mentionCount}`;
  return item.label;
}

// Edge-cut fade applied only while the row overflows; alpha-based so it is
// colour-agnostic and correct in light and dark with no token.
const OVERFLOW_MASK = 'linear-gradient(to right, #000 0, #000 calc(100% - 26px), transparent 100%)';

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
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const measure = () => setOverflowing(row.scrollWidth - row.clientWidth > 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const mask = overflowing ? OVERFLOW_MASK : 'none';

  return (
    // One horizontally scrollable line of chips, never wraps.
    // Runs full-bleed to the right edge (negative right margin cancels the page
    // gutter, paddingRight 0) so the boundary chip is clipped by the screen, with
    // an edge-cut fade applied only when the row overflows.
    <div
      ref={rowRef}
      className="mt-3 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 pl-4 -mr-4 md:pl-6 md:-mr-6"
      style={{ paddingRight: 0, WebkitMaskImage: mask, maskImage: mask }}
    >
      {STATE_CHIPS.map((item) => (
        <Chip
          key={item.key}
          label={chipLabel(item, totalUnread, mentionCount)}
          selected={state === item.key}
          size="tap"
          className="flex-none whitespace-nowrap"
          onClick={() => onStateChange(item.key)}
        />
      ))}
    </div>
  );
}
