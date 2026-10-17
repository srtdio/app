// The Book a call sheet's pure pieces: the three suggested slots, the custom
// date and time, and whether Book is enabled. Every time is wall-clock time in
// the viewer's time zone; the sheet sends the instant (ISO, Z) plus that zone.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Suggested times: first weekday 11:00 and 16:00, second weekday 11:00. */
const SLOT_RULE: readonly { day: 0 | 1; hour: number }[] = [
  { day: 0, hour: 11 },
  { day: 0, hour: 16 },
  { day: 1, hour: 11 },
];

/** A calendar date, month 1 to 12. */
interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface CallSlot {
  at: Date;
  label: string;
}

/** The viewer's IANA time zone. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The wall-clock fields of an instant in a time zone. */
function zonedFields(at: Date, timeZone: string): CivilDate & { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(at);
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
  };
}

/** The zone's offset from UTC at an instant, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const f = zonedFields(at, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute);
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** The instant a wall-clock date and time in a zone names. */
export function zonedInstant(
  date: CivilDate,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const first = wall - zoneOffsetMs(new Date(wall), timeZone);
  // Re-read the offset at the guess so a DST change between the two is honoured.
  return new Date(wall - zoneOffsetMs(new Date(first), timeZone));
}

function addDays(date: CivilDate, days: number): CivilDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function weekday(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** "Mon 20 Oct, 11:00": weekday, day, month and 24h time, all in the zone. */
export function slotLabel(at: Date, timeZone: string): string {
  const f = zonedFields(at, timeZone);
  const date = { year: f.year, month: f.month, day: f.day };
  return `${WEEKDAYS[weekday(date)]} ${f.day} ${MONTHS[f.month - 1]}, ${pad(f.hour)}:${pad(f.minute)}`;
}

/** The next two weekdays after today in the zone (weekends skipped). */
function nextWeekdays(now: Date, timeZone: string): [CivilDate, CivilDate] {
  const f = zonedFields(now, timeZone);
  const found: CivilDate[] = [];
  let date: CivilDate = { year: f.year, month: f.month, day: f.day };
  while (found.length < 2) {
    date = addDays(date, 1);
    const day = weekday(date);
    if (day !== 0 && day !== 6) found.push(date);
  }
  return [found[0]!, found[1]!];
}

/** The three suggested slots, from the rule, in the viewer's zone. */
export function suggestedSlots(now: Date, timeZone: string): CallSlot[] {
  const days = nextWeekdays(now, timeZone);
  return SLOT_RULE.map(({ day, hour }) => {
    const at = zonedInstant(days[day], hour, 0, timeZone);
    return { at, label: slotLabel(at, timeZone) };
  });
}

/** Tomorrow in the zone as YYYY-MM-DD, the custom date's minimum. */
export function tomorrowInputValue(now: Date, timeZone: string): string {
  const f = zonedFields(now, timeZone);
  const date = addDays({ year: f.year, month: f.month, day: f.day }, 1);
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** What the viewer picked: a suggested slot, the custom fields, or nothing yet. */
export type CallChoice = { kind: 'slot'; index: number } | { kind: 'other' } | null;

/**
 * The instant to book, or null while Book stays disabled: a suggested slot, or
 * both custom fields set (date from tomorrow on, a valid HH:MM time).
 */
export function chosenInstant(input: {
  choice: CallChoice;
  slots: readonly CallSlot[];
  date: string;
  time: string;
  minDate: string;
  timeZone: string;
}): Date | null {
  const { choice } = input;
  if (choice === null) return null;
  if (choice.kind === 'slot') return input.slots[choice.index]?.at ?? null;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date);
  const time = /^(\d{2}):(\d{2})$/.exec(input.time);
  if (date === null || time === null || input.date < input.minDate) return null;
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  if (hour > 23 || minute > 59) return null;
  return zonedInstant(
    { year: Number(date[1]), month: Number(date[2]), day: Number(date[3]) },
    hour,
    minute,
    input.timeZone,
  );
}
