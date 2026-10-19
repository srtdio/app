// @vitest-environment jsdom
// X4: one Save of N tasks is ONE chat line "{Name} added N tasks" (whatever
// COLLAPSE_MIN says; a tap opens the Tasks sheet) and ONE bell row "{Name}
// added N tasks in {chat}" labelled "Tasks". Other runs keep the collapse.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { TaskEventLine, type TaskLineContext } from '@/components/chat/tasks/TaskEventLine';
import { isTaskBatch, TASK_BELL_PREVIEW, taskBellLine } from '@/components/chat/NotificationsPanel';
import { mapBellEntry, taskFieldsOf } from '@/lib/chat/bell';
import {
  addedLabel,
  collapseTaskRun,
  COLLAPSE_MIN,
  TASKS_SHEET_ONLY,
  type TaskEvent,
} from '@/lib/chat/tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-19T10:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

function ev(over: Partial<TaskEvent>): TaskEvent {
  return {
    id: 'e1',
    taskId: 't1',
    channelId: 'c1',
    actorId: 'u2',
    kind: 'created',
    oldValue: null,
    newValue: 'Hook',
    createdAt: at(0),
    ...over,
  };
}

const batch = (n: number, stepMs = 0) =>
  Array.from({ length: n }, (_, k) =>
    ev({ id: `b${k}`, taskId: `t${k}`, createdAt: at(k * stepMs) }),
  );

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('X4 batch chat line', () => {
  it('5 adds in one Save (one instant) are one "added" line', () => {
    const lines = collapseTaskRun(batch(5));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('added');
  });

  it('2 adds within 10 seconds are one line, below COLLAPSE_MIN', () => {
    expect(COLLAPSE_MIN).toBeGreaterThan(2);
    const lines = collapseTaskRun(batch(2, 9_000));
    expect(lines.map((l) => l.kind)).toEqual(['added']);
  });

  it('adds further apart, or by someone else, are not a batch; other runs keep the collapse', () => {
    expect(collapseTaskRun(batch(2, 30_000)).map((l) => l.kind)).toEqual(['one', 'one']);
    const mixed = [ev({ id: 'a' }), ev({ id: 'b', actorId: 'u9' })];
    expect(collapseTaskRun(mixed).map((l) => l.kind)).toEqual(['one', 'one']);
    const edits = [0, 1, 2, 3].map((k) =>
      ev({ id: `x${k}`, kind: 'edited', createdAt: at(k * 1000) }),
    );
    expect(collapseTaskRun(edits).map((l) => l.kind)).toEqual(['many']);
  });

  it('renders "{Name} added N tasks"; a tap opens the Tasks sheet (no row)', () => {
    const onOpenTask = vi.fn();
    const ctx: TaskLineContext = {
      tasksById: new Map(),
      nameOf: () => 'Leo',
      nowMs: NOW,
      timeZone: 'UTC',
      onOpenTask,
    };
    const [line] = collapseTaskRun(batch(5));
    if (line === undefined) throw new Error('no line');
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <ul>
          <TaskEventLine line={line} ctx={ctx} />
        </ul>,
      ),
    );
    const pill = document.querySelector<HTMLButtonElement>('[data-task-added]');
    expect(pill?.textContent).toBe('Leo added 5 tasks');
    expect(document.querySelectorAll('[data-task-row]')).toHaveLength(1);
    act(() => pill?.click());
    expect(onOpenTask).toHaveBeenCalledWith(TASKS_SHEET_ONLY);
    expect(addedLabel('You', 1)).toBe('You added 1 task');
  });
});

describe('X4 batch bell row', () => {
  const row = {
    id: 'i1',
    workspace_id: 'w1',
    user_id: 'u1',
    actor_user_id: 'u2',
    event_type: 'task_changed',
    entity_type: 'chat_channel',
    entity_id: 'c1',
    scope: 'groups',
    scope_key: 'c1',
    tier: 'active',
    created_at: at(0),
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    payload: { kind: 'created_many', count: 5, task_ids: ['t0', 't1'], title: 'Grid' },
  };

  it('the payload maps to one entry with its count', () => {
    expect(taskFieldsOf(row as never).count).toBe(5);
    const entry = mapBellEntry(row as never);
    expect(entry).not.toBeNull();
    expect(entry?.eventType).toBe('task_changed');
    expect(entry?.task?.kind).toBe('created_many');
  });

  it('reads "{Name} added N tasks in {chat}", labelled "Tasks"', () => {
    const entry = { eventType: 'task_changed' as const, task: taskFieldsOf(row as never) };
    expect(isTaskBatch(entry)).toBe(true);
    expect(taskBellLine(entry, 'Leo', NOW, 'UTC', 'Launch')).toBe('Leo added 5 tasks in Launch');
    expect(TASK_BELL_PREVIEW).toBe('Tasks');
  });

  it('a single change still reads as before', () => {
    const one = {
      eventType: 'task_changed' as const,
      task: taskFieldsOf({ payload: { kind: 'created', number: 3, title: 'Hook' } } as never),
    };
    expect(isTaskBatch(one)).toBe(false);
    expect(taskBellLine(one, 'Leo', NOW, 'UTC', 'Launch')).toMatch(/^Leo · /);
  });
});
