// Day pills between thread messages. Pure render-time grouping over the loaded
// message array (no data change): a pill goes before the first message and
// before every message whose calendar day, on the viewer's clock, differs from
// the one above it. Labels are computed against a supplied now, so no timer.

import { civilDay, formatDayLabel } from '@/lib/time';
import type { ThreadMessage } from '@/lib/chat/thread';

/**
 * The pill for a civil day key: "Today" (a clock time makes no sense for a
 * whole day), else the app's one past-time format (src/lib/time.ts formatWhen):
 * "Yesterday", "Mon" 2-6 days back, "3 Sep", "31 Dec 2025". `timeZone` is for tests.
 */
export function dayPillLabel(day: string, nowMs: number, timeZone?: string): string {
  return formatDayLabel(day, new Date(nowMs), timeZone);
}

export type ThreadItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; message: ThreadMessage; index: number };

/**
 * The thread's render list: messages in order with a day pill before each new
 * calendar day. A message with no usable time (0) never starts a day.
 */
export function withDaySeparators(
  messages: readonly ThreadMessage[],
  nowMs: number,
  timeZone?: string,
): ThreadItem[] {
  const items: ThreadItem[] = [];
  let current: string | null = null;
  messages.forEach((message, index) => {
    if (Number.isFinite(message.time) && message.time > 0) {
      const day = civilDay(message.time, timeZone);
      if (day !== current) {
        current = day;
        items.push({ kind: 'day', key: `day-${day}`, label: dayPillLabel(day, nowMs, timeZone) });
      }
    }
    items.push({ kind: 'message', message, index });
  });
  return items;
}
