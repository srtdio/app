import { describe, expect, it } from 'vitest';
import type { DayIds } from '@/lib/chat/plan-drag';
import {
  KEY_HINTS,
  dayMoveToast,
  othersIn,
  previewGroups,
  rowKeyIntent,
  slotAnnouncement,
  stepSlot,
} from '@/lib/chat/plan-keyboard-move';
import type { PlanWeekGroup } from '@/lib/plan-week';

const DAYS: DayIds[] = [
  { day: '2026-10-11', ids: ['out'] },
  { day: '2026-10-12', ids: ['a', 'b'] },
  { day: '2026-10-13', ids: [] },
  { day: '2026-10-14', ids: ['c'] },
  { day: null, ids: ['d'] },
];
// The 11th is outside the plan: never a slot.
const droppable = (day: string | null): boolean => day !== '2026-10-11';

describe('stepSlot: every slot of every droppable day', () => {
  it('down walks a day, then the next day from its first slot', () => {
    let at = { day: '2026-10-12', index: 0 } as { day: string | null; index: number } | null;
    const seen: string[] = [];
    while (at !== null) {
      seen.push(`${at.day ?? 'none'}:${at.index}`);
      at = stepSlot(DAYS, 'a', at, 1, droppable);
    }
    expect(seen).toEqual([
      '2026-10-12:0',
      '2026-10-12:1',
      '2026-10-13:0',
      '2026-10-14:0',
      '2026-10-14:1',
      'none:0',
      'none:1',
    ]);
  });

  it('up walks back, landing on the previous day last slot', () => {
    expect(stepSlot(DAYS, 'c', { day: '2026-10-14', index: 0 }, -1, droppable)).toEqual({
      day: '2026-10-13',
      index: 0,
    });
    expect(stepSlot(DAYS, 'd', { day: null, index: 0 }, -1, droppable)).toEqual({
      day: '2026-10-14',
      index: 1,
    });
  });

  it('stops at either end and skips days outside the plan', () => {
    expect(stepSlot(DAYS, 'a', { day: '2026-10-12', index: 0 }, -1, droppable)).toBeNull();
    expect(stepSlot(DAYS, 'd', { day: null, index: 0 }, 1, droppable)).toBeNull();
    expect(stepSlot(DAYS, 'out', { day: '2026-10-11', index: 0 }, 1, droppable)).toBeNull();
  });

  it('counts a day without the moved item', () => {
    expect(othersIn(DAYS, 'a', '2026-10-12')).toBe(1);
    expect(othersIn(DAYS, 'c', '2026-10-12')).toBe(2);
    expect(othersIn(DAYS, 'a', '2026-10-30')).toBe(0);
  });
});

describe('previewGroups: the pick-up shown where it would land', () => {
  const groups: PlanWeekGroup<{ id: string }>[] = [
    {
      label: null,
      days: DAYS.map((d) => ({
        day: d.day,
        label: d.day ?? 'No date',
        inRange: d.day !== '2026-10-11',
        items: d.ids.map((id) => ({ id })),
      })),
    },
  ];
  const ids = (g: PlanWeekGroup<{ id: string }>[]) =>
    g[0]?.days.map((d) => d.items.map((i) => i.id).join(',')) ?? [];

  it('moves the row into another day at the index, other days unchanged', () => {
    expect(ids(previewGroups(groups, 'a', { day: '2026-10-14', index: 1 }))).toEqual([
      'out',
      'b',
      '',
      'c,a',
      'd',
    ]);
  });

  it('an unknown item leaves the groups as they are', () => {
    expect(ids(previewGroups(groups, 'zz', { day: null, index: 0 }))).toEqual(ids(groups));
  });
});

describe('keys on a focused row', () => {
  it('maps resting and picked-up keys', () => {
    expect(rowKeyIntent(' ', false)).toBe('pick');
    expect(rowKeyIntent('Enter', false)).toBeNull();
    expect(rowKeyIntent('Delete', false)).toBe('remove');
    expect(rowKeyIntent('Backspace', false)).toBe('remove');
    expect(rowKeyIntent('ArrowDown', false)).toBe('down');
    expect(rowKeyIntent('ArrowUp', true)).toBe('up');
    expect(rowKeyIntent(' ', true)).toBe('drop');
    expect(rowKeyIntent('Enter', true)).toBe('drop');
    expect(rowKeyIntent('Escape', true)).toBe('cancel');
    expect(rowKeyIntent('Escape', false)).toBeNull();
    expect(rowKeyIntent('Delete', true)).toBeNull();
  });
});

describe('copy', () => {
  it('announcements, toast and hints; no em-dashes', () => {
    expect(slotAnnouncement('Wed 14 Oct', 1)).toBe('Wed 14 Oct, position 2');
    // D2: posts name the Pipeline date; concepts do not. Both keep Undo.
    expect(dayMoveToast('Thu 15 Oct', true, false)).toEqual({
      title: 'Moved to Thu 15 Oct. Due date updated.',
      undo: true,
    });
    expect(dayMoveToast('Thu 15 Oct', false, false)).toEqual({
      title: 'Moved to Thu 15 Oct.',
      undo: true,
    });
    expect(dayMoveToast(null, false, false).title).toBe('Moved to No date.');
    // F4: a reset says so and has no Undo.
    expect(dayMoveToast('Wed 14 Oct', true, true)).toEqual({
      title: 'Moved to Wed 14 Oct. Due date updated. Its ticks were reset.',
      undo: false,
    });
    expect(dayMoveToast('Wed 14 Oct', false, true)).toEqual({
      title: 'Moved to Wed 14 Oct. Its ticks were reset.',
      undo: false,
    });
    expect(KEY_HINTS).toBe(
      'Drag handle to move · Space pick up, arrows move, Space drop · Del remove',
    );
    for (const s of [KEY_HINTS, dayMoveToast('x', true, true).title, slotAnnouncement('x', 0)]) {
      expect(s).not.toContain(String.fromCharCode(0x2014));
    }
  });
});
