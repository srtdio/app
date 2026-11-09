// The creator-side order for the Briefs list (role key agency). Fixed since
// 9 Nov 2026: no Sort control. Open briefs by due date soonest first, undated
// last by newest updated; closed briefs by closed_at newest first; on All the
// open block comes first. Pure (no hooks, no Date.now), so the order is
// unit-tested without rendering. Approvers keep the time sections.

import type { SortOption } from '@/components/ui/SortMenu';

export type BriefSort = 'due' | 'updated';

export const BRIEF_SORT_OPTIONS: SortOption<BriefSort>[] = [
  { value: 'due', label: 'Due date' },
  { value: 'updated', label: 'Newest first' },
];

interface BriefSortable {
  target_date: string | null;
  updated_at: string;
}

/**
 * A new array in the chosen order. Due date: soonest first (date-only strings
 * compare as text), briefs with no due date last, ties by most recently
 * updated. Newest first: newest updated_at first. Never mutates the input.
 */
export function sortBriefs<T extends BriefSortable>(items: readonly T[], sort: BriefSort): T[] {
  const byUpdated = (a: T, b: T): number =>
    a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
  if (sort === 'updated') return [...items].sort(byUpdated);
  return [...items].sort((a, b) => {
    if (a.target_date !== b.target_date) {
      if (a.target_date === null) return 1;
      if (b.target_date === null) return -1;
      return a.target_date < b.target_date ? -1 : 1;
    }
    return byUpdated(a, b);
  });
}

interface BriefClosedSortable {
  closed_at: string | null;
  updated_at: string;
}

/**
 * A new array of closed briefs, most recently closed first (closed_at newest
 * first; a row with no closed_at falls back to its updated_at). Never mutates
 * the input.
 */
export function sortClosedBriefs<T extends BriefClosedSortable>(items: readonly T[]): T[] {
  const at = (row: T): string => row.closed_at ?? row.updated_at;
  return [...items].sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
}

interface BriefFixedSortable extends BriefSortable, BriefClosedSortable {
  status: string;
}

/**
 * The creator-side fixed order over any mix of statuses: the open block
 * (sortBriefs by due date) first, then the closed block (sortClosedBriefs).
 * Never mutates the input.
 */
export function orderBriefsFixed<T extends BriefFixedSortable>(items: readonly T[]): T[] {
  const open = items.filter((row) => row.status !== 'closed');
  const closed = items.filter((row) => row.status === 'closed');
  return [...sortBriefs(open, 'due'), ...sortClosedBriefs(closed)];
}
