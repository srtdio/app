// Book a demo: the pure date and form rules behind /demo. Dates are calendar
// days in DEMO.timeZone (IST), never the visitor's own zone.

import { DEMO, type DemoSlot } from './config';

/** A calendar day; month is 1-12. */
export interface CalendarDay {
  y: number;
  m: number;
  d: number;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
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
] as const;

/** Column headers, Monday first. */
export const WEEK_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const zoneParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEMO.timeZone,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

/** Today's date in IST at the instant `now`. */
export function todayIn(now: Date): CalendarDay {
  const parts = zoneParts.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { y: part('year'), m: part('month'), d: part('day') };
}

function utc(day: CalendarDay): number {
  return Date.UTC(day.y, day.m - 1, day.d);
}

function fromUtc(ms: number): CalendarDay {
  const date = new Date(ms);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

export function addDays(day: CalendarDay, days: number): CalendarDay {
  return fromUtc(utc(day) + days * DAY_MS);
}

export function sameDay(a: CalendarDay, b: CalendarDay): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

/** 0 = Sunday .. 6 = Saturday. */
function weekday(day: CalendarDay): number {
  return new Date(utc(day)).getUTCDay();
}

/** Tomorrow to 30 days ahead (IST), Monday to Friday only. */
export function isBookable(day: CalendarDay, today: CalendarDay): boolean {
  const ahead = Math.round((utc(day) - utc(today)) / DAY_MS);
  const wd = weekday(day);
  return ahead >= DEMO.firstDay && ahead <= DEMO.lastDay && wd >= 1 && wd <= 5;
}

/** The first and last month (as the 1st of the month) the calendar can show. */
export function monthRange(today: CalendarDay): { first: CalendarDay; last: CalendarDay } {
  const end = addDays(today, DEMO.lastDay);
  return { first: { y: today.y, m: today.m, d: 1 }, last: { y: end.y, m: end.m, d: 1 } };
}

/** The 1st of the month `delta` months from `month`. */
export function shiftMonth(month: CalendarDay, delta: number): CalendarDay {
  const index = month.y * 12 + (month.m - 1) + delta;
  return { y: Math.floor(index / 12), m: (index % 12) + 1, d: 1 };
}

/** A month's days in Monday-first weeks; null pads the first and last week. */
export function monthGrid(month: CalendarDay): (CalendarDay | null)[] {
  const first: CalendarDay = { y: month.y, m: month.m, d: 1 };
  const lead = (weekday(first) + 6) % 7;
  const length = new Date(Date.UTC(month.y, month.m, 0)).getUTCDate();
  const cells: (CalendarDay | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= length; d += 1) cells.push({ y: month.y, m: month.m, d });
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function monthTitle(month: CalendarDay): string {
  return `${MONTH_NAMES[month.m - 1] ?? ''} ${month.y}`;
}

/** "Thursday 16 October 2026": a day button's accessible name. */
export function longDate(day: CalendarDay): string {
  const names = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ] as const;
  return `${names[weekday(day)] ?? ''} ${day.d} ${MONTH_NAMES[day.m - 1] ?? ''} ${day.y}`;
}

/** "Thu 16 Oct, 11:00 am IST · 30 min". */
export function bookingSummary(day: CalendarDay, slot: DemoSlot): string {
  const wd = WEEKDAYS[weekday(day)] ?? '';
  const mon = MONTHS[day.m - 1] ?? '';
  return `${wd} ${day.d} ${mon}, ${slot} ${DEMO.timeZoneLabel} · ${DEMO.durationLabel}`;
}

export interface DemoForm {
  name: string;
  email: string;
  /** Digits only, without the fixed +91. */
  mobile: string;
  day: CalendarDay | null;
  slot: DemoSlot | null;
}

export type DemoField = 'name' | 'email' | 'mobile' | 'day' | 'slot';

/** Fields in form order: the first invalid one takes focus. */
export const DEMO_FIELDS: readonly DemoField[] = ['name', 'email', 'mobile', 'day', 'slot'];

export const DEMO_ERRORS: Record<DemoField, string> = {
  name: 'Enter your name.',
  email: 'Enter an email like you@agency.com.',
  mobile: 'Enter a 10 digit mobile number.',
  day: 'Pick a day for the call.',
  slot: 'Pick a time for the call.',
};

export const DEMO_NOTICE = 'Demo booking opens soon. Nothing was sent.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^[6-9]\d{9}$/;

/** Keeps digits only, at most 10: what the mobile field holds. */
export function mobileDigits(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 10);
}

/** The error for each invalid field, in form order. Pure. */
export function validateDemo(form: DemoForm): Partial<Record<DemoField, string>> {
  const errors: Partial<Record<DemoField, string>> = {};
  if (form.name.trim() === '') errors.name = DEMO_ERRORS.name;
  if (!EMAIL_RE.test(form.email.trim())) errors.email = DEMO_ERRORS.email;
  if (!MOBILE_RE.test(form.mobile)) errors.mobile = DEMO_ERRORS.mobile;
  if (form.day === null) errors.day = DEMO_ERRORS.day;
  if (form.slot === null) errors.slot = DEMO_ERRORS.slot;
  return errors;
}
