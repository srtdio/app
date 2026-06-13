// Shared, pure search/sort derivations for date-keyed list surfaces (Pipeline
// posts, Briefs). Both rows carry a created_at and a nullable target_date, so a
// single generic helper serves both pages without duplicating the comparators.
// Pure and non-mutating: the page holds the full in-memory list (one unpaginated
// read), so deriving here is correct and never triggers a refetch or N+1.

import type { SortOption } from '@/components/ui/SortMenu';

/** The date-keyed sort orders, in menu order. */
export type DateSort = 'newest' | 'oldest' | 'target';

export const DATE_SORT_DEFAULT: DateSort = 'newest';

export const DATE_SORT_OPTIONS: SortOption<DateSort>[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'target', label: 'Target date' },
];

/** The minimal row shape the comparators need. */
export interface DateSortable {
  created_at: string;
  target_date: string | null;
}

/** Target date ascending, rows without a target date sorted last. */
function compareTargetDate(a: DateSortable, b: DateSortable): number {
  if (a.target_date === null && b.target_date === null) return 0;
  if (a.target_date === null) return 1;
  if (b.target_date === null) return -1;
  return a.target_date.localeCompare(b.target_date);
}

/** Order a list by the chosen date sort. Pure; returns a new array. */
export function sortByDate<T extends DateSortable>(items: T[], sort: DateSort): T[] {
  const copy = [...items];
  switch (sort) {
    case 'oldest':
      return copy.sort((a, b) => a.created_at.localeCompare(b.created_at));
    case 'target':
      return copy.sort(compareTargetDate);
    case 'newest':
    default:
      return copy.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}

/** Case-insensitive, trimmed title substring filter. Empty query passes all. */
export function filterByTitle<T extends { title: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return items;
  return items.filter((item) => item.title.toLowerCase().includes(q));
}
