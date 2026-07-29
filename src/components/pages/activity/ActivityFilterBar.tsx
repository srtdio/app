import { useEffect, useRef, useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import type { ActivityScope, ActivityState } from '@/components/pages/activity/data';

const STATE_CHIPS: { key: ActivityState; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'mentions', label: 'Mentions' },
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

// Scope chips are single-select toggles; the 'everything' default is never a chip.
const SCOPE_CHIPS: { key: Exclude<ActivityScope, 'everything'>; label: string }[] = [
  { key: 'posts', label: 'Posts' },
  { key: 'briefs', label: 'Briefs' },
  { key: 'people', label: 'People' },
  { key: 'groups', label: 'Groups' },
  { key: 'clients', label: 'Clients' },
];

const DEFAULT_SCOPE: ActivityScope = 'everything';

// Single-select toggle: tap a scope to select it, tap the active scope to clear
// back to the internal default. State chips are not handled here.
export function nextScope(current: ActivityScope, clicked: ActivityScope): ActivityScope {
  return current === clicked ? DEFAULT_SCOPE : clicked;
}

// Edge-cut fade applied only while the row overflows; alpha-based so it is
// colour-agnostic and correct in light and dark with no token.
const OVERFLOW_MASK = 'linear-gradient(to right, #000 0, #000 calc(100% - 26px), transparent 100%)';

interface ActivityFilterBarProps {
  state: ActivityState;
  onStateChange: (state: ActivityState) => void;
  scope: ActivityScope;
  onScopeChange: (scope: ActivityScope) => void;
  totalUnread: number;
  mentionCount: number;
}

export function ActivityFilterBar({
  state,
  onStateChange,
  scope,
  onScopeChange,
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
    // One horizontally scrollable line: state chips then scope chips, never wraps.
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
      {SCOPE_CHIPS.map((item) => (
        <Chip
          key={item.key}
          label={item.label}
          selected={scope === item.key}
          size="tap"
          className="flex-none whitespace-nowrap"
          onClick={() => onScopeChange(nextScope(scope, item.key))}
        />
      ))}
    </div>
  );
}
