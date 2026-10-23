// The one date formatter for the whole app. Every visible date or time reads
// through here so the register never drifts between surfaces:
//   formatDay       "23 Oct", or "4 Jan 2027" once the year is not now's year
//   formatDue       "Due 23 Oct"
//   formatOverdue   "Overdue · 12 Oct" up to a month late, then "Overdue 5 months"
//   formatAgo       "just now", "5 minutes ago" ... "1 year ago"
//   formatDateTime  "23 Oct, 2:14 PM"
// Days are read on the WORKSPACE civil clock (safeTimeZone degrades a blank or
// unknown zone to the browser's). A date-only "YYYY-MM-DD" value is read off the
// string itself so no zone can shift it. Pure: `now` is always passed in, and
// 'en-US' parts are re-assembled by type so the output never follows the
// browser locale. Unparseable input renders as ''.

import { safeTimeZone } from '@/lib/chat/time-format';

/** An instant (ISO string, epoch ms or Date) or a date-only "YYYY-MM-DD". */
export type DateInput = string | number | Date;

const SHORT_MONTHS = [
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
] as const;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

interface Civil {
  year: number;
  /** 1..12 */
  month: number;
  day: number;
}

function instantOf(value: DateInput): Date | undefined {
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

function civilOfInstant(instant: Date, timeZone: string): Civil {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  return { year: read('year'), month: read('month'), day: read('day') };
}

/** The civil day a value falls on in the zone; a date-only string is read as-is. */
function civilOf(value: DateInput, timeZone: string): Civil | undefined {
  if (typeof value === 'string') {
    const match = DATE_ONLY.exec(value.trim());
    if (match !== null) {
      const civil = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
      if (civil.month < 1 || civil.month > 12 || civil.day < 1 || civil.day > 31) return undefined;
      return civil;
    }
  }
  const instant = instantOf(value);
  return instant === undefined ? undefined : civilOfInstant(instant, timeZone);
}

function dayText(civil: Civil, nowYear: number): string {
  const base = `${civil.day} ${SHORT_MONTHS[civil.month - 1] ?? ''}`;
  return civil.year === nowYear ? base : `${base} ${civil.year}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** "23 Oct"; "4 Jan 2027" when the year is not now's year in the zone. */
export function formatDay(value: DateInput, timeZone: string, now: Date): string {
  const civil = civilOf(value, timeZone);
  if (civil === undefined) return '';
  return dayText(civil, civilOfInstant(now, timeZone).year);
}

/** "Due 23 Oct" (year rule as formatDay); '' for unparseable input. */
export function formatDue(value: DateInput, timeZone: string, now: Date): string {
  const day = formatDay(value, timeZone, now);
  return day === '' ? '' : `Due ${day}`;
}

/** An overdue reading; `bad` is always true so callers colour it with the bad token. */
export interface OverdueLabel {
  text: string;
  bad: true;
}

/**
 * Up to one calendar month late: "Overdue · 12 Oct". More than a month late:
 * whole months, "Overdue 1 month" / "Overdue 5 months". Days are civil days in
 * the zone. Unparseable input reads as plain "Overdue".
 */
export function formatOverdue(value: DateInput, timeZone: string, now: Date): OverdueLabel {
  const civil = civilOf(value, timeZone);
  if (civil === undefined) return { text: 'Overdue', bad: true };
  const today = civilOfInstant(now, timeZone);
  let months = (today.year - civil.year) * 12 + (today.month - civil.month);
  if (today.day < civil.day) months -= 1;
  // Exactly one month late (same day of the month) still reads as a date.
  const moreThanMonth = months > 1 || (months === 1 && today.day > civil.day);
  if (!moreThanMonth) return { text: `Overdue · ${dayText(civil, today.year)}`, bad: true };
  return { text: `Overdue ${plural(months, 'month')}`, bad: true };
}

/**
 * Spoken elapsed time: "just now" under a minute (and for a future instant),
 * then minutes, hours, days (under a week), weeks (under 30 days), months
 * (under a year), years. Singular and plural agree. '' for unparseable input.
 */
export function formatAgo(value: DateInput, now: Date): string {
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const diff = now.getTime() - instant.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${plural(Math.floor(diff / MINUTE), 'minute')} ago`;
  if (diff < DAY) return `${plural(Math.floor(diff / HOUR), 'hour')} ago`;
  if (diff < WEEK) return `${plural(Math.floor(diff / DAY), 'day')} ago`;
  if (diff < MONTH) return `${plural(Math.floor(diff / WEEK), 'week')} ago`;
  if (diff < YEAR) return `${plural(Math.min(11, Math.floor(diff / MONTH)), 'month')} ago`;
  return `${plural(Math.floor(diff / YEAR), 'year')} ago`;
}

/** "23 Oct, 2:14 PM" (12-hour, uppercase period; year rule as formatDay). */
export function formatDateTime(value: DateInput, timeZone: string, now: Date): string {
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const day = formatDay(instant, timeZone, now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${day}, ${read('hour')}:${read('minute')} ${read('dayPeriod').toUpperCase()}`;
}
