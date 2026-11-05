import { describe, expect, it } from 'vitest';
import type { DayIds } from '@/lib/chat/plan-drag';
import { dayMoveToast, othersIn } from '@/lib/chat/plan-keyboard-move';

const DAYS: DayIds[] = [
  { day: '2026-10-11', ids: ['out'] },
  { day: '2026-10-12', ids: ['a', 'b'] },
  { day: '2026-10-13', ids: [] },
  { day: '2026-10-14', ids: ['c'] },
  { day: null, ids: ['d'] },
];

describe('othersIn', () => {
  it('counts a day without the moved item', () => {
    expect(othersIn(DAYS, 'a', '2026-10-12')).toBe(1);
    expect(othersIn(DAYS, 'c', '2026-10-12')).toBe(2);
    expect(othersIn(DAYS, 'a', '2026-10-30')).toBe(0);
  });
});

describe('dayMoveToast', () => {
  it('names the day, a post says its Due date moved; no em-dashes', () => {
    expect(dayMoveToast('Thu 15 Oct', true, false)).toEqual({
      title: 'Moved to Thu 15 Oct. Due date updated.',
      undo: true,
    });
    expect(dayMoveToast('Thu 15 Oct', false, false)).toEqual({
      title: 'Moved to Thu 15 Oct.',
      undo: true,
    });
    expect(dayMoveToast(null, false, false).title).toBe('Moved to No date.');
    expect(dayMoveToast('Wed 14 Oct', true, true)).toEqual({
      title: 'Moved to Wed 14 Oct. Due date updated. Its ticks were reset.',
      undo: false,
    });
    expect(dayMoveToast('x', true, true).title).not.toContain(String.fromCharCode(0x2014));
  });
});
