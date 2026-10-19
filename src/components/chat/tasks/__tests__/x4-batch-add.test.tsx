// @vitest-environment jsdom
// X4 add several, then one Save: Enter adds a draft (no write), drafts can be
// edited or removed, the footer reads Cancel / "Save N tasks", Save is one
// createMany, success toasts "N tasks added", failure keeps the drafts with a
// plain error and Retry, and the sheet is busy ("Saving…") while saving.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@/components/ui/toast/types';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const shown: ToastOptions[] = [];
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({
    show: (options: ToastOptions) => {
      shown.push(options);
      return String(shown.length);
    },
    dismiss: vi.fn(),
  }),
}));
// The Sheet's props are recorded so the test can read dirty, busy and copy.
const sheetProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock('@/components/ui/Sheet', () => ({
  Sheet: (props: { open: boolean; children: ReactNode; footer?: ReactNode }) => {
    sheetProps.current = props as unknown as Record<string, unknown>;
    return props.open ? (
      <div role="dialog">
        {props.children}
        {props.footer}
      </div>
    ) : null;
  },
}));
vi.mock('@/components/ui/SearchHighlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/SearchHighlight')>()),
  glowTarget: () => () => {},
}));

import {
  ADD_PLACEHOLDER,
  DISCARD_TASKS_MESSAGE,
  DISCARD_TASKS_TITLE,
  SAVE_TASKS_FAILED,
  saveTasksLabel,
  TaskSheet,
  tasksAddedLabel,
} from '@/components/chat/tasks/TaskSheet';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { x4FakeTasks, x4Type } from './x4-fake-tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function render(tasks: UseChatTasks): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <TaskSheet open onClose={() => {}} tasks={tasks} timeZone="UTC" focusTaskId={null} />,
    ),
  );
}

const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];

function add(side: 'agency' | 'client', title: string): void {
  const input = q(`[data-task-add="${side}"] input`) as HTMLInputElement;
  act(() => input.focus());
  act(() => x4Type(input, title));
  act(() => q(`[data-task-add="${side}"] [data-task-add-submit]`)?.click());
}

beforeEach(() => {
  shown.length = 0;
  sheetProps.current = null;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('X4 batch add', () => {
  it('Enter adds a "new" draft and clears the field; nothing is written', () => {
    const tasks = x4FakeTasks([]);
    render(tasks);
    const input = q('[data-task-add="agency"] input') as HTMLInputElement;
    expect(input.placeholder).toBe(ADD_PLACEHOLDER);
    add('agency', 'Hook');
    add('agency', 'Grid');
    expect(qa('[data-task-draft]')).toHaveLength(2);
    expect(qa('[data-task-draft] [data-task-new]')).toHaveLength(2);
    expect(input.value).toBe('');
    expect(tasks.create).not.toHaveBeenCalled();
    expect(tasks.createMany).not.toHaveBeenCalled();
  });

  it('drafts edit and remove before saving; the label counts them', () => {
    render(x4FakeTasks([]));
    add('agency', 'Hook');
    add('client', 'Caption');
    expect(q('[data-task-save-all]')?.textContent).toBe(saveTasksLabel(2));
    expect(saveTasksLabel(1)).toBe('Save 1 task');
    act(() => q('[data-task-draft-remove]')?.click());
    expect(qa('[data-task-draft]')).toHaveLength(1);
    expect(q('[data-task-save-all]')?.textContent).toBe('Save 1 task');
    const title = q('[data-task-draft] input') as HTMLInputElement;
    act(() => x4Type(title, 'Caption v2'));
    expect((q('[data-task-draft] input') as HTMLInputElement).value).toBe('Caption v2');
  });

  it('drafts make the sheet dirty with "Discard these tasks?"', () => {
    render(x4FakeTasks([]));
    expect(sheetProps.current?.dirty).toBe(false);
    add('agency', 'Hook');
    expect(sheetProps.current?.dirty).toBe(true);
    expect(sheetProps.current?.discard).toEqual({
      title: DISCARD_TASKS_TITLE,
      message: DISCARD_TASKS_MESSAGE,
    });
  });

  it('Save is one createMany; success drops the drafts and toasts "N tasks added"', async () => {
    const tasks = x4FakeTasks([]);
    render(tasks);
    add('agency', 'Hook');
    add('client', 'Caption');
    await act(async () => q('[data-task-save-all]')?.click());
    expect(tasks.createMany).toHaveBeenCalledTimes(1);
    const [items] = (tasks.createMany as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(items).toEqual([
      { title: 'Hook', side: 'agency', priority: 2, dueAt: null },
      { title: 'Caption', side: 'client', priority: 2, dueAt: null },
    ]);
    expect(qa('[data-task-draft]')).toHaveLength(0);
    expect(shown.map((t) => t.title)).toEqual([tasksAddedLabel(2)]);
    expect(tasksAddedLabel(2)).toBe('2 tasks added');
  });

  it('while saving the sheet is busy and the button reads "Saving…"', async () => {
    let finish: (ok: boolean) => void = () => {};
    const tasks = x4FakeTasks([], {
      createMany: vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve))),
    });
    render(tasks);
    add('agency', 'Hook');
    act(() => q('[data-task-save-all]')?.click());
    expect(sheetProps.current?.busy).toBe(true);
    expect(q('[data-task-save-all]')?.textContent).toBe('Saving…');
    await act(async () => finish(true));
    expect(sheetProps.current?.busy).toBe(false);
  });

  it('a refused Save keeps the drafts, says so plainly and offers Retry', async () => {
    const tasks = x4FakeTasks([], { createMany: vi.fn(async () => false) });
    render(tasks);
    add('agency', 'Hook');
    add('agency', 'Grid');
    await act(async () => q('[data-task-save-all]')?.click());
    expect(qa('[data-task-draft]')).toHaveLength(2);
    expect(q('[data-task-save-bar] [role="alert"]')?.textContent).toBe(SAVE_TASKS_FAILED);
    expect(q('[data-task-save-all]')?.textContent).toBe('Retry');
    expect(shown).toHaveLength(0);
    await act(async () => q('[data-task-save-all]')?.click());
    expect(tasks.createMany).toHaveBeenCalledTimes(2);
  });

  it('Cancel asks "Discard these tasks?"; Keep editing keeps the drafts', () => {
    render(x4FakeTasks([]));
    add('agency', 'Hook');
    act(() => q('[data-task-save-cancel]')?.click());
    const ask = q('[role="alertdialog"]');
    expect(ask?.getAttribute('aria-label')).toBe(DISCARD_TASKS_TITLE);
    const keep = [...(ask?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Keep editing',
    );
    act(() => keep?.click());
    expect(qa('[data-task-draft]')).toHaveLength(1);
  });
});
