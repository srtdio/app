// Pure relative-time formatters for the post-detail surfaces. No React and no
// timers: `now` is always passed in so output is deterministic and unit
// testable. Two registers share the same bucket boundaries: a terse glyph form
// (relativeShort: "5m", "3h", "2d", "1w") for dense status lines, and a spoken
// form (relativeLong: "5 minutes ago") for comment timestamps. shortDate is the
// calendar form used once a relative reading stops being useful.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Terse relative reading: just now / 5m / 3h / 2d / 1w. */
export function relativeShort(ts: string, now: Date): string {
  const diff = now.getTime() - new Date(ts).getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`;
  return `${Math.floor(diff / WEEK)}w`;
}

/** Spoken relative reading with singular/plural agreement: "1 minute ago",
 *  "5 minutes ago", "just now". */
export function relativeLong(ts: string, now: Date): string {
  const diff = now.getTime() - new Date(ts).getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return agoPhrase(Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return agoPhrase(Math.floor(diff / HOUR), 'hour');
  if (diff < WEEK) return agoPhrase(Math.floor(diff / DAY), 'day');
  return agoPhrase(Math.floor(diff / WEEK), 'week');
}

function agoPhrase(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/** Calendar reading: "Jun 11", or "Jun 11, 2025" when the year differs from
 *  now's year. */
export function shortDate(ts: string, now: Date): string {
  const date = new Date(ts);
  const base = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return date.getFullYear() === now.getFullYear() ? base : `${base}, ${date.getFullYear()}`;
}
