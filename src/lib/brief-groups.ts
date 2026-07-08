// Pure time-grouping for the Briefs list. Native Date only (no date lib): the
// page holds the whole in-memory list (one unpaginated read), so bucketing here
// is correct with no refetch and no N+1. Weeks start Monday and every boundary
// is evaluated in LOCAL time, matching how an agency reads "this week".

/** One rendered time section: a stable key, a display label, and its briefs. */
export interface BriefGroup<T> {
  key: string;
  label: string;
  items: T[];
}

// Full month names indexed by Date.getMonth() (0=January). A constant lookup
// keeps labels deterministic and locale-independent (native Date only).
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

/** Local midnight of the Monday that opens `date`'s week (Sunday closes it). */
function startOfWeekMonday(date: Date): Date {
  // getDay: 0=Sun..6=Sat. Days since Monday: Mon->0 .. Sun->6, so Sunday falls
  // in the ending week and Monday opens the new one.
  const daysSinceMonday = (date.getDay() + 6) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysSinceMonday);
}

/**
 * Group briefs into time sections, newest-first. Sections are ordered This Week,
 * Last Week, then calendar months descending; empty sections are never emitted.
 * Items inside every section stay newest-first. `now` is injected so callers (and
 * tests) control "today"; all comparisons run in local time. Month labels append
 * " YYYY" only when the month's year differs from now's year. Keys are stable:
 * w0 (this week), w1 (last week), m-YYYY-MM (a calendar month).
 */
export function groupBriefsByTime<T extends { created_at: string }>(
  briefs: T[],
  now: Date,
): BriefGroup<T>[] {
  const sorted = [...briefs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const thisWeekMonday = startOfWeekMonday(now).getTime();
  const lastWeekMonday = startOfWeekMonday(now).getTime() - 7 * 24 * 60 * 60 * 1000;
  const nowYear = now.getFullYear();

  // Insertion order over the newest-first list yields exactly the required
  // section order (This Week, Last Week, months descending): time is monotonic,
  // so each key is first seen in that order.
  const groups: BriefGroup<T>[] = [];
  const byKey = new Map<string, BriefGroup<T>>();

  for (const brief of sorted) {
    const created = new Date(brief.created_at);
    const at = created.getTime();

    let key: string;
    let label: string;
    if (at >= thisWeekMonday) {
      key = 'w0';
      label = 'This Week';
    } else if (at >= lastWeekMonday) {
      key = 'w1';
      label = 'Last Week';
    } else {
      const year = created.getFullYear();
      const month = created.getMonth();
      key = `m-${year}-${String(month + 1).padStart(2, '0')}`;
      label = year === nowYear ? MONTH_NAMES[month]! : `${MONTH_NAMES[month]!} ${year}`;
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
