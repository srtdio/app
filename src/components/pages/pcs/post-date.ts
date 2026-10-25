// The post's target date on the WORKSPACE civil clock (FB8). posts.target_date
// is a timestamptz; the browser's own zone must never decide which day it
// reads as, so the details sheet's input reads and writes the workspace-zone
// day (the plan's civil helpers). Display goes through the app formatter
// (src/lib/time.ts: formatDueDate, formatDue, on the same workspace zone);
// this module only owns the date input round trip.

import { civilDayOf, civilNoonInZoneIso } from '@/lib/plan-week';

/** The YYYY-MM-DD a native date input shows for a stored date, in the workspace zone. */
export function targetDateInputValue(value: string | null, timeZone: string): string {
  return civilDayOf(value, timeZone) ?? '';
}

/**
 * The instant to store for a picked YYYY-MM-DD: noon of that civil day in the
 * workspace zone, so it reads back as the same day in that zone (and any zone
 * within twelve hours of it) rather than as midnight UTC.
 */
export function targetDateFromInput(civil: string, timeZone: string): string {
  return civilNoonInZoneIso(civil, timeZone);
}
