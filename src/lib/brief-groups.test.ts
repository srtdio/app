import { describe, expect, it } from 'vitest';
import { formatRaisedDay, groupBriefsByDay, groupBriefsByTime } from '@/lib/brief-groups';

// The workspace calendar every case is read on: Mumbai, weeks opening Monday.
// Passing it explicitly is the point of the change - nothing below depends on
// the machine's timezone, so the suite reads identically on any runner.
const ZONE = 'Asia/Kolkata';
const CAL = { timeZone: ZONE, weekStartDay: 1 };

// A fixed "now": Wednesday 2026-07-08, 12:00 in Asia/Kolkata. Its week opens
// Monday 2026-07-06; the previous week opens Monday 2026-06-29 and closes Sunday
// 2026-07-05.
const NOW = new Date('2026-07-08T12:00:00+05:30');

// Build a created_at from WORKSPACE wall-clock parts: the offset is written into
// the string, so the instant is fixed and reads back as that same civil day in
// Asia/Kolkata whatever zone the test process runs in.
function at(civil: string, time = '12:00'): { created_at: string } {
  return { created_at: `${civil}T${time}:00+05:30` };
}

function labels(now: Date, items: { created_at: string }[]): string[] {
  return groupBriefsByTime(items, now, CAL).map((g) => g.label);
}

describe('groupBriefsByTime', () => {
  it('returns no sections for empty input', () => {
    expect(groupBriefsByTime([], NOW, CAL)).toEqual([]);
  });

  it('puts the Monday that opens the week in This Week and the prior Sunday in Last Week', () => {
    const monday = { ...at('2026-07-06', '00:00'), id: 'mon' };
    const sunday = { ...at('2026-07-05', '23:00'), id: 'sun' };
    const groups = groupBriefsByTime([sunday, monday], NOW, CAL);
    expect(groups.map((g) => g.label)).toEqual(['This Week', 'Last Week']);
    expect(groups[0]!.key).toBe('w0');
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['mon']);
    expect(groups[1]!.key).toBe('w1');
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['sun']);
  });

  it('keeps this-week and last-week edges in their own sections', () => {
    const items = [
      at('2026-07-08'), // Wed, this week
      at('2026-07-06'), // Mon, this week (edge)
      at('2026-07-05'), // Sun, last week (edge)
      at('2026-06-29'), // Mon, last week (edge, opens prev week)
    ];
    expect(labels(NOW, items)).toEqual(['This Week', 'Last Week']);
    const groups = groupBriefsByTime(items, NOW, CAL);
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[1]!.items).toHaveLength(2);
  });

  it('lets Last Week span a month boundary (late June and early July together)', () => {
    const items = [at('2026-07-01'), at('2026-06-30'), at('2026-06-29')];
    const groups = groupBriefsByTime(items, NOW, CAL);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Last Week');
    expect(groups[0]!.items).toHaveLength(3);
  });

  it('orders calendar months newest-first below the week sections', () => {
    const items = [
      at('2026-04-10'), // April
      at('2026-07-08'), // this week
      at('2026-05-20'), // May
      at('2026-06-10'), // June (before the last-week window)
    ];
    const groups = groupBriefsByTime(items, NOW, CAL);
    expect(groups.map((g) => g.label)).toEqual(['This Week', 'June', 'May', 'April']);
    expect(groups.map((g) => g.key)).toEqual(['w0', 'm-2026-06', 'm-2026-05', 'm-2026-04']);
  });

  it("appends the year only when a month is not in now's year", () => {
    const items = [
      at('2026-06-10'), // June 2026 (same year, no suffix)
      at('2025-12-15'), // December 2025 (prior year, suffix)
      at('2025-01-05'), // January 2025 (prior year, suffix)
    ];
    const groups = groupBriefsByTime(items, NOW, CAL);
    expect(groups.map((g) => g.label)).toEqual(['June', 'December 2025', 'January 2025']);
    expect(groups.map((g) => g.key)).toEqual(['m-2026-06', 'm-2025-12', 'm-2025-01']);
  });

  it('keeps items newest-first inside a section regardless of input order', () => {
    const older = { ...at('2026-07-06', '09:00'), id: 'older' };
    const newer = { ...at('2026-07-08', '15:00'), id: 'newer' };
    const middle = { ...at('2026-07-07', '10:00'), id: 'middle' };
    const groups = groupBriefsByTime([older, newer, middle], NOW, CAL);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['newer', 'middle', 'older']);
  });

  it('reads the week boundary in the workspace zone, not the browser zone', () => {
    // 2026-09-20 19:00Z is still Sunday 20 Sep in London, but already Monday
    // 21 Sep in Mumbai. With Monday weeks and a Friday "now", the SAME instant is
    // therefore Last Week in London and This Week in Mumbai.
    const brief = { created_at: '2026-09-20T19:00:00Z' };
    const now = new Date('2026-09-25T12:00:00Z');
    expect(groupBriefsByTime([brief], now, CAL)[0]!.label).toBe('This Week');
    expect(
      groupBriefsByTime([brief], now, { timeZone: 'Europe/London', weekStartDay: 1 })[0]!.label,
    ).toBe('Last Week');
  });

  it('honours a Sunday week start (weekStartDay 0 pulls Sunday into This Week)', () => {
    // Sunday 2026-07-05 closes the previous week when weeks open on Monday, and
    // OPENS the current one when they open on Sunday.
    const sunday = [at('2026-07-05')];
    expect(groupBriefsByTime(sunday, NOW, CAL)[0]!.label).toBe('Last Week');
    expect(groupBriefsByTime(sunday, NOW, { timeZone: ZONE, weekStartDay: 0 })[0]!.label).toBe(
      'This Week',
    );
  });

  it('degrades an unknown zone to UTC instead of throwing', () => {
    const brief = { created_at: '2026-09-20T19:00:00Z' };
    const now = new Date('2026-09-25T12:00:00Z');
    const bad = groupBriefsByTime([brief], now, { timeZone: 'Not/AZone', weekStartDay: 1 });
    // UTC reads the instant as Sunday 20 Sep, exactly like London does here.
    expect(bad.map((g) => g.label)).toEqual(['Last Week']);
  });
});

describe('formatRaisedDay', () => {
  it('formats a stored timestamp as "Weekday D Mon" in the workspace zone', () => {
    expect(formatRaisedDay('2026-09-22T12:00:00Z', ZONE)).toBe('Tuesday 22 Sep');
  });

  it('reads the day in the given zone, so one instant can be two days', () => {
    expect(formatRaisedDay('2026-09-22T19:00:00Z', ZONE)).toBe('Wednesday 23 Sep');
    expect(formatRaisedDay('2026-09-22T19:00:00Z', 'Europe/London')).toBe('Tuesday 22 Sep');
  });

  it('degrades an unknown zone to UTC instead of throwing', () => {
    expect(formatRaisedDay('2026-09-22T19:00:00Z', 'Not/AZone')).toBe('Tuesday 22 Sep');
  });

  it('returns an unparseable timestamp unchanged', () => {
    expect(formatRaisedDay('not-a-date', ZONE)).toBe('not-a-date');
  });
});

describe('groupBriefsByDay', () => {
  it('returns no groups for empty input', () => {
    expect(groupBriefsByDay([], ZONE)).toEqual([]);
  });

  it('collapses briefs raised on the same workspace day into one group', () => {
    const items = [
      { ...at('2026-09-22', '18:00'), id: 'a' },
      { ...at('2026-09-22', '09:00'), id: 'b' },
    ];
    const groups = groupBriefsByDay(items, ZONE);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('d-2026-09-22');
    expect(groups[0]!.label).toBe('Tuesday 22 Sep');
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('splits two days into two groups, preserving the input order', () => {
    const items = [
      { ...at('2026-09-23', '10:00'), id: 'newer' },
      { ...at('2026-09-22', '10:00'), id: 'older' },
    ];
    const groups = groupBriefsByDay(items, ZONE);
    expect(groups.map((g) => g.key)).toEqual(['d-2026-09-23', 'd-2026-09-22']);
    expect(groups.map((g) => g.label)).toEqual(['Wednesday 23 Sep', 'Tuesday 22 Sep']);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['newer'], ['older']]);
  });

  it('buckets by the workspace civil day, so the same instant can change group', () => {
    const items = [{ created_at: '2026-09-22T19:00:00Z', id: 'x' }];
    expect(groupBriefsByDay(items, ZONE)[0]!.key).toBe('d-2026-09-23');
    expect(groupBriefsByDay(items, ZONE)[0]!.label).toBe('Wednesday 23 Sep');
    expect(groupBriefsByDay(items, 'Europe/London')[0]!.key).toBe('d-2026-09-22');
    expect(groupBriefsByDay(items, 'Europe/London')[0]!.label).toBe('Tuesday 22 Sep');
  });

  it('degrades an unknown zone to UTC instead of throwing', () => {
    const items = [{ created_at: '2026-09-22T19:00:00Z', id: 'x' }];
    expect(groupBriefsByDay(items, 'Not/AZone')[0]!.label).toBe('Tuesday 22 Sep');
  });
});
