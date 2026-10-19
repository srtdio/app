import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  EDITING_REFRESH_MS,
  EDITING_TTL_MS,
  EMPTY_DRAFT,
  applyChanges,
  batchPayload,
  batchRowText,
  batchRows,
  collapseTaskRun,
  conflictLine,
  dropTask,
  editField,
  editedTasksLabel,
  editingLabel,
  editingSignalStep,
  eventsInWindow,
  hasUnseenChanges,
  isDraftDirty,
  isEmptyPayload,
  keepMine,
  liveEditors,
  liveMerge,
  markText,
  marksSince,
  marksStrip,
  parseBatchResult,
  queueDelete,
  readChannelTasks,
  readTaskEvents,
  readTasksByIds,
  rowToTask,
  saveTaskBatch,
  shareSnapshot,
  taskRefOf,
  type ChatTask,
  type SheetDraft,
  type TaskEvent,
} from '@/lib/chat/tasks';

// 13 Oct 2026, 2 pm UTC.
const NOW = Date.parse('2026-10-13T14:00:00.000Z');
const UTC = 'UTC';
const T0 = '2026-10-12T09:00:00.000Z';

function task(over: Partial<ChatTask>): ChatTask {
  return {
    id: 't1',
    channelId: 'c1',
    number: 1,
    title: 'Reel cut',
    side: 'agency',
    status: 'todo',
    priority: 2,
    createdBy: 'u1',
    createdAt: T0,
    updatedAt: T0,
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
    kind: 'created',
    oldValue: null,
    newValue: 'Reel cut',
    createdAt: '2026-10-13T10:00:00.000Z',
    batchId: null,
    ...over,
  };
}

const at = (s: number): string => new Date(NOW + s * 1000).toISOString();
const mapOf = (...tasks: ChatTask[]) => new Map(tasks.map((t) => [t.id, t] as const));

describe('rows', () => {
  it('maps status to todo/done (older statuses read as to do) and drops due/side columns', () => {
    const row = {
      id: 'a',
      channel_id: 'c1',
      workspace_id: 'w',
      number: 4,
      title: 'Hook',
      side: 'client',
      status: 'waiting',
      priority: 0,
      created_by: null,
      created_at: T0,
      updated_at: T0,
      deleted_at: null,
    };
    expect(rowToTask(row as never)?.status).toBe('todo');
    expect(rowToTask({ ...row, status: 'done' } as never)?.status).toBe('done');
    expect(rowToTask({ ...row, priority: 7 } as never)).toBeNull();
  });
});

describe('draft: diff and no-op detection', () => {
  const a = task({ id: 'a', number: 1, title: 'Hook', priority: 2 });
  const b = task({ id: 'b', number: 2, title: 'Grid', priority: 1, updatedAt: at(-60) });
  const byId = mapOf(a, b);

  it('an empty draft is clean; a real change is dirty', () => {
    expect(isDraftDirty(EMPTY_DRAFT, byId)).toBe(false);
    expect(isDraftDirty(editField(EMPTY_DRAFT, a, { priority: 0 }), byId)).toBe(true);
  });

  it('change then revert is no change (title trimmed, priority back, untick)', () => {
    let d = editField(EMPTY_DRAFT, a, { priority: 0 });
    d = editField(d, a, { priority: 2 });
    d = editField(d, a, { title: '  Hook ' });
    d = editField(d, a, { status: 'done' });
    d = editField(d, a, { status: 'todo' });
    expect(isDraftDirty(d, byId)).toBe(false);
    expect(isEmptyPayload(batchPayload(d, byId))).toBe(true);
  });

  it('an empty title is no change; a new task needs a title', () => {
    expect(isDraftDirty(editField(EMPTY_DRAFT, a, { title: '   ' }), byId)).toBe(false);
    const blank: SheetDraft = {
      ...EMPTY_DRAFT,
      creates: [{ key: 'n', title: '  ', priority: 1, side: 'agency' }],
    };
    expect(isDraftDirty(blank, byId)).toBe(false);
  });

  it('remembers each task base the first time it is touched', () => {
    let d = editField(EMPTY_DRAFT, b, { priority: 0 });
    d = editField(d, { ...b, updatedAt: at(10) }, { title: 'Grid v2' });
    expect(d.bases.b).toBe(b.updatedAt);
  });
});

describe('batch payload', () => {
  const a = task({ id: 'a', number: 1, title: 'Hook', priority: 2 });
  const b = task({ id: 'b', number: 2, title: 'Grid', priority: 1 });
  const c = task({ id: 'c', number: 3, title: 'Copy' });
  const byId = mapOf(a, b, c);

  it('edits send only changed fields with base_updated_at; deletes are objects; creates keep side', () => {
    let d = editField(EMPTY_DRAFT, a, { priority: 0, title: 'Hook' });
    d = editField(d, b, { title: ' Grid v2 ', status: 'done' });
    d = queueDelete(d, c);
    d = { ...d, creates: [{ key: 'n1', title: ' Story ', priority: 1, side: 'client' }] };
    expect(batchPayload(d, byId)).toEqual({
      creates: [{ title: 'Story', priority: 1, side: 'client' }],
      edits: [
        { task_id: 'a', base_updated_at: T0, changes: { priority: 0 } },
        { task_id: 'b', base_updated_at: T0, changes: { title: 'Grid v2', status: 'done' } },
      ],
      deletes: [{ task_id: 'c', base_updated_at: T0 }],
    });
  });

  it('a task queued for delete sends no edit', () => {
    const d = queueDelete(editField(EMPTY_DRAFT, a, { priority: 0 }), a);
    expect(batchPayload(d, byId).edits).toEqual([]);
    expect(batchPayload(d, byId).deletes).toHaveLength(1);
  });

  it('applyChanges paints the edit', () => {
    expect(applyChanges(a, { title: 'X', status: 'done' })).toMatchObject({
      title: 'X',
      status: 'done',
      priority: 2,
    });
  });
});

describe('conflicts (both edited)', () => {
  const a = task({ id: 'a', number: 1, title: 'Hook', priority: 2 });
  const raw = {
    batch_id: 'b9',
    created_ids: ['n1'],
    conflicts: [
      {
        task_id: 'a',
        deleted: false,
        title: 'Hook (Leo)',
        priority: 0,
        status: 'todo',
        updated_at: at(5),
      },
      {
        task_id: 'z',
        deleted: true,
        title: 'Gone',
        priority: 1,
        status: 'done',
        updated_at: at(6),
      },
      { bogus: true },
    ],
  };

  it('parses the result, skipping malformed conflicts', () => {
    const r = parseBatchResult(raw);
    expect(r?.batchId).toBe('b9');
    expect(r?.createdIds).toEqual(['n1']);
    expect(r?.conflicts.map((c) => c.taskId)).toEqual(['a', 'z']);
    expect(r?.conflicts[1]?.deleted).toBe(true);
    expect(parseBatchResult({ batch_id: null, created_ids: [] })?.conflicts).toEqual([]);
    expect(parseBatchResult(null)).toBeNull();
  });

  it('names their value for the fields I changed; a delete says so', () => {
    const [mine, gone] = parseBatchResult(raw)?.conflicts ?? [];
    if (mine === undefined || gone === undefined) throw new Error('no conflicts');
    expect(conflictLine('Leo', mine, { priority: 1 })).toBe('Leo changed this to P0');
    expect(conflictLine('Leo', mine, { title: 'Mine' })).toBe('Leo changed this to "Hook (Leo)"');
    expect(conflictLine('Leo', mine, { status: 'done' })).toBe('Leo changed this to not done');
    expect(conflictLine('Leo', gone, { title: 'x' })).toBe('Leo deleted this');
  });

  it('Keep mine re-bases on their version so the edit goes again', () => {
    const [c] = parseBatchResult(raw)?.conflicts ?? [];
    if (c === undefined) throw new Error('no conflict');
    const d = keepMine(editField(EMPTY_DRAFT, a, { priority: 1 }), c);
    const theirs = { ...a, title: c.title, priority: c.priority, updatedAt: c.updatedAt };
    expect(batchPayload(d, mapOf(theirs)).edits).toEqual([
      { task_id: 'a', base_updated_at: at(5), changes: { priority: 1 } },
    ]);
  });

  it('Keep theirs drops my edit', () => {
    const d = dropTask(editField(EMPTY_DRAFT, a, { priority: 1 }), 'a');
    expect(isDraftDirty(d, mapOf(a))).toBe(false);
    expect(d.bases).toEqual({});
  });

  it('live merge: untouched rows need nothing; touched rows changed or deleted there get a notice', () => {
    const b = task({ id: 'b', number: 2, title: 'Grid' });
    const d = editField(EMPTY_DRAFT, a, { priority: 0 });
    const after = mapOf(
      { ...a, title: 'Hook (Leo)', updatedAt: at(9) },
      { ...b, priority: 0, updatedAt: at(9) },
    );
    const { notices } = liveMerge({ draft: d, before: mapOf(a, b), after });
    expect(notices.map((n) => [n.taskId, n.deleted, n.title])).toEqual([
      ['a', false, 'Hook (Leo)'],
    ]);
    const deleted = liveMerge({ draft: d, before: mapOf(a, b), after: mapOf(b) });
    expect(deleted.notices.map((n) => [n.taskId, n.deleted])).toEqual([['a', true]]);
    const same = liveMerge({ draft: d, before: mapOf(a, b), after: mapOf(a, b) });
    expect(same.notices).toEqual([]);
  });
});

describe('thread lines: one Save is one line', () => {
  it('events sharing a batch id are ONE line wherever they sit; older rows keep their collapse', () => {
    const lines = collapseTaskRun([
      ev({ id: 'a', kind: 'edited', batchId: 'B1', createdAt: at(0) }),
      ev({ id: 'b', kind: 'created', batchId: 'B1', createdAt: at(0) }),
      ev({ id: 'c', kind: 'edited', batchId: 'B2', actorId: 'u3', createdAt: at(1) }),
      ev({ id: 'd', kind: 'deleted', batchId: 'B1', createdAt: at(0) }),
      ev({ id: 'e', kind: 'note', createdAt: at(2) }),
    ]);
    expect(lines.map((l) => l.kind)).toEqual(['batch', 'batch', 'one']);
    const first = lines[0];
    expect(first?.kind === 'batch' && first.events.map((e) => e.id)).toEqual(['a', 'b', 'd']);
    const legacy = collapseTaskRun([0, 1, 2].map((k) => ev({ id: `x${k}`, createdAt: at(k) })));
    expect(legacy.map((l) => l.kind)).toEqual(['added']);
  });

  it('expands to its rows', () => {
    const ref = taskRefOf(task({ number: 7, title: 'Grid v2', priority: 0 }));
    const rows = [
      ...batchRows(ev({ kind: 'created', newValue: 'Story' }), { ...ref, priority: 1 }),
      ...batchRows(
        ev({
          kind: 'edited',
          oldValue: '{"title":"Grid","priority":2}',
          newValue: '{"title":"Grid v2","priority":0}',
        }),
        ref,
      ),
      ...batchRows(
        ev({ kind: 'edited', oldValue: '{"status":"todo"}', newValue: '{"status":"done"}' }),
        ref,
      ),
      ...batchRows(
        ev({ kind: 'edited', oldValue: '{"status":"done"}', newValue: '{"status":"todo"}' }),
        ref,
      ),
      ...batchRows(ev({ kind: 'deleted', oldValue: 'Old', newValue: null }), ref),
    ].map(batchRowText);
    expect(rows).toEqual([
      'Added #7 Story · P1',
      'Edited #7 Grid → Grid v2',
      'Priority #7 P2 → P0',
      'Done #7 Grid v2',
      'Reopened #7 Grid v2',
      'Deleted #7 Old',
    ]);
    expect(editedTasksLabel('You')).toBe('You edited tasks');
  });

  it('keeps only the loaded window while older history exists', () => {
    const events = [ev({ id: 'old', createdAt: at(-100) }), ev({ id: 'new', createdAt: at(10) })];
    expect(eventsInWindow(events, NOW, true).map((e) => e.id)).toEqual(['new']);
    expect(eventsInWindow(events, NOW, false).map((e) => e.id)).toEqual(['old', 'new']);
  });

  it('the dot: a newer change by someone else', () => {
    const mine = ev({ actorId: 'me', createdAt: at(10) });
    const theirs = ev({ actorId: 'u2', createdAt: at(5) });
    expect(hasUnseenChanges([theirs, mine], 'me', null)).toBe(true);
    expect(hasUnseenChanges([theirs, mine], 'me', NOW + 6000)).toBe(false);
    expect(hasUnseenChanges([mine], 'me', null)).toBe(false);
  });
});

describe('marks: changed since you looked', () => {
  const b1 = [
    ev({
      id: '1',
      taskId: 'a',
      kind: 'edited',
      batchId: 'B1',
      actorId: 'u2',
      createdAt: at(0),
      oldValue: '{"title":"Hook"}',
      newValue: '{"title":"Hook v2"}',
    }),
    ev({
      id: '2',
      taskId: 'b',
      kind: 'edited',
      batchId: 'B1',
      actorId: 'u2',
      createdAt: at(0),
      oldValue: '{"priority":2}',
      newValue: '{"priority":0}',
    }),
  ];
  const b2 = [
    ev({
      id: '3',
      taskId: 'c',
      kind: 'edited',
      batchId: 'B2',
      actorId: 'u3',
      createdAt: at(60),
      oldValue: '{"status":"todo"}',
      newValue: '{"status":"done"}',
    }),
    ev({
      id: '4',
      taskId: 'd',
      kind: 'created',
      batchId: 'B2',
      actorId: 'u3',
      createdAt: at(60),
      newValue: 'New',
    }),
  ];
  const mineB = [
    ev({
      id: '5',
      taskId: 'e',
      kind: 'edited',
      batchId: 'B3',
      actorId: 'me',
      createdAt: at(90),
      oldValue: '{"priority":2}',
      newValue: '{"priority":1}',
    }),
  ];
  const all = [...b1, ...b2, ...mineB];

  it('no seen time: only the latest batch by someone else', () => {
    const m = marksSince(all, 'me', null);
    expect([...m.byTask.keys()]).toEqual(['c', 'd']);
    expect(m.actorIds).toEqual(['u3']);
    expect(m.byTask.get('c')?.map(markText)).toEqual(['marked done']);
    expect(m.byTask.get('d')?.map(markText)).toEqual(['New task']);
  });

  it('a seen time: every other batch after it, never my own', () => {
    const m = marksSince(all, 'me', NOW - 1000);
    expect([...m.byTask.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(m.byTask.get('a')?.map(markText)).toEqual(['was Hook']);
    expect(m.byTask.get('b')?.map(markText)).toEqual(['priority was P2']);
    expect(m.byTask.has('e')).toBe(false);
    expect(marksSince(all, 'me', NOW + 30_000).byTask.has('a')).toBe(false);
  });

  it('both directions: the other person sees my Save marked', () => {
    const m = marksSince(all, 'u2', NOW + 30_000);
    expect([...m.byTask.keys()].sort()).toEqual(['c', 'd', 'e']);
    expect(m.byTask.get('e')?.map(markText)).toEqual(['priority was P2']);
  });

  it('the oldest "was" wins across two Saves; a deleted task has no mark', () => {
    const two = [
      ev({
        id: 'x',
        taskId: 'a',
        kind: 'edited',
        batchId: 'X',
        createdAt: at(0),
        oldValue: '{"title":"One"}',
        newValue: '{"title":"Two"}',
      }),
      ev({
        id: 'y',
        taskId: 'a',
        kind: 'edited',
        batchId: 'Y',
        createdAt: at(5),
        oldValue: '{"title":"Two"}',
        newValue: '{"title":"Three"}',
      }),
      ev({ id: 'z', taskId: 'b', kind: 'created', batchId: 'Y', createdAt: at(5) }),
      ev({ id: 'w', taskId: 'b', kind: 'deleted', batchId: 'Z', createdAt: at(6) }),
    ];
    const m = marksSince(two, 'me', NOW - 1);
    expect(m.byTask.get('a')?.map(markText)).toEqual(['was One']);
    expect(m.byTask.has('b')).toBe(false);
  });

  it('the strip', () => {
    expect(marksStrip(['Leo'], 3)).toBe('Leo changed 3 tasks · marked below');
    expect(marksStrip(['Leo', 'Ana'], 1)).toBe('Leo and Ana changed 1 task · marked below');
  });
});

describe('editing signal timing', () => {
  it('starts on the first unsaved change, refreshes every 5s, stops once clean', () => {
    expect(editingSignalStep({ dirty: false, lastSentMs: null, nowMs: 0 })).toBe('none');
    expect(editingSignalStep({ dirty: true, lastSentMs: null, nowMs: 0 })).toBe('start');
    expect(editingSignalStep({ dirty: true, lastSentMs: 0, nowMs: EDITING_REFRESH_MS - 1 })).toBe(
      'none',
    );
    expect(editingSignalStep({ dirty: true, lastSentMs: 0, nowMs: EDITING_REFRESH_MS })).toBe(
      'refresh',
    );
    expect(editingSignalStep({ dirty: false, lastSentMs: 0, nowMs: 1 })).toBe('stop');
  });

  it('a receiver drops an editor 12s after the last refresh', () => {
    const heard = new Map([
      ['u2', 0],
      ['u3', 4000],
    ]);
    expect(liveEditors(heard, EDITING_TTL_MS - 1)).toEqual(['u3', 'u2']);
    expect(liveEditors(heard, EDITING_TTL_MS)).toEqual(['u3']);
    expect(liveEditors(heard, EDITING_TTL_MS + 4000)).toEqual([]);
    expect(editingLabel(['Leo'])).toBe('Leo is editing…');
    expect(editingLabel([])).toBeNull();
  });
});

describe('shareSnapshot', () => {
  const tasks = [
    task({ id: 'a', number: 3, title: 'Hook copy', priority: 0 }),
    task({ id: 'b', number: 1, title: 'Reel cut', priority: 1, side: 'client' }),
    task({ id: 'c', number: 2, title: 'Approve grid', status: 'done' }),
    task({ id: 'd', number: 4, title: 'Gone', deletedAt: at(0) }),
  ];
  it('flat numbered list, done items under Done; no side, no due', () => {
    expect(shareSnapshot({ chatName: 'Launch crew', tasks, nowMs: NOW, timeZone: UTC })).toBe(
      [
        'Tasks · Launch crew · 13 Oct, 2 pm',
        '1. Reel cut · P1',
        '3. Hook copy · P0',
        'Done',
        '2. Approve grid · P2',
      ].join('\n'),
    );
  });
  it('no Done section when nothing is done', () => {
    const text = shareSnapshot({
      chatName: 'X',
      tasks: [tasks[0] as ChatTask],
      nowMs: NOW,
      timeZone: UTC,
    });
    expect(text).toBe('Tasks · X · 13 Oct, 2 pm\n3. Hook copy · P0');
  });
  it('past the limit: drops Done, then trailing items, ending "+k more"', () => {
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
    is: (...args: unknown[]) => (calls.push({ method: 'is', args }), query),
    gt: (...args: unknown[]) => (calls.push({ method: 'gt', args }), query),
    lt: (...args: unknown[]) => (calls.push({ method: 'lt', args }), query),
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

describe('reads and the write', () => {
  it('reads the live list in one query, explicit columns, no deleted rows', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    expect(await readChannelTasks(client, 'c1')).toEqual({ ok: true, data: [] });
    expect(calls.map((c) => c.method)).toEqual(['from', 'select', 'eq', 'is']);
    expect(String(calls[1]?.args[0])).not.toContain('due');
    expect(calls[3]?.args).toEqual(['deleted_at', null]);
  });
  it('reads tasks by id in one IN read, none for no ids', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    expect(await readTasksByIds(client, [])).toEqual({ ok: true, data: [] });
    expect(calls).toHaveLength(0);
    await readTasksByIds(client, ['a', 'b']);
    expect(calls[2]?.args).toEqual(['id', ['a', 'b']]);
  });
  it('reads events with their batch id, oldest first', async () => {
    const row = {
      id: 'e2',
      task_id: 't',
      channel_id: 'c1',
      workspace_id: 'w',
      actor_user_id: 'u',
      kind: 'edited',
      old_value: null,
      new_value: null,
      created_at: '2026-10-13T11:00:00Z',
      batch_id: 'B',
    };
    const { client, calls } = fakeClient({ data: [row], error: null });
    const res = await readTaskEvents(client, 'c1', { sinceIso: 'a', untilIso: 'b' });
    expect(res.ok && res.data.events.map((e) => e.batchId)).toEqual(['B']);
    expect(String(calls[1]?.args[0])).toContain('batch_id');
  });
  it('a Save is one chat_task_save_batch call with the payload and an explicit trace id', async () => {
    const { client, calls } = fakeClient({
      data: { batch_id: 'B', created_ids: ['n'], conflicts: [] },
      error: null,
    });
    const payload = {
      creates: [{ title: 'Story', priority: 1 as const, side: 'agency' as const }],
      edits: [],
      deletes: [{ task_id: 'a', base_updated_at: T0 }],
    };
    const res = await saveTaskBatch({ client, channelId: 'c1', payload, traceId: 'tr' });
    expect(res).toEqual({ ok: true, data: { batchId: 'B', createdIds: ['n'], conflicts: [] } });
    expect(calls).toEqual([
      {
        method: 'rpc',
        args: ['chat_task_save_batch', { p_channel_id: 'c1', p_batch: payload, p_trace_id: 'tr' }],
      },
    ]);
    const refused = fakeClient({ data: null, error: { message: 'not a member of this chat' } });
    expect(
      await saveTaskBatch({ client: refused.client, channelId: 'c1', payload, traceId: 'tr' }),
    ).toEqual({ ok: false, message: 'not a member of this chat' });
  });
});
