import { describe, expect, it } from 'vitest';
import { groupBriefsByTime } from '@/lib/brief-groups';

// A fixed "now": Wednesday 2026-07-08 (local). Its week opens Monday 2026-07-06;
// the previous week opens Monday 2026-06-29 and closes Sunday 2026-07-05.
const NOW = new Date(2026, 6, 8, 12, 0, 0);

// Build a created_at from LOCAL wall-clock parts. Round-tripping through
// toISOString keeps the instant, so groupBriefsByTime (which reads local time)
// buckets identically regardless of the machine's timezone.
function at(year: number, monthIndex: number, day: number, hour = 12): { created_at: string } {
  return { created_at: new Date(year, monthIndex, day, hour, 0, 0).toISOString() };
}

function labels(now: Date, items: { created_at: string }[]): string[] {
  return groupBriefsByTime(items, now).map((g) => g.label);
}

describe('groupBriefsByTime', () => {
  it('returns no sections for empty input', () => {
    expect(groupBriefsByTime([], NOW)).toEqual([]);
  });

  it('puts the Monday that opens the week in This Week and the prior Sunday in Last Week', () => {
    const monday = { ...at(2026, 6, 6, 0), id: 'mon' }; // 2026-07-06 00:00 local
    const sunday = { ...at(2026, 6, 5, 23), id: 'sun' }; // 2026-07-05 23:00 local
    const groups = groupBriefsByTime([sunday, monday], NOW);
    expect(groups.map((g) => g.label)).toEqual(['This Week', 'Last Week']);
    expect(groups[0]!.key).toBe('w0');
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['mon']);
    expect(groups[1]!.key).toBe('w1');
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['sun']);
  });

  it('keeps this-week and last-week edges in their own sections', () => {
    const items = [
      at(2026, 6, 8), // Wed, this week
      at(2026, 6, 6), // Mon, this week (edge)
      at(2026, 6, 5), // Sun, last week (edge)
      at(2026, 5, 29), // Mon, last week (edge, opens prev week)
    ];
    expect(labels(NOW, items)).toEqual(['This Week', 'Last Week']);
    const groups = groupBriefsByTime(items, NOW);
    expect(groups[0]!.items).toHaveLength(2);
    expect(groups[1]!.items).toHaveLength(2);
  });

  it('lets Last Week span a month boundary (late June and early July together)', () => {
    const items = [
      at(2026, 6, 1), // Wed 2026-07-01, last week
      at(2026, 5, 30), // Tue 2026-06-30, last week
      at(2026, 5, 29), // Mon 2026-06-29, last week
    ];
    const groups = groupBriefsByTime(items, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe('Last Week');
    expect(groups[0]!.items).toHaveLength(3);
  });

  it('orders calendar months newest-first below the week sections', () => {
    const items = [
      at(2026, 3, 10), // April
      at(2026, 6, 8), // this week
      at(2026, 4, 20), // May
      at(2026, 5, 10), // June (before the last-week window)
    ];
    const groups = groupBriefsByTime(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['This Week', 'June', 'May', 'April']);
    expect(groups.map((g) => g.key)).toEqual(['w0', 'm-2026-06', 'm-2026-05', 'm-2026-04']);
  });

  it('appends the year only when a month is not in now\'s year', () => {
    const items = [
      at(2026, 5, 10), // June 2026 (same year, no suffix)
      at(2025, 11, 15), // December 2025 (prior year, suffix)
      at(2025, 0, 5), // January 2025 (prior year, suffix)
    ];
    const groups = groupBriefsByTime(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['June', 'December 2025', 'January 2025']);
    expect(groups.map((g) => g.key)).toEqual(['m-2026-06', 'm-2025-12', 'm-2025-01']);
  });

  it('keeps items newest-first inside a section regardless of input order', () => {
    const older = { ...at(2026, 6, 6, 9), id: 'older' };
    const newer = { ...at(2026, 6, 8, 15), id: 'newer' };
    const middle = { ...at(2026, 6, 7, 10), id: 'middle' };
    const groups = groupBriefsByTime([older, newer, middle], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['newer', 'middle', 'older']);
  });
});
