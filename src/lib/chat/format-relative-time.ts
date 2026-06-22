// Pure relative-time label for the chat conversation cards. No React and no
// clock: `nowMs` is always passed in, so the label is deterministic and unit
// testable, and it refreshes only when the store-driven re-render passes a fresh
// `nowMs`. The registers are tuned for a chat list: "now" under a minute, then
// "{m}m" / "{h}h", "Yesterday" for the prior day, and a short calendar date once
// a relative reading stops being useful.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Conversation-card timestamp: now / 5m / 3h / Yesterday / Jun 11. */
export function formatRelativeTime(tsMs: number, nowMs: number): string {
  const diff = nowMs - tsMs;
  if (diff < MINUTE) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 2 * DAY) return 'Yesterday';
  return new Date(tsMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
