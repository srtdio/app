// Pure time-grouping for the Briefs list. Native Date + Intl only (no date lib):
// the page holds the whole in-memory list (one unpaginated read), so bucketing
// here is correct with no refetch and no N+1. Every boundary is read on the
// WORKSPACE civil calendar (its zone and its week start), never the browser's,
// so a brief raised at 00:30 in Mumbai does not slide into the previous week for
// a reviewer whose laptop is in London. All day stepping and civil-date reading
// reuses the shared helpers (src/lib/list-sort.ts, src/lib/plan-week.ts); nothing
// here does zone maths of its own.

import { formatDate, isValidTimeZone } from '@/lib/time';
import { addCivilDays, civilDate } from '@/lib/list-sort';
import { weekBounds } from '@/lib/plan-week';

/** One rendered section: a stable key, a display label, and its briefs. */
export interface BriefGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** The workspace civil calendar every boundary is evaluated on. */
export interface BriefCalendar {
  /** The workspace IANA zone; a blank or unknown value degrades to UTC. */
  timeZone: string;
  /** The workspace week start, 0=Sun..6=Sat. */
  weekStartDay: number;
}

// Full month names indexed by calendar month - 1 (0=January). A constant lookup
// keeps the section labels deterministic and independent of the browser locale.
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Probe a zone once; a blank or non-IANA value degrades to UTC, never throws. */
function safeZone(timeZone: string): string {
  return isValidTimeZone(timeZone) ? timeZone : 'UTC';
}

/**
 * The civil day 'YYYY-MM-DD' a stored timestamp falls on in a validated zone. An
 * unparseable value would otherwise be handed to Intl.format (which throws), so
 * it degrades to its own leading characters: still comparable, never fatal.
 */
function civilDayOf(iso: string, zone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso.slice(0, 10);
  return civilDate(instant, zone);
}

/**
 * Group briefs into time sections, newest-first. Sections are ordered This week,
 * Last week, then calendar months descending; empty sections are never emitted.
 * Items inside every section stay newest-first. `now` is injected so callers (and
 * tests) control "today", and `calendar` supplies the workspace zone and week
 * start, so no comparison reads the browser clock or the browser's zone. Every
 * boundary is a civil-date string comparison ('YYYY-MM-DD' sorts lexicographically,
 * so no instant arithmetic and no DST edge is involved). Month labels append
 * " YYYY" only when the month's year differs from now's year IN THE WORKSPACE
 * ZONE. Keys are stable: w0 (this week), w1 (last week), m-YYYY-MM (a month).
 */
export function groupBriefsByTime<T extends { created_at: string }>(
  briefs: T[],
  now: Date,
  calendar: BriefCalendar,
): BriefGroup<T>[] {
  const zone = safeZone(calendar.timeZone);

  const sorted = [...briefs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const thisWeekStart = weekBounds({
    now,
    timeZone: zone,
    weekStartDay: calendar.weekStartDay,
    offset: 0,
  }).start;
  const lastWeekStart = addCivilDays(thisWeekStart, -7);
  const nowYear = civilDate(now, zone).slice(0, 4);

  // Insertion order over the newest-first list yields exactly the required
  // section order (This week, Last week, months descending): time is monotonic,
  // so each key is first seen in that order.
  const groups: BriefGroup<T>[] = [];
  const byKey = new Map<string, BriefGroup<T>>();

  for (const brief of sorted) {
    const day = civilDayOf(brief.created_at, zone);

    let key: string;
    let label: string;
    if (day >= thisWeekStart) {
      key = 'w0';
      label = 'This week';
    } else if (day >= lastWeekStart) {
      key = 'w1';
      label = 'Last week';
    } else {
      const year = day.slice(0, 4);
      const month = day.slice(5, 7);
      key = `m-${year}-${month}`;
      const name = MONTH_NAMES[Number(month) - 1];
      label = name === undefined ? key : year === nowYear ? name : `${name} ${year}`;
    }

    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.items.push(brief);
    } else {
      const group: BriefGroup<T> = { key, label, items: [brief] };
      byKey.set(key, group);
      groups.push(group);
    }
  }

  return groups;
}

/**
 * Split ONE time section's items into its civil days in the workspace zone. The
 * input is already newest-first, so first-seen order is newest-day-first and no
 * sorting happens here: the caller's order survives inside every day. Keys are
 * stable ("d-YYYY-MM-DD"); the label is the day the first item of that day was
 * raised, in the app day format ("22 Sep", "4 Jan 2027" outside now's year; an
 * unknown zone degrades to UTC, an unparseable timestamp shows as stored). Pure,
 * and empty in gives empty out.
 */
export function groupBriefsByDay<T extends { created_at: string }>(
  items: T[],
  timeZone: string,
  now: Date,
): BriefGroup<T>[] {
  const zone = safeZone(timeZone);
  const groups: BriefGroup<T>[] = [];
  const byKey = new Map<string, BriefGroup<T>>();

  for (const item of items) {
    const key = `d-${civilDayOf(item.created_at, zone)}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.items.push(item);
      continue;
    }
    const group: BriefGroup<T> = {
      key,
      // The workspace zone, so the label always names the day the key groups by.
      label: formatDate(item.created_at, now, zone) || item.created_at,
      items: [item],
    };
    byKey.set(key, group);
    groups.push(group);
  }

  return groups;
}
