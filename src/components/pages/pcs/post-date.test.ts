// The browser is in Los Angeles for this file: a post date (a due date) must
// still read as the WORKSPACE zone's day (FB8), on display and in the details
// sheet's date input. TZ is set before any Date work; the assertions pass every
// zone explicitly (the "browser" reading is produced with the LA zone).
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { targetDateFromInput, targetDateInputValue } from '@/components/pages/pcs/post-date';
import { formatDue, formatDueDate } from '@/lib/time';

// 02:30 UTC on 20 Oct: still 19 Oct in Los Angeles, already 20 Oct in Mumbai.
const INSTANT = '2026-10-20T02:30:00.000Z';
const NOW = new Date('2026-10-23T12:00:00Z');

describe('post target date display', () => {
  it('renders the workspace-zone day for a browser in America/Los_Angeles', () => {
    expect(formatDueDate(INSTANT, 'Asia/Kolkata', NOW)).toBe('20 Oct');
    // The same instant read on the browser's own clock is a day earlier: the
    // page never shows that for an Asia/Kolkata workspace.
    expect(formatDueDate(INSTANT, 'America/Los_Angeles', NOW)).toBe('19 Oct');
  });

  it('adds the year outside the current year and never throws on a bad zone', () => {
    expect(formatDueDate('2027-01-05T12:00:00.000Z', 'UTC', NOW)).toBe('5 Jan 2027');
    expect(() => formatDueDate(INSTANT, 'Not/AZone', NOW)).not.toThrow();
    expect(formatDueDate('garbage', 'Asia/Kolkata', NOW)).toBe('');
  });
});

describe('the details sheet date input reads and writes the workspace-zone day', () => {
  it('reads the stored instant as the workspace day', () => {
    expect(targetDateInputValue(INSTANT, 'Asia/Kolkata')).toBe('2026-10-20');
    expect(targetDateInputValue(INSTANT, 'America/Los_Angeles')).toBe('2026-10-19');
    expect(targetDateInputValue(null, 'Asia/Kolkata')).toBe('');
  });

  it('writes a picked day as an instant that reads back as that day in the zone', () => {
    for (const zone of ['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
      const stored = targetDateFromInput('2026-10-20', zone);
      expect(targetDateInputValue(stored, zone)).toBe('2026-10-20');
      expect(formatDueDate(stored, zone, NOW)).toBe('20 Oct');
    }
  });
});

describe('the due label (flow B 28)', () => {
  it('reads "Due 28 Oct" in the workspace zone, no year in the current year', () => {
    expect(formatDue('2026-10-28T06:30:00.000Z', 'Asia/Kolkata', NOW)).toBe('Due 28 Oct');
    expect(formatDue(INSTANT, 'Asia/Kolkata', NOW)).toBe('Due 20 Oct');
    expect(formatDue(INSTANT, 'America/Los_Angeles', NOW)).toBe('Due 19 Oct');
  });
});
