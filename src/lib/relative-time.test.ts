import { describe, expect, it } from 'vitest';
import { relativeLong, relativeShort, shortDate } from './relative-time';

// A fixed reference clock plus fixed timestamps, so every bucket and the
// singular/plural boundary are exercised deterministically (no real Date.now()).
const now = new Date('2026-06-22T12:00:00Z');

function before(ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('relativeShort', () => {
  it('reads "just now" under a minute', () => {
    expect(relativeShort(before(30 * 1000), now)).toBe('just now');
  });
  it('reads minutes', () => {
    expect(relativeShort(before(5 * MINUTE), now)).toBe('5m');
    expect(relativeShort(before(MINUTE), now)).toBe('1m');
  });
  it('reads hours', () => {
    expect(relativeShort(before(3 * HOUR), now)).toBe('3h');
  });
  it('reads days', () => {
    expect(relativeShort(before(2 * DAY), now)).toBe('2d');
  });
  it('reads weeks', () => {
    expect(relativeShort(before(2 * WEEK), now)).toBe('2w');
  });
});

describe('relativeLong', () => {
  it('reads "just now" under a minute', () => {
    expect(relativeLong(before(30 * 1000), now)).toBe('just now');
  });
  it('uses singular at one and plural beyond', () => {
    expect(relativeLong(before(MINUTE), now)).toBe('1 minute ago');
    expect(relativeLong(before(5 * MINUTE), now)).toBe('5 minutes ago');
  });
  it('reads hours singular and plural', () => {
    expect(relativeLong(before(HOUR), now)).toBe('1 hour ago');
    expect(relativeLong(before(3 * HOUR), now)).toBe('3 hours ago');
  });
  it('reads days singular and plural', () => {
    expect(relativeLong(before(DAY), now)).toBe('1 day ago');
    expect(relativeLong(before(2 * DAY), now)).toBe('2 days ago');
  });
  it('reads weeks singular and plural', () => {
    expect(relativeLong(before(WEEK), now)).toBe('1 week ago');
    expect(relativeLong(before(2 * WEEK), now)).toBe('2 weeks ago');
  });
});

describe('shortDate', () => {
  it('omits the year in the same calendar year', () => {
    expect(shortDate('2026-06-11T12:00:00Z', now)).toBe('Jun 11');
  });
  it('appends the year for a prior year', () => {
    expect(shortDate('2025-06-11T12:00:00Z', now)).toBe('Jun 11, 2025');
  });
});
