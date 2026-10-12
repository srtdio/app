// Pure week helpers for the Pipeline Plan view: a read-only grouping of the
// posts already in memory by their target date's civil day in the WORKSPACE
// zone. No React, no scheduling, no reads. Every day step goes through the
// civil helpers in list-sort.ts (UTC-anchored, DST-proof); nothing here builds
// a zoned instant of its own, so the browser's default zone never leaks in.

import { addCivilDays, civilDate } from '@/lib/list-sort';
import type { Stage } from '@srtdio/posts';

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

/**
 * The order the undated block lists posts in: the most urgent first. Approved
 * posts with no date are the ones that need a date, so they lead; rejected ones
 * need it least, so they close. This is a PLAN-ONLY ordering: the week columns
 * keep the page's own sort, and nothing else on the surface reads it.
 */
export const PLAN_URGENCY_ORDER: readonly Stage[] = [
  'approved',
  'review',
  'draft',
  'parked',
  'rejected',
];

const URGENCY_RANK = new Map<string, number>(
  PLAN_URGENCY_ORDER.map((stage, index) => [stage, index]),
);

/**
 * A new list ordered by {@link PLAN_URGENCY_ORDER}. Stable, so posts sharing a
 * stage keep the caller's sort; an unknown stage sorts last rather than
 * vanishing or throwing.
 */
export function sortByUrgency<T extends { stage: string }>(posts: T[]): T[] {
  return [...posts].sort(
    (a, b) =>
      (URGENCY_RANK.get(a.stage) ?? PLAN_URGENCY_ORDER.length) -
      (URGENCY_RANK.get(b.stage) ?? PLAN_URGENCY_ORDER.length),
  );
}

/** The zone's UTC offset in ms at an instant, read through Intl (no libraries). */
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  // hourCycle 'h23' still reports midnight as '24' in some engines; % 24 folds it.
  const wall = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return wall - instant.getTime();
}

/**
 * The instant that is 12:00 on a civil date IN THE GIVEN ZONE, as an ISO string.
 *
 * posts.target_date is timestamptz, so a bare 'YYYY-MM-DD' would be stored as
 * UTC midnight and read back as the PREVIOUS day in every negative-offset zone.
 * Anchoring on local noon puts the instant at least eleven hours from either
 * civil boundary, so {@link groupByCivilDay} always buckets it back onto the day
 * the user picked, in any zone and on either side of a DST change.
 *
 * The offset is probed at the guessed instant and then re-probed at the
 * corrected one, so a guess that landed on the wrong side of a transition is
 * healed. An unparseable civil date or zone degrades to UTC noon instead of
 * throwing.
 */
export function civilNoonInZoneIso(civil: string, timeZone: string): string {
  const [year, month, day] = civil.split('-').map((part) => Number(part));
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return new Date(0).toISOString();
  }
  const zone = safeZone(timeZone);
  const wallNoon = Date.UTC(year, month - 1, day, 12, 0, 0);
  const first = new Date(wallNoon - zoneOffsetMs(new Date(wallNoon), zone));
  return new Date(wallNoon - zoneOffsetMs(first, zone)).toISOString();
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

// ---------------------------------------------------------------------------
// The Plan screen's week list: every day of a plan's range, in order, with the
// items that fall on it. Same civil-day rules as above (workspace zone).
// ---------------------------------------------------------------------------

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The weekday (0=Sun..6=Sat) of a civil date; pure string-to-UTC work, no zone. */
function civilWeekday(civil: string): number {
  const [y, m, d] = civil.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

/** "Mon 12 Oct" from "2026-10-12". Pure. */
export function formatCivilDayHeader(civil: string): string {
  return `${WEEKDAY_NAMES[civilWeekday(civil)] ?? ''} ${formatCivilShort(civil)}`;
}

/** The Monday on or before a civil date (Mon-start weeks). Pure. */
export function civilMondayOf(civil: string): string {
  return addCivilDays(civil, -((civilWeekday(civil) + 6) % 7));
}

/** "Week of 12 Oct" for the Mon-start week holding `civil`. Pure. */
export function planWeekLabel(civil: string): string {
  return `Week of ${formatCivilShort(civilMondayOf(civil))}`;
}

/**
 * The civil day of a stored date in the workspace zone: a bare 'YYYY-MM-DD'
 * (a concept's own date) is that day; an instant (a post's timestamptz) is
 * read in the zone. Blank or unparseable is null. Pure.
 */
export function civilDayOf(raw: string | null | undefined, timeZone: string): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (CIVIL_DATE.test(raw)) return raw;
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) return null;
  return civilDate(instant, safeZone(timeZone));
}

/** Every civil day from `start` to `end` inclusive (empty when end < start). Pure. */
export function civilDaysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  if (!CIVIL_DATE.test(start) || !CIVIL_DATE.test(end)) return days;
  for (let day = start; day <= end && days.length < 400; day = addCivilDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/** Plans longer than this many days get a week header per Mon-start week. */
export const PLAN_WEEK_HEADER_AFTER_DAYS = 7;

/** Whether a plan's list shows week headers: more than 7 days. Pure. */
export function planShowsWeeks(startsOn: string, endsOn: string): boolean {
  return civilDaysBetween(startsOn, endsOn).length > PLAN_WEEK_HEADER_AFTER_DAYS;
}

export interface PlanDayGroup<T> {
  /** The civil day, or null for the "No date" group. */
  day: string | null;
  /** "Mon 12 Oct", or "No date". */
  label: string;
  /** Whether the day is inside the plan's range. */
  inRange: boolean;
  /** The items on that day, in the caller's order. */
  items: T[];
}

export interface PlanWeekGroup<T> {
  /** "Week of 12 Oct"; null when the plan shows no week headers, and for "No date". */
  label: string | null;
  days: PlanDayGroup<T>[];
}

/**
 * The Plan screen's list: one group per day of the range (empty days kept),
 * items dated outside it in their own day groups before or after it (date
 * order), undated items last under "No date". Input order survives inside a
 * day. With `weeks`, dated days are split into Mon-start weeks; otherwise one
 * unlabelled week holds every dated day. Pure.
 */
export function planWeekGroups<T>(
  items: readonly T[],
  range: { startsOn: string; endsOn: string },
  dayOf: (item: T) => string | null,
  weeks: boolean,
): PlanWeekGroup<T>[] {
  const byDay = new Map<string, T[]>();
  const undated: T[] = [];
  for (const item of items) {
    const day = dayOf(item);
    if (day === null) {
      undated.push(item);
      continue;
    }
    const list = byDay.get(day);
    if (list === undefined) byDay.set(day, [item]);
    else list.push(item);
  }
  const rangeDays = civilDaysBetween(range.startsOn, range.endsOn);
  const inRange = new Set(rangeDays);
  const allDays = [...new Set([...rangeDays, ...byDay.keys()])].sort();
  const days: PlanDayGroup<T>[] = allDays.map((day) => ({
    day,
    label: formatCivilDayHeader(day),
    inRange: inRange.has(day),
    items: byDay.get(day) ?? [],
  }));
  const out: PlanWeekGroup<T>[] = [];
  if (weeks) {
    for (const group of days) {
      const label = planWeekLabel(group.day ?? '');
      const last = out[out.length - 1];
      if (last !== undefined && last.label === label) last.days.push(group);
      else out.push({ label, days: [group] });
    }
  } else if (days.length > 0) {
    out.push({ label: null, days });
  }
  if (undated.length > 0) {
    out.push({
      label: null,
      days: [{ day: null, label: 'No date', inRange: false, items: undated }],
    });
  }
  return out;
}
