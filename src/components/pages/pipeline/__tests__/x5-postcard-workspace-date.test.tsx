// X5 fix 2 (FB8): target_date is timestamptz; the card shows its day in the
// workspace zone, never the browser zone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatTargetDate } from '@/components/pages/PostCard';

const civil = (y: number, m: number, d: number): string =>
  new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

describe('X5 PostCard date in the workspace zone', () => {
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it('a browser in America/Los_Angeles shows the Asia/Kolkata workspace day', () => {
    // 02:00Z on 15 Mar is 07:30 on 15 Mar in Kolkata but 19:00 on 14 Mar in LA.
    const out = formatTargetDate('2026-03-15T02:00:00Z', 'Asia/Kolkata');
    expect(out).toBe(civil(2026, 3, 15));
    expect(out).not.toBe(civil(2026, 3, 14));
  });

  it('the same instant in a workspace west of UTC reads its own day', () => {
    expect(formatTargetDate('2026-03-15T02:00:00Z', 'America/New_York')).toBe(civil(2026, 3, 14));
  });

  it('a bad zone falls back to UTC and an unparseable value shows as stored', () => {
    expect(formatTargetDate('2026-03-15T02:00:00Z', 'Not/AZone')).toBe(civil(2026, 3, 15));
    expect(formatTargetDate('soon', 'Asia/Kolkata')).toBe('soon');
  });
});
