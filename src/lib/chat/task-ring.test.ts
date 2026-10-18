import { afterEach, describe, expect, it, vi } from 'vitest';
import { RING_GRACE_MS } from '@/lib/chat/reminders';
import {
  armTaskRing,
  dueNowTitle,
  missedDueCopy,
  missedDueCount,
  nextDue,
  readTaskDueLastSeen,
  stillDue,
  taskDueLastSeenKey,
  taskRungKey,
  writeTaskDueLastSeen,
  type TaskDueRow,
} from '@/lib/chat/task-ring';

const NOW = Date.parse('2026-10-13T10:00:00.000Z');

function row(over: Partial<TaskDueRow>): TaskDueRow {
  return {
    id: 't1',
    channel_id: 'c1',
    number: 1,
    title: 'Hook options',
    due_at: new Date(NOW + 60_000).toISOString(),
    ...over,
  };
}

describe('nextDue', () => {
  it('is null for no rows', () => {
    expect(nextDue([], NOW)).toBeNull();
  });

  it('skips rows past the grace, rows with no or a bad time', () => {
    const rows = [
      row({ id: 'old', due_at: new Date(NOW - RING_GRACE_MS - 1).toISOString() }),
      row({ id: 'none', due_at: null }),
      row({ id: 'bad', due_at: 'soon' }),
    ];
    expect(nextDue(rows, NOW)).toBeNull();
    // Inside the grace it still rings (the timer fired a moment late).
    const late = row({ id: 'late', due_at: new Date(NOW - 1000).toISOString() });
    expect(nextDue([...rows, late], NOW)?.id).toBe('late');
  });

  it('picks the soonest; ties go by number, then id', () => {
    const at = new Date(NOW + 60_000).toISOString();
    const rows = [
      row({ id: 'later', number: 1, due_at: new Date(NOW + 120_000).toISOString() }),
      row({ id: 'b', number: 5, due_at: at }),
      row({ id: 'c', number: 3, due_at: at }),
      row({ id: 'a', number: 3, due_at: at }),
    ];
    expect(nextDue(rows, NOW)?.id).toBe('a');
  });

  it('a rung task and due time never comes back; a new due time does', () => {
    const first = row({ id: 'a', number: 3 });
    const twin = row({ id: 'b', number: 4 });
    const rung = new Set([taskRungKey('a', first.due_at) ?? '']);
    // Its tie still rings, even once the moment has passed.
    expect(nextDue([first, twin], NOW + 60_000, rung)?.id).toBe('b');
    rung.add(taskRungKey('b', twin.due_at) ?? '');
    expect(nextDue([first, twin], NOW + 60_000, rung)).toBeNull();
    const moved = { ...first, due_at: new Date(NOW + 600_000).toISOString() };
    expect(nextDue([moved], NOW, rung)?.id).toBe('a');
  });
});

describe('taskRungKey', () => {
  it('is the same for one instant in any ISO spelling', () => {
    expect(taskRungKey('a', '2026-10-13T10:00:00+00:00')).toBe(
      taskRungKey('a', '2026-10-13T10:00:00.000Z'),
    );
    expect(taskRungKey('a', null)).toBeNull();
    expect(taskRungKey('a', 'x')).toBeNull();
  });
});

describe('stillDue', () => {
  const armed = row({ id: 'a' });
  it('rings only for the same open item and due time', () => {
    expect(stillDue(armed, { ...armed, status: 'todo' })).toBe(true);
    expect(stillDue(armed, { ...armed, status: 'waiting' })).toBe(true);
    expect(stillDue(armed, { ...armed, status: 'done' })).toBe(false);
    expect(stillDue(armed, { ...armed, status: 'shared' })).toBe(false);
    expect(
      stillDue(armed, {
        ...armed,
        status: 'todo',
        due_at: new Date(NOW + 120_000).toISOString(),
      }),
    ).toBe(false);
    expect(stillDue(armed, { ...armed, status: 'todo', due_at: null })).toBe(false);
    expect(stillDue(armed, null)).toBe(false);
  });
  it('W9 fix 4: a deleted item never rings', () => {
    expect(stillDue(armed, { ...armed, status: 'todo', deleted_at: null })).toBe(true);
    expect(stillDue(armed, { ...armed, status: 'todo', deleted_at: '2026-10-13T13:00:00Z' })).toBe(
      false,
    );
  });
});

describe('armTaskRing', () => {
  afterEach(() => vi.useRealTimers());

  it('rings on time once; cancel stops it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onRing = vi.fn();
    const target = row({ id: 'a' });
    armTaskRing({
      rows: [target],
      now: () => Date.now(),
      rung: new Set(),
      onRing,
      onRearm: () => {},
    });
    vi.advanceTimersByTime(59_999);
    expect(onRing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRing).toHaveBeenCalledWith(target);

    const later = vi.fn();
    const cancel = armTaskRing({
      rows: [row({ id: 'b', due_at: new Date(Date.now() + 1000).toISOString() })],
      now: () => Date.now(),
      rung: new Set(),
      onRing: later,
      onRearm: () => {},
    });
    cancel();
    vi.advanceTimersByTime(5000);
    expect(later).not.toHaveBeenCalled();
  });

  it('arms nothing when nothing is due', () => {
    vi.useFakeTimers();
    const onRing = vi.fn();
    armTaskRing({ rows: [], now: () => NOW, rung: new Set(), onRing, onRearm: onRing });
    vi.runAllTimers();
    expect(onRing).not.toHaveBeenCalled();
  });
});

describe('missed due times', () => {
  const rows = [
    { createdAt: '2026-10-13T09:00:00Z', readAt: null, taskId: 'a', dueAt: '2026-10-13T09:00:00Z' },
    { createdAt: '2026-10-13T09:30:00Z', readAt: null, taskId: 'b', dueAt: '2026-10-13T09:30:00Z' },
    {
      createdAt: '2026-10-13T09:40:00Z',
      readAt: '2026-10-13T09:41:00Z',
      taskId: 'c',
      dueAt: '2026-10-13T09:40:00Z',
    },
    { createdAt: '2026-10-13T08:00:00Z', readAt: null, taskId: 'd', dueAt: '2026-10-13T08:00:00Z' },
  ];
  const since = Date.parse('2026-10-13T08:30:00Z');

  it('counts unread rows after the mark, minus the rung ones; none on a first run', () => {
    expect(missedDueCount(rows, since, new Set())).toBe(2);
    expect(
      missedDueCount(rows, since, new Set([taskRungKey('a', rows[0]?.dueAt ?? null) ?? ''])),
    ).toBe(1);
    expect(missedDueCount(rows, null, new Set())).toBe(0);
  });

  it('copy', () => {
    expect(missedDueCopy(1)).toBe('You missed 1 due time');
    expect(missedDueCopy(3)).toBe('You missed 3 due times');
    expect(dueNowTitle({ number: 12, title: 'Caption' })).toBe('Due now: 12 Caption');
  });

  it('keeps its own last-seen key; blocked storage reads as none', () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    writeTaskDueLastSeen('u1', 42, store);
    expect(readTaskDueLastSeen('u1', store)).toBe(42);
    expect(taskDueLastSeenKey('u1')).not.toBe('sorted:bell:last-seen:u1');
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readTaskDueLastSeen('u1', blocked)).toBeNull();
    expect(() => writeTaskDueLastSeen('u1', 1, blocked)).not.toThrow();
  });
});
