// The browser is in Los Angeles for this file: a post date must still read as
// the WORKSPACE zone's day (FB8). TZ is set before any Date work; Node honours
// a runtime change, and the assertions below do not depend on it taking (the
// "browser" reading is produced explicitly with the LA zone).
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import {
  formatPostTargetDate,
  targetDateFromInput,
  targetDateInputValue,
} from '@/components/pages/pcs/post-date';

// 02:30 UTC on 20 Oct: still 19 Oct in Los Angeles, already 20 Oct in Mumbai.
const INSTANT = '2026-10-20T02:30:00.000Z';

describe('formatPostTargetDate', () => {
  it('renders the workspace-zone day for a browser in America/Los_Angeles', () => {
    expect(formatPostTargetDate(INSTANT, 'Asia/Kolkata')).toBe('Oct 20, 2026');
    // The same instant read on the browser's own clock is a day earlier: the
    // page never shows that.
    expect(formatPostTargetDate(INSTANT, 'America/Los_Angeles')).toBe('Oct 19, 2026');
    expect(formatPostTargetDate(INSTANT, 'Asia/Kolkata')).not.toBe(
      formatPostTargetDate(INSTANT, 'America/Los_Angeles'),
    );
  });

  it('is locale-stable and degrades a bad zone to a day, never a throw', () => {
    expect(formatPostTargetDate('2026-01-05T12:00:00.000Z', 'UTC')).toBe('Jan 5, 2026');
    expect(() => formatPostTargetDate(INSTANT, 'Not/AZone')).not.toThrow();
    expect(formatPostTargetDate('garbage', 'Asia/Kolkata')).toBe('garbage');
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
      expect(formatPostTargetDate(stored, zone)).toBe('Oct 20, 2026');
    }
  });
});
