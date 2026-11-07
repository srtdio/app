import { describe, expect, it } from 'vitest';
import {
  civilDay,
  daysFromToday,
  formatDate,
  formatDateTime,
  formatDayLabel,
  formatDayRange,
  formatDue,
  formatDueDate,
  formatOverdue,
  formatPlanStart,
  formatRelative,
  formatTime,
  safeTimeZone,
} from '@/lib/time';

// Zones are passed explicitly so the suite is deterministic on any machine.
const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
// 25 Oct 2026, 14:14 IST.
const NOW = new Date('2026-10-25T08:44:00Z');

describe('formatTime', () => {
  it('12-hour clock, uppercase period', () => {
    expect(formatTime('2026-10-25T08:44:00Z', IST)).toBe('2:14 PM');
    expect(formatTime('2026-10-25T00:05:00Z', 'UTC')).toBe('12:05 AM');
  });
  it('unparseable is empty', () => {
    expect(formatTime('nope', IST)).toBe('');
  });
});

// ago(ms): an instant that many milliseconds before NOW.
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('formatRelative: THE past-time format', () => {
  it('under a minute is "just now"', () => {
    expect(formatRelative(NOW, NOW)).toBe('just now');
    expect(formatRelative(ago(59 * SEC), NOW)).toBe('just now');
  });
  it('minutes: "1 min ago" .. "59 min ago" (min never pluralises)', () => {
    expect(formatRelative(ago(MIN), NOW)).toBe('1 min ago');
    expect(formatRelative(ago(5 * MIN), NOW)).toBe('5 min ago');
    expect(formatRelative(ago(59 * MIN + 59 * SEC), NOW)).toBe('59 min ago');
  });
  it('hours, singular and plural', () => {
    expect(formatRelative(ago(HOUR), NOW)).toBe('1 hour ago');
    expect(formatRelative(ago(3 * HOUR), NOW)).toBe('3 hours ago');
    expect(formatRelative(ago(DAY - MIN), NOW)).toBe('23 hours ago');
  });
  it('days under 30, singular and plural', () => {
    expect(formatRelative(ago(DAY), NOW)).toBe('1 day ago');
    expect(formatRelative(ago(2 * DAY), NOW)).toBe('2 days ago');
    expect(formatRelative(ago(29 * DAY), NOW)).toBe('29 days ago');
  });
  it('months under a year, singular and plural, never "12 months"', () => {
    expect(formatRelative(ago(30 * DAY), NOW)).toBe('1 month ago');
    expect(formatRelative(ago(4 * 30 * DAY), NOW)).toBe('4 months ago');
    expect(formatRelative(ago(364 * DAY), NOW)).toBe('11 months ago');
  });
  it('years, singular and plural', () => {
    expect(formatRelative(ago(365 * DAY), NOW)).toBe('1 year ago');
    expect(formatRelative(ago(2 * 365 * DAY), NOW)).toBe('2 years ago');
  });
  it('takes ISO strings and epoch ms; a future instant reads "just now"', () => {
    expect(formatRelative('2026-10-25T05:44:00Z', NOW)).toBe('3 hours ago');
    expect(formatRelative(NOW.getTime() - 2 * DAY, NOW)).toBe('2 days ago');
    expect(formatRelative('2026-10-25T09:00:00Z', NOW)).toBe('just now');
  });
  it('is zone-free: an elapsed time reads the same across midnight, month end and year change', () => {
    // 23:59 IST on 24 Oct to 00:01 IST on 25 Oct is two minutes, not "yesterday".
    expect(formatRelative('2026-10-24T18:29:00Z', new Date('2026-10-24T18:31:00Z'))).toBe(
      '2 min ago',
    );
    expect(formatRelative('2026-10-31T23:00:00Z', new Date('2026-11-01T01:00:00Z'))).toBe(
      '2 hours ago',
    );
    expect(formatRelative('2026-12-31T22:00:00Z', new Date('2027-01-01T02:00:00Z'))).toBe(
      '4 hours ago',
    );
  });
  it('unparseable is empty', () => {
    expect(formatRelative('', NOW)).toBe('');
    expect(formatRelative('nope', NOW)).toBe('');
  });
});

describe('formatDayLabel: chat day dividers only', () => {
  it('"Today", "Yesterday", then weekday + day, the year only off the current year', () => {
    expect(formatDayLabel('2026-10-25T08:44:00Z', NOW, IST)).toBe('Today');
    // 24 Oct 23:59 IST.
    expect(formatDayLabel('2026-10-24T18:29:00Z', NOW, IST)).toBe('Yesterday');
    expect(formatDayLabel('2026-10-21', NOW, IST)).toBe('Wed 21 Oct');
    expect(formatDayLabel('2026-10-02', NOW, IST)).toBe('Fri 2 Oct');
    expect(formatDayLabel('2025-12-31', NOW, IST)).toBe('Wed 31 Dec 2025');
  });
  it('a date-only key for today is "Today" on any zone', () => {
    expect(formatDayLabel('2026-10-25', NOW, IST)).toBe('Today');
  });
  it('across midnight in America/Los_Angeles (UTC is already on the next day)', () => {
    // Now: 6 Nov 00:01 PST = 6 Nov 08:01Z. 5 Nov 23:59 PST = 6 Nov 07:59Z.
    const now = new Date('2026-11-06T08:01:00Z');
    expect(formatDayLabel('2026-11-06T07:59:00Z', now, LA)).toBe('Yesterday');
    expect(formatDayLabel('2026-11-06T08:01:00Z', now, LA)).toBe('Today');
    expect(formatDayLabel('2026-11-06T07:59:00Z', now, 'UTC')).toBe('Today');
  });
  it('across midnight in Asia/Kolkata (UTC is still on the same day)', () => {
    // Now: 6 Nov 00:01 IST = 5 Nov 18:31Z. 5 Nov 23:59 IST = 5 Nov 18:29Z.
    const now = new Date('2026-11-05T18:31:00Z');
    expect(formatDayLabel('2026-11-05T18:29:00Z', now, IST)).toBe('Yesterday');
    expect(formatDayLabel('2026-11-05T18:29:00Z', now, 'UTC')).toBe('Today');
    expect(formatDayLabel('2026-11-04T18:29:00Z', now, IST)).toBe('Wed 4 Nov');
  });
  it('across a month end', () => {
    const now = new Date('2026-11-01T10:00:00Z');
    expect(formatDayLabel('2026-10-31T10:00:00Z', now, 'UTC')).toBe('Yesterday');
    expect(formatDayLabel('2026-10-30T10:00:00Z', now, 'UTC')).toBe('Fri 30 Oct');
  });
  it('across a year change', () => {
    const now = new Date('2027-01-01T10:00:00Z');
    expect(formatDayLabel('2026-12-31T10:00:00Z', now, 'UTC')).toBe('Yesterday');
    expect(formatDayLabel('2026-12-30T10:00:00Z', now, 'UTC')).toBe('Wed 30 Dec 2026');
    // 31 Dec 20:00Z is already 1 Jan 01:30 in Kolkata: today there.
    expect(formatDayLabel('2026-12-31T20:00:00Z', now, IST)).toBe('Today');
  });
  it('invalid input is empty; a day the month lacks is not rolled over', () => {
    expect(formatDayLabel('', NOW, IST)).toBe('');
    expect(formatDayLabel('2026-02-31', NOW, IST)).toBe('');
  });
});

describe('formatDue: a due day on the workspace zone', () => {
  it('today, tomorrow, in N days (under 30), then the day', () => {
    expect(formatDue('2026-10-25', IST, NOW)).toBe('Due today');
    expect(formatDue('2026-10-26', IST, NOW)).toBe('Due tomorrow');
    expect(formatDue('2026-10-28', IST, NOW)).toBe('Due in 3 days');
    expect(formatDue('2026-11-23', IST, NOW)).toBe('Due in 29 days');
    expect(formatDue('2026-11-24', IST, NOW)).toBe('Due 24 Nov');
    expect(formatDue('2026-12-12', IST, NOW)).toBe('Due 12 Dec');
    expect(formatDue('2027-01-05', IST, NOW)).toBe('Due 5 Jan 2027');
  });
  it('a past day reads its date (callers show formatOverdue unless approved)', () => {
    expect(formatDue('2026-10-20', IST, NOW)).toBe('Due 20 Oct');
  });
  it('a stored instant reads its day on the workspace zone', () => {
    // Noon IST on 28 Oct is still 27 Oct 23:30 in Los Angeles.
    expect(formatDue('2026-10-28T06:30:00Z', IST, NOW)).toBe('Due in 3 days');
    expect(formatDue('2026-10-28T06:30:00Z', LA, NOW)).toBe('Due in 2 days');
  });
  it('across midnight: Los Angeles is still on the 5th, Kolkata on the 6th', () => {
    const beforeLa = new Date('2026-11-06T07:59:00Z'); // 5 Nov 23:59 PST
    const afterLa = new Date('2026-11-06T08:01:00Z'); // 6 Nov 00:01 PST
    expect(formatDue('2026-11-06', LA, beforeLa)).toBe('Due tomorrow');
    expect(formatDue('2026-11-06', LA, afterLa)).toBe('Due today');
    expect(formatDue('2026-11-06', IST, beforeLa)).toBe('Due today');
  });
  it('across a month end', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    expect(formatDue('2026-11-01', 'UTC', now)).toBe('Due tomorrow');
    expect(formatDue('2026-11-03', 'UTC', now)).toBe('Due in 3 days');
  });
  it("across a year change: the year shows only off now's year in that zone", () => {
    const now = new Date('2026-12-31T20:00:00Z'); // LA 31 Dec 12:00; IST 1 Jan 01:30
    expect(formatDue('2027-01-01', LA, now)).toBe('Due tomorrow');
    expect(formatDue('2027-01-01', IST, now)).toBe('Due today');
    expect(formatDue('2027-02-15', IST, now)).toBe('Due 15 Feb');
    expect(formatDue('2027-02-15', LA, now)).toBe('Due 15 Feb 2027');
  });
  it('unparseable is empty', () => {
    expect(formatDue('nope', IST, NOW)).toBe('');
    expect(formatDue('2026-02-31', IST, NOW)).toBe('');
  });
});

describe('formatOverdue and daysFromToday', () => {
  it('days under 30, then months, then years; singular and plural; always bad', () => {
    expect(formatOverdue('2026-10-24', IST, NOW)).toEqual({ text: 'Overdue 1 day', bad: true });
    expect(formatOverdue('2026-10-23', IST, NOW)).toEqual({ text: 'Overdue 2 days', bad: true });
    expect(formatOverdue('2026-09-26', IST, NOW).text).toBe('Overdue 29 days');
    expect(formatOverdue('2026-09-25', IST, NOW).text).toBe('Overdue 1 month');
    expect(formatOverdue('2026-08-26', IST, NOW).text).toBe('Overdue 1 month');
    expect(formatOverdue('2026-08-25', IST, NOW).text).toBe('Overdue 2 months');
    expect(formatOverdue('2026-05-01', IST, NOW).text).toBe('Overdue 5 months');
    expect(formatOverdue('2025-10-25', IST, NOW).text).toBe('Overdue 1 year');
    expect(formatOverdue('2024-10-01', IST, NOW).text).toBe('Overdue 2 years');
  });
  it('never the old "Overdue ·" form', () => {
    for (const day of ['2026-10-24', '2026-10-12', '2026-09-25', '2026-05-01', 'nope']) {
      expect(formatOverdue(day, IST, NOW).text).not.toContain('·');
    }
  });
  it("flips at the workspace's midnight (Asia/Kolkata), not the viewer's", () => {
    const due = '2026-10-24T06:30:00Z'; // noon IST, 24 Oct
    const beforeMidnight = new Date('2026-10-24T18:29:00Z'); // 23:59 IST
    const afterMidnight = new Date('2026-10-24T18:30:00Z'); // 00:00 IST, 25 Oct
    expect(daysFromToday(due, IST, beforeMidnight)).toBe(0);
    expect(daysFromToday(due, IST, afterMidnight)).toBe(-1);
    // A Los Angeles viewer's own clock is still on the 24th; the workspace rule holds anyway.
    expect(civilDay(afterMidnight, LA)).toBe('2026-10-24');
    expect(formatOverdue(due, IST, afterMidnight)).toEqual({ text: 'Overdue 1 day', bad: true });
  });
  it('across a month end in America/Los_Angeles', () => {
    const now = new Date('2026-11-01T05:00:00Z'); // LA 31 Oct 22:00; UTC 1 Nov
    expect(daysFromToday('2026-10-31', LA, now)).toBe(0);
    expect(daysFromToday('2026-10-31', 'UTC', now)).toBe(-1);
    expect(formatOverdue('2026-10-31', 'UTC', now).text).toBe('Overdue 1 day');
  });
  it('across a year change', () => {
    const now = new Date('2027-01-01T03:00:00Z'); // IST 1 Jan 08:30; LA 31 Dec 19:00
    expect(daysFromToday('2026-12-31', IST, now)).toBe(-1);
    expect(daysFromToday('2026-12-31', LA, now)).toBe(0);
    expect(formatOverdue('2026-12-31', IST, now).text).toBe('Overdue 1 day');
    expect(formatOverdue('2026-11-30', IST, now).text).toBe('Overdue 1 month');
  });
  it('daysFromToday: 0 today, 1 tomorrow, -1 yesterday, undefined unparseable', () => {
    expect(daysFromToday('2026-10-25', IST, NOW)).toBe(0);
    expect(daysFromToday('2026-10-26', IST, NOW)).toBe(1);
    expect(daysFromToday('2026-10-24', IST, NOW)).toBe(-1);
    expect(daysFromToday('nope', IST, NOW)).toBeUndefined();
  });
  it('unparseable reads plain "Overdue"', () => {
    expect(formatOverdue('nope', IST, NOW)).toEqual({ text: 'Overdue', bad: true });
  });
});

describe('formatPlanStart', () => {
  it('ahead: today, tomorrow, in N days, then the day', () => {
    expect(formatPlanStart('2026-10-25', IST, NOW)).toBe('Starts today');
    expect(formatPlanStart('2026-10-26', IST, NOW)).toBe('Starts tomorrow');
    expect(formatPlanStart('2026-11-03', IST, NOW)).toBe('Starts in 9 days');
    expect(formatPlanStart('2026-12-12', IST, NOW)).toBe('Starts 12 Dec');
    expect(formatPlanStart('2027-03-01', IST, NOW)).toBe('Starts 1 Mar 2027');
  });
  it('behind: "Started N days/months/years ago", singular and plural', () => {
    expect(formatPlanStart('2026-10-24', IST, NOW)).toBe('Started 1 day ago');
    expect(formatPlanStart('2026-10-22', IST, NOW)).toBe('Started 3 days ago');
    expect(formatPlanStart('2026-09-25', IST, NOW)).toBe('Started 1 month ago');
    expect(formatPlanStart('2026-08-20', IST, NOW)).toBe('Started 2 months ago');
    expect(formatPlanStart('2025-09-01', IST, NOW)).toBe('Started 1 year ago');
  });
  it('across midnight in America/Los_Angeles and Asia/Kolkata', () => {
    const now = new Date('2026-11-06T07:59:00Z'); // LA 5 Nov 23:59; IST 6 Nov 13:29
    expect(formatPlanStart('2026-11-06', LA, now)).toBe('Starts tomorrow');
    expect(formatPlanStart('2026-11-06', IST, now)).toBe('Starts today');
    expect(formatPlanStart('2026-11-05', IST, now)).toBe('Started 1 day ago');
  });
  it('across a year change', () => {
    const now = new Date('2026-12-31T20:00:00Z'); // LA 31 Dec; IST 1 Jan 2027
    expect(formatPlanStart('2027-01-01', LA, now)).toBe('Starts tomorrow');
    expect(formatPlanStart('2027-01-01', IST, now)).toBe('Starts today');
    expect(formatPlanStart('2026-12-30', IST, now)).toBe('Started 2 days ago');
  });
  it('unparseable is empty', () => {
    expect(formatPlanStart('nope', IST, NOW)).toBe('');
  });
});

describe('formatDateTime', () => {
  it('current year has no year', () => {
    expect(formatDateTime('2026-10-23T08:44:00Z', NOW, IST)).toBe('23 Oct, 2:14 PM');
  });
  it('other years carry the year', () => {
    expect(formatDateTime('2025-10-23T08:44:00Z', NOW, IST)).toBe('23 Oct 2025, 2:14 PM');
  });
  it('non-IST zone', () => {
    expect(formatDateTime('2026-10-23T08:44:00Z', NOW, NY)).toBe('23 Oct, 4:44 AM');
  });
});

describe('formatDate', () => {
  it('current and other year', () => {
    expect(formatDate('2026-10-23T08:44:00Z', NOW, IST)).toBe('23 Oct');
    expect(formatDate('2025-10-23T08:44:00Z', NOW, IST)).toBe('23 Oct 2025');
  });
  it('a date-only value is never shifted by the zone', () => {
    expect(formatDate('2026-10-23', NOW, NY)).toBe('23 Oct');
    expect(formatDate('2026-10-23', NOW, 'Pacific/Kiritimati')).toBe('23 Oct');
  });
  it('year boundary reads against now in the zone', () => {
    // 31 Dec 2026 20:00 New York is already 1 Jan 2027 in IST.
    const now = new Date('2027-01-01T01:00:00Z');
    expect(formatDate('2026-12-30T12:00:00Z', now, NY)).toBe('30 Dec');
    expect(formatDate('2026-12-30T12:00:00Z', now, IST)).toBe('30 Dec 2026');
  });
});

describe('formatDayRange', () => {
  it('same month and across months', () => {
    expect(formatDayRange('2026-10-19', '2026-10-25', IST, NOW)).toBe('19\u201325 Oct');
    expect(formatDayRange('2026-10-28', '2026-11-03', IST, NOW)).toBe('28 Oct \u2013 3 Nov');
  });
  it('years appear off the current year', () => {
    expect(formatDayRange('2025-10-19', '2025-10-25', IST, NOW)).toBe('19\u201325 Oct 2025');
    expect(formatDayRange('2026-12-28', '2027-01-03', IST, NOW)).toBe(
      '28 Dec 2026 \u2013 3 Jan 2027',
    );
  });
});

describe('formatDayRange: one formatter, no "to" or "-"', () => {
  it('one day reads as the day', () => {
    expect(formatDayRange('2026-10-12', '2026-10-12', IST, NOW)).toBe('12 Oct');
  });
  it('never uses "to" or a hyphen', () => {
    for (const [a, b] of [
      ['2026-10-12', '2026-10-18'],
      ['2026-03-28', '2026-04-03'],
      ['2026-12-28', '2027-01-03'],
    ] as const) {
      const range = formatDayRange(a, b, IST, NOW);
      expect(range).not.toMatch(/ to | - /);
      expect(range).toContain('\u2013');
    }
  });
  it('across months spaces the dash', () => {
    expect(formatDayRange('2026-03-28', '2026-04-03', IST, NOW)).toBe('28 Mar \u2013 3 Apr');
  });
});

describe('zones', () => {
  it('a blank or unknown zone falls back to the device zone', () => {
    expect(safeTimeZone('Not/AZone')).toBe(safeTimeZone(undefined));
    expect(safeTimeZone(IST)).toBe(IST);
  });
  it('civilDay', () => {
    expect(civilDay('2026-10-24T18:30:00Z', IST)).toBe('2026-10-25');
    expect(civilDay('2026-10-24T18:30:00Z', NY)).toBe('2026-10-24');
    expect(civilDay('2026-10-24')).toBe('2026-10-24');
  });
});

describe('due dates are calendar days on the workspace zone', () => {
  const AKL = 'Pacific/Auckland';
  // posts.target_date as stored for a workspace in IST: noon IST on 28 Oct.
  const TARGET = '2026-10-28T06:30:00Z';

  it('a noon-IST target date reads 28 Oct for every viewer', () => {
    expect(formatDueDate(TARGET, IST, NOW)).toBe('28 Oct');
    expect(formatDue(TARGET, IST, NOW)).toBe('Due in 3 days');
    // On the device clock a Los Angeles viewer would have seen the 27th; Auckland the 28th.
    expect(formatDate(TARGET, NOW, LA)).toBe('27 Oct');
    expect(formatDate(TARGET, NOW, AKL)).toBe('28 Oct');
    // The workspace zone wins whatever the viewer's zone is.
    expect(civilDay(TARGET, IST)).toBe('2026-10-28');
  });

  it('a null workspace zone degrades to the device zone, never throws', () => {
    expect(formatDueDate('2026-10-28', null, NOW)).toBe('28 Oct');
    expect(formatDue('2026-10-28', undefined, NOW)).toMatch(/^Due in \d+ days$/);
  });

  it('plan ranges read on the workspace zone', () => {
    // Monday 00:00 IST is still Sunday in UTC.
    expect(formatDayRange('2026-10-18T18:30:00Z', '2026-10-25T06:30:00Z', IST, NOW)).toBe(
      '19\u201325 Oct',
    );
  });
});
