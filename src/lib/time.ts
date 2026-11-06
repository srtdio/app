// The one date and time module for the whole app. Every visible date or time
// reads through here so the register never drifts between surfaces:
//   formatTime        "2:14 PM" (clock inside a message bubble)
//   formatWhen        THE past-time format: "2:14 PM" today, "Yesterday",
//                     "Mon" 2-6 days back, "20 Oct", "20 Oct 2025"
//   formatChatTime    alias of formatWhen
//   formatDayLabel    day dividers/headings: "Today", else as formatWhen
//   formatDateTime    "23 Oct, 2:14 PM"; "23 Oct 2025, 2:14 PM" off the current year
//   formatDate        "23 Oct"; "23 Oct 2025" off the current year
//   formatDayRange    "19 - 25 Oct"; "28 Oct - 3 Nov"
//   formatDueDate     "23 Oct" for a due/target date, on the workspace zone
//   formatDue         "Due 23 Oct", on the workspace zone
//   formatOverdue     "Overdue · 12 Oct" up to a month late, then "Overdue 5 months"
//   formatSpokenDate  "Monday, 19 October 2026" (accessible names)
// Moments (message, comment, activity times) are read on the VIEWER's device
// time zone. Due dates (posts.target_date, brief due dates, plan days and plan
// ranges) are calendar days: formatDueDate, formatDue, formatOverdue and
// formatDayRange take the WORKSPACE zone as a required argument (null or blank
// only when the workspace has none, which degrades to the device zone). A date-only
// "YYYY-MM-DD" value is read off the string itself so no zone can shift it.
// 'en-US' parts are re-assembled by type so the output never follows the
// browser locale. `now` defaults to the current instant; tests pass it (and a
// zone) explicitly. Unparseable input renders as ''.

/** An instant (ISO string, epoch ms or Date) or a date-only "YYYY-MM-DD". */
type DateInput = string | number | Date;

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

const LONG_MONTHS = [
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
] as const;

const LONG_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAY = 24 * 60 * 60 * 1000;

interface Civil {
  year: number;
  /** 1..12 */
  month: number;
  day: number;
}

/** The device's IANA zone; 'UTC' only if Intl cannot say. */
export function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A blank, missing or non-IANA zone degrades to the device zone; never throws. */
export function safeTimeZone(timeZone?: string | null): string {
  if (timeZone == null || timeZone.trim() === '') return deviceTimeZone();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return deviceTimeZone();
  }
}

function instantOf(value: DateInput): Date | undefined {
  const instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

function civilOfInstant(instant: Date, timeZone: string): Civil {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
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

function civilKey(civil: Civil): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${civil.year}-${pad(civil.month)}-${pad(civil.day)}`;
}

function monthName(month: number): string {
  return SHORT_MONTHS[month - 1] ?? '';
}

function dayText(civil: Civil, nowYear: number): string {
  const base = `${civil.day} ${monthName(civil.month)}`;
  return civil.year === nowYear ? base : `${base} ${civil.year}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** The calendar date (YYYY-MM-DD) a value falls on, for day comparisons and grouping. */
export function civilDay(value: DateInput, timeZone?: string): string {
  const civil = civilOf(value, safeTimeZone(timeZone));
  return civil === undefined ? '' : civilKey(civil);
}

/** "2:14 PM": 12-hour clock, uppercase period. */
export function formatTime(value: DateInput, timeZone?: string): string {
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('hour')}:${read('minute')} ${read('dayPeriod').toUpperCase()}`;
}

/** "23 Oct"; "23 Oct 2025" when the year is not now's year. */
export function formatDate(value: DateInput, now: Date = new Date(), timeZone?: string): string {
  const zone = safeTimeZone(timeZone);
  const civil = civilOf(value, zone);
  if (civil === undefined) return '';
  return dayText(civil, civilOfInstant(now, zone).year);
}

const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Whole civil days from `from` to `to` (calendar arithmetic, no zone involved). */
function civilDaysBetween(from: Civil, to: Civil): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / DAY);
}

/**
 * THE past-time format, app-wide (lists, chat day dividers, comments, history,
 * Activity, Assets, Members...): today "10:27 AM"; yesterday "Yesterday";
 * 2-6 days ago the weekday "Mon"; older "19 Oct"; another year "19 Oct 2025".
 * Civil days on the given (workspace) zone. Never relative ("ago", "just now").
 * A future instant reads as its day like any other ("Due" lives in formatDue).
 */
export function formatWhen(value: DateInput, now: Date = new Date(), timeZone?: string): string {
  const zone = safeTimeZone(timeZone);
  const civil = civilOf(value, zone);
  if (civil === undefined) return '';
  const today = civilOfInstant(now, zone);
  const days = civilDaysBetween(civil, today);
  if (days === 0) return formatTime(value, zone);
  if (days === 1) return 'Yesterday';
  if (days >= 2 && days <= 6) {
    const weekday = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
    return SHORT_WEEKDAYS[weekday] ?? '';
  }
  return dayText(civil, today.year);
}

/** Alias of formatWhen, kept for existing chat call sites. */
export function formatChatTime(
  value: DateInput,
  now: Date = new Date(),
  timeZone?: string,
): string {
  return formatWhen(value, now, timeZone);
}

/**
 * A day divider or day heading (chat day pills, grouped lists): "Today" for
 * today (a clock time makes no sense for a whole day), else formatWhen:
 * "Yesterday", "Mon", "19 Oct", "19 Oct 2025". Never relative.
 */
export function formatDayLabel(
  value: DateInput,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const zone = safeTimeZone(timeZone);
  const civil = civilOf(value, zone);
  if (civil === undefined) return '';
  if (civilDaysBetween(civil, civilOfInstant(now, zone)) === 0) return 'Today';
  return formatWhen(value, now, zone);
}

/** "23 Oct, 2:14 PM"; "23 Oct 2025, 2:14 PM" off the current year. */
export function formatDateTime(
  value: DateInput,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const zone = safeTimeZone(timeZone);
  return `${formatDate(instant, now, zone)}, ${formatTime(instant, zone)}`;
}

/** The range dash: an en dash, tight between day numbers, spaced between full dates. */
const RANGE_DASH = '\u2013';

/**
 * The one date-range formatter: "12–18 Oct" in one month, "28 Mar – 3 Apr"
 * across months (spaced en dash), "12 Oct" for one day; the year appears only
 * off the current year ("28 Dec 2026 – 3 Jan 2027" across years). Civil days
 * on the workspace zone; a date-only string is read as-is. Never "to" or "-".
 */
export function formatDayRange(
  start: DateInput,
  end: DateInput,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): string {
  const timeZone = workspaceZone ?? undefined;
  const zone = safeTimeZone(timeZone);
  const a = civilOf(start, zone);
  const b = civilOf(end, zone);
  if (a === undefined || b === undefined) return '';
  const nowYear = civilOfInstant(now, zone).year;
  if (a.year !== b.year) return `${dayText(a, -1)} ${RANGE_DASH} ${dayText(b, -1)}`;
  const year = a.year === nowYear ? '' : ` ${a.year}`;
  if (a.month === b.month) {
    return a.day === b.day
      ? `${a.day} ${monthName(a.month)}${year}`
      : `${a.day}${RANGE_DASH}${b.day} ${monthName(a.month)}${year}`;
  }
  return `${a.day} ${monthName(a.month)} ${RANGE_DASH} ${b.day} ${monthName(b.month)}${year}`;
}

/**
 * A due or target date as its calendar day on the WORKSPACE zone: "23 Oct",
 * "23 Oct 2025" off the current year. posts.target_date is stored as noon in
 * the workspace zone, so every viewer sees the day that was picked.
 */
export function formatDueDate(
  value: DateInput,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): string {
  return formatDate(value, now, workspaceZone ?? undefined);
}

/** "Due 23 Oct" on the workspace zone (year rule as formatDate); '' for unparseable input. */
export function formatDue(
  value: DateInput,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): string {
  const day = formatDueDate(value, workspaceZone, now);
  return day === '' ? '' : `Due ${day}`;
}

/** An overdue reading; `bad` is always true so callers colour it with the bad token. */
interface OverdueLabel {
  text: string;
  bad: true;
}

/**
 * Up to one calendar month late: "Overdue · 12 Oct". More than a month late:
 * whole months, "Overdue 1 month" / "Overdue 5 months". Days are civil days on
 * the workspace zone, so overdue flips at the workspace's midnight.
 * Unparseable input reads as plain "Overdue".
 */
export function formatOverdue(
  value: DateInput,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): OverdueLabel {
  const zone = safeTimeZone(workspaceZone);
  const civil = civilOf(value, zone);
  if (civil === undefined) return { text: 'Overdue', bad: true };
  const today = civilOfInstant(now, zone);
  let months = (today.year - civil.year) * 12 + (today.month - civil.month);
  if (today.day < civil.day) months -= 1;
  // Exactly one month late (same day of the month) still reads as a date.
  const moreThanMonth = months > 1 || (months === 1 && today.day > civil.day);
  if (!moreThanMonth) return { text: `Overdue · ${dayText(civil, today.year)}`, bad: true };
  return { text: `Overdue ${plural(months, 'month')}`, bad: true };
}

/** "Monday, 19 October 2026": the full spoken date, for accessible names. '' when unparseable. */
export function formatSpokenDate(value: DateInput, timeZone?: string): string {
  const civil = civilOf(value, safeTimeZone(timeZone));
  if (civil === undefined) return '';
  const weekday = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
  const month = LONG_MONTHS[civil.month - 1] ?? '';
  return `${LONG_WEEKDAYS[weekday] ?? ''}, ${civil.day} ${month} ${civil.year}`;
}

/** True when Intl accepts the value as an IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a zone (24-hour; weekday 0=Sun..6=Sat), for calendar math. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Wall-clock parts of an instant in a zone; an invalid zone reads as the device zone. */
export function zonedParts(instant: Date, timeZone?: string | null): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const text = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const num = (type: string): number => Number(text(type));
  const weekday = WEEKDAYS.indexOf(text('weekday') as (typeof WEEKDAYS)[number]);
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    // Some engines report midnight as 24 even with h23.
    hour: num('hour') % 24,
    minute: num('minute'),
    second: num('second'),
    weekday: weekday === -1 ? 0 : weekday,
  };
}

/** The device's short zone name ("IST", "GMT+5:30"); '' if Intl cannot say. */
export function shortZoneName(now: Date, locale?: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}
