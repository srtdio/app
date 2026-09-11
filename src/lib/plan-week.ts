// Pure week helpers for the Pipeline Plan view: a read-only grouping of the
// posts already in memory by their target date's civil day in the WORKSPACE
// zone. No React, no scheduling, no reads. Every day step goes through the
// civil helpers in list-sort.ts (UTC-anchored, DST-proof); nothing here builds
// a zoned instant of its own, so the browser's default zone never leaks in.

import { addCivilDays, civilDate } from '@/lib/list-sort';

/** Weekday index 0=Sun..6=Sat, in the order Intl's 'short' weekday returns. */
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Days in one week; the Plan view always renders exactly this many columns. */
export const PLAN_WEEK_DAYS = 7;

/** Probe a zone once; a blank or non-IANA value degrades to UTC, never throws. */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** Clamp any stored week_start_day (0=Sun..6=Sat) into range without throwing. */
function safeWeekStart(weekStartDay: number): number {
  if (!Number.isFinite(weekStartDay)) return 0;
  return ((Math.trunc(weekStartDay) % 7) + 7) % 7;
}

/**
 * The weekday (0=Sun..6=Sat) of an instant read in a validated zone. Uses Intl
 * rather than Date.getDay so the answer is the WORKSPACE weekday, not the
 * browser's, and so no instant arithmetic is needed to get it.
 */
function zonedWeekday(instant: Date, zone: string): number {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(
    instant,
  );
  const index = WEEKDAY_NAMES.indexOf(short);
  return index === -1 ? 0 : index;
}

/** The civil date 'YYYY-MM-DD' of `now` in the workspace zone (UTC if invalid). */
export function civilToday(now: Date, timeZone: string): string {
  return civilDate(now, safeZone(timeZone));
}

/** 'YYYY-MM-DD' rendered as "7 Sep"; pure string work, no Date, no locale read. */
export function formatCivilShort(civil: string): string {
  const [, month, day] = civil.split('-');
  const name = MONTH_NAMES[Number(month) - 1];
  if (name === undefined || day === undefined) return civil;
  return `${Number(day)} ${name}`;
}

/** The day-of-month of a civil date as a plain number (no leading zero). */
export function dayOfMonth(civil: string): number {
  return Number(civil.split('-')[2]);
}

/**
 * The short weekday name of the Nth day of a week that starts on
 * `weekStartDay`. The week is built by stepping from its own start, so the
 * weekday is positional: no date parsing needed.
 */
export function weekdayName(weekStartDay: number, index: number): string {
  return WEEKDAY_NAMES[(safeWeekStart(weekStartDay) + index) % 7]!;
}

export interface WeekBoundsInput {
  /** The instant "today" is read from; supplied by the caller, never read here. */
  now: Date;
  /** The workspace IANA zone; a blank or unknown value degrades to UTC. */
  timeZone: string;
  /** The workspace week start, 0=Sun..6=Sat. */
  weekStartDay: number;
  /** Whole weeks away from the current one: 0 = this week, -1 = last, +1 = next. */
  offset: number;
}

export interface PlanWeekBounds {
  /** First civil day of the week, 'YYYY-MM-DD'. */
  start: string;
  /** Last civil day of the week, INCLUSIVE ('YYYY-MM-DD'). */
  end: string;
  /** The seven civil days, in order, start first. */
  days: string[];
  /** "This week" / "Last week" / "Next week", else the start day as "7 Sep". */
  label: string;
}

/**
 * The seven civil days of the offset week, anchored on the WORKSPACE zone and
 * week start. Pure: `now` is injected, the zone is validated (UTC fallback),
 * and every day is a civil string that is never converted back to an instant.
 */
export function weekBounds({
  now,
  timeZone,
  weekStartDay,
  offset,
}: WeekBoundsInput): PlanWeekBounds {
  const zone = safeZone(timeZone);
  const today = civilToday(now, zone);
  const back = (zonedWeekday(now, zone) - safeWeekStart(weekStartDay) + 7) % 7;
  const start = addCivilDays(today, -back + offset * PLAN_WEEK_DAYS);
  const days = Array.from({ length: PLAN_WEEK_DAYS }, (_unused, i) => addCivilDays(start, i));
  return { start, end: days[PLAN_WEEK_DAYS - 1]!, days, label: weekLabel(start, offset) };
}

/** The week header label for an offset; named weeks first, else the start day. */
export function weekLabel(start: string, offset: number): string {
  if (offset === 0) return 'This week';
  if (offset === -1) return 'Last week';
  if (offset === 1) return 'Next week';
  return formatCivilShort(start);
}

export interface DayGrouping<T> {
  /** One bucket per day in `days`, always present (empty days included). */
  byDay: Record<string, T[]>;
  /** Posts with no usable target date; shown above the week, never dropped. */
  undated: T[];
}

/**
 * Bucket posts into the week's civil days. A post lands in the day its
 * target_date resolves to IN THE WORKSPACE ZONE, so an instant that is the 8th
 * in Asia/Kolkata and the 7th in UTC groups by the workspace's reading. A null
 * (or unparseable, which would otherwise vanish) target_date is undated; a date
 * outside the week is excluded. Input order is preserved, so the caller's sort
 * survives the grouping.
 */
export function groupByCivilDay<T extends { target_date: string | null }>(
  posts: T[],
  days: string[],
  timeZone: string,
): DayGrouping<T> {
  const zone = safeZone(timeZone);
  const byDay: Record<string, T[]> = {};
  for (const day of days) byDay[day] = [];
  const undated: T[] = [];

  for (const post of posts) {
    if (post.target_date === null) {
      undated.push(post);
      continue;
    }
    const instant = new Date(post.target_date);
    if (Number.isNaN(instant.getTime())) {
      undated.push(post);
      continue;
    }
    const bucket = byDay[civilDate(instant, zone)];
    if (bucket !== undefined) bucket.push(post);
  }

  return { byDay, undated };
}
