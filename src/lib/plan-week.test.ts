import { describe, expect, it } from 'vitest';
import {
  civilNoonInZoneIso,
  civilToday,
  dayOfMonth,
  formatCivilShort,
  groupByCivilDay,
  PLAN_URGENCY_ORDER,
  sortByUrgency,
  weekBounds,
  weekdayName,
  weekLabel,
} from '@/lib/plan-week';

// Fixed instant: Wed 2026-09-09 12:00 UTC. Every case injects it, so nothing
// here reads the machine clock or the machine zone.
const NOW = new Date('2026-09-09T12:00:00Z');

function bounds(over: { weekStartDay?: number; offset?: number; timeZone?: string } = {}) {
  return weekBounds({
    now: NOW,
    timeZone: over.timeZone ?? 'UTC',
    weekStartDay: over.weekStartDay ?? 1,
    offset: over.offset ?? 0,
  });
}

describe('weekBounds', () => {
  it('weekStartDay 1 (Mon) anchors the week on the preceding Monday', () => {
    const week = bounds({ weekStartDay: 1 });
    expect(week.start).toBe('2026-09-07');
    expect(week.end).toBe('2026-09-13');
    expect(week.days).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ]);
  });

  it('weekStartDay 0 (Sun) anchors the same day on the preceding Sunday', () => {
    const week = bounds({ weekStartDay: 0 });
    expect(week.start).toBe('2026-09-06');
    expect(week.end).toBe('2026-09-12');
    expect(week.days).toHaveLength(7);
    expect(weekdayName(0, 0)).toBe('Sun');
    expect(weekdayName(1, 0)).toBe('Mon');
    expect(weekdayName(1, 6)).toBe('Sun');
  });

  it('offsets step whole weeks back and forward', () => {
    expect(bounds({ offset: -1 }).start).toBe('2026-08-31');
    expect(bounds({ offset: -1 }).end).toBe('2026-09-06');
    expect(bounds({ offset: 1 }).start).toBe('2026-09-14');
    expect(bounds({ offset: 1 }).end).toBe('2026-09-20');
    // Two hops forward is still exactly 14 days from this week's start.
    expect(bounds({ offset: 2 }).start).toBe('2026-09-21');
  });

  it('labels the near weeks by name and every other week by its start day', () => {
    expect(bounds({ offset: 0 }).label).toBe('This week');
    expect(bounds({ offset: -1 }).label).toBe('Last week');
    expect(bounds({ offset: 1 }).label).toBe('Next week');
    expect(bounds({ offset: 2 }).label).toBe('21 Sep');
    expect(weekLabel('2026-09-21', 2)).toBe('21 Sep');
  });

  it('reads today from the WORKSPACE zone, not UTC, across a zone boundary', () => {
    // 2026-09-06 19:00 UTC is still Sunday in UTC but already Monday the 7th in
    // Asia/Kolkata (+05:30). With a Monday week start the two zones therefore
    // land on different weeks from the SAME instant.
    const instant = new Date('2026-09-06T19:00:00Z');
    expect(civilToday(instant, 'UTC')).toBe('2026-09-06');
    expect(civilToday(instant, 'Asia/Kolkata')).toBe('2026-09-07');

    const utc = weekBounds({ now: instant, timeZone: 'UTC', weekStartDay: 1, offset: 0 });
    const ist = weekBounds({ now: instant, timeZone: 'Asia/Kolkata', weekStartDay: 1, offset: 0 });
    expect(utc.start).toBe('2026-08-31');
    expect(ist.start).toBe('2026-09-07');
  });

  it('degrades an invalid zone to UTC instead of throwing', () => {
    expect(() => bounds({ timeZone: 'Not/AZone' })).not.toThrow();
    expect(bounds({ timeZone: 'Not/AZone' }).start).toBe(bounds({ timeZone: 'UTC' }).start);
    expect(civilToday(NOW, '')).toBe('2026-09-09');
  });
});

describe('groupByCivilDay', () => {
  const days = bounds().days;

  function post(id: string, target: string | null): { id: string; target_date: string | null } {
    return { id, target_date: target };
  }

  function ids(list: { id: string }[]): string[] {
    return list.map((p) => p.id);
  }

  it('buckets each post under its target date civil day, in input order', () => {
    const { byDay, undated } = groupByCivilDay(
      [
        post('a', '2026-09-07T00:00:00Z'),
        post('b', '2026-09-09T23:00:00Z'),
        post('c', '2026-09-07T18:00:00Z'),
      ],
      days,
      'UTC',
    );
    expect(ids(byDay['2026-09-07']!)).toEqual(['a', 'c']);
    expect(ids(byDay['2026-09-09']!)).toEqual(['b']);
    expect(undated).toHaveLength(0);
    // Every day of the week has a bucket, empty ones included.
    expect(Object.keys(byDay)).toHaveLength(7);
  });

  it('groups by the WORKSPACE zone when an instant straddles the date line', () => {
    // 2026-09-07 19:00 UTC is the 7th in UTC and the 8th in Asia/Kolkata.
    const posts = [post('a', '2026-09-07T19:00:00Z')];
    expect(ids(groupByCivilDay(posts, days, 'UTC').byDay['2026-09-07']!)).toEqual(['a']);
    expect(ids(groupByCivilDay(posts, days, 'Asia/Kolkata').byDay['2026-09-08']!)).toEqual(['a']);
    expect(groupByCivilDay(posts, days, 'Asia/Kolkata').byDay['2026-09-07']).toEqual([]);
  });

  it('a null target_date lands in undated, never in a day', () => {
    const { byDay, undated } = groupByCivilDay([post('n', null)], days, 'UTC');
    expect(ids(undated)).toEqual(['n']);
    expect(Object.values(byDay).every((list) => list.length === 0)).toBe(true);
  });

  it('an unparseable target_date is undated rather than dropped', () => {
    const { undated } = groupByCivilDay([post('bad', 'not-a-date')], days, 'UTC');
    expect(ids(undated)).toEqual(['bad']);
  });

  it('a date outside the week is excluded from every bucket and from undated', () => {
    const { byDay, undated } = groupByCivilDay(
      [post('in', '2026-09-10T00:00:00Z'), post('out', '2026-10-01T00:00:00Z')],
      days,
      'UTC',
    );
    expect(ids(byDay['2026-09-10']!)).toEqual(['in']);
    expect(undated).toHaveLength(0);
    const all = Object.values(byDay).flatMap(ids);
    expect(all).toEqual(['in']);
  });

  it('an invalid zone degrades to UTC without throwing', () => {
    expect(() =>
      groupByCivilDay([post('a', '2026-09-07T00:00:00Z')], days, 'Not/AZone'),
    ).not.toThrow();
    expect(
      ids(
        groupByCivilDay([post('a', '2026-09-07T00:00:00Z')], days, 'Not/AZone').byDay[
          '2026-09-07'
        ]!,
      ),
    ).toEqual(['a']);
  });
});

describe('civil formatting', () => {
  it('renders a civil date as "D Mon" and exposes the day of month', () => {
    expect(formatCivilShort('2026-09-07')).toBe('7 Sep');
    expect(formatCivilShort('2026-12-31')).toBe('31 Dec');
    expect(dayOfMonth('2026-09-07')).toBe(7);
  });
});

describe('sortByUrgency', () => {
  function staged(...stages: string[]): { id: string; stage: string }[] {
    return stages.map((stage, i) => ({ id: `${stage}${i}`, stage }));
  }

  it('orders approved, review, draft, parked, rejected', () => {
    expect([...PLAN_URGENCY_ORDER]).toEqual(['approved', 'review', 'draft', 'parked', 'rejected']);
    const sorted = sortByUrgency(staged('rejected', 'draft', 'approved', 'parked', 'review')).map(
      (item) => item.stage,
    );
    expect(sorted).toEqual([...PLAN_URGENCY_ORDER]);
  });

  it('is stable within a stage and never mutates the input', () => {
    const input = staged('draft', 'draft', 'approved');
    const sorted = sortByUrgency(input);
    expect(sorted.map((item) => item.id)).toEqual(['approved2', 'draft0', 'draft1']);
    // The caller's list (and its order) is untouched.
    expect(input.map((item) => item.id)).toEqual(['draft0', 'draft1', 'approved2']);
  });

  it('sorts an unknown stage last instead of dropping it', () => {
    const sorted = sortByUrgency([{ stage: 'mystery' }, { stage: 'approved' }]);
    expect(sorted.map((item) => item.stage)).toEqual(['approved', 'mystery']);
  });
});

describe('civilNoonInZoneIso', () => {
  it('anchors on local noon in the workspace zone, not UTC midnight', () => {
    // IST is UTC+5:30 year round: noon local is 06:30 UTC.
    expect(civilNoonInZoneIso('2026-09-10', 'Asia/Kolkata')).toBe('2026-09-10T06:30:00.000Z');
    // UTC is its own noon.
    expect(civilNoonInZoneIso('2026-09-10', 'UTC')).toBe('2026-09-10T12:00:00.000Z');
  });

  it('tracks DST in a negative-offset zone (New York, winter and summer)', () => {
    // EST (UTC-5) in January, EDT (UTC-4) in July.
    expect(civilNoonInZoneIso('2026-01-15', 'America/New_York')).toBe('2026-01-15T17:00:00.000Z');
    expect(civilNoonInZoneIso('2026-07-15', 'America/New_York')).toBe('2026-07-15T16:00:00.000Z');
    // The transition days themselves: spring forward and fall back.
    expect(civilNoonInZoneIso('2026-03-08', 'America/New_York')).toBe('2026-03-08T16:00:00.000Z');
    expect(civilNoonInZoneIso('2026-11-01', 'America/New_York')).toBe('2026-11-01T17:00:00.000Z');
  });

  it('an invalid zone degrades to UTC and a malformed civil date never throws', () => {
    expect(civilNoonInZoneIso('2026-09-10', 'Not/AZone')).toBe('2026-09-10T12:00:00.000Z');
    expect(() => civilNoonInZoneIso('nonsense', 'UTC')).not.toThrow();
  });

  it('round-trips: the written instant groups back onto the chosen day in every zone', () => {
    const zones = ['Asia/Kolkata', 'America/New_York', 'UTC', 'Pacific/Kiritimati'];
    // A week spanning both New York DST changes plus ordinary days.
    const chosen = ['2026-01-15', '2026-03-08', '2026-07-15', '2026-11-01', '2026-09-10'];
    for (const zone of zones) {
      for (const civil of chosen) {
        const stored = civilNoonInZoneIso(civil, zone);
        const { byDay, undated } = groupByCivilDay(
          [{ id: civil, target_date: stored }],
          [civil],
          zone,
        );
        expect(undated).toHaveLength(0);
        expect(byDay[civil]!.map((item) => item.id)).toEqual([civil]);
      }
    }
  });
});
