import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TIMER_MS,
  RING_GRACE_MS,
  armRing,
  cancelReminder,
  isWithinReminderWindow,
  mapReminderError,
  minutesAhead,
  missedCopy,
  missedCount,
  nextToRing,
  readLastSeen,
  readRung,
  reminderPresets,
  reminderSetCopy,
  reminderSummary,
  ringDelayMs,
  setReminder,
  writeLastSeen,
  writeRung,
  type ReminderRow,
} from '@/lib/chat/reminders';

function at(y: number, m: number, d: number, h = 0, min = 0, s = 0): Date {
  return new Date(y, m - 1, d, h, min, s, 0);
}

function preset(now: Date, id: string): Date {
  const p = reminderPresets(now).find((x) => x.id === id);
  if (p === undefined) throw new Error(`no preset ${id}`);
  return p.at;
}

function reminder(over: Partial<ReminderRow>): ReminderRow {
  return {
    id: 'r1',
    user_id: 'u1',
    message_id: 'm1',
    channel_id: 'c1',
    workspace_id: 'w1',
    remind_at: new Date().toISOString(),
    fired_at: null,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe('reminder presets', () => {
  it('lists 20 minutes, 1 hour, 3 hours, Tomorrow, Next week in order', () => {
    expect(reminderPresets(at(2026, 10, 3, 10)).map((p) => p.label)).toEqual([
      '20 minutes',
      '1 hour',
      '3 hours',
      'Tomorrow',
      'Next week',
    ]);
  });

  it('relative presets land on the whole minute, rounded up', () => {
    const now = at(2026, 10, 3, 10, 7, 30);
    expect(preset(now, '20m')).toEqual(at(2026, 10, 3, 10, 28));
    expect(preset(now, '1h')).toEqual(at(2026, 10, 3, 11, 8));
    expect(preset(now, '3h')).toEqual(at(2026, 10, 3, 13, 8));
    // Already on the minute: exactly n minutes ahead.
    expect(preset(at(2026, 10, 3, 10, 0, 0), '20m')).toEqual(at(2026, 10, 3, 10, 20));
  });

  it('3 hours crosses midnight', () => {
    expect(preset(at(2026, 10, 3, 22, 30), '3h')).toEqual(at(2026, 10, 4, 1, 30));
  });

  it('Tomorrow is 9:00 AM the next day, across month and year ends', () => {
    expect(preset(at(2026, 10, 3, 23, 59), 'tomorrow')).toEqual(at(2026, 10, 4, 9));
    expect(preset(at(2026, 10, 31, 8), 'tomorrow')).toEqual(at(2026, 11, 1, 9));
    expect(preset(at(2026, 12, 31, 12), 'tomorrow')).toEqual(at(2027, 1, 1, 9));
    expect(preset(at(2028, 2, 28, 12), 'tomorrow')).toEqual(at(2028, 2, 29, 9));
  });

  it('Next week is the next Monday strictly after today, 9:00 AM', () => {
    // 3 Oct 2026 is a Saturday.
    expect(preset(at(2026, 10, 3, 10), 'next_week')).toEqual(at(2026, 10, 5, 9));
    // Sunday: tomorrow is Monday.
    expect(preset(at(2026, 10, 4, 10), 'next_week')).toEqual(at(2026, 10, 5, 9));
    // Monday (even before 9 AM): the Monday after.
    expect(preset(at(2026, 10, 5, 7), 'next_week')).toEqual(at(2026, 10, 12, 9));
    // Month and year rollover.
    expect(preset(at(2026, 12, 30, 10), 'next_week')).toEqual(at(2027, 1, 4, 9));
  });

  it('custom edges: 1 minute to 365 days', () => {
    const now = at(2026, 10, 3, 10);
    expect(isWithinReminderWindow(new Date(now.getTime() + 59_000), now)).toBe(false);
    expect(isWithinReminderWindow(new Date(now.getTime() + 60_000), now)).toBe(true);
    expect(isWithinReminderWindow(new Date(now.getTime() + 365 * 86_400_000), now)).toBe(true);
    expect(isWithinReminderWindow(new Date(now.getTime() + 365 * 86_400_000 + 1), now)).toBe(false);
    expect(isWithinReminderWindow(new Date(Number.NaN), now)).toBe(false);
  });

  it('copy: the toast and the custom summary read local time', () => {
    const now = at(2026, 10, 3, 10);
    expect(reminderSetCopy(at(2026, 10, 4, 9), now)).toBe('Reminder set for tomorrow 9:00 AM');
    expect(reminderSetCopy(at(2026, 10, 3, 15, 5), now)).toBe('Reminder set for today 3:05 PM');
    expect(reminderSummary(at(2026, 10, 7, 11, 30), now)).toBe('Reminds you Wed 7 Oct at 11:30 AM');
  });

  it('minutesAhead never lands before the lead', () => {
    const now = at(2026, 10, 3, 10, 0, 1);
    expect(minutesAhead(now, 60_000).getTime() - now.getTime()).toBeGreaterThanOrEqual(60_000);
  });
});

describe('mapReminderError', () => {
  it('not found is silent (null), range has its copy, the rest is the action copy', () => {
    expect(mapReminderError('message not found')).toBeNull();
    expect(mapReminderError('reminder must be between 1 minute and 1 year from now')).toBe(
      'Pick a time at least 1 minute from now',
    );
    expect(mapReminderError('boom')).toBe("Couldn't set the reminder. Try again.");
    expect(mapReminderError('permission denied for table chat_reminders')).toBe(
      "Couldn't set the reminder. You don't have access to do this.",
    );
  });
});

describe('the ring: one timer for the next due reminder', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('picks the soonest pending, unrung, not long overdue', () => {
    const now = Date.parse('2026-10-03T10:00:00Z');
    const rows = [
      reminder({ id: 'late', remind_at: '2026-10-03T12:00:00Z' }),
      reminder({ id: 'old', remind_at: new Date(now - RING_GRACE_MS - 1).toISOString() }),
      reminder({ id: 'rung', remind_at: '2026-10-03T10:05:00Z' }),
      reminder({ id: 'next', remind_at: '2026-10-03T10:10:00Z' }),
      reminder({ id: 'gone', remind_at: '2026-10-03T10:01:00Z', cancelled_at: 'x' }),
    ];
    expect(nextToRing(rows, now, new Set(['rung']))?.id).toBe('next');
  });

  it('caps the timeout and never goes negative', () => {
    expect(ringDelayMs(1000, 5000)).toBe(0);
    expect(ringDelayMs(10 * MAX_TIMER_MS, 0)).toBe(MAX_TIMER_MS);
    expect(ringDelayMs(90_000, 30_000)).toBe(60_000);
  });

  it('fires on the exact minute and clears on cancel (unmount)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T10:00:30Z'));
    const onRing = vi.fn();
    const rows = [reminder({ id: 'a', remind_at: '2026-10-03T10:02:00Z' })];
    const cancel = armRing({
      rows,
      now: () => Date.now(),
      rung: new Set(),
      onRing,
      onRearm: vi.fn(),
    });
    vi.advanceTimersByTime(89_999);
    expect(onRing).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRing).toHaveBeenCalledWith(rows[0]);

    const second = vi.fn();
    const cancel2 = armRing({
      rows: [reminder({ id: 'b', remind_at: '2026-10-03T10:05:00Z' })],
      now: () => Date.now(),
      rung: new Set(),
      onRing: second,
      onRearm: vi.fn(),
    });
    cancel2();
    vi.advanceTimersByTime(10 * 60_000);
    expect(second).not.toHaveBeenCalled();
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a far reminder re-arms after the cap instead of ringing early', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T10:00:00Z'));
    const onRing = vi.fn();
    const onRearm = vi.fn();
    armRing({
      rows: [reminder({ remind_at: '2026-10-05T10:00:00Z' })],
      now: () => Date.now(),
      rung: new Set(),
      onRing,
      onRearm,
    });
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(onRing).not.toHaveBeenCalled();
    expect(onRearm).toHaveBeenCalledTimes(1);
  });

  it('nothing pending arms nothing', () => {
    vi.useFakeTimers();
    armRing({ rows: [], now: () => 0, rung: new Set(), onRing: vi.fn(), onRearm: vi.fn() });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('missed on open', () => {
  const lastSeen = Date.parse('2026-10-03T08:00:00Z');
  const rows = [
    { createdAt: '2026-10-03T09:00:00Z', readAt: null, reminderId: 'a' },
    { createdAt: '2026-10-03T09:30:00Z', readAt: null, reminderId: 'b' },
    { createdAt: '2026-10-03T07:00:00Z', readAt: null, reminderId: 'before' },
    { createdAt: '2026-10-03T09:40:00Z', readAt: '2026-10-03T09:41:00Z', reminderId: 'read' },
    { createdAt: '2026-10-03T09:50:00Z', readAt: null, reminderId: 'rung' },
  ];

  it('counts unread rows created after last seen, minus rung ones', () => {
    expect(missedCount(rows, lastSeen, new Set(['rung']))).toBe(2);
  });

  it('a first run on this device counts none', () => {
    expect(missedCount(rows, null, new Set())).toBe(0);
  });

  it('copy', () => {
    expect(missedCopy(1)).toBe('You missed 1 reminder');
    expect(missedCopy(3)).toBe('You missed 3 reminders');
  });
});

describe('per-device storage is wrapped', () => {
  it('round-trips through a store', () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    writeLastSeen('u1', 123, store);
    expect(readLastSeen('u1', store)).toBe(123);
    writeRung('u1', ['a', 'b'], store);
    expect(readRung('u1', store)).toEqual(['a', 'b']);
  });

  it('a throwing store reads as nothing and writes are ignored', () => {
    const store = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(readLastSeen('u1', store)).toBeNull();
    expect(readRung('u1', store)).toEqual([]);
    expect(() => writeLastSeen('u1', 1, store)).not.toThrow();
    expect(() => writeRung('u1', ['a'], store)).not.toThrow();
  });

  it('garbage reads as nothing', () => {
    const store = { getItem: () => 'not json', setItem: () => undefined };
    expect(readRung('u1', store)).toEqual([]);
    expect(readLastSeen('u1', { getItem: () => 'abc', setItem: () => undefined })).toBeNull();
  });
});

describe('RPC wrappers send p_trace_id', () => {
  function rpcClient(error: { message: string } | null = null) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { abortSignal: () => Promise.resolve({ data: null, error }) };
      },
    };
    return { client: client as unknown as Parameters<typeof setReminder>[0]['client'], calls };
  }

  it('chat_reminder_set', async () => {
    const { client, calls } = rpcClient();
    const res = await setReminder({
      client,
      id: 'id-1',
      messageId: 'm1',
      channelId: 'c1',
      remindAt: new Date('2026-10-04T03:30:00Z'),
      traceId: 'trace-1',
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      {
        name: 'chat_reminder_set',
        args: {
          p_id: 'id-1',
          p_message_id: 'm1',
          p_channel_id: 'c1',
          p_remind_at: '2026-10-04T03:30:00.000Z',
          p_trace_id: 'trace-1',
        },
      },
    ]);
  });

  it('chat_reminder_cancel, and a refusal resolves (never throws)', async () => {
    const { client, calls } = rpcClient({ message: 'boom' });
    const res = await cancelReminder({ client, id: 'r1', traceId: 'trace-2' });
    expect(calls[0]).toEqual({
      name: 'chat_reminder_cancel',
      args: { p_id: 'r1', p_trace_id: 'trace-2' },
    });
    expect(res).toMatchObject({ ok: false, message: 'boom' });
  });
});
