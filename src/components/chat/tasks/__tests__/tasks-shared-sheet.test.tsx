// @vitest-environment jsdom
// The shared Tasks sheet: nothing writes until Save; Save is one saveBatch
// with only the changed fields; change-then-revert keeps Save disabled; a
// conflicting edit stays dirty with Keep mine / Keep theirs; a deleted one
// offers Restore mine / OK; marks show other people's changes; Cmd+S saves.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/ui/SearchHighlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/SearchHighlight')>()),
  glowTarget: () => () => {},
}));

import { TaskSheet } from '@/components/chat/tasks/TaskSheet';
import type { SaveOutcome, UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import type { BatchPayload, TaskEvent } from '@/lib/chat/tasks';
import { x4FakeTasks, x4Task, x4Type } from './x4-fake-tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const q = (s: string) => document.querySelector<HTMLElement>(s);
const saveButton = () => q('[data-task-save]') as HTMLButtonElement;

function render(tasks: UseChatTasks, seenMs: number | null = null): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <TaskSheet
        open
        onClose={() => {}}
        tasks={tasks}
        currentUserId="me"
        side="client"
        seenMs={seenMs}
        focusTaskId={null}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const A = x4Task({ id: 'a', number: 1, title: 'Hook', priority: 2 });
const B = x4Task({ id: 'b', number: 2, title: 'Grid', priority: 1 });

describe('shared Tasks sheet', () => {
  it('nothing writes until Save; change-then-revert keeps Save disabled', () => {
    const tasks = x4FakeTasks([A, B]);
    render(tasks);
    expect(saveButton().disabled).toBe(true);
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    expect(saveButton().disabled).toBe(false);
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    expect(saveButton().disabled).toBe(true);
    expect(tasks.saveBatch).not.toHaveBeenCalled();
  });

  it('Save is one saveBatch: edits with only changed fields, the new task on my side at P1', async () => {
    const tasks = x4FakeTasks([A, B]);
    render(tasks);
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    act(() => q('[data-task-row-id="b"] [data-task-chip]')?.click());
    act(() => q('[data-task-menu-p="0"]')?.click());
    const input = q('[data-task-add] input') as HTMLInputElement;
    act(() => x4Type(input, 'Story'));
    act(() => q('[data-task-add-submit]')?.click());
    await act(async () => saveButton().click());
    expect(tasks.saveBatch).toHaveBeenCalledTimes(1);
    const payload = (tasks.saveBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as BatchPayload;
    expect(payload.edits).toEqual([
      { task_id: 'a', base_updated_at: A.updatedAt, changes: { status: 'done' } },
      { task_id: 'b', base_updated_at: B.updatedAt, changes: { priority: 0 } },
    ]);
    expect(payload.creates).toEqual([{ title: 'Story', priority: 1, side: 'client' }]);
    expect(payload.deletes).toEqual([]);
  });

  it('the priority menu lists P0 Urgent, P1 High, P2 Normal with the current ticked', () => {
    render(x4FakeTasks([A]));
    act(() => q('[data-task-row-id="a"] [data-task-chip]')?.click());
    const items = [...document.querySelectorAll('[data-task-menu] [role="menuitemradio"]')];
    expect(items.map((i) => i.textContent)).toEqual(['P0Urgent', 'P1High', 'P2Normal']);
    expect(items[2]?.getAttribute('aria-checked')).toBe('true');
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(q('[data-task-menu]')).toBeNull();
  });

  it('a conflict stays dirty with Keep mine / Keep theirs; Keep mine re-sends with the new base', async () => {
    const conflict: SaveOutcome = {
      ok: true,
      createdIds: [],
      batchId: null,
      conflicts: [
        {
          taskId: 'a',
          deleted: false,
          title: 'Hook (Leo)',
          priority: 2,
          status: 'todo',
          updatedAt: '2026-10-19T10:00:00.000Z',
        },
      ],
    };
    const saveBatch = vi
      .fn<(p: BatchPayload) => Promise<SaveOutcome>>()
      .mockResolvedValueOnce(conflict)
      .mockResolvedValue({ ok: true, createdIds: [], conflicts: [], batchId: 'b2' });
    const events: TaskEvent[] = [
      {
        id: 'e',
        taskId: 'a',
        channelId: 'c1',
        actorId: 'u2',
        kind: 'edited',
        oldValue: null,
        newValue: null,
        createdAt: '2026-10-19T10:00:00.000Z',
        batchId: 'x',
      },
    ];
    render(x4FakeTasks([A], { saveBatch, events }), Date.parse('2026-10-19T11:00:00.000Z'));
    act(() => q('[data-task-row-id="a"] [data-task-title]')?.click());
    const title = q('[data-task-title-input]') as HTMLInputElement;
    act(() => x4Type(title, 'Hook (mine)'));
    act(() => title.blur());
    await act(async () => saveButton().click());
    expect(q('[data-task-conflict]')?.textContent).toContain('Leo changed this to "Hook (Leo)"');
    expect(saveButton().disabled).toBe(false);
    await act(async () => q('[data-task-keep-mine]')?.click());
    const again = saveBatch.mock.calls[1]?.[0];
    expect(again?.edits).toEqual([
      {
        task_id: 'a',
        base_updated_at: '2026-10-19T10:00:00.000Z',
        changes: { title: 'Hook (mine)' },
      },
    ]);
  });

  it('a deleted conflict offers Restore mine / OK; OK drops my edit', async () => {
    const saveBatch = vi.fn(
      async (): Promise<SaveOutcome> => ({
        ok: true,
        createdIds: [],
        batchId: null,
        conflicts: [
          {
            taskId: 'a',
            deleted: true,
            title: 'Hook',
            priority: 2,
            status: 'todo',
            updatedAt: '2026-10-19T10:00:00.000Z',
          },
        ],
      }),
    );
    render(x4FakeTasks([A], { saveBatch }));
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    await act(async () => saveButton().click());
    expect(q('[data-task-conflict]')?.textContent).toContain('deleted this');
    expect(q('[data-task-keep-mine]')?.textContent).toBe('Restore mine');
    expect(q('[data-task-keep-theirs]')?.textContent).toBe('OK');
    act(() => q('[data-task-keep-theirs]')?.click());
    expect(q('[data-task-conflict]')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it("marks: the strip, a dot and a 'was' line for someone else's Save", () => {
    const events: TaskEvent[] = [
      {
        id: 'e1',
        taskId: 'a',
        channelId: 'c1',
        actorId: 'u2',
        kind: 'edited',
        oldValue: '{"title":"Old hook"}',
        newValue: '{"title":"Hook"}',
        // Saved before the sheet opened (a minute ago), so the strip counts it.
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        batchId: 'B',
      },
    ];
    render(x4FakeTasks([A, B], { events }), null);
    expect(q('[data-task-strip]')?.textContent).toContain('Leo changed 1 task · marked below');
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-marked')).toBe(true);
    expect(q('[data-task-row-id="a"] [data-task-mark]')?.textContent).toBe('was Old hook');
    expect(q('[data-task-row-id="b"]')?.hasAttribute('data-task-marked')).toBe(false);
  });

  it('"<Name> is editing…" under the title; Cmd+S saves', async () => {
    const tasks = x4FakeTasks([A], { editors: ['u2'] });
    render(tasks);
    expect(q('[data-task-editing]')?.textContent).toBe('Leo is editing…');
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    expect(tasks.setEditing).toHaveBeenLastCalledWith(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
    });
    expect(tasks.saveBatch).toHaveBeenCalledTimes(1);
  });
});
