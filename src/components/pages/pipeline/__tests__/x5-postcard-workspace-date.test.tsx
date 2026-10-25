// X5 fix 2 (FB8): target_date is timestamptz and a due date; the card shows its
// day in the WORKSPACE zone, never the browser zone (src/lib/time.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
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
    expect(out).not.toBe(dueLabel('2026-03-15T02:00:00Z', 'America/Los_Angeles', NOW));
  });

  it('the same instant in a workspace west of UTC reads its own day', () => {
    expect(dueLabel('2026-03-15T02:00:00Z', 'America/New_York', NOW)).toBe('Due 14 Mar');
  });

  it('a workspace with no zone or a bad zone reads the device zone', () => {
    const device = dueLabel('2026-03-15T02:00:00Z', null, NOW);
    expect(dueLabel('2026-03-15T02:00:00Z', 'Not/AZone', NOW)).toBe(device);
    expect(dueLabel('2026-03-15T02:00:00Z', undefined, NOW)).toBe(device);
  });

  it('an unparseable value shows as stored', () => {
    expect(dueLabel('soon', 'Asia/Kolkata', NOW)).toBe('Due soon');
  });
});
