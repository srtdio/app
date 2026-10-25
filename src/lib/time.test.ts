import { describe, expect, it } from 'vitest';
import {
  civilDay,
  formatChatTime,
  formatDate,
  formatDateTime,
  formatDayRange,
  formatDue,
  formatDueDate,
  formatOverdue,
  formatRelative,
  formatTime,
  safeTimeZone,
} from '@/lib/time';

// Zones are passed explicitly so the suite is deterministic on any machine.
const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
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

describe('formatChatTime', () => {
  it('today is the clock time', () => {
    expect(formatChatTime('2026-10-25T08:44:00Z', NOW, IST)).toBe('2:14 PM');
  });
  it('yesterday, including just before midnight', () => {
    // 24 Oct 23:59 IST.
    expect(formatChatTime('2026-10-24T18:29:00Z', NOW, IST)).toBe('Yesterday');
    // 25 Oct 00:00 IST is today.
    expect(formatChatTime('2026-10-24T18:30:00Z', NOW, IST)).toBe('12:00 AM');
  });
  it('this year and older', () => {
    expect(formatChatTime('2026-10-20T06:00:00Z', NOW, IST)).toBe('20 Oct');
    expect(formatChatTime('2025-10-20T06:00:00Z', NOW, IST)).toBe('20 Oct 2025');
  });
  it('yesterday across a year boundary', () => {
    const jan1 = new Date('2027-01-01T10:00:00Z');
    expect(formatChatTime('2026-12-31T10:00:00Z', jan1, 'UTC')).toBe('Yesterday');
    expect(formatChatTime('2026-12-30T10:00:00Z', jan1, 'UTC')).toBe('30 Dec 2026');
  });
  it('reads the day in a non-IST zone', () => {
    // 04:44 New York on 25 Oct is today there; 03:00Z is 24 Oct 23:00 there.
    expect(formatChatTime('2026-10-25T08:44:00Z', NOW, NY)).toBe('4:44 AM');
    expect(formatChatTime('2026-10-25T03:00:00Z', NOW, NY)).toBe('Yesterday');
  });
});

describe('formatRelative', () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  it('each unit', () => {
    expect(formatRelative(ago(20 * 1000), NOW)).toBe('just now');
    expect(formatRelative(new Date(NOW.getTime() + 60_000), NOW)).toBe('just now');
    expect(formatRelative(ago(5 * 60_000), NOW)).toBe('5 min ago');
    expect(formatRelative(ago(3600_000), NOW)).toBe('1 hour ago');
    expect(formatRelative(ago(3 * 3600_000), NOW)).toBe('3 hours ago');
    expect(formatRelative(ago(2 * 86400_000), NOW)).toBe('2 days ago');
    expect(formatRelative(ago(125 * 86400_000), NOW)).toBe('4 months ago');
    expect(formatRelative(ago(800 * 86400_000), NOW)).toBe('2 years ago');
  });
  it('unparseable is empty', () => {
    expect(formatRelative('nope', NOW)).toBe('');
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
    expect(formatDayRange('2026-10-19', '2026-10-25', IST, NOW)).toBe('19 - 25 Oct');
    expect(formatDayRange('2026-10-28', '2026-11-03', IST, NOW)).toBe('28 Oct - 3 Nov');
  });
  it('years appear off the current year', () => {
    expect(formatDayRange('2025-10-19', '2025-10-25', IST, NOW)).toBe('19 - 25 Oct 2025');
    expect(formatDayRange('2026-12-28', '2027-01-03', IST, NOW)).toBe('28 Dec 2026 - 3 Jan 2027');
  });
});

describe('due and overdue', () => {
  it('formatDue', () => {
    expect(formatDue('2026-10-30', IST, NOW)).toBe('Due 30 Oct');
    expect(formatDue('nope', IST, NOW)).toBe('');
  });
  it('formatOverdue keeps the post-flow rules', () => {
    expect(formatOverdue('2026-10-12', IST, NOW)).toEqual({ text: 'Overdue · 12 Oct', bad: true });
    expect(formatOverdue('2026-09-25', IST, NOW)).toEqual({ text: 'Overdue · 25 Sep', bad: true });
    expect(formatOverdue('2026-09-24', IST, NOW)).toEqual({ text: 'Overdue 1 month', bad: true });
    expect(formatOverdue('2026-05-01', IST, NOW)).toEqual({ text: 'Overdue 5 months', bad: true });
    expect(formatOverdue('nope', IST, NOW)).toEqual({ text: 'Overdue', bad: true });
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
  const LA = 'America/Los_Angeles';
  const AKL = 'Pacific/Auckland';
  // posts.target_date as stored for a workspace in IST: noon IST on 28 Oct.
  const TARGET = '2026-10-28T06:30:00Z';

  it('a noon-IST target date reads 28 Oct for every viewer', () => {
    expect(formatDueDate(TARGET, IST, NOW)).toBe('28 Oct');
    expect(formatDue(TARGET, IST, NOW)).toBe('Due 28 Oct');
    // On the device clock a Los Angeles viewer would have seen the 27th; Auckland the 28th.
    expect(formatDate(TARGET, NOW, LA)).toBe('27 Oct');
    expect(formatDate(TARGET, NOW, AKL)).toBe('28 Oct');
    // The workspace zone wins whatever the viewer's zone is.
    expect(civilDay(TARGET, IST)).toBe('2026-10-28');
  });

  it('a null workspace zone degrades to the device zone, never throws', () => {
    expect(formatDueDate('2026-10-28', null, NOW)).toBe('28 Oct');
    expect(formatDue('2026-10-28', undefined, NOW)).toBe('Due 28 Oct');
  });

  it("overdue flips on the workspace's midnight, not the viewer's", () => {
    const due = '2026-10-24T06:30:00Z'; // noon IST, 24 Oct
    const beforeMidnight = new Date('2026-10-24T18:29:00Z'); // 23:59 IST
    const afterMidnight = new Date('2026-10-24T18:30:00Z'); // 00:00 IST, 25 Oct
    expect(civilDay(beforeMidnight, IST) > civilDay(due, IST)).toBe(false);
    expect(civilDay(afterMidnight, IST) > civilDay(due, IST)).toBe(true);
    // A Los Angeles viewer's own clock is still on the 24th; the workspace rule holds anyway.
    expect(civilDay(afterMidnight, LA)).toBe('2026-10-24');
    expect(formatOverdue(due, IST, afterMidnight)).toEqual({ text: 'Overdue · 24 Oct', bad: true });
  });

  it('plan ranges read on the workspace zone', () => {
    // Monday 00:00 IST is still Sunday in UTC.
    expect(formatDayRange('2026-10-18T18:30:00Z', '2026-10-25T06:30:00Z', IST, NOW)).toBe(
      '19 - 25 Oct',
    );
  });
});
