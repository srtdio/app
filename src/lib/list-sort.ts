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

/** The target-date window filter orders, in menu order. Pipeline-only. */
export type DateWindow = 'week' | 'month' | 'any';

export const DATE_WINDOW_DEFAULT: DateWindow = 'any';

export const DATE_WINDOW_OPTIONS: { value: DateWindow; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'any', label: 'Any time' },
];

/**
 * Inputs to {@link filterByWindow}. Pure: the page supplies `now`, the workspace
 * `timeZone`, and `weekStartDay` (0=Sun..6=Sat), so the filter never reads the
 * browser clock or the browser's default zone.
 */
export interface WindowBounds {
  now: Date;
  timeZone: string;
  weekStartDay: number;
}

/** Probe a zone once; a blank or non-IANA value degrades to UTC, never throws. */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** The civil date 'YYYY-MM-DD' of an instant rendered in a (validated) zone. */
function civilDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Parse 'YYYY-MM-DD' into [year, month1to12, day]. */
function parseCivil(civil: string): [number, number, number] {
  const [y, m, d] = civil.split('-').map((part) => Number(part));
  return [y!, m!, d!];
}

/** Re-pad a [year, month1to12, day] triple back to 'YYYY-MM-DD'. */
function formatCivil(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/**
 * Shift a civil date by whole days. All arithmetic runs in UTC (no DST), so a
 * day add/subtract is exact; the result is read back as a naked civil date and
 * never converted to a zoned instant.
 */
function addCivilDays(civil: string, days: number): string {
  const [y, m, d] = parseCivil(civil);
  const base = Date.UTC(y, m - 1, d) + days * 86400000;
  const shifted = new Date(base);
  return formatCivil(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * Keep items whose `target_date` civil date (in the workspace zone) falls in the
 * chosen window. Pure and NON-THROWING for every input:
 * - 'any' returns the list unchanged BEFORE any Intl/Date work, so the default
 *   render never touches the timezone path.
 * - A blank/non-IANA `bounds.timeZone` degrades to UTC (validated in try/catch).
 * - An item with a null or unparseable `target_date` is excluded for week/month
 *   (an Invalid Date is never handed to Intl.format, which would throw).
 * Range is [start, end) of workspace-LOCAL civil date strings.
 */
export function filterByWindow<T extends { target_date: string | null }>(
  items: T[],
  window: DateWindow,
  bounds: WindowBounds,
): T[] {
  if (window === 'any') return items;

  const zone = safeZone(bounds.timeZone);
  const todayCivil = civilDate(bounds.now, zone);
  const [ty, tm, td] = parseCivil(todayCivil);

  let start: string;
  let end: string;
  if (window === 'week') {
    const weekday = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay();
    const offset = (weekday - bounds.weekStartDay + 7) % 7;
    start = addCivilDays(todayCivil, -offset);
    end = addCivilDays(start, 7);
  } else {
    start = formatCivil(ty, tm, 1);
    end = tm === 12 ? formatCivil(ty + 1, 1, 1) : formatCivil(ty, tm + 1, 1);
  }

  return items.filter((item) => {
    if (item.target_date === null) return false;
    const instant = new Date(item.target_date);
    if (Number.isNaN(instant.getTime())) return false;
    const d = civilDate(instant, zone);
    return start <= d && d < end;
  });
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
