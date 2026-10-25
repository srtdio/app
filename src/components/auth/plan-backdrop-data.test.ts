import { describe, expect, it } from 'vitest';
import {
  BACKDROP_THUMBS,
  backdropMonth,
  backdropThumbSrc,
  backdropWeekdays,
} from '@/components/auth/plan-backdrop-data';

const CASES: Array<{ label: string; today: Date; days: number }> = [
  { label: 'Feb 2027', today: new Date(2027, 1, 14), days: 28 },
  { label: 'Oct 2026', today: new Date(2026, 9, 25), days: 31 },
  { label: 'Mar 2026', today: new Date(2026, 2, 1), days: 31 },
];

describe('BACKDROP_THUMBS', () => {
  it('holds the 35 shipped sample thumbnails in order', () => {
    expect(BACKDROP_THUMBS).toHaveLength(35);
    expect(BACKDROP_THUMBS[0]).toBe('look-1');
    expect(BACKDROP_THUMBS[15]).toBe('knit');
    expect(BACKDROP_THUMBS[16]).toBe('np-01');
    expect(BACKDROP_THUMBS[34]).toBe('np-19');
    expect(backdropThumbSrc('mono')).toBe('/induction-sample/thumb/mono.jpg');
  });
});

describe('backdropMonth', () => {
  for (const { label, today, days } of CASES) {
    describe(label, () => {
      const weeks = backdropMonth(today);
      const cells = weeks.flat();

      it('has 5 or 6 Monday-start weeks of 7 days', () => {
        expect(weeks.length).toBeGreaterThanOrEqual(5);
        expect(weeks.length).toBeLessThanOrEqual(6);
        for (const week of weeks) expect(week).toHaveLength(7);
        const firstInMonth = cells.findIndex((cell) => cell.inMonth);
        const weekday = (new Date(today.getFullYear(), today.getMonth(), 1).getDay() + 6) % 7;
        expect(firstInMonth).toBe(weekday);
        const monday = new Date(today.getFullYear(), today.getMonth(), 1 - weekday);
        expect(monday.getDay()).toBe(1);
        expect(weeks[0]?.[0]?.day).toBe(monday.getDate());
      });

      it('gives every cell a thumbnail, cycling by cell index', () => {
        cells.forEach((cell, index) => {
          expect(BACKDROP_THUMBS).toContain(cell.thumb);
          expect(cell.thumb).toBe(BACKDROP_THUMBS[index % BACKDROP_THUMBS.length]);
        });
      });

      it('marks exactly one day as today', () => {
        const todays = cells.filter((cell) => cell.isToday);
        expect(todays).toHaveLength(1);
        expect(todays[0]?.day).toBe(today.getDate());
        expect(todays[0]?.inMonth).toBe(true);
      });

      it('has one in-month cell per day of the month', () => {
        expect(cells.filter((cell) => cell.inMonth)).toHaveLength(days);
      });
    });
  }

  it('pads a 4-week February to 5 rows', () => {
    // Feb 2027 starts on a Monday and has 28 days.
    expect(backdropMonth(new Date(2027, 1, 14))).toHaveLength(5);
  });

  it('covers months that need 6 rows', () => {
    // Nov 2026 starts on a Sunday: 6 leading days plus 30.
    expect(backdropMonth(new Date(2026, 10, 3))).toHaveLength(6);
  });
});

describe('backdropWeekdays', () => {
  it('returns 7 labels starting Monday', () => {
    const labels = backdropWeekdays();
    expect(labels).toHaveLength(7);
    const monday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(
      new Date(2026, 9, 26),
    );
    expect(labels[0]).toBe(monday);
  });
});
