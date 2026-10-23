import { describe, expect, it } from 'vitest';
import { formatAgo, formatDateTime, formatDay, formatDue, formatOverdue } from './display-date';

const NOW = new Date('2026-10-23T12:00:00Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const before = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe('formatDay', () => {
  it('reads day then short month, no comma, no year in the current year', () => {
    expect(formatDay('2026-10-23T06:00:00Z', 'UTC', NOW)).toBe('23 Oct');
    expect(formatDay('2026-09-02T06:00:00Z', 'UTC', NOW)).toBe('2 Sep');
  });

  it('adds the year only when it is not the current year', () => {
    expect(formatDay('2027-01-04T06:00:00Z', 'UTC', NOW)).toBe('4 Jan 2027');
    expect(formatDay('2025-12-31T06:00:00Z', 'UTC', NOW)).toBe('31 Dec 2025');
  });

  it('reads the day in the workspace zone', () => {
    // 20:30 UTC on 19 Oct is already 20 Oct in Kolkata.
    expect(formatDay('2026-10-19T20:30:00Z', 'Asia/Kolkata', NOW)).toBe('20 Oct');
    expect(formatDay('2026-10-19T20:30:00Z', 'America/Los_Angeles', NOW)).toBe('19 Oct');
  });

  it('reads a date-only value off the string, never shifted by the zone', () => {
    expect(formatDay('2026-10-08', 'America/Los_Angeles', NOW)).toBe('8 Oct');
    expect(formatDay('2027-01-04', 'Asia/Kolkata', NOW)).toBe('4 Jan 2027');
  });

  it('renders unparseable input as empty and never throws on a bad zone', () => {
    expect(formatDay('garbage', 'UTC', NOW)).toBe('');
    expect(() => formatDay('2026-10-23T06:00:00Z', 'Not/AZone', NOW)).not.toThrow();
  });
});

describe('formatDue', () => {
  it('prefixes Due', () => {
    expect(formatDue('2026-10-23T06:00:00Z', 'UTC', NOW)).toBe('Due 23 Oct');
    expect(formatDue('2027-01-04', 'UTC', NOW)).toBe('Due 4 Jan 2027');
    expect(formatDue('nope', 'UTC', NOW)).toBe('');
  });
});

describe('formatOverdue', () => {
  it('shows the day when up to a month late, flagged bad', () => {
    expect(formatOverdue('2026-10-12', 'UTC', NOW)).toEqual({
      text: 'Overdue · 12 Oct',
      bad: true,
    });
    expect(formatOverdue('2026-09-23', 'UTC', NOW).text).toBe('Overdue · 23 Sep');
  });

  it('shows whole months when more than a month late', () => {
    expect(formatOverdue('2026-05-20', 'UTC', NOW)).toEqual({
      text: 'Overdue 5 months',
      bad: true,
    });
    expect(formatOverdue('2026-09-10', 'UTC', NOW).text).toBe('Overdue 1 month');
    expect(formatOverdue('2025-10-01', 'UTC', NOW).text).toBe('Overdue 12 months');
  });
});

describe('formatAgo', () => {
  it('covers every bucket with singular and plural', () => {
    expect(formatAgo(before(30 * 1000), NOW)).toBe('just now');
    expect(formatAgo(before(MINUTE), NOW)).toBe('1 minute ago');
    expect(formatAgo(before(5 * MINUTE), NOW)).toBe('5 minutes ago');
    expect(formatAgo(before(HOUR), NOW)).toBe('1 hour ago');
    expect(formatAgo(before(3 * HOUR), NOW)).toBe('3 hours ago');
    expect(formatAgo(before(DAY), NOW)).toBe('1 day ago');
    expect(formatAgo(before(2 * DAY), NOW)).toBe('2 days ago');
    expect(formatAgo(before(7 * DAY), NOW)).toBe('1 week ago');
    expect(formatAgo(before(21 * DAY), NOW)).toBe('3 weeks ago');
    expect(formatAgo(before(30 * DAY), NOW)).toBe('1 month ago');
    expect(formatAgo(before(125 * DAY), NOW)).toBe('4 months ago');
    expect(formatAgo(before(364 * DAY), NOW)).toBe('11 months ago');
    expect(formatAgo(before(365 * DAY), NOW)).toBe('1 year ago');
    expect(formatAgo(before(800 * DAY), NOW)).toBe('2 years ago');
  });

  it('never shows the retired glyph form', () => {
    expect(formatAgo(before(119 * DAY), NOW)).not.toMatch(/^\d+w$/);
  });

  it('reads a future instant as just now and bad input as empty', () => {
    expect(formatAgo(new Date(NOW.getTime() + HOUR).toISOString(), NOW)).toBe('just now');
    expect(formatAgo('garbage', NOW)).toBe('');
  });
});

describe('formatDateTime', () => {
  it('is "23 Oct, 2:14 PM" with an uppercase period', () => {
    expect(formatDateTime('2026-10-23T14:14:00Z', 'UTC', NOW)).toBe('23 Oct, 2:14 PM');
    expect(formatDateTime('2026-10-23T09:05:00Z', 'UTC', NOW)).toBe('23 Oct, 9:05 AM');
    expect(formatDateTime('2026-10-23T00:30:00Z', 'UTC', NOW)).toBe('23 Oct, 12:30 AM');
  });

  it('reads in the zone and applies the year rule', () => {
    expect(formatDateTime('2026-10-23T08:44:00Z', 'Asia/Kolkata', NOW)).toBe('23 Oct, 2:14 PM');
    expect(formatDateTime('2027-01-04T14:14:00Z', 'UTC', NOW)).toBe('4 Jan 2027, 2:14 PM');
    expect(formatDateTime('garbage', 'UTC', NOW)).toBe('');
  });
});
