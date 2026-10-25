// The one date and time module for the whole app. Every visible date or time
// reads through here so the register never drifts between surfaces:
//   formatTime        "2:14 PM"
//   formatChatTime    "2:14 PM" today, "Yesterday", "20 Oct", "20 Oct 2025"
//   formatRelative    "just now", "5 min ago", "3 hours ago" ... "2 years ago"
//   formatDateTime    "23 Oct, 2:14 PM"; "23 Oct 2025, 2:14 PM" off the current year
//   formatDate        "23 Oct"; "23 Oct 2025" off the current year
//   formatDayRange    "19 - 25 Oct"; "28 Oct - 3 Nov"
//   formatDue         "Due 23 Oct"
//   formatOverdue     "Overdue · 12 Oct" up to a month late, then "Overdue 5 months"
// Days and clock times are read on the VIEWER's device time zone. A date-only
// "YYYY-MM-DD" value is read off the string itself so no zone can shift it.
// 'en-US' parts are re-assembled by type so the output never follows the
// browser locale. `now` defaults to the current instant; tests pass it (and a
// zone) explicitly. Unparseable input renders as ''.

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
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

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

/** The day before a civil day (calendar arithmetic, no zone involved). */
function previousDay(civil: Civil): Civil {
  const d = new Date(Date.UTC(civil.year, civil.month - 1, civil.day - 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
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

/** Today "2:14 PM", yesterday "Yesterday", this year "20 Oct", older "20 Oct 2025". */
export function formatChatTime(
  value: DateInput,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const zone = safeTimeZone(timeZone);
  const civil = civilOf(value, zone);
  if (civil === undefined) return '';
  const today = civilOfInstant(now, zone);
  const key = civilKey(civil);
  if (key === civilKey(today)) return formatTime(value, zone);
  if (key === civilKey(previousDay(today))) return 'Yesterday';
  return dayText(civil, today.year);
}

/**
 * Spoken elapsed time: "just now" under a minute (and for a future instant),
 * then "5 min ago", "3 hours ago", "2 days ago" (under 30 days), "4 months ago"
 * (under a year), "2 years ago". Singular and plural agree.
 */
export function formatRelative(value: DateInput, now: Date = new Date()): string {
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const diff = now.getTime() - instant.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${plural(Math.floor(diff / HOUR), 'hour')} ago`;
  if (diff < MONTH) return `${plural(Math.floor(diff / DAY), 'day')} ago`;
  if (diff < YEAR) return `${plural(Math.min(11, Math.floor(diff / MONTH)), 'month')} ago`;
  return `${plural(Math.floor(diff / YEAR), 'year')} ago`;
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

/** "19 - 25 Oct", "28 Oct - 3 Nov"; years appear only off the current year. */
export function formatDayRange(
  start: DateInput,
  end: DateInput,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const zone = safeTimeZone(timeZone);
  const a = civilOf(start, zone);
  const b = civilOf(end, zone);
  if (a === undefined || b === undefined) return '';
  const nowYear = civilOfInstant(now, zone).year;
  if (a.year !== b.year) return `${dayText(a, -1)} - ${dayText(b, -1)}`;
  const year = a.year === nowYear ? '' : ` ${a.year}`;
  if (a.month === b.month) {
    return a.day === b.day
      ? `${a.day} ${monthName(a.month)}${year}`
      : `${a.day} - ${b.day} ${monthName(a.month)}${year}`;
  }
  return `${a.day} ${monthName(a.month)} - ${b.day} ${monthName(b.month)}${year}`;
}

/** "Due 23 Oct" (year rule as formatDate); '' for unparseable input. */
export function formatDue(value: DateInput, now: Date = new Date(), timeZone?: string): string {
  const day = formatDate(value, now, timeZone);
  return day === '' ? '' : `Due ${day}`;
}

/** An overdue reading; `bad` is always true so callers colour it with the bad token. */
export interface OverdueLabel {
  text: string;
  bad: true;
}

/**
 * Up to one calendar month late: "Overdue · 12 Oct". More than a month late:
 * whole months, "Overdue 1 month" / "Overdue 5 months". Days are civil days.
 * Unparseable input reads as plain "Overdue".
 */
export function formatOverdue(
  value: DateInput,
  now: Date = new Date(),
  timeZone?: string,
): OverdueLabel {
  const zone = safeTimeZone(timeZone);
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
