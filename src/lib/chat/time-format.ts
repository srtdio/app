// Chat timestamps rendered on the WORKSPACE civil clock, never the browser's.
// Every formatter takes an explicit IANA zone and hands it to
// Intl.DateTimeFormat, the same approach src/lib/list-sort.ts (civilDate) and
// src/lib/brief-groups.ts (formatRaisedDay) use for briefs. 'en-US' is the
// reference locale so the output is identical whatever the browser's locale,
// and parts are re-assembled by type so part order never drifts between engines.

/** Probe a zone once; a blank or non-IANA value degrades to UTC, never throws. */
export function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

function instantOf(value: string | number): Date | undefined {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

/**
 * A message's clock time in the workspace zone, e.g. "14:05". 24-hour, zero
 * padded, so the bubble footer keeps a fixed width. An unparseable input renders
 * as an empty string rather than reaching Intl.format (which would throw).
 */
export function formatMessageTime(createdAt: string | number, timeZone: string): string {
  const instant = instantOf(createdAt);
  if (instant === undefined) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('hour')}:${read('minute')}`;
}

/**
 * A short calendar date in the workspace zone, e.g. "Jun 20", for conversation
 * cards once a relative reading stops being useful.
 */
export function formatShortDate(createdAt: string | number, timeZone: string): string {
  const instant = instantOf(createdAt);
  if (instant === undefined) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTimeZone(timeZone),
    month: 'short',
    day: 'numeric',
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('month')} ${read('day')}`;
}
