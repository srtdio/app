// Pure relative-time label for the chat conversation cards. No React and no
// clock: `nowMs` is always passed in, so the label is deterministic and unit
// testable, and it refreshes only when the store-driven re-render passes a fresh
// `nowMs`. The registers are tuned for a chat list: "now" under a minute, then
// "{m}m" / "{h}h" within the same calendar day, "Yesterday" for the previous
// calendar day, and a short calendar date before that. Days are calendar days
// in the WORKSPACE zone (a message at 23:50 read at 00:10 is "Yesterday", not
// "20m"), via the shared chat time formatter.

import { civilDay, formatShortDate } from '@/lib/chat/time-format';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The calendar day before a YYYY-MM-DD day (pure date arithmetic, no zone). */
function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const prior = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - 1));
  return prior.toISOString().slice(0, 10);
}

/** Conversation-card timestamp: now / 5m / 3h / Yesterday / Jun 11. */
export function formatRelativeTime(tsMs: number, nowMs: number, timeZone: string): string {
  const diff = nowMs - tsMs;
  if (diff < MINUTE) return 'now';
  const today = civilDay(nowMs, timeZone);
  const day = civilDay(tsMs, timeZone);
  if (day === today || diff < 0) {
    return diff < HOUR ? `${Math.floor(diff / MINUTE)}m` : `${Math.floor(diff / HOUR)}h`;
  }
  if (day === previousDay(today) && diff < 2 * DAY) return 'Yesterday';
  return formatShortDate(tsMs, timeZone);
}
