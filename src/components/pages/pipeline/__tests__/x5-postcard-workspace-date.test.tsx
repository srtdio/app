// X5 fix 2 (FB8): target_date is timestamptz; the card shows its day in the
// workspace zone, never the browser zone.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueLabel } from '@/components/pages/PostCard';

const NOW = new Date('2026-06-01T00:00:00Z');

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
    const out = dueLabel('2026-03-15T02:00:00Z', 'Asia/Kolkata', NOW);
    expect(out).toBe('Due 15 Mar');
    expect(out).not.toBe('Due 14 Mar');
  });

  it('the same instant in a workspace west of UTC reads its own day', () => {
    expect(dueLabel('2026-03-15T02:00:00Z', 'America/New_York', NOW)).toBe('Due 14 Mar');
  });

  it('a bad zone falls back to UTC and an unparseable value shows as stored', () => {
    expect(dueLabel('2026-03-15T02:00:00Z', 'Not/AZone', NOW)).toBe('Due 15 Mar');
    expect(dueLabel('soon', 'Asia/Kolkata', NOW)).toBe('Due soon');
  });
});
