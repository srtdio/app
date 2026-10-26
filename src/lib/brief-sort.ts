// The agency-side sort for the Briefs list. Pure (no hooks, no Date.now), so
// the order is unit-tested without rendering. Client approvers keep the time
// sections and never see this control.

import type { SortOption } from '@/components/ui/SortMenu';

export type BriefSort = 'due' | 'updated';

export const BRIEF_SORT_DEFAULT: BriefSort = 'due';

export const BRIEF_SORT_OPTIONS: SortOption<BriefSort>[] = [
  { value: 'due', label: 'Due date' },
  { value: 'updated', label: 'Newest first' },
];

/** Heal a persisted value the menu no longer lists back to the default. Pure. */
export function sanitizeBriefSort(value: string): BriefSort {
  return BRIEF_SORT_OPTIONS.some((option) => option.value === value)
    ? (value as BriefSort)
    : BRIEF_SORT_DEFAULT;
}

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
