import { describe, expect, it } from 'vitest';
import {
  calendarDays,
  countByWhen,
  dayChoices,
  isPickableDay,
  openingChip,
  rowDateLine,
  searchTasks,
  taskWhen,
  type TaskCalendar,
} from '@/lib/chat/task-when';

// Thursday 5 Nov 2026, 10:00 UTC; the week runs Monday 2 to Sunday 8 Nov.
const CAL: TaskCalendar = {
  now: new Date('2026-11-05T10:00:00.000Z'),
  timeZone: 'UTC',
  weekStartDay: 1,
};
const DAYS = calendarDays(CAL);
const open = { status: 'todo' as const, doneAt: null };

describe('task chips', () => {
  it('today and the week end read on the workspace calendar', () => {
    expect(DAYS).toEqual({ today: '2026-11-05', weekEnd: '2026-11-08' });
    // Sunday start: the week ends Saturday 7 Nov.
    expect(calendarDays({ ...CAL, weekStartDay: 0 }).weekEnd).toBe('2026-11-07');
    // Late evening in Mumbai is already the next day there.
    const mumbai = { ...CAL, now: new Date('2026-11-05T20:00:00.000Z'), timeZone: 'Asia/Kolkata' };
    expect(calendarDays(mumbai).today).toBe('2026-11-06');
  });

  it('a task falls under Past, Today, This week, Later or No date by its due day', () => {
    expect(taskWhen({ dueOn: null }, DAYS)).toBe('none');
    expect(taskWhen({ dueOn: '2026-11-04' }, DAYS)).toBe('past');
    expect(taskWhen({ dueOn: '2026-11-05' }, DAYS)).toBe('today');
    expect(taskWhen({ dueOn: '2026-11-06' }, DAYS)).toBe('week');
    expect(taskWhen({ dueOn: '2026-11-08' }, DAYS)).toBe('week');
    expect(taskWhen({ dueOn: '2026-11-09' }, DAYS)).toBe('later');
  });

  it('opens on Today when it holds anything, else the first chip that does, else Today', () => {
    const counts = countByWhen(
      [{ dueOn: '2026-11-01' }, { dueOn: null }, { dueOn: '2026-11-20' }],
      DAYS,
    );
    expect(counts).toEqual({ past: 1, today: 0, week: 0, later: 1, none: 1 });
    expect(openingChip(counts)).toBe('past');
    expect(openingChip({ ...counts, today: 2 })).toBe('today');
    expect(openingChip({ past: 0, today: 0, week: 0, later: 0, none: 0 })).toBe('today');
  });
});

describe('the date line', () => {
  it('open tasks: Overdue in the bad tone, the day alone later; nothing for today or no date', () => {
    expect(rowDateLine({ ...open, dueOn: '2026-11-03' }, CAL)).toEqual({
      text: 'Overdue · 3 Nov',
      bad: true,
    });
    expect(rowDateLine({ ...open, dueOn: '2026-11-05' }, CAL)).toBeNull();
    expect(rowDateLine({ ...open, dueOn: '2026-11-12' }, CAL)).toEqual({
      text: '12 Nov',
      bad: false,
    });
    expect(rowDateLine({ ...open, dueOn: '2027-01-02' }, CAL)).toEqual({
      text: '2 Jan 2027',
      bad: false,
    });
    expect(rowDateLine({ ...open, dueOn: null }, CAL)).toBeNull();
  });

  it('done tasks: what was due and when it was done', () => {
    const done = { status: 'done' as const, doneAt: '2026-10-30T09:00:00.000Z' };
    expect(rowDateLine({ ...done, dueOn: '2026-10-31' }, CAL, 'UTC')?.text).toBe(
      'Due 31 Oct · done 30 Oct',
    );
    expect(rowDateLine({ ...done, dueOn: null }, CAL, 'UTC')?.text).toBe('Done 30 Oct');
    // Done before the stamp existed: the due day alone.
    expect(rowDateLine({ ...done, doneAt: null, dueOn: '2026-10-31' }, CAL)?.text).toBe(
      'Due 31 Oct',
    );
    expect(rowDateLine({ ...done, doneAt: null, dueOn: null }, CAL)).toBeNull();
  });
});

describe('the row menu and search', () => {
  it('quick days: Today, Tomorrow, No date; never before today', () => {
    expect(dayChoices(CAL).map((c) => [c.key, c.label, c.dueOn])).toEqual([
      ['today', 'Today', '2026-11-05'],
      ['tomorrow', 'Tomorrow', '2026-11-06'],
      ['none', 'No date', null],
    ]);
    expect(isPickableDay('2026-11-05', CAL)).toBe(true);
    expect(isPickableDay('2026-11-04', CAL)).toBe(false);
  });

  it('search keeps titles where every word starts a word, any case', () => {
    const tasks = [
      { title: 'Get GBL logo files' },
      { title: 'Old logo cleanup' },
      { title: 'Blog' },
    ];
    expect(searchTasks(tasks, ['logo']).map((t) => t.title)).toEqual([
      'Get GBL logo files',
      'Old logo cleanup',
    ]);
    expect(searchTasks(tasks, ['log', 'fil']).map((t) => t.title)).toEqual(['Get GBL logo files']);
    // A word inside another word is no match (prefix rule): "log" never finds "Blog".
    expect(searchTasks(tasks, ['log']).map((t) => t.title)).not.toContain('Blog');
    expect(searchTasks(tasks, [])).toHaveLength(3);
  });
});
