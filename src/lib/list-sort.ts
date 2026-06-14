// Shared, pure search/sort derivations for list surfaces (Pipeline posts,
// Briefs). Both rows carry a created_at and a nullable target_date, so a single
// generic helper serves both pages without duplicating the comparators. Pure and
// non-mutating: the page holds the full in-memory list (one unpaginated read),
// so deriving here is correct and never triggers a refetch or N+1.

import type { SortOption } from '@/components/ui/SortMenu';

/** The date-keyed sort orders, in menu order. Used by Briefs. */
export type DateSort = 'newest' | 'oldest' | 'target';

export const DATE_SORT_DEFAULT: DateSort = 'newest';

export const DATE_SORT_OPTIONS: SortOption<DateSort>[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'target', label: 'Target date' },
];

/** The minimal row shape the date comparators need. */
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

/** The full Pipeline sort orders, in menu order. */
export type PostSort = 'updated' | 'newest' | 'oldest' | 'target' | 'title';

export const POST_SORT_DEFAULT: PostSort = 'newest';

export const POST_SORT_OPTIONS: SortOption<PostSort>[] = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'target', label: 'Target date' },
  { value: 'title', label: 'Title A-Z' },
];

/** The minimal row shape the post comparators need (id is the stable tiebreaker). */
export interface PostSortable extends DateSortable {
  id: string;
  updated_at: string;
  title: string;
}

/** Stable tiebreaker: equal primary keys order deterministically by id. */
function byId(a: PostSortable, b: PostSortable): number {
  return a.id.localeCompare(b.id);
}

/**
 * Order a Pipeline post list by the chosen sort. Pure; returns a new array.
 * Every comparator falls back to {@link byId} so equal keys are deterministic.
 * Title is compared case-insensitively and locale-aware; target_date keeps
 * nulls last (see {@link compareTargetDate}).
 */
export function sortPosts<T extends PostSortable>(items: T[], sort: PostSort): T[] {
  const copy = [...items];
  switch (sort) {
    case 'updated':
      return copy.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || byId(a, b));
    case 'oldest':
      return copy.sort((a, b) => a.created_at.localeCompare(b.created_at) || byId(a, b));
    case 'target':
      return copy.sort((a, b) => compareTargetDate(a, b) || byId(a, b));
    case 'title':
      return copy.sort(
        (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || byId(a, b),
      );
    case 'newest':
    default:
      return copy.sort((a, b) => b.created_at.localeCompare(a.created_at) || byId(a, b));
  }
}

/**
 * Case-insensitive, trimmed substring filter over one or more text fields per
 * item. Null fields are skipped; an item matches if ANY field contains the
 * query. Empty/whitespace query passes all. Generic over a field accessor so
 * each surface picks its own searchable fields without widening the others.
 */
export function filterByFields<T>(
  items: T[],
  query: string,
  fields: (item: T) => (string | null)[],
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return items;
  return items.filter((item) =>
    fields(item).some((field) => field !== null && field.toLowerCase().includes(q)),
  );
}

/** Case-insensitive, trimmed title substring filter. Empty query passes all. */
export function filterByTitle<T extends { title: string }>(items: T[], query: string): T[] {
  return filterByFields(items, query, (item) => [item.title]);
}
