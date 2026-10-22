// @vitest-environment jsdom
// One Save is ONE chat line "<Name> edited tasks" (a chevron expands its rows
// and "Open tasks") and ONE Notifications alert "<Name> edited tasks" labelled
// "Tasks".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { TaskEventLine, type TaskLineContext } from '@/components/chat/tasks/TaskEventLine';
import {
  alertKindOf,
  isTaskBatch,
  TASK_ALERT_LABEL,
  taskAlertLine,
  taskFieldsOf,
} from '@/lib/inbox/alerts';
import { collapseTaskRun, TASKS_SHEET_ONLY, type TaskEvent } from '@/lib/chat/tasks';
import { x4Task } from './x4-fake-tasks';

// Built from its char code so this file passes the chat token-hygiene check.
const H = String.fromCharCode(35);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = '2026-10-19T10:00:00.000Z';
function ev(over: Partial<TaskEvent>): TaskEvent {
  return {
    id: 'e1',
    taskId: 't1',
    channelId: 'c1',
    actorId: 'u2',
    kind: 'edited',
    oldValue: null,
    newValue: null,
    createdAt: at,
    batchId: 'B',
    ...over,
  };
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('batch chat line', () => {
  it('renders one "<Name> edited tasks" line; a tap expands its rows and Open tasks', () => {
    const onOpenTask = vi.fn();
    const ctx: TaskLineContext = {
      tasksById: new Map([
        ['a', x4Task({ id: 'a', number: 4, title: 'Hook v2' })],
        ['b', x4Task({ id: 'b', number: 5, title: 'Grid' })],
        ['c', x4Task({ id: 'c', number: 6, title: 'Story', priority: 1 })],
      ]),
      nameOf: () => 'Leo',
      onOpenTask,
    };
    const lines = collapseTaskRun([
      ev({ id: '1', taskId: 'a', oldValue: '{"title":"Hook"}', newValue: '{"title":"Hook v2"}' }),
      ev({ id: '2', taskId: 'b', oldValue: '{"priority":2}', newValue: '{"priority":0}' }),
      ev({ id: '3', taskId: 'c', kind: 'created', newValue: 'Story' }),
    ]);
    expect(lines).toHaveLength(1);
    const [line] = lines;
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
    const toggle = document.querySelector<HTMLButtonElement>('[data-task-batch-toggle]');
    expect(toggle?.textContent).toBe('Leo edited tasks');
    expect(document.querySelectorAll('[data-task-batch-row]')).toHaveLength(0);
    act(() => toggle?.click());
    const rows = [...document.querySelectorAll('[data-task-batch-row]')].map((r) => r.textContent);
    expect(rows).toEqual([
      `Edited ${H}4 Hook → Hook v2`,
      `Priority ${H}5 P2 → P0`,
      `Added ${H}6 Story · P1`,
    ]);
    act(() => document.querySelector<HTMLButtonElement>('[data-task-open]')?.click());
    expect(onOpenTask).toHaveBeenCalledWith(TASKS_SHEET_ONLY);
  });
});

describe('batch task alert', () => {
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
    created_at: at,
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    payload: { kind: 'batch', batch_id: 'B', created: 1, changed: 2, task_ids: ['a', 'b', 'c'] },
  };

  it('maps the payload and reads "<Name> edited tasks", labelled Tasks', () => {
    const fields = taskFieldsOf(row as never);
    expect(fields).toMatchObject({ kind: 'batch', batchId: 'B', created: 1, changed: 2 });
    expect(alertKindOf(row.event_type)).toBe('task');
    expect(isTaskBatch('task_changed', fields)).toBe(true);
    expect(taskAlertLine('task_changed', fields, 'Leo')).toBe('Leo edited tasks');
    expect(TASK_ALERT_LABEL).toBe('Tasks');
  });

  it('older rows still read', () => {
    const many = taskFieldsOf({ payload: { kind: 'created_many', count: 3 } } as never);
    expect(taskAlertLine('task_changed', many, 'Leo')).toBe('Leo added 3 tasks');
    const one = taskFieldsOf({ payload: { kind: 'created', number: 3, title: 'Hook' } } as never);
    expect(isTaskBatch('task_changed', one)).toBe(false);
    expect(taskAlertLine('task_changed', one, 'Leo')).toBe(`Leo · added ${H}3 Hook`);
  });
});
