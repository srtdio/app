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

/** The Pipeline sort orders, in menu order. */
export type PostSort = 'updated' | 'target';

export const POST_SORT_DEFAULT: PostSort = 'updated';

export const POST_SORT_OPTIONS: SortOption<PostSort>[] = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'target', label: 'Target date' },
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
 * target_date keeps nulls last (see {@link compareTargetDate}); 'updated' is the
 * default branch.
 */
export function sortPosts<T extends PostSortable>(items: T[], sort: PostSort): T[] {
  const copy = [...items];
  switch (sort) {
    case 'target':
      return copy.sort((a, b) => compareTargetDate(a, b) || byId(a, b));
    case 'updated':
    default:
      return copy.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || byId(a, b));
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

/** The Pipeline-only target-date window filters, in segmented-control order. */
export type DateWindow = 'week' | 'month' | 'any';

export const DATE_WINDOW_DEFAULT: DateWindow = 'any';

export const DATE_WINDOW_OPTIONS: { value: DateWindow; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'any', label: 'Any time' },
];

/**
 * Everything {@link filterByWindow} needs to compute a workspace-local window.
 * Injected by the caller so the filter stays pure: `now` is the reference
 * instant, `timeZone` an IANA zone, `weekStartDay` 0 (Sun) .. 6 (Sat).
 */
export interface WindowBounds {
  now: Date;
  timeZone: string;
  weekStartDay: number;
}

/** The civil date ('YYYY-MM-DD') of an instant rendered in a given IANA zone. */
function civilDateInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Parse a 'YYYY-MM-DD' civil string into its [year, month (1-12), day] parts. */
function parseCivil(civil: string): [number, number, number] {
  const [y, m, d] = civil.split('-').map((part) => Number(part));
  return [y!, m!, d!];
}

/** Re-pad numeric civil parts back into a 'YYYY-MM-DD' string. */
function formatCivil(year: number, month: number, day: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/**
 * Shift a civil date by a whole number of days. Arithmetic runs in UTC (which has
 * no DST) so day add/subtract is exact; the result is read back as civil parts and
 * never converted to an instant in any zone.
 */
function addCivilDays(civil: string, days: number): string {
  const [y, m, d] = parseCivil(civil);
  const base = Date.UTC(y, m - 1, d) + days * 86400000;
  const shifted = new Date(base);
  return formatCivil(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** The half-open civil range [start, end) for a window around `now`, in zone. */
function windowRange(window: DateWindow, bounds: WindowBounds): [string, string] {
  const today = civilDateInZone(bounds.now, bounds.timeZone);
  const [y, m, d] = parseCivil(today);
  if (window === 'month') {
    const start = formatCivil(y, m, 1);
    const end = m === 12 ? formatCivil(y + 1, 1, 1) : formatCivil(y, m + 1, 1);
    return [start, end];
  }
  // week: walk back to the configured week-start weekday, span seven days.
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const offset = (weekday - bounds.weekStartDay + 7) % 7;
  const start = addCivilDays(today, -offset);
  return [start, addCivilDays(start, 7)];
}

/**
 * Keep only items whose target_date, rendered as a civil date in the workspace
 * zone, falls in the chosen window's half-open [start, end) range. 'any' returns
 * the list unchanged; for 'week'/'month' a null target_date is excluded. Pure and
 * fully driven by `bounds` (no internal new Date() / default-zone Intl); returns a
 * new array.
 */
export function filterByWindow<T extends { target_date: string | null }>(
  items: T[],
  window: DateWindow,
  bounds: WindowBounds,
): T[] {
  if (window === 'any') return [...items];
  const [start, end] = windowRange(window, bounds);
  return items.filter((item) => {
    if (item.target_date === null) return false;
    const d = civilDateInZone(new Date(item.target_date), bounds.timeZone);
    return start <= d && d < end;
  });
}
