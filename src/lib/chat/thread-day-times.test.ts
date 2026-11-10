import { describe, expect, it } from 'vitest';
import { threadDayTimes } from '@/lib/chat/thread-day-times';

describe('threadDayTimes: the first message of each day shows its day', () => {
  it('a single message shows its day', () => {
    expect(threadDayTimes(['2026-11-10T09:00:00Z'], 'UTC')).toEqual(['day']);
  });

  it('later messages on the same day show the clock only', () => {
    expect(
      threadDayTimes(
        ['2026-11-10T09:00:00Z', '2026-11-10T09:05:00Z', '2026-11-10T20:00:00Z'],
        'UTC',
      ),
    ).toEqual(['day', 'clock', 'clock']);
  });

  it('a day change shows the day again, then the clock', () => {
    expect(
      threadDayTimes(
        [
          '2026-11-08T12:00:00Z',
          '2026-11-09T12:17:00Z',
          '2026-11-09T14:48:00Z',
          '2026-11-10T09:00:00Z',
        ],
        'UTC',
      ),
    ).toEqual(['day', 'day', 'clock', 'day']);
  });

  it('days follow the viewer zone', () => {
    // 18:00 and 19:00 UTC on 9 Nov: one day in UTC, 23:30 and 00:30 (two days) in Kolkata.
    const times = ['2026-11-09T18:00:00Z', '2026-11-09T19:00:00Z'];
    expect(threadDayTimes(times, 'UTC')).toEqual(['day', 'clock']);
    expect(threadDayTimes(times, 'Asia/Kolkata')).toEqual(['day', 'day']);
  });

  it('accepts epoch ms and an empty list', () => {
    const at = Date.parse('2026-11-10T09:00:00Z');
    expect(threadDayTimes([at, at + 60_000], 'UTC')).toEqual(['day', 'clock']);
    expect(threadDayTimes([], 'UTC')).toEqual([]);
  });
});
