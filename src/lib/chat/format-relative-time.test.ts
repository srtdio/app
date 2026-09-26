import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './format-relative-time';

// A fixed reference clock plus offsets, so every bucket and its boundary are
// exercised deterministically (no real Date.now()).
const now = Date.parse('2026-06-22T12:00:00Z');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): number {
  return now - ms;
}

describe('formatRelativeTime', () => {
  it('reads "now" under a minute, up to its boundary', () => {
    expect(formatRelativeTime(now, now, 'UTC')).toBe('now');
    expect(formatRelativeTime(ago(59 * 1000), now, 'UTC')).toBe('now');
  });

  it('reads minutes from the one-minute boundary up to the hour', () => {
    expect(formatRelativeTime(ago(MINUTE), now, 'UTC')).toBe('1m');
    expect(formatRelativeTime(ago(5 * MINUTE), now, 'UTC')).toBe('5m');
    expect(formatRelativeTime(ago(HOUR - 1), now, 'UTC')).toBe('59m');
  });

  it('reads hours from the one-hour boundary within the same calendar day', () => {
    expect(formatRelativeTime(ago(HOUR), now, 'UTC')).toBe('1h');
    expect(formatRelativeTime(ago(3 * HOUR), now, 'UTC')).toBe('3h');
    expect(formatRelativeTime(ago(12 * HOUR), now, 'UTC')).toBe('12h');
  });

  it('reads "Yesterday" for the previous calendar day in the workspace zone', () => {
    expect(formatRelativeTime(ago(12 * HOUR + 1), now, 'UTC')).toBe('Yesterday');
    expect(formatRelativeTime(ago(DAY), now, 'UTC')).toBe('Yesterday');
    expect(formatRelativeTime(ago(36 * HOUR), now, 'UTC')).toBe('Yesterday');
    // 23:50 read at 00:10 the next day is Yesterday, not "20m".
    const justAfterMidnight = Date.parse('2026-06-22T00:10:00Z');
    expect(formatRelativeTime(Date.parse('2026-06-21T23:50:00Z'), justAfterMidnight, 'UTC')).toBe(
      'Yesterday',
    );
    // The same instants are both Jun 22 in Mumbai (UTC+5:30): same day, so "20m".
    expect(
      formatRelativeTime(Date.parse('2026-06-21T23:50:00Z'), justAfterMidnight, 'Asia/Kolkata'),
    ).toBe('20m');
  });

  it('falls back to a short calendar date two calendar days out and beyond', () => {
    expect(formatRelativeTime(ago(36 * HOUR + 1), now, 'UTC')).toBe('Jun 20');
    expect(formatRelativeTime(ago(2 * DAY), now, 'UTC')).toBe('Jun 20');
    expect(formatRelativeTime(ago(10 * DAY), now, 'UTC')).toBe('Jun 12');
  });

  it('reads the calendar date in the workspace zone, not the browser zone', () => {
    // 2026-06-19T22:30Z is still Jun 19 in Los Angeles but already Jun 20 in Mumbai.
    const ts = Date.parse('2026-06-19T22:30:00Z');
    expect(formatRelativeTime(ts, now, 'America/Los_Angeles')).toBe('Jun 19');
    expect(formatRelativeTime(ts, now, 'Asia/Kolkata')).toBe('Jun 20');
  });
});
