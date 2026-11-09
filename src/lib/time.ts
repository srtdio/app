// The one date and time module for the whole app. Every visible date or time
// reads through here so the register never drifts between surfaces:
//   formatTime        "2:14 PM" (clock inside a message bubble, chosen times)
// The three list-time functions, by meaning (every list caller uses one):
//   formatAgo         things that just happened: "just now", "5m", "3h",
//                     "Yesterday", "Mon", "2 Nov" ("2 Nov 2025" off-year)
//   formatDue         deadlines, words only: "Today", "Tomorrow", "Fri", "12 Nov";
//                     late via formatOverdue: "2d late" / "3w late" / "2mo late" / "1y late";
//                     plans via formatPlanStart: "Mon" before, "Live" while on, "1 Nov" once ended
//   formatAdded       records (never ticks): "10:27 AM" today, else "2 Nov"
//   formatDayLabel    chat day dividers: "Today", "Yesterday", "Mon 2 Nov"
//   formatDateTime    "23 Oct, 2:14 PM"; "23 Oct 2025, 2:14 PM" off the current year
//   formatDate        "23 Oct"; "23 Oct 2025" off the current year (pickers, calendars)
//   formatDayRange    "19-25 Oct"; "28 Oct - 3 Nov"
//   formatDueDate     "23 Oct" for a due/target date shown as a value
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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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
      // A day the month does not have ("2026-02-31") is unparseable, never rolled over.
      const check = new Date(Date.UTC(civil.year, civil.month - 1, civil.day));
      if (check.getUTCMonth() !== civil.month - 1 || check.getUTCDate() !== civil.day) {
        return undefined;
      }
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

/** The weekday of a civil day: "Mon". */
function weekdayOf(civil: Civil): string {
  const weekday = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
  return SHORT_WEEKDAYS[weekday] ?? '';
}

/**
 * formatAgo: things that just happened (Chat list, Activity, the Pipeline
 * status line, comments, post activity and versions). "just now" under a
 * minute, "5m" under an hour, "3h" under 24 hours, then by civil day on the
 * zone: "Yesterday", the weekday "Mon" 2-6 days back, else "2 Nov" ("2 Nov
 * 2025" off the current year). A future instant reads "just now". Civil
 * days read on `timeZone` (the viewer's device zone when omitted).
 */
export function formatAgo(value: DateInput, now: Date = new Date(), timeZone?: string): string {
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const diff = now.getTime() - instant.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  const zone = safeTimeZone(timeZone);
  const civil = civilOfInstant(instant, zone);
  const today = civilOfInstant(now, zone);
  const days = civilDaysBetween(civil, today);
  // A 25-hour (DST fall-back) day can hold 24h+ on one civil day: still hours.
  if (days <= 0) return `${Math.floor(diff / HOUR)}h`;
  if (days === 1) return 'Yesterday';
  if (days <= 6) return weekdayOf(civil);
  return dayText(civil, today.year);
}

/** The full weekday of a civil day: "Friday". */
function longWeekdayOf(civil: Civil): string {
  const weekday = new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
  return LONG_WEEKDAYS[weekday] ?? '';
}

/** Which day word a thread time leads with (threadWhen). */
export type ThreadWhenMode = 'date' | 'relative';

/** The day word of a thread time: 'relative' adds "Friday" 2-6 days back, 'row' does not. */
function threadDay(instant: Date, mode: ThreadWhenMode | 'row', now: Date, zone: string): string {
  const civil = civilOfInstant(instant, zone);
  const today = civilOfInstant(now, zone);
  if (mode !== 'date') {
    const days = civilDaysBetween(civil, today);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (mode === 'relative' && days >= 2 && days <= 6) return longWeekdayOf(civil);
  }
  return dayText(civil, today.year);
}

/**
 * threadWhen (9 Nov 2026): a thread's root and replies. 'date': "16 Oct at
 * 10:09 AM" ("16 Oct 2025 at 10:09 AM" off now's year). 'relative': "Today at
 * 10:12 AM", "Yesterday at ...", the weekday "Friday at ..." 2-6 days back,
 * else the date form. Civil days on `timeZone` (device zone when omitted).
 */
export function threadWhen(
  value: DateInput,
  mode: ThreadWhenMode,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const zone = safeTimeZone(timeZone);
  return `${threadDay(instant, mode, now, zone)} at ${formatTime(instant, zone)}`;
}

/** rowWhen: the chat replies row's last reply time; threadWhen 'relative' with no weekday step. */
export function rowWhen(value: DateInput, now: Date = new Date(), timeZone?: string): string {
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const zone = safeTimeZone(timeZone);
  return `${threadDay(instant, 'row', now, zone)} at ${formatTime(instant, zone)}`;
}

/**
 * formatAdded: when a record was made (Assets, Bank, Recently deleted, Members
 * joined, Settings). Never ticks: "10:27 AM" on the same civil day, else
 * "2 Nov" ("2 Nov 2025" off the current year).
 */
export function formatAdded(value: DateInput, now: Date = new Date(), timeZone?: string): string {
  const zone = safeTimeZone(timeZone);
  const instant = instantOf(value);
  if (instant === undefined) return '';
  const civil = civilOfInstant(instant, zone);
  const today = civilOfInstant(now, zone);
  if (civilDaysBetween(civil, today) === 0) return formatTime(instant, zone);
  return dayText(civil, today.year);
}

/**
 * A chat day divider: "Today", "Yesterday", else "Mon 2 Nov" ("Mon 2 Nov 2025"
 * off the current year). Civil days on the given zone. The only absolute
 * day text in a thread, beside the bubble clock (formatTime).
 */
export function formatDayLabel(
  value: DateInput,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const zone = safeTimeZone(timeZone);
  const civil = civilOf(value, zone);
  if (civil === undefined) return '';
  const today = civilOfInstant(now, zone);
  const days = civilDaysBetween(civil, today);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${weekdayOf(civil)} ${dayText(civil, today.year)}`;
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

/**
 * Whole civil days from today to the value's day on the workspace zone:
 * 0 today, 1 tomorrow, -1 yesterday; undefined when unparseable.
 */
export function daysFromToday(
  value: DateInput,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  const zone = safeTimeZone(workspaceZone);
  const civil = civilOf(value, zone);
  if (civil === undefined) return undefined;
  return civilDaysBetween(civilOfInstant(now, zone), civil);
}

/** "Today", "Tomorrow", the weekday "Fri" 2-6 days ahead, else "12 Nov" ("12 Nov 2027" off-year). */
function aheadText(value: DateInput, zone: string, now: Date): string | undefined {
  const civil = civilOf(value, zone);
  if (civil === undefined) return undefined;
  const today = civilOfInstant(now, zone);
  const days = civilDaysBetween(today, civil);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days >= 2 && days <= 6) return weekdayOf(civil);
  return dayText(civil, today.year);
}

/** How long ago a civil day was, short: "1d".."6d", "1w".."4w", "1mo".."11mo", "1y" (at least 1d). */
function behindText(value: DateInput, zone: string, now: Date): string | undefined {
  const civil = civilOf(value, zone);
  if (civil === undefined) return undefined;
  const today = civilOfInstant(now, zone);
  const days = Math.max(1, civilDaysBetween(civil, today));
  if (days < 7) return `${days}d`;
  let months = (today.year - civil.year) * 12 + (today.month - civil.month);
  if (today.day < civil.day) months -= 1;
  if (months < 1) return `${Math.floor(days / 7)}w`;
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/**
 * formatDue: a deadline on the workspace zone, words only (Pipeline, Briefs):
 * "Today", "Tomorrow", "Fri" (2-6 days ahead), then "12 Nov" ("12 Nov 2027"
 * off-year). Never the word "Due". A past day reads its date "12 Oct":
 * callers show formatOverdue instead unless the post is approved (approved is
 * never overdue).
 */
export function formatDue(
  value: DateInput,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): string {
  const zone = safeTimeZone(workspaceZone);
  const days = daysFromToday(value, zone, now);
  if (days === undefined) return '';
  if (days < 0) return formatDueDate(value, zone, now);
  return aheadText(value, zone, now) ?? '';
}

/** An overdue reading; `bad` is always true so callers colour it with the bad token. */
interface OverdueLabel {
  text: string;
  bad: true;
}

/**
 * How late a due day is, on the workspace zone: "1d late" .. "6d late",
 * "3w late", "2mo late", "1y late". Flips at the workspace's midnight.
 * Unparseable input reads as plain "Late".
 */
export function formatOverdue(
  value: DateInput,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): OverdueLabel {
  const late = behindText(value, safeTimeZone(workspaceZone), now);
  return { text: late === undefined ? 'Late' : `${late} late`, bad: true };
}

/**
 * A plan's words on the workspace zone, flipping at workspace midnight:
 * up to its start "Today" (it starts today), "Tomorrow", "Mon" (2-6 days ahead),
 * then "16 Nov"; started (after its first day) and its end day not passed "Live"; once its end day has passed, the
 * end day "1 Nov" (formatAdded style, "1 Nov 2025" off-year). With no end day
 * a started plan reads "Live".
 */
export function formatPlanStart(
  value: DateInput,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
  endsOn?: DateInput | null,
): string {
  const zone = safeTimeZone(workspaceZone);
  const days = daysFromToday(value, zone, now);
  if (days === undefined) return '';
  if (days >= 0) return aheadText(value, zone, now) ?? '';
  if (endsOn !== undefined && endsOn !== null) {
    const end = civilOf(endsOn, zone);
    if (end !== undefined) {
      const today = civilOfInstant(now, zone);
      if (civilDaysBetween(end, today) > 0) return dayText(end, today.year);
    }
  }
  return 'Live';
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
