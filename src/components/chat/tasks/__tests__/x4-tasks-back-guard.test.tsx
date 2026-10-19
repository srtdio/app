// @vitest-environment jsdom
// X4 (FT49): TaskSheet under a real useHistoryStep('chatTasks') parent, the
// way MessageThread mounts it. With drafts or a dirty row edit, system Back
// shows "Discard these tasks?" (the Sheet's own guard), the parent's close
// callback never runs, Keep editing keeps the work, and Discard closes with
// no stray history entry.
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/ui/SearchHighlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/SearchHighlight')>()),
  glowTarget: () => () => {},
}));

import { DISCARD_TASKS_TITLE, TaskSheet } from '@/components/chat/tasks/TaskSheet';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { isStepEntry, resetHistorySteps, useHistoryStep } from '@/lib/chat/use-history-step';
import { DUR_BASE_MS } from '@/lib/motion';
import { x4FakeTasks, x4Task, x4Type } from './x4-fake-tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// jsdom traverses history on a queued task and fires popstate when it lands.
const settle = () => act(async () => wait(60));

let root: Root | null = null;

/** MessageThread's wiring: one 'chatTasks' step while the sheet is open. */
function Parent(props: { tasks: UseChatTasks; onParentBack: () => void }): ReactElement {
  const [open, setOpen] = useState(true);
  useHistoryStep(open, 'chatTasks', () => {
    props.onParentBack();
    setOpen(false);
  });
  return (
    <TaskSheet
      open={open}
      onClose={() => setOpen(false)}
      tasks={props.tasks}
      timeZone="UTC"
      focusTaskId={null}
    />
  );
}

async function mount(tasks: UseChatTasks): Promise<{ onParentBack: ReturnType<typeof vi.fn> }> {
  const onParentBack = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Parent tasks={tasks} onParentBack={onParentBack} />));
  await settle();
  return { onParentBack };
}

const q = (s: string) => document.querySelector<HTMLElement>(s);
const confirmDialog = () => q('[role="alertdialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const sheetOpen = () => q('[data-task-sheet]') !== null;

async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await wait(60);
  });
}

async function addDraft(title: string): Promise<void> {
  const input = q('[data-task-add="agency"] input') as HTMLInputElement;
  act(() => input.focus());
  act(() => x4Type(input, title));
  act(() => q('[data-task-add="agency"] [data-task-add-submit]')?.click());
  // The Sheet's guard places its step after the commit (a microtask).
  await settle();
}

beforeEach(() => {
  resetHistorySteps();
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('X4 TaskSheet and system Back', () => {
  it('with drafts: Back asks, the parent close never runs, Keep editing keeps them', async () => {
    const { onParentBack } = await mount(x4FakeTasks([]));
    await addDraft('Hook');
    await addDraft('Grid');
    await pressBack();
    expect(confirmDialog()?.getAttribute('aria-label')).toBe(DISCARD_TASKS_TITLE);
    expect(onParentBack).not.toHaveBeenCalled();
    expect(sheetOpen()).toBe(true);
    await act(async () => {
      button('Keep editing')?.click();
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirmDialog()).toBeNull();
    expect(document.querySelectorAll('[data-task-draft]')).toHaveLength(2);
    // Back again asks again: the guard's entry came back.
    await pressBack();
    expect(confirmDialog()).not.toBeNull();
    expect(onParentBack).not.toHaveBeenCalled();
  });

  it('with a dirty row edit: Back asks the same and the parent close never runs', async () => {
    const { onParentBack } = await mount(x4FakeTasks([x4Task({})]));
    act(() => q('[data-task-row-id="t1"] button[aria-expanded]')?.click());
    act(() => q('[data-task-row-id="t1"] [data-task-opt="p0"]')?.click());
    await settle();
    await pressBack();
    expect(confirmDialog()?.getAttribute('aria-label')).toBe(DISCARD_TASKS_TITLE);
    expect(onParentBack).not.toHaveBeenCalled();
    expect(q('[data-task-row-id="t1"]')?.hasAttribute('data-task-expanded')).toBe(true);
  });

  it('Discard closes the sheet and leaves no stray history entry', async () => {
    const { onParentBack } = await mount(x4FakeTasks([]));
    await addDraft('Hook');
    await pressBack();
    await act(async () => button('Discard')?.click());
    await settle();
    await act(async () => wait(DUR_BASE_MS + 40));
    expect(sheetOpen()).toBe(false);
    expect(onParentBack).not.toHaveBeenCalled();
    expect(isStepEntry(window.history.state)).toBe(false);
  });

  it('a clean sheet: Back closes through the parent step as before', async () => {
    const { onParentBack } = await mount(x4FakeTasks([]));
    await pressBack();
    expect(confirmDialog()).toBeNull();
    expect(onParentBack).toHaveBeenCalledTimes(1);
  });
});
