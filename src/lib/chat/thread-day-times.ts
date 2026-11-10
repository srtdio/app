// The Threads list's time rule (10 Nov 2026): inside one block (a thread's
// root, then its shown replies, oldest first) the first message of each
// calendar day shows its day and clock ("Yesterday at 12:17 PM"); later
// messages on the same day show the clock only ("2:54 PM") until the day
// changes. The rule restarts per block. Civil days on the viewer's zone
// (time.ts civilDay). Pure.

import { civilDay } from '@/lib/time';

/** Which time a bubble's head shows: the clock alone, or the day + clock (threadWhen 'relative'). */
export type ThreadTimeLabel = 'clock' | 'day';

/** One label per message, in order: 'day' on each day's first, else 'clock'. Pure. */
export function threadDayTimes(
  times: readonly (string | number)[],
  timeZone?: string,
): ThreadTimeLabel[] {
  let last: string | null = null;
  return times.map((at) => {
    const day = civilDay(at, timeZone);
    if (day === last) return 'clock';
    last = day;
    return 'day';
  });
}
