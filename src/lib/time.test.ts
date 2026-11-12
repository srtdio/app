import { describe, expect, it } from 'vitest';
import {
  civilDay,
  daysFromToday,
  formatAdded,
  formatAgo,
  formatDate,
  formatDateTime,
  formatDateWithYear,
  formatDayLabel,
  formatDayRange,
  formatDue,
  formatDueDate,
  formatOverdue,
  formatPlanStart,
  formatTime,
  rowWhen,
  safeTimeZone,
  threadWhen,
} from '@/lib/time';

// Zones are passed explicitly so the suite is deterministic on any machine.
const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
// Sun 25 Oct 2026, 14:14 IST (01:44 PDT in Los Angeles).
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

// ago(ms): an instant that many milliseconds before NOW (Sun 25 Oct 2026, 14:14 IST).
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('formatAgo: things that just happened', () => {
  it('under a minute is "just now"; a future instant too', () => {
    expect(formatAgo(NOW, NOW, IST)).toBe('just now');
    expect(formatAgo(ago(59 * SEC), NOW, IST)).toBe('just now');
    expect(formatAgo('2026-10-25T09:00:00Z', NOW, IST)).toBe('just now');
  });
  it('minutes: "1m" .. "59m"', () => {
    expect(formatAgo(ago(MIN), NOW, IST)).toBe('1m');
    expect(formatAgo(ago(5 * MIN), NOW, IST)).toBe('5m');
    expect(formatAgo(ago(59 * MIN + 59 * SEC), NOW, IST)).toBe('59m');
  });
  it('hours: "1h" .. "23h" under 24 hours, whatever the civil day', () => {
    expect(formatAgo(ago(HOUR), NOW, IST)).toBe('1h');
    expect(formatAgo(ago(3 * HOUR), NOW, IST)).toBe('3h');
    expect(formatAgo(ago(DAY - MIN), NOW, IST)).toBe('23h');
    expect(formatAgo('2026-10-25T05:44:00Z', NOW, IST)).toBe('3h');
  });
  it('24 hours or more: "Yesterday", the weekday 2-6 days back, then the day', () => {
    expect(formatAgo(ago(DAY), NOW, IST)).toBe('Yesterday');
    expect(formatAgo(ago(2 * DAY), NOW, IST)).toBe('Fri');
    expect(formatAgo(NOW.getTime() - 2 * DAY, NOW, IST)).toBe('Fri');
    expect(formatAgo(ago(30 * DAY), NOW, IST)).toBe('25 Sep');
  });
  it('week boundary: 6 days back is the weekday, 7 days back is the day', () => {
    expect(formatAgo(ago(6 * DAY), NOW, IST)).toBe('Mon');
    expect(formatAgo(ago(7 * DAY), NOW, IST)).toBe('18 Oct');
    // 19 Oct 01:44 PDT and 18 Oct 01:44 PDT in Los Angeles.
    expect(formatAgo(ago(6 * DAY), NOW, LA)).toBe('Mon');
    expect(formatAgo(ago(7 * DAY), NOW, LA)).toBe('18 Oct');
    // 18 Oct 23:00 PDT (19 Oct 11:30 IST): under 7 days elapsed, but 7 civil days back in LA.
    expect(formatAgo('2026-10-19T06:00:00Z', NOW, LA)).toBe('18 Oct');
    expect(formatAgo('2026-10-19T06:00:00Z', NOW, IST)).toBe('Mon');
  });
  it('across midnight in Asia/Kolkata: minutes stay minutes; 24h+ counts civil days', () => {
    // 24 Oct 23:59 IST to 25 Oct 00:01 IST is two minutes, not "Yesterday".
    expect(formatAgo('2026-10-24T18:29:00Z', new Date('2026-10-24T18:31:00Z'), IST)).toBe('2m');
    // 23 Oct 23:00 IST read at 25 Oct 00:30 IST: 25.5 hours, two civil days back.
    expect(formatAgo('2026-10-23T17:30:00Z', new Date('2026-10-24T19:00:00Z'), IST)).toBe('Fri');
  });
  it('across midnight in America/Los_Angeles (UTC is already on the next day)', () => {
    // Now: 6 Nov 00:01 PST. 4 Nov 23:00 PST is two civil days back there, one in UTC.
    const now = new Date('2026-11-06T08:01:00Z');
    expect(formatAgo('2026-11-05T07:00:00Z', now, LA)).toBe('Wed');
    expect(formatAgo('2026-11-05T07:00:00Z', now, 'UTC')).toBe('Yesterday');
  });
  it('the same instant reads by the zone it is handed', () => {
    // 23 Oct 23:00 PDT = 24 Oct 11:30 IST; now is 25 Oct in both.
    expect(formatAgo('2026-10-24T06:00:00Z', NOW, LA)).toBe('Fri');
    expect(formatAgo('2026-10-24T06:00:00Z', NOW, IST)).toBe('Yesterday');
  });
  it('a 25-hour day (Los Angeles falls back on 1 Nov) keeps hours on one civil day', () => {
    // 1 Nov 00:00 PDT to 1 Nov 23:30 PST is 24.5 hours on the same civil day.
    expect(formatAgo('2026-11-01T07:00:00Z', new Date('2026-11-02T07:30:00Z'), LA)).toBe('24h');
  });
  it('across a month end', () => {
    const now = new Date('2026-11-01T10:00:00Z');
    expect(formatAgo('2026-10-31T09:00:00Z', now, 'UTC')).toBe('Yesterday');
    expect(formatAgo('2026-10-26T10:00:00Z', now, 'UTC')).toBe('Mon');
    expect(formatAgo('2026-10-25T10:00:00Z', now, 'UTC')).toBe('25 Oct');
  });
  it("across a year change: the year shows only off now's year", () => {
    const now = new Date('2027-01-01T10:00:00Z');
    expect(formatAgo('2026-12-31T09:00:00Z', now, 'UTC')).toBe('Yesterday');
    expect(formatAgo('2026-12-26T10:00:00Z', now, 'UTC')).toBe('Sat');
    expect(formatAgo('2026-12-25T10:00:00Z', now, 'UTC')).toBe('25 Dec 2026');
    expect(formatAgo('2025-10-24T08:44:00Z', NOW, IST)).toBe('24 Oct 2025');
  });
  it('unparseable is empty', () => {
    expect(formatAgo('', NOW, IST)).toBe('');
    expect(formatAgo('nope', NOW, IST)).toBe('');
  });
});

describe('formatAdded: records, never ticks', () => {
  it('the clock time on the same civil day, else the day', () => {
    expect(formatAdded('2026-10-25T04:57:00Z', NOW, IST)).toBe('10:27 AM');
    expect(formatAdded('2026-10-23T04:57:00Z', NOW, IST)).toBe('23 Oct');
    expect(formatAdded('2026-10-02T04:57:00Z', NOW, IST)).toBe('2 Oct');
  });
  it('never ticks: the same record reads the same all day', () => {
    const later = new Date('2026-10-25T18:00:00Z'); // 23:30 IST
    expect(formatAdded('2026-10-25T04:57:00Z', later, IST)).toBe('10:27 AM');
    expect(formatAdded(ago(MIN), NOW, IST)).toBe('2:13 PM');
  });
  it('across midnight in Asia/Kolkata', () => {
    expect(formatAdded('2026-10-24T18:31:00Z', NOW, IST)).toBe('12:01 AM');
    expect(formatAdded('2026-10-24T18:29:00Z', NOW, IST)).toBe('24 Oct');
  });
  it('across midnight in America/Los_Angeles (now: 25 Oct 01:44 PDT)', () => {
    expect(formatAdded('2026-10-25T07:00:00Z', NOW, LA)).toBe('12:00 AM');
    expect(formatAdded('2026-10-25T06:59:00Z', NOW, LA)).toBe('24 Oct');
    expect(formatAdded('2026-10-25T06:59:00Z', NOW, IST)).toBe('12:29 PM');
  });
  it('across a month end', () => {
    const now = new Date('2026-11-01T10:00:00Z');
    expect(formatAdded('2026-10-31T23:59:00Z', now, 'UTC')).toBe('31 Oct');
    expect(formatAdded('2026-11-01T00:00:00Z', now, 'UTC')).toBe('12:00 AM');
  });
  it('across a year end: an earlier year reads its year', () => {
    const now = new Date('2027-01-01T10:00:00Z');
    expect(formatAdded('2026-12-31T23:59:00Z', now, 'UTC')).toBe('31 Dec 2026');
    expect(formatAdded('2027-01-01T00:00:00Z', now, 'UTC')).toBe('12:00 AM');
  });
  it("across a year change: the year shows only off now's year", () => {
    const now = new Date('2027-01-01T10:00:00Z'); // IST 1 Jan 15:30
    expect(formatAdded('2026-12-31T23:00:00Z', now, 'UTC')).toBe('31 Dec 2026');
    expect(formatAdded('2026-12-31T20:00:00Z', now, IST)).toBe('1:30 AM');
    expect(formatAdded('2026-12-31T18:00:00Z', now, IST)).toBe('31 Dec 2026');
  });
  it('unparseable is empty', () => {
    expect(formatAdded('', NOW, IST)).toBe('');
    expect(formatAdded('nope', NOW, IST)).toBe('');
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
  it('a week back keeps the weekday + day (6 and 7 days alike)', () => {
    expect(formatDayLabel('2026-10-19', NOW, IST)).toBe('Mon 19 Oct');
    expect(formatDayLabel('2026-10-18', NOW, IST)).toBe('Sun 18 Oct');
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
  it('today, tomorrow, the weekday 2-6 days ahead, then the day', () => {
    expect(formatDue('2026-10-25', IST, NOW)).toBe('Today');
    expect(formatDue('2026-10-26', IST, NOW)).toBe('Tomorrow');
    expect(formatDue('2026-10-27', IST, NOW)).toBe('Tue');
    expect(formatDue('2026-10-28', IST, NOW)).toBe('Wed');
    expect(formatDue('2026-12-12', IST, NOW)).toBe('12 Dec');
    expect(formatDue('2027-01-05', IST, NOW)).toBe('5 Jan 2027');
  });
  it('week boundary: 6 days ahead is the weekday, 7 days ahead is the day', () => {
    expect(formatDue('2026-10-31', IST, NOW)).toBe('Sat');
    expect(formatDue('2026-11-01', IST, NOW)).toBe('1 Nov');
  });
  it('a past day reads its date (callers show formatOverdue unless approved)', () => {
    expect(formatDue('2026-10-20', IST, NOW)).toBe('20 Oct');
  });
  it('a stored instant reads its day on the workspace zone', () => {
    // Noon IST on 28 Oct is still 27 Oct 23:30 in Los Angeles.
    expect(formatDue('2026-10-28T06:30:00Z', IST, NOW)).toBe('Wed');
    expect(formatDue('2026-10-28T06:30:00Z', LA, NOW)).toBe('Tue');
  });
  it('across midnight: Los Angeles is still on the 5th, Kolkata on the 6th', () => {
    const beforeLa = new Date('2026-11-06T07:59:00Z'); // 5 Nov 23:59 PST
    const afterLa = new Date('2026-11-06T08:01:00Z'); // 6 Nov 00:01 PST
    expect(formatDue('2026-11-06', LA, beforeLa)).toBe('Tomorrow');
    expect(formatDue('2026-11-06', LA, afterLa)).toBe('Today');
    expect(formatDue('2026-11-06', IST, beforeLa)).toBe('Today');
    expect(formatDue('2026-11-12', LA, beforeLa)).toBe('12 Nov');
    expect(formatDue('2026-11-12', LA, afterLa)).toBe('Thu');
  });
  it('across a month end', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    expect(formatDue('2026-11-01', 'UTC', now)).toBe('Tomorrow');
    expect(formatDue('2026-11-03', 'UTC', now)).toBe('Tue');
    expect(formatDue('2026-11-06', 'UTC', now)).toBe('Fri');
    expect(formatDue('2026-11-07', 'UTC', now)).toBe('7 Nov');
  });
  it("across a year change: the year shows only off now's year in that zone", () => {
    const now = new Date('2026-12-31T20:00:00Z'); // LA 31 Dec 12:00; IST 1 Jan 01:30
    expect(formatDue('2027-01-01', LA, now)).toBe('Tomorrow');
    expect(formatDue('2027-01-01', IST, now)).toBe('Today');
    expect(formatDue('2027-01-02', LA, now)).toBe('Sat');
    expect(formatDue('2027-01-03', IST, now)).toBe('Sun');
    expect(formatDue('2027-02-15', IST, now)).toBe('15 Feb');
    expect(formatDue('2027-02-15', LA, now)).toBe('15 Feb 2027');
  });
  it('unparseable is empty', () => {
    expect(formatDue('nope', IST, NOW)).toBe('');
    expect(formatDue('2026-02-31', IST, NOW)).toBe('');
  });
});

describe('formatOverdue and daysFromToday', () => {
  it('days under a week, then weeks, months, years; singular forms; always bad', () => {
    expect(formatOverdue('2026-10-24', IST, NOW)).toEqual({ text: '1d late', bad: true });
    expect(formatOverdue('2026-10-23', IST, NOW)).toEqual({ text: '2d late', bad: true });
    expect(formatOverdue('2026-10-11', IST, NOW).text).toBe('2w late');
    expect(formatOverdue('2026-09-26', IST, NOW).text).toBe('4w late');
    expect(formatOverdue('2026-09-25', IST, NOW).text).toBe('1mo late');
    expect(formatOverdue('2026-08-26', IST, NOW).text).toBe('1mo late');
    expect(formatOverdue('2026-08-25', IST, NOW).text).toBe('2mo late');
    expect(formatOverdue('2026-05-01', IST, NOW).text).toBe('5mo late');
    expect(formatOverdue('2025-10-26', IST, NOW).text).toBe('11mo late');
    expect(formatOverdue('2025-10-25', IST, NOW).text).toBe('1y late');
    expect(formatOverdue('2024-10-01', IST, NOW).text).toBe('2y late');
  });
  it('week boundary: 6 days late is "6d", 7 days late is "1w"', () => {
    expect(formatOverdue('2026-10-19', IST, NOW).text).toBe('6d late');
    expect(formatOverdue('2026-10-18', IST, NOW).text).toBe('1w late');
  });
  it('never "Overdue", the old "·" form, nor the long "N days"', () => {
    for (const day of ['2026-10-24', '2026-10-12', '2026-09-25', '2026-05-01', 'nope']) {
      expect(formatOverdue(day, IST, NOW).text).not.toContain('·');
      expect(formatOverdue(day, IST, NOW).text).not.toContain('Overdue');
      expect(formatOverdue(day, IST, NOW).text).not.toMatch(/\d+ (day|week|month|year)/);
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
    expect(formatOverdue(due, IST, afterMidnight)).toEqual({ text: '1d late', bad: true });
  });
  it('across midnight in America/Los_Angeles', () => {
    const now = new Date('2026-11-06T08:01:00Z'); // 6 Nov 00:01 PST
    expect(formatOverdue('2026-11-05', LA, now).text).toBe('1d late');
    expect(formatOverdue('2026-10-30', LA, now).text).toBe('1w late');
    expect(formatOverdue('2026-10-31', LA, now).text).toBe('6d late');
  });
  it('across a month end in America/Los_Angeles', () => {
    const now = new Date('2026-11-01T05:00:00Z'); // LA 31 Oct 22:00; UTC 1 Nov
    expect(daysFromToday('2026-10-31', LA, now)).toBe(0);
    expect(daysFromToday('2026-10-31', 'UTC', now)).toBe(-1);
    expect(formatOverdue('2026-10-31', 'UTC', now).text).toBe('1d late');
    expect(formatOverdue('2026-09-30', LA, now).text).toBe('1mo late');
  });
  it('across a year change', () => {
    const now = new Date('2027-01-01T03:00:00Z'); // IST 1 Jan 08:30; LA 31 Dec 19:00
    expect(daysFromToday('2026-12-31', IST, now)).toBe(-1);
    expect(daysFromToday('2026-12-31', LA, now)).toBe(0);
    expect(formatOverdue('2026-12-31', IST, now).text).toBe('1d late');
    expect(formatOverdue('2026-12-25', IST, now).text).toBe('1w late');
    expect(formatOverdue('2026-11-30', IST, now).text).toBe('1mo late');
    expect(formatOverdue('2026-01-01', IST, now).text).toBe('1y late');
  });
  it('daysFromToday: 0 today, 1 tomorrow, -1 yesterday, undefined unparseable', () => {
    expect(daysFromToday('2026-10-25', IST, NOW)).toBe(0);
    expect(daysFromToday('2026-10-26', IST, NOW)).toBe(1);
    expect(daysFromToday('2026-10-24', IST, NOW)).toBe(-1);
    expect(daysFromToday('nope', IST, NOW)).toBeUndefined();
  });
  it('unparseable reads plain "Late"', () => {
    expect(formatOverdue('nope', IST, NOW)).toEqual({ text: 'Late', bad: true });
  });
});

describe('formatPlanStart: plan words on the workspace zone', () => {
  it('up to the start: Today, Tomorrow, the weekday 2-6 days ahead, then the day', () => {
    expect(formatPlanStart('2026-10-25', IST, NOW)).toBe('Today');
    expect(formatPlanStart('2026-10-26', IST, NOW)).toBe('Tomorrow');
    expect(formatPlanStart('2026-10-27', IST, NOW)).toBe('Tue');
    expect(formatPlanStart('2026-10-31', IST, NOW)).toBe('Sat');
    expect(formatPlanStart('2026-11-01', IST, NOW)).toBe('1 Nov');
    expect(formatPlanStart('2026-12-12', IST, NOW)).toBe('12 Dec');
    expect(formatPlanStart('2027-03-01', IST, NOW)).toBe('1 Mar 2027');
  });
  it('started and the end day not passed: "Live"', () => {
    expect(formatPlanStart('2026-10-24', IST, NOW, '2026-10-30')).toBe('Live');
    expect(formatPlanStart('2026-10-19', IST, NOW, '2026-10-25')).toBe('Live');
    expect(formatPlanStart('2026-10-24', IST, NOW)).toBe('Live');
    expect(formatPlanStart('2026-10-24', IST, NOW, null)).toBe('Live');
  });
  it('the end day passed: the end day as a date ("1 Nov"; the year off-year)', () => {
    expect(formatPlanStart('2026-10-12', IST, NOW, '2026-10-18')).toBe('18 Oct');
    expect(formatPlanStart('2026-10-18', IST, NOW, '2026-10-24')).toBe('24 Oct');
    expect(formatPlanStart('2025-12-01', IST, NOW, '2025-12-07')).toBe('7 Dec 2025');
  });
  it('never the old "Starts" / "Started" words', () => {
    for (const day of ['2026-10-25', '2026-10-27', '2026-12-12', '2026-10-24', '2026-09-01']) {
      expect(formatPlanStart(day, IST, NOW, '2026-10-30')).not.toMatch(/Start/);
    }
  });
  it('flips at workspace midnight in America/Los_Angeles and Asia/Kolkata', () => {
    const now = new Date('2026-11-06T07:59:00Z'); // LA 5 Nov 23:59; IST 6 Nov 13:29
    expect(formatPlanStart('2026-11-06', LA, now)).toBe('Tomorrow');
    expect(formatPlanStart('2026-11-06', IST, now)).toBe('Today');
    expect(formatPlanStart('2026-11-05', IST, now, '2026-11-11')).toBe('Live');
    expect(formatPlanStart('2026-11-05', LA, now, '2026-11-11')).toBe('Today');
    expect(formatPlanStart('2026-10-30', IST, now, '2026-11-05')).toBe('5 Nov');
    expect(formatPlanStart('2026-10-30', LA, now, '2026-11-05')).toBe('Live');
  });
  it('across a month end', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    expect(formatPlanStart('2026-11-02', 'UTC', now)).toBe('Mon');
    expect(formatPlanStart('2026-10-30', 'UTC', now, '2026-11-05')).toBe('Live');
  });
  it('across a year change', () => {
    const now = new Date('2026-12-31T20:00:00Z'); // LA 31 Dec; IST 1 Jan 2027
    expect(formatPlanStart('2027-01-01', LA, now)).toBe('Tomorrow');
    expect(formatPlanStart('2027-01-01', IST, now)).toBe('Today');
    expect(formatPlanStart('2026-12-24', IST, now, '2026-12-30')).toBe('30 Dec 2026');
    expect(formatPlanStart('2027-01-07', IST, now)).toBe('Thu');
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

describe('formatDateWithYear: a date field value, short month, always the year', () => {
  it('reads a date-only day as-is, in and off the current year', () => {
    expect(formatDateWithYear('2026-10-25')).toBe('25 Oct 2026');
    expect(formatDateWithYear('2026-10-19')).toBe('19 Oct 2026');
    expect(formatDateWithYear('2027-01-03')).toBe('3 Jan 2027');
  });
  it('reads an instant on the zone', () => {
    // 20:00 UTC on 24 Oct is 01:30 on 25 Oct in Kolkata.
    expect(formatDateWithYear('2026-10-24T20:00:00Z', IST)).toBe('25 Oct 2026');
    expect(formatDateWithYear('2026-10-24T20:00:00Z', NY)).toBe('24 Oct 2026');
  });
  it('a bad value is empty', () => {
    expect(formatDateWithYear('nope')).toBe('');
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
    expect(formatDue(TARGET, IST, NOW)).toBe('Wed');
    // On the device clock a Los Angeles viewer would have seen the 27th; Auckland the 28th.
    expect(formatDate(TARGET, NOW, LA)).toBe('27 Oct');
    expect(formatDate(TARGET, NOW, AKL)).toBe('28 Oct');
    // The workspace zone wins whatever the viewer's zone is.
    expect(civilDay(TARGET, IST)).toBe('2026-10-28');
  });

  it('a null workspace zone degrades to the device zone, never throws', () => {
    expect(formatDueDate('2026-10-28', null, NOW)).toBe('28 Oct');
    // A date-only day 2-6 days ahead reads its own weekday on any zone.
    expect(formatDue('2026-10-28', undefined, NOW)).toBe('Wed');
  });

  it('plan ranges read on the workspace zone', () => {
    // Monday 00:00 IST is still Sunday in UTC.
    expect(formatDayRange('2026-10-18T18:30:00Z', '2026-10-25T06:30:00Z', IST, NOW)).toBe(
      '19\u201325 Oct',
    );
  });
});

describe('threadWhen and rowWhen (9 Nov 2026, thread times)', () => {
  const UTC = 'UTC';
  // Mon 9 Nov 2026, 15:00 UTC.
  const now = new Date('2026-11-09T15:00:00Z');
  it("'date': day, month and time; the year only off now's year", () => {
    expect(threadWhen('2026-10-16T10:09:00Z', 'date', now, UTC)).toBe('16 Oct at 10:09 AM');
    expect(threadWhen('2025-10-16T10:09:00Z', 'date', now, UTC)).toBe('16 Oct 2025 at 10:09 AM');
    expect(threadWhen('2026-11-09T10:12:00Z', 'date', now, UTC)).toBe('9 Nov at 10:12 AM');
  });
  it("'relative': Today, Yesterday, the weekday 2-6 days back, else the date", () => {
    expect(threadWhen('2026-11-09T10:12:00Z', 'relative', now, UTC)).toBe('Today at 10:12 AM');
    expect(threadWhen('2026-11-08T22:05:00Z', 'relative', now, UTC)).toBe('Yesterday at 10:05 PM');
    expect(threadWhen('2026-11-06T09:00:00Z', 'relative', now, UTC)).toBe('Friday at 9:00 AM');
    expect(threadWhen('2026-11-03T09:00:00Z', 'relative', now, UTC)).toBe('Tuesday at 9:00 AM');
    expect(threadWhen('2026-11-02T09:00:00Z', 'relative', now, UTC)).toBe('2 Nov at 9:00 AM');
  });
  it('rowWhen: Today, Yesterday, else the date (no weekday step)', () => {
    expect(rowWhen('2026-11-09T10:12:00Z', now, UTC)).toBe('Today at 10:12 AM');
    expect(rowWhen('2026-11-08T10:12:00Z', now, UTC)).toBe('Yesterday at 10:12 AM');
    expect(rowWhen('2026-11-06T09:00:00Z', now, UTC)).toBe('6 Nov at 9:00 AM');
    expect(rowWhen('2025-12-31T09:00:00Z', now, UTC)).toBe('31 Dec 2025 at 9:00 AM');
  });
  it('midnight: the civil day turns at 00:00, not 24 hours back', () => {
    const justAfter = new Date('2026-11-09T00:01:00Z');
    expect(threadWhen('2026-11-08T23:59:00Z', 'relative', justAfter, UTC)).toBe(
      'Yesterday at 11:59 PM',
    );
    expect(threadWhen('2026-11-09T00:00:00Z', 'relative', justAfter, UTC)).toBe(
      'Today at 12:00 AM',
    );
    expect(rowWhen('2026-11-08T23:59:00Z', justAfter, UTC)).toBe('Yesterday at 11:59 PM');
  });
  it('year boundary: yesterday across 1 Jan is Yesterday; older shows the year', () => {
    const newYear = new Date('2027-01-01T08:00:00Z');
    expect(threadWhen('2026-12-31T21:00:00Z', 'relative', newYear, UTC)).toBe(
      'Yesterday at 9:00 PM',
    );
    expect(threadWhen('2026-12-29T21:00:00Z', 'relative', newYear, UTC)).toBe('Tuesday at 9:00 PM');
    expect(threadWhen('2026-12-20T21:00:00Z', 'relative', newYear, UTC)).toBe(
      '20 Dec 2026 at 9:00 PM',
    );
    expect(threadWhen('2026-12-31T21:00:00Z', 'date', newYear, UTC)).toBe('31 Dec 2026 at 9:00 PM');
  });
  it('time zone: the day and the clock read on the zone', () => {
    // 20:00 UTC on 8 Nov is 01:30 on 9 Nov in Kolkata.
    expect(threadWhen('2026-11-08T20:00:00Z', 'relative', now, IST)).toBe('Today at 1:30 AM');
    expect(threadWhen('2026-11-08T20:00:00Z', 'relative', now, UTC)).toBe('Yesterday at 8:00 PM');
    expect(rowWhen('2026-11-08T20:00:00Z', now, 'America/Los_Angeles')).toBe(
      'Yesterday at 12:00 PM',
    );
  });
  it('a bad value is empty', () => {
    expect(threadWhen('nope', 'date', now, UTC)).toBe('');
    expect(rowWhen('nope', now, UTC)).toBe('');
  });
});
