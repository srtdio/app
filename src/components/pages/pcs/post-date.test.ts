// The browser is in Los Angeles for this file. Display reads the viewer's
// device clock (src/lib/time.ts); the zone argument pins it here, and the
// details sheet's date input still round-trips the WORKSPACE zone's day (FB8).
// TZ is set before any Date work; the assertions pass every zone explicitly.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { targetDateFromInput, targetDateInputValue } from '@/components/pages/pcs/post-date';
import { formatDate, formatDue } from '@/lib/time';

// 02:30 UTC on 20 Oct: still 19 Oct in Los Angeles, already 20 Oct in Mumbai.
const INSTANT = '2026-10-20T02:30:00.000Z';
const NOW = new Date('2026-10-23T12:00:00Z');

describe('post target date display', () => {
  it('renders the day in the given zone for a browser in America/Los_Angeles', () => {
    expect(formatDate(INSTANT, NOW, 'Asia/Kolkata')).toBe('20 Oct');
    // The same instant read on the browser's own clock is a day earlier.
    expect(formatDate(INSTANT, NOW, 'America/Los_Angeles')).toBe('19 Oct');
  });

  it('adds the year outside the current year and never throws on a bad zone', () => {
    expect(formatDate('2027-01-05T12:00:00.000Z', NOW, 'UTC')).toBe('5 Jan 2027');
    expect(() => formatDate(INSTANT, NOW, 'Not/AZone')).not.toThrow();
    expect(formatDate('garbage', NOW, 'Asia/Kolkata')).toBe('');
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
      expect(formatDate(stored, NOW, zone)).toBe('20 Oct');
    }
  });
});

describe('the due label (flow B 28)', () => {
  it('reads "Due 28 Oct" in the given zone, no year in the current year', () => {
    expect(formatDue('2026-10-28T06:30:00.000Z', NOW, 'Asia/Kolkata')).toBe('Due 28 Oct');
    expect(formatDue(INSTANT, NOW, 'Asia/Kolkata')).toBe('Due 20 Oct');
    expect(formatDue(INSTANT, NOW, 'America/Los_Angeles')).toBe('Due 19 Oct');
  });
});
