// The post's target date on the WORKSPACE civil clock (FB8). posts.target_date
// is a timestamptz; the browser's own zone must never decide which day it
// reads as, so every read goes through Intl with the workspace zone (the same
// approach chat's time-format and the plan's civil helpers use), and the
// details sheet's date input reads and writes that same workspace-zone day.

import { safeTimeZone } from '@/lib/chat/time-format';
import { civilDayOf, civilNoonInZoneIso } from '@/lib/plan-week';

/**
 * "Oct 19, 2026" for an instant, read in `timeZone`. 'en-US' is the reference
 * locale so the output never drifts with the browser locale; parts are
 * re-assembled by type. Unparseable input renders as-is.
 */
export function formatPostTargetDate(value: string, timeZone: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('month')} ${read('day')}, ${read('year')}`;
}

/**
 * The details row's due label: "Due 28 Oct" for an instant, read in `timeZone`
 * (day then short month, no year). Unparseable input renders as "Due {value}".
 */
export function formatPostDueLabel(value: string, timeZone: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return `Due ${value}`;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeTimeZone(timeZone),
    month: 'short',
    day: 'numeric',
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `Due ${read('day')} ${read('month')}`;
}

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
