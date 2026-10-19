// @vitest-environment jsdom
// W9 regressions in the sheet: edit then Save (or Discard), Delete, the due
// picker keeping a tapped day, the next number only in the row being typed
// in, and opening at a task the list does not hold.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The Sheet portals and animates; its body renders in place here.
vi.mock('@/components/ui/Sheet', () => ({
  Sheet: (props: { open: boolean; children: ReactNode; footer?: ReactNode }) =>
    props.open ? (
      <div role="dialog">
        {props.children}
        {props.footer}
      </div>
    ) : null,
}));
vi.mock('@/components/ui/SearchHighlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/SearchHighlight')>()),
  glowTarget: () => () => {},
}));

import { TaskSheet, DISCARD_TITLE } from '@/components/chat/tasks/TaskSheet';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import type { ChatTask } from '@/lib/chat/tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UTC = 'UTC';

function task(over: Partial<ChatTask>): ChatTask {
  const now = new Date().toISOString();
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
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...over,
  };
}

function fakeTasks(list: ChatTask[], over: Partial<UseChatTasks> = {}): UseChatTasks {
  return {
    tasks: list,
    events: [],
    lineTasks: new Map(list.map((t) => [t.id, t] as const)),
    loaded: true,
    loadState: 'ready',
    retrying: false,
    covers: () => true,
    pending: [],
    failed: new Map(),
    hiddenIds: new Set(),
    nameOf: () => 'You',
    refetch: vi.fn(),
    ensureEventsSince: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(async () => true),
    save: vi.fn(),
    retryField: vi.fn(),
    remove: vi.fn(),
    loadTask: vi.fn(),
    retryCreate: vi.fn(),
    removeCreate: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;

function render(tasks: UseChatTasks, focusTaskId: string | null = null): void {
  const sheet = (
    <TaskSheet open onClose={() => {}} tasks={tasks} timeZone={UTC} focusTaskId={focusTaskId} />
  );
  if (root === null) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root?.render(sheet));
}

function q(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

function click(selector: string): void {
  const el = q(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  act(() => el.click());
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('TaskSheet (W9)', () => {
  it('fix 1: edits stay local; Save sends only the changed field once', () => {
    const t = task({});
    const tasks = fakeTasks([t]);
    render(tasks);
    click('[data-task-row-id="t1"] button[aria-expanded]');
    click('[data-task-row-id="t1"] [data-task-opt="p0"]');
    expect(tasks.save).not.toHaveBeenCalled();
    click('[data-task-row-id="t1"] [data-task-save]');
    expect(tasks.save).toHaveBeenCalledTimes(1);
    expect(tasks.save).toHaveBeenCalledWith(t, { priority: 0 });
  });

  it('fix 1: Cancel with changes asks "Discard your changes?" (Keep editing / Discard)', () => {
    const tasks = fakeTasks([task({})]);
    render(tasks);
    click('[data-task-row-id="t1"] button[aria-expanded]');
    click('[data-task-row-id="t1"] [data-task-opt="p1"]');
    click('[data-task-row-id="t1"] [data-task-cancel]');
    const ask = document.querySelector('[role="alertdialog"]');
    expect(ask?.getAttribute('aria-label')).toBe(DISCARD_TITLE);
    const labels = [...(ask?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(['Keep editing', 'Discard']);
    expect(tasks.save).not.toHaveBeenCalled();
  });

  it('fix 4: Delete hands the task to the undoable remove and collapses', () => {
    const t = task({});
    const tasks = fakeTasks([t]);
    render(tasks);
    click('[data-task-row-id="t1"] button[aria-expanded]');
    click('[data-task-row-id="t1"] [data-task-delete]');
    expect(tasks.remove).toHaveBeenCalledWith(t);
    expect(q('[data-task-expanded]')).toBeNull();
  });

  it('fix 5: tapping the picked day keeps it; Clear date clears; a day alone is 9 pm', () => {
    const tasks = fakeTasks([task({})]);
    render(tasks);
    click('[data-task-row-id="t1"] button[aria-expanded]');
    click('[data-task-row-id="t1"] [data-task-opt="tomorrow"]');
    expect(q('[data-task-due-line]')?.textContent).toBe('Due 9 pm');
    click('[data-task-row-id="t1"] [data-task-opt="tomorrow"]');
    expect(q('[data-task-due-line]')?.textContent).toBe('Due 9 pm');
    click('[data-task-clear-date]');
    expect(q('[data-task-due-line]')).toBeNull();
  });

  it('fix 6: opened for a task the list lacks, it reads it and shows it expanded', () => {
    const open = task({ id: 'open1' });
    const closed = task({
      id: 'old1',
      number: 1,
      status: 'approved',
      updatedAt: '2026-01-02T10:00:00.000Z',
    });
    const before = fakeTasks([open]);
    render(before, 'old1');
    expect(before.loadTask).toHaveBeenCalledWith('old1');
    render(
      fakeTasks([open], {
        lineTasks: new Map([
          [open.id, open],
          [closed.id, closed],
        ]),
      }),
      'old1',
    );
    const row = q('[data-task-row-id="old1"]');
    expect(row).not.toBeNull();
    expect(row?.hasAttribute('data-task-expanded')).toBe(true);
  });

  it('fix 7: the next number shows only in the row being typed in; counts read open for', () => {
    render(fakeTasks([task({}), task({ id: 't2', number: 4, side: 'client' })]));
    expect(q('[data-task-counts]')?.textContent).toBe('1 open for creators · 1 for approvers');
    expect(q('[data-task-preview]')).toBeNull();
    const input = q('[data-task-add="agency"] input');
    act(() => input?.focus());
    expect(q('[data-task-add="agency"] [data-task-preview]')?.textContent).toBe('5');
    expect(q('[data-task-add="client"] [data-task-preview]')).toBeNull();
  });

  it('fix 2 (X4): the add row keeps title, priority and due on a draft; Save sends them', async () => {
    const tasks = fakeTasks([]);
    render(tasks);
    const input = q('[data-task-add="agency"] input') as HTMLInputElement;
    act(() => input.focus());
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Hook');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click('[data-task-add="agency"] [data-task-opt="add-p0"]');
    click('[data-task-add="agency"] [data-task-opt="add-tomorrow"]');
    click('[data-task-add="agency"] button[type="submit"]');
    // Enter adds a draft: nothing is written until Save.
    expect(tasks.create).not.toHaveBeenCalled();
    expect(tasks.createMany).not.toHaveBeenCalled();
    expect(q('[data-task-draft]')).not.toBeNull();
    await act(async () => q('[data-task-save-all]')?.click());
    expect(tasks.createMany).toHaveBeenCalledTimes(1);
    const [items] = (tasks.createMany as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    const [first] = items as { side: string; title: string; priority: number; dueAt: string }[];
    expect([first?.side, first?.title]).toEqual(['agency', 'Hook']);
    expect(first?.priority).toBe(0);
    expect(String(first?.dueAt)).toMatch(/T21:00:00\.000Z$/);
  });
});
