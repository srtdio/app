// Day pills between thread messages. Pure render-time grouping over the loaded
// message array (no data change): a pill goes before the first message and
// before every message whose calendar day, on the viewer's clock, differs from
// the one above it. Labels are computed against a supplied now, so no timer.

import { civilDay } from '@/lib/time';
import type { ThreadMessage } from '@/lib/chat/thread';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The civil day (YYYY-MM-DD) before a civil day, by calendar, not by 24h. */
function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - 1));
  return date.toISOString().slice(0, 10);
}

/** "Today", "Yesterday", else "D MMM" for a civil day key. `timeZone` is for tests. */
export function dayPillLabel(day: string, nowMs: number, timeZone?: string): string {
  const today = civilDay(nowMs, timeZone);
  if (day === today) return 'Today';
  if (day === previousDay(today)) return 'Yesterday';
  const [, m, d] = day.split('-').map(Number);
  return `${d ?? ''} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
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
