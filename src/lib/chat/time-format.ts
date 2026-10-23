// Chat timestamps rendered on the WORKSPACE civil clock (the browser's zone only
// as the fallback when the workspace has none).
// Every formatter takes an explicit IANA zone and hands it to
// Intl.DateTimeFormat, the same approach src/lib/list-sort.ts (civilDate) and
// src/lib/display-date.ts (the app day formatter) use. Dates use 'en-US'
// as the reference locale so the output is identical whatever the browser's
// locale, with parts re-assembled by type so part order never drifts between
// engines; the chat clock time (formatClockTime) follows the device locale.

import { formatDay } from '@/lib/display-date';

/**
 * The browser's IANA zone, the fallback when the workspace has none (a viewer's
 * own clock beats UTC for someone in Mumbai). 'UTC' only if Intl cannot say.
 */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The workspace zone when set, else the browser zone. */
export function workspaceTimeZone(timeZone: string | null | undefined): string {
  return timeZone != null && timeZone.trim() !== '' ? timeZone : browserTimeZone();
}

/** Probe a zone once; a blank or non-IANA value degrades to the browser zone, never throws. */
export function safeTimeZone(timeZone: string): string {
  if (timeZone.trim() === '') return browserTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return browserTimeZone();
  }
}

/** The calendar date (YYYY-MM-DD) of an instant in a zone, for day comparisons. */
export function civilDay(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instantMs));
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function instantOf(value: string | number): Date | undefined {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

/**
 * The one clock time every chat surface shows (bubble meta, last seen, the
 * image viewer), in the workspace zone and the DEVICE locale's hour cycle:
 * "2:05 pm" on an en-IN device, "14:05" on en-GB. hour12 is never forced.
 * `locale` is for tests; the app passes none. Unparseable input is ''.
 */
export function formatClockTime(
  createdAt: string | number,
  timeZone: string,
  locale?: string,
): string {
  const instant = instantOf(createdAt);
  if (instant === undefined) return '';
  return new Intl.DateTimeFormat(locale, {
    timeZone: safeTimeZone(timeZone),
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}

/**
 * A short calendar date in the workspace zone, e.g. "20 Jun" ("4 Jan 2027" once
 * the year is not `now`'s), for conversation cards once a relative reading stops
 * being useful. The app's one day formatter ({@link formatDay}) does the work.
 * Without `now` the year is never added (the value is read against its own
 * instant), so callers with no clock stay pure and deterministic.
 */
export function formatShortDate(createdAt: string | number, timeZone: string, now?: Date): string {
  const instant = instantOf(createdAt);
  if (instant === undefined) return '';
  return formatDay(createdAt, timeZone, now ?? instant);
}

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

/**
 * A calendar DATE column (YYYY-MM-DD) in the same "2 Oct" style as
 * {@link formatShortDate}, read straight off the string so no timezone can shift
 * the day. Anything that is not a valid YYYY-MM-DD renders as an empty string.
 */
export function formatShortDateOnly(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (match === null) return '';
  const month = SHORT_MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (month === undefined || day < 1 || day > 31) return '';
  return `${day} ${month}`;
}
