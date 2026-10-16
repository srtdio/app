// Catch-up email schedule: decides whether a recipient is due a catch-up now.
//
// Two slots per recipient, 10:30 and 15:30 in the recipient's own zone, on
// local Mon-Fri only. A slot is due for 30 minutes after it starts so a cron
// tick on any half hour catches it. The window runs from the previous slot's
// instant to this slot's instant (Mon 10:30 starts at Fri 15:30). Pure: Intl
// only, no I/O, no libraries. Local wall times are converted to UTC by reading
// the zone offset at the candidate instant, so DST changes between days are
// handled.

import type { DecideSlot, LocalSlotDate, Slot } from './catchup-contracts';

const SLOT_MINUTES: Record<Slot, number> = { '10:30': 10 * 60 + 30, '15:30': 15 * 60 + 30 };
const DUE_FOR_MINUTES = 30;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A local calendar date; month is 1-12. */
interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface WallClock extends CalendarDate {
  minuteOfDay: number;
}

function wallClock(format: Intl.DateTimeFormat, at: Date): WallClock {
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    minuteOfDay: ((parts.hour ?? 0) % 24) * 60 + (parts.minute ?? 0),
  };
}

/** Calendar arithmetic on a date with no zone attached (UTC used as a neutral calendar). */
function calendarUtcMs(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function weekdayIndex(date: CalendarDate): number {
  return new Date(calendarUtcMs(date)).getUTCDay();
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(calendarUtcMs(date) + days * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isWeekend(date: CalendarDate): boolean {
  const index = weekdayIndex(date);
  return index === 0 || index === 6;
}

function previousWeekday(date: CalendarDate): CalendarDate {
  let prev = addDays(date, -1);
  while (isWeekend(prev)) prev = addDays(prev, -1);
  return prev;
}

/** The zone's UTC offset (ms) at an instant whose seconds are zero. */
function offsetAt(format: Intl.DateTimeFormat, instantMs: number): number {
  const wall = wallClock(format, new Date(instantMs));
  return calendarUtcMs(wall) + wall.minuteOfDay * MINUTE_MS - instantMs;
}

/** UTC instant of a local wall time, correcting once if the offset differs at the guess. */
function localToUtc(format: Intl.DateTimeFormat, date: CalendarDate, slot: Slot): Date {
  const asUtc = calendarUtcMs(date) + SLOT_MINUTES[slot] * MINUTE_MS;
  const guess = asUtc - offsetAt(format, asUtc);
  return new Date(asUtc - offsetAt(format, guess));
}

function toIsoDate(date: CalendarDate): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.year).padStart(4, '0')}-${pad(date.month)}-${pad(date.day)}`;
}

function zoneFormat(timezone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

function dueSlot(minuteOfDay: number): Slot | null {
  for (const slot of Object.keys(SLOT_MINUTES) as Slot[]) {
    const start = SLOT_MINUTES[slot];
    if (minuteOfDay >= start && minuteOfDay < start + DUE_FOR_MINUTES) return slot;
  }
  return null;
}

export const decideSlot: DecideSlot = (timezone, now) => {
  if (timezone === null) return { send: false, reason: 'no_timezone' };
  const format = zoneFormat(timezone);
  if (!format) return { send: false, reason: 'invalid_timezone' };

  const wall = wallClock(format, now);
  if (isWeekend(wall)) return { send: false, reason: 'weekend' };
  const slot = dueSlot(wall.minuteOfDay);
  if (!slot) return { send: false, reason: 'not_slot_time' };

  const today: CalendarDate = { year: wall.year, month: wall.month, day: wall.day };
  const sameDay = slot === '15:30';
  const previousDate = sameDay ? today : previousWeekday(today);
  const previousSlot: Slot = sameDay ? '10:30' : '15:30';

  const local: LocalSlotDate = {
    isoDate: toIsoDate(today),
    weekday: WEEKDAYS[weekdayIndex(today)] ?? '',
    day: today.day,
    month: MONTHS[today.month - 1] ?? '',
  };

  return {
    send: true,
    slot,
    local,
    previous: {
      slot: previousSlot,
      weekday: WEEKDAYS[weekdayIndex(previousDate)] ?? '',
      sameDay,
    },
    window: {
      start: localToUtc(format, previousDate, previousSlot).toISOString(),
      end: localToUtc(format, today, slot).toISOString(),
    },
  };
};
