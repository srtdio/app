// W9 regressions: edit then Save, one chat line per create, the 'edited' and
// 'deleted' lines, deleted tasks out of every list, the 9 pm due default, the
// header counts and the date strip's month.
import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  applyTaskChanges,
  collapseTaskRun,
  countsLine,
  createTask,
  dateStripDays,
  deleteTask,
  diffDraft,
  draftOf,
  dueForDay,
  dueHourLine,
  dueSelection,
  editedFields,
  eventText,
  groupTasks,
  readChannelTasks,
  saveTask,
  type ChatTask,
  type TaskEvent,
} from '@/lib/chat/tasks';
import { stillDue } from '@/lib/chat/task-ring';

// 13 Oct 2026, 2 pm UTC.
const NOW = Date.parse('2026-10-13T14:00:00.000Z');
const UTC = 'UTC';

function task(over: Partial<ChatTask>): ChatTask {
  return {
    id: 't1',
    channelId: 'c1',
    number: 3,
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
    deletedAt: null,
    ...over,
  };
}

function ev(over: Partial<TaskEvent>): TaskEvent {
  return {
    id: 'e1',
    taskId: 't1',
    channelId: 'c1',
    actorId: 'u2',
    kind: 'edited',
    oldValue: null,
    newValue: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    ...over,
  };
}

function rpcClient(answer: { data: unknown; error: { message: string } | null }) {
  const calls: unknown[][] = [];
  const query = {
    select: () => query,
    eq: () => query,
    or: () => query,
    then: (resolve: (v: unknown) => void) => resolve(answer),
  };
  const client = {
    from: () => query,
    rpc: (fn: string, args: unknown) => {
      calls.push([fn, args]);
      return Promise.resolve(answer);
    },
  };
  return { client: client as unknown as Client, calls };
}

describe('fix 1: edit locally, Save sends only the changed fields', () => {
  it('diffDraft names only what changed; an unchanged draft is empty', () => {
    const t = task({ dueAt: '2026-10-14T21:00:00.000Z' });
    expect(diffDraft(t, draftOf(t))).toEqual({});
    const changes = diffDraft(t, {
      ...draftOf(t),
      priority: 0,
      dueAt: '2026-10-14T12:00:00.000Z',
      title: '  Reel cut  ',
    });
    expect(changes).toEqual({ priority: 0, due: '2026-10-14T12:00:00.000Z' });
    expect(applyTaskChanges(t, changes, 'me', '2026-10-13T14:00:00.000Z')).toMatchObject({
      priority: 0,
      dueAt: '2026-10-14T12:00:00.000Z',
      dueSetBy: 'me',
      title: 'Reel cut',
    });
  });
  it('saveTask makes one chat_task_save call with only those keys and the trace id', async () => {
    const { client, calls } = rpcClient({ data: null, error: null });
    await saveTask({ client, taskId: 't1', changes: { priority: 0, due: null }, traceId: 'tr' });
    expect(calls).toEqual([
      [
        'chat_task_save',
        { p_task_id: 't1', p_changes: { priority: 0, due: '' }, p_trace_id: 'tr' },
      ],
    ]);
  });
});

describe('fix 2: a new task is one chat_task_create call', () => {
  it('carries the title, priority and due together', async () => {
    const { client, calls } = rpcClient({ data: 'new-id', error: null });
    const res = await createTask({
      client,
      channelId: 'c1',
      title: ' Hook ',
      side: 'agency',
      priority: 0,
      dueAt: '2026-10-13T21:00:00.000Z',
      traceId: 'tr',
    });
    expect(res).toEqual({ ok: true, data: 'new-id' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'chat_task_create',
      {
        p_channel_id: 'c1',
        p_title: 'Hook',
        p_note: null,
        p_side: 'agency',
        p_priority: 0,
        p_due_at: '2026-10-13T21:00:00.000Z',
        p_trace_id: 'tr',
      },
    ]);
  });
});

describe("fix 3: 'edited' and 'deleted' lines", () => {
  const ref = { number: 3, title: 'Reel cut', side: null };
  it('names the changed fields from the JSON, in field order', () => {
    const edited = ev({
      oldValue: JSON.stringify({ due: null, priority: 2 }),
      newValue: JSON.stringify({ due: '2026-10-14T21:00:00Z', priority: 0 }),
    });
    expect(editedFields(edited)).toEqual(['priority', 'due']);
    expect(eventText(edited, ref, NOW, UTC)).toBe('#3 updated: priority, due');
    expect(eventText(ev({ kind: 'deleted' }), ref, NOW, UTC)).toBe('#3 deleted');
    // Existing kinds read as before.
    expect(eventText(ev({ kind: 'note' }), ref, NOW, UTC)).toBe('3 note updated');
  });
  it('still collapses 4+ quick changes by one person, edited lines included', () => {
    const run = [0, 1, 2, 3].map((k) =>
      ev({ id: `e${k}`, createdAt: new Date(NOW + k * 10_000).toISOString() }),
    );
    const lines = collapseTaskRun(run);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('many');
    expect(collapseTaskRun(run.slice(0, 3)).map((l) => l.kind)).toEqual(['one', 'one', 'one']);
  });
});

describe('fix 4: deleted tasks never show', () => {
  it('groupTasks leaves a deleted task out', () => {
    const groups = groupTasks(
      [task({ id: 'a' }), task({ id: 'b', deletedAt: '2026-10-13T10:00:00Z' })],
      NOW,
      UTC,
    );
    expect(groups.agency.map((t) => t.id)).toEqual(['a']);
  });
  it('the list read drops deleted rows; a deleted task never rings', async () => {
    const row = {
      id: 'x',
      channel_id: 'c1',
      workspace_id: 'w',
      number: 1,
      title: 'Gone',
      note: null,
      side: 'agency',
      status: 'todo',
      priority: 2,
      due_at: null,
      due_set_by: null,
      due_set_at: null,
      due_passed_at: null,
      created_by: null,
      created_at: '2026-10-13T10:00:00Z',
      updated_at: '2026-10-13T10:00:00Z',
      deleted_at: '2026-10-13T11:00:00Z',
      deleted_by: 'u1',
    };
    const { client } = rpcClient({
      data: [row, { ...row, id: 'y', deleted_at: null }],
      error: null,
    });
    const res = await readChannelTasks(client, 'c1', { nowMs: NOW, timeZone: UTC });
    expect(res.ok && res.data.map((t) => t.id)).toEqual(['y']);
    const armed = {
      id: 'x',
      channel_id: 'c1',
      number: 1,
      title: 'Gone',
      due_at: '2026-10-13T21:00:00Z',
    };
    expect(stillDue(armed, { ...armed, status: 'todo', deleted_at: '2026-10-13T11:00:00Z' })).toBe(
      false,
    );
  });
  it('deleteTask is one chat_task_delete call with the trace id', async () => {
    const { client, calls } = rpcClient({ data: null, error: null });
    expect(await deleteTask({ client, taskId: 't1', traceId: 'tr' })).toEqual({
      ok: true,
      data: null,
    });
    expect(calls).toEqual([['chat_task_delete', { p_task_id: 't1', p_trace_id: 'tr' }]]);
  });
});

describe('fix 5: a day without a time is 9 pm', () => {
  it('defaults to 9 pm, keeps an hour already set, and says "Due 9 pm"', () => {
    const iso = dueForDay('2026-10-15', null, NOW, UTC);
    expect(iso).toBe('2026-10-15T21:00:00.000Z');
    expect(dueSelection(iso, NOW, UTC)?.hour).toBe(21);
    expect(dueHourLine(21)).toBe('Due 9 pm');
    expect(dueForDay('2026-10-16', '2026-10-15T12:00:00.000Z', NOW, UTC)).toBe(
      '2026-10-16T12:00:00.000Z',
    );
  });
});

describe('fix 7: header counts and the month on the date strip', () => {
  it('reads "2 open for creators · 2 for approvers"', () => {
    expect(countsLine(2, 2)).toBe('2 open for creators · 2 for approvers');
  });
  it('shows the month on the first tile and on the 1st only', () => {
    // 20 Oct: the strip runs 22 Oct to 4 Nov.
    const days = dateStripDays(Date.parse('2026-10-20T08:00:00Z'), UTC);
    expect(days[0]).toMatchObject({ civil: '2026-10-22', month: 'Oct' });
    expect(days[1]?.month).toBeNull();
    const first = days.find((d) => d.civil === '2026-11-01');
    expect(first?.month).toBe('Nov');
    expect(days.filter((d) => d.month !== null)).toHaveLength(2);
  });
});
