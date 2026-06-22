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
    expect(formatRelativeTime(now, now)).toBe('now');
    expect(formatRelativeTime(ago(59 * 1000), now)).toBe('now');
  });

  it('reads minutes from the one-minute boundary up to the hour', () => {
    expect(formatRelativeTime(ago(MINUTE), now)).toBe('1m');
    expect(formatRelativeTime(ago(5 * MINUTE), now)).toBe('5m');
    expect(formatRelativeTime(ago(HOUR - 1), now)).toBe('59m');
  });

  it('reads hours from the one-hour boundary up to the day', () => {
    expect(formatRelativeTime(ago(HOUR), now)).toBe('1h');
    expect(formatRelativeTime(ago(3 * HOUR), now)).toBe('3h');
    expect(formatRelativeTime(ago(DAY - 1), now)).toBe('23h');
  });

  it('reads "Yesterday" across the prior day only', () => {
    expect(formatRelativeTime(ago(DAY), now)).toBe('Yesterday');
    expect(formatRelativeTime(ago(2 * DAY - 1), now)).toBe('Yesterday');
  });

  it('falls back to a short calendar date two days out and beyond', () => {
    expect(formatRelativeTime(ago(2 * DAY), now)).toBe('Jun 20');
    expect(formatRelativeTime(ago(10 * DAY), now)).toBe('Jun 12');
  });
});
