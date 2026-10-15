import { describe, expect, it } from 'vitest';
import {
  applyTaskField,
  civilHourToUtcIso,
  collapseTaskRun,
  commitmentLine,
  createTask,
  dateStripDays,
  dueLabel,
  dueSelection,
  eventText,
  eventsInWindow,
  groupTasks,
  hasUnseenChanges,
  holdOrder,
  lastChangeLine,
  nextNumberPreview,
  readChannelTasks,
  readTasksByIds,
  isPastHour,
  openOrTodayFilter,
  startOfTodayIso,
  readTaskEvents,
  setTaskField,
  shareSnapshot,
  type ChatTask,
  type TaskEvent,
} from '@/lib/chat/tasks';
import type { Client } from '@srtdio/rpc';

// 13 Oct 2026, 2 pm UTC (7:30 pm in Kolkata).
const NOW = Date.parse('2026-10-13T14:00:00.000Z');
const UTC = 'UTC';

function task(over: Partial<ChatTask>): ChatTask {
  return {
    id: 't1',
    channelId: 'c1',
    number: 1,
    title: 'Reel cut',
    note: null,
    side: 'agency',
    status: 'todo',
    priority: 2,
    dueAt: null,
    dueSetBy: null,
    dueSetAt: null,
    duePassedAt: null,
    createdBy: 'u1',
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
    ...over,
  };
}

function ev(over: Partial<TaskEvent>): TaskEvent {
  return {
    id: 'e1',
    taskId: 't1',
    channelId: 'c1',
    actorId: 'u2',
    kind: 'created',
    oldValue: null,
    newValue: 'Reel cut',
    createdAt: '2026-10-13T10:00:00.000Z',
    ...over,
  };
}

describe('civilHourToUtcIso: the workspace civil date + hour as UTC', () => {
  it('Asia/Kolkata (+5:30, no DST)', () => {
    expect(civilHourToUtcIso('2026-10-14', 20, 'Asia/Kolkata')).toBe('2026-10-14T14:30:00.000Z');
    expect(civilHourToUtcIso('2026-10-14', 10, 'Asia/Kolkata')).toBe('2026-10-14T04:30:00.000Z');
  });
  it('America/New_York across both DST changes', () => {
    expect(civilHourToUtcIso('2026-03-07', 12, 'America/New_York')).toBe(
      '2026-03-07T17:00:00.000Z',
    );
    expect(civilHourToUtcIso('2026-03-08', 12, 'America/New_York')).toBe(
      '2026-03-08T16:00:00.000Z',
    );
    expect(civilHourToUtcIso('2026-11-01', 10, 'America/New_York')).toBe(
      '2026-11-01T15:00:00.000Z',
    );
  });
  it('round-trips through dueSelection', () => {
    const iso = civilHourToUtcIso('2026-10-16', 17, 'Asia/Kolkata');
    expect(dueSelection(iso, NOW, 'Asia/Kolkata')).toEqual({
      civil: '2026-10-16',
      hour: 17,
      which: 'other',
    });
  });
});

describe('dueLabel', () => {
  it('today, tomorrow, another date, none', () => {
    expect(dueLabel(task({ dueAt: '2026-10-13T20:00:00Z' }), NOW, UTC)).toEqual({
      text: '8 pm',
      tone: 'today',
    });
    expect(dueLabel(task({ dueAt: '2026-10-14T12:00:00Z' }), NOW, UTC)).toEqual({
      text: 'Tmrw 12 pm',
      tone: 'later',
    });
    expect(dueLabel(task({ dueAt: '2026-10-16T17:00:00Z' }), NOW, UTC)).toEqual({
      text: '16 Oct 5 pm',
      tone: 'later',
    });
    expect(dueLabel(task({}), NOW, UTC)).toEqual({ text: '–', tone: 'none' });
    expect(dueLabel(task({ dueAt: '2026-10-13T20:30:00Z' }), NOW, UTC).text).toBe('8:30 pm');
  });
  it('missed: the clock is past it, or the timer fired', () => {
    expect(dueLabel(task({ dueAt: '2026-10-13T13:00:00Z' }), NOW, UTC)).toEqual({
      text: '1 pm',
      tone: 'missed',
    });
    expect(
      dueLabel(
        task({ dueAt: '2026-10-13T20:00:00Z', duePassedAt: '2026-10-13T13:59:00Z' }),
        NOW,
        UTC,
      ).tone,
    ).toBe('missed');
  });
  it('reads on the workspace clock (Kolkata: 2 pm UTC is already 7:30 pm)', () => {
    expect(dueLabel(task({ dueAt: '2026-10-13T18:30:00Z' }), NOW, 'Asia/Kolkata').text).toBe(
      'Tmrw 12 am',
    );
  });
});

describe('commitmentLine', () => {
  const nameOf = (id: string): string => (id === 'u3' ? 'Chitra' : 'Member');
  it('names who set it and when', () => {
    expect(
      commitmentLine(
        task({ dueAt: '2026-10-13T20:00:00Z', dueSetBy: 'u3', dueSetAt: '2026-10-13T11:05:00Z' }),
        nameOf,
        NOW,
        UTC,
      ),
    ).toEqual({ text: 'Due today 8 pm · set by Chitra at 11:05 am', missed: false });
  });
  it('missed and none', () => {
    expect(
      commitmentLine(
        task({ dueAt: '2026-10-13T15:00:00Z', duePassedAt: 'x', dueSetBy: 'u3', dueSetAt: null }),
        nameOf,
        NOW,
        UTC,
      ),
    ).toEqual({ text: 'Missed: due today 3 pm · set by Chitra', missed: true });
    expect(commitmentLine(task({}), nameOf, NOW, UTC).text).toBe('No due time yet');
  });
});

describe('groups and order', () => {
  const tasks = [
    task({ id: 'a', number: 3, priority: 2 }),
    task({ id: 'b', number: 5, priority: 0 }),
    task({ id: 'c', number: 1, priority: 2 }),
    task({ id: 'd', number: 2, priority: 1, side: 'client', status: 'waiting' }),
    task({ id: 'e', number: 4, status: 'shared', updatedAt: '2026-10-13T09:00:00Z' }),
    task({ id: 'f', number: 6, status: 'approved', updatedAt: '2026-10-12T09:00:00Z' }),
  ];
  it('open by priority then number, per side; done today only', () => {
    const g = groupTasks(tasks, NOW, UTC);
    expect(g.agency.map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(g.client.map((t) => t.id)).toEqual(['d']);
    expect(g.done.map((t) => t.id)).toEqual(['e']);
  });
  it('holds the order while a row is expanded, appending newcomers', () => {
    const fresh = [task({ id: 'x' }), task({ id: 'a' }), task({ id: 'n' })];
    expect(holdOrder(fresh, ['a', 'gone', 'x']).map((t) => t.id)).toEqual(['a', 'x', 'n']);
    // A row that left the group (closed) stays where it was until collapse,
    // and is not shown twice in the group it moved to.
    const moved = task({ id: 'm', status: 'shared' });
    const all = new Map([...fresh, moved].map((t) => [t.id, t] as const));
    const held = new Set(['m', 'a']);
    expect(holdOrder([task({ id: 'a' })], ['m', 'a'], all, held).map((t) => t.id)).toEqual([
      'm',
      'a',
    ]);
    expect(holdOrder([moved], [], all, held)).toEqual([]);
  });
  it('previews the next number', () => {
    expect(nextNumberPreview(tasks)).toBe(7);
    expect(nextNumberPreview([])).toBe(1);
  });
  it('applies a write optimistically', () => {
    const t = task({});
    expect(applyTaskField(t, 'priority', '0', 'me', 'now').priority).toBe(0);
    expect(applyTaskField(t, 'status', 'shared', 'me', 'now').status).toBe('shared');
    expect(applyTaskField(t, 'note', '  ', 'me', 'now').note).toBeNull();
    const due = applyTaskField(t, 'due', '2026-10-14T12:00:00Z', 'me', 'now');
    expect(due).toMatchObject({ dueAt: '2026-10-14T12:00:00Z', dueSetBy: 'me', dueSetAt: 'now' });
    expect(applyTaskField(due, 'due', '', 'me', 'now').dueAt).toBeNull();
  });
});

describe('event text: every kind', () => {
  const ref = { number: 12, title: 'Reel cut', side: 'agency' as const };
  const text = (over: Partial<TaskEvent>): string => eventText(ev(over), ref, NOW, UTC);
  it('reads each change', () => {
    expect(text({ kind: 'created', newValue: 'Reel cut' })).toBe('added 12 Reel cut · Creators');
    expect(text({ kind: 'status', oldValue: 'todo', newValue: 'shared' })).toBe(
      '12 Reel cut → Shared',
    );
    expect(text({ kind: 'priority', oldValue: '1', newValue: '0' })).toBe('12 P1 → P0');
    expect(text({ kind: 'due', newValue: '2026-10-13T20:00:00+00:00' })).toBe('12 due today 8 pm');
    expect(text({ kind: 'due', newValue: null })).toBe('12 due cleared');
    expect(text({ kind: 'side', newValue: 'client' })).toBe('12 moved to Approvers');
    expect(text({ kind: 'title', oldValue: 'Old', newValue: 'New cut' })).toBe(
      'renamed 12 to New cut',
    );
    expect(text({ kind: 'note', newValue: 'x' })).toBe('12 note updated');
    expect(text({ kind: 'due_passed', oldValue: '2026-10-13T15:00:00+00:00', actorId: null })).toBe(
      '3 pm passed · 12 Reel cut',
    );
  });
  it('the footer names who, what and when', () => {
    const byId = new Map([['t1', task({ number: 12 })]]);
    expect(
      lastChangeLine(
        [ev({ kind: 'status', newValue: 'approved', createdAt: '2026-10-13T13:30:00Z' })],
        byId,
        () => 'Chitra',
        NOW,
        UTC,
      ),
    ).toBe('Last change: Chitra · 12 Reel cut → Approved · 1:30 pm');
    expect(lastChangeLine([], byId, () => 'x', NOW, UTC)).toBeNull();
  });
});

describe('thread lines', () => {
  const at = (s: number): string => new Date(NOW + s * 1000).toISOString();
  it('collapses 4+ by one actor within 2 minutes; fewer stay single', () => {
    const burst = [0, 20, 40, 60].map((s, k) => ev({ id: `b${k}`, createdAt: at(s) }));
    const lines = collapseTaskRun([
      ...burst,
      ev({ id: 'other', actorId: 'u9', createdAt: at(70) }),
    ]);
    expect(lines.map((l) => l.kind)).toEqual(['many', 'one']);
    const three = [0, 20, 40].map((s, k) => ev({ id: `t${k}`, createdAt: at(s) }));
    expect(collapseTaskRun(three).map((l) => l.kind)).toEqual(['one', 'one', 'one']);
    const slow = [0, 50, 100, 150].map((s, k) => ev({ id: `s${k}`, createdAt: at(s) }));
    expect(collapseTaskRun(slow).map((l) => l.kind)).toEqual(['one', 'one', 'one', 'one']);
  });
  it('the timer never collapses', () => {
    const timer = [0, 1, 2, 3].map((s, k) => ev({ id: `d${k}`, actorId: null, createdAt: at(s) }));
    expect(collapseTaskRun(timer).every((l) => l.kind === 'one')).toBe(true);
  });
  it('keeps only the loaded window while older history exists', () => {
    const events = [ev({ id: 'old', createdAt: at(-100) }), ev({ id: 'new', createdAt: at(10) })];
    expect(eventsInWindow(events, NOW, true).map((e) => e.id)).toEqual(['new']);
    expect(eventsInWindow(events, NOW, false).map((e) => e.id)).toEqual(['old', 'new']);
  });
  it('the dot: a newer change by someone else (the timer counts)', () => {
    const mine = ev({ actorId: 'me', createdAt: at(10) });
    const theirs = ev({ actorId: 'u2', createdAt: at(5) });
    expect(hasUnseenChanges([theirs, mine], 'me', null)).toBe(true);
    expect(hasUnseenChanges([theirs, mine], 'me', NOW + 6000)).toBe(false);
    expect(hasUnseenChanges([theirs], 'me', NOW)).toBe(true);
    expect(hasUnseenChanges([mine], 'me', null)).toBe(false);
    expect(hasUnseenChanges([ev({ actorId: null })], 'me', null)).toBe(true);
  });
});

describe('today on the workspace clock', () => {
  it('starts today at local midnight', () => {
    expect(startOfTodayIso(NOW, UTC)).toBe('2026-10-13T00:00:00.000Z');
    expect(startOfTodayIso(NOW, 'Asia/Kolkata')).toBe('2026-10-12T18:30:00.000Z');
    expect(openOrTodayFilter(NOW, UTC)).toBe(
      'status.in.(todo,waiting),updated_at.gte.2026-10-13T00:00:00.000Z',
    );
  });
  it('past hours: today up to and including the current hour, never another day', () => {
    // 2 pm UTC: 10 am to 2 pm are over today; 3 pm is open; tomorrow is open.
    expect(isPastHour('2026-10-13', 14, NOW, UTC)).toBe(true);
    expect(isPastHour('2026-10-13', 10, NOW, UTC)).toBe(true);
    expect(isPastHour('2026-10-13', 15, NOW, UTC)).toBe(false);
    expect(isPastHour('2026-10-14', 10, NOW, UTC)).toBe(false);
    // Kolkata: it is already 7:30 pm there, so 7 pm is over and 8 pm is not.
    expect(isPastHour('2026-10-13', 19, NOW, 'Asia/Kolkata')).toBe(true);
    expect(isPastHour('2026-10-13', 20, NOW, 'Asia/Kolkata')).toBe(false);
  });
});

describe('date strip', () => {
  it('lists the 14 days after tomorrow', () => {
    const days = dateStripDays(NOW, UTC);
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ civil: '2026-10-15', weekday: 'Thu', day: 15 });
    expect(days[13]?.civil).toBe('2026-10-28');
  });
});

describe('shareSnapshot', () => {
  const tasks = [
    task({ id: 'a', number: 3, title: 'Hook copy', priority: 0, dueAt: '2026-10-13T20:00:00Z' }),
    task({ id: 'b', number: 5, title: 'Reel cut', dueAt: '2026-10-13T10:00:00Z' }),
    task({
      id: 'c',
      number: 2,
      title: 'Approve grid',
      side: 'client',
      dueAt: '2026-10-14T12:00:00Z',
    }),
    task({ id: 'd', number: 7, title: 'Moodboard', side: 'client', dueAt: '2026-10-16T17:00:00Z' }),
    task({ id: 'e', number: 4, status: 'approved', updatedAt: '2026-10-13T09:00:00Z' }),
    task({ id: 'f', number: 6, status: 'rejected', updatedAt: '2026-10-13T09:30:00Z' }),
  ];
  it('formats the plain-text snapshot on the workspace clock', () => {
    expect(shareSnapshot({ chatName: 'Launch crew', tasks, nowMs: NOW, timeZone: UTC })).toBe(
      [
        'Task list · Launch crew · 13 Oct, 2 pm',
        'Creators',
        '3. Hook copy · P0 · today 8 pm',
        '5. Reel cut · P2 · today 10 am (missed)',
        'Approvers',
        '2. Approve grid · P2 · tomorrow 12 pm',
        '7. Moodboard · P2 · 16 Oct 5 pm',
        'Done today: 4, 6',
      ].join('\n'),
    );
  });
  it('leaves out an empty side and the done line when nothing closed today', () => {
    const text = shareSnapshot({
      chatName: 'X',
      tasks: [tasks[2] as ChatTask],
      nowMs: NOW,
      timeZone: UTC,
    });
    expect(text).toBe(
      'Task list · X · 13 Oct, 2 pm\nApprovers\n2. Approve grid · P2 · tomorrow 12 pm',
    );
  });
  it('past the limit: drops the done line, then trailing items, ending "+k more"', () => {
    const full = shareSnapshot({ chatName: 'X', tasks, nowMs: NOW, timeZone: UTC });
    const noDone = shareSnapshot({
      chatName: 'X',
      tasks,
      nowMs: NOW,
      timeZone: UTC,
      max: full.length - 1,
    });
    expect(noDone).not.toContain('Done today');
    expect(noDone).toContain('7. Moodboard');
    const cut = shareSnapshot({ chatName: 'X', tasks, nowMs: NOW, timeZone: UTC, max: 110 });
    expect(cut.length).toBeLessThanOrEqual(110);
    expect(cut).toMatch(/\n\+\d more$/);
    expect(cut).toContain('3. Hook copy');
    expect(cut).not.toContain('Moodboard');
    const many = Array.from({ length: 300 }, (_, k) =>
      task({ id: `m${k}`, number: k + 1, title: 'A long enough item title for the limit' }),
    );
    const big = shareSnapshot({ chatName: 'X', tasks: many, nowMs: NOW, timeZone: UTC });
    expect(big.length).toBeLessThanOrEqual(5000);
    expect(big).toMatch(/\+\d+ more$/);
  });
});

/** A recording fake of the slice of the Supabase client the reads and writes use. */
function fakeClient(answer: { data: unknown; error: { message: string } | null }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const query = {
    select: (...args: unknown[]) => (calls.push({ method: 'select', args }), query),
    eq: (...args: unknown[]) => (calls.push({ method: 'eq', args }), query),
    gt: (...args: unknown[]) => (calls.push({ method: 'gt', args }), query),
    lt: (...args: unknown[]) => (calls.push({ method: 'lt', args }), query),
    or: (...args: unknown[]) => (calls.push({ method: 'or', args }), query),
    in: (...args: unknown[]) => (calls.push({ method: 'in', args }), query),
    order: (...args: unknown[]) => (calls.push({ method: 'order', args }), query),
    limit: (...args: unknown[]) => (calls.push({ method: 'limit', args }), query),
    then: (resolve: (v: unknown) => void) => resolve(answer),
  };
  const client = {
    from: (table: string) => (calls.push({ method: 'from', args: [table] }), query),
    rpc: (fn: string, args: unknown) => {
      calls.push({ method: 'rpc', args: [fn, args] });
      return Promise.resolve(answer);
    },
  };
  return { client: client as unknown as Client, calls };
}

describe('reads and writes', () => {
  it("reads open items plus today's changes: one query, explicit columns, one or()", async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    const res = await readChannelTasks(client, 'c1', { nowMs: NOW, timeZone: 'Asia/Kolkata' });
    expect(res).toEqual({ ok: true, data: [] });
    expect(calls.map((c) => c.method)).toEqual(['from', 'select', 'eq', 'or']);
    expect(String(calls[1]?.args[0])).toContain('due_set_by');
    expect(calls[3]?.args).toEqual([
      'status.in.(todo,waiting),updated_at.gte.2026-10-12T18:30:00.000Z',
    ]);
  });
  it('reads tasks by id in one IN read, none for no ids', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    expect(await readTasksByIds(client, [])).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(0);
    await readTasksByIds(client, ['a', 'b']);
    expect(calls.map((c) => c.method)).toEqual(['from', 'select', 'in']);
    expect(calls[2]?.args).toEqual(['id', ['a', 'b']]);
  });
  it('reads a window of events newest first and returns them oldest first', async () => {
    const rows = [
      {
        id: 'e2',
        task_id: 't',
        channel_id: 'c1',
        workspace_id: 'w',
        actor_user_id: 'u',
        kind: 'note',
        old_value: null,
        new_value: null,
        created_at: '2026-10-13T11:00:00Z',
      },
      {
        id: 'e1',
        task_id: 't',
        channel_id: 'c1',
        workspace_id: 'w',
        actor_user_id: 'u',
        kind: 'bogus',
        old_value: null,
        new_value: null,
        created_at: '2026-10-13T10:00:00Z',
      },
    ];
    const { client, calls } = fakeClient({ data: rows, error: null });
    const res = await readTaskEvents(client, 'c1', { sinceIso: 'a', untilIso: 'b' });
    expect(res.ok && res.data.events.map((e) => e.id)).toEqual(['e2']);
    expect(calls.map((c) => c.method)).toEqual([
      'from',
      'select',
      'eq',
      'gt',
      'lt',
      'order',
      'limit',
    ]);
  });
  it('writes pass an explicit p_trace_id', async () => {
    const created = fakeClient({ data: 'new-id', error: null });
    expect(
      await createTask({
        client: created.client,
        channelId: 'c1',
        title: ' Hook ',
        side: 'client',
        traceId: 'tr',
      }),
    ).toEqual({ ok: true, data: 'new-id' });
    expect(created.calls[0]?.args).toEqual([
      'chat_task_create',
      {
        p_channel_id: 'c1',
        p_title: 'Hook',
        p_note: null,
        p_side: 'client',
        p_priority: 2,
        p_due_at: null,
        p_trace_id: 'tr',
      },
    ]);
    const set = fakeClient({ data: null, error: { message: 'not a member of this chat' } });
    expect(
      await setTaskField({
        client: set.client,
        taskId: 't1',
        field: 'due',
        value: '',
        traceId: 'tr',
      }),
    ).toEqual({ ok: false, message: 'not a member of this chat' });
    expect(set.calls[0]?.args).toEqual([
      'chat_task_set',
      { p_task_id: 't1', p_field: 'due', p_value: '', p_trace_id: 'tr' },
    ]);
  });
});
