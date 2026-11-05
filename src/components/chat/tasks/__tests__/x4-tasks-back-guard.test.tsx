// @vitest-environment jsdom
// X4 (FT49): TaskSheet under a real useHistoryStep('chatTasks') parent, the
// way MessageThread mounts it. Tasks save themselves: with changes still
// waiting, system Back sends them first and then closes the sheet (the
// parent's own close callback never runs); a failed save keeps the sheet open
// with Retry; a clean sheet closes through the parent step as before.
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

import { TaskSheet } from '@/components/chat/tasks/TaskSheet';
import type { SaveOutcome, UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import type { BatchPayload } from '@/lib/chat/tasks';
import { resetHistorySteps, useHistoryStep } from '@/lib/chat/use-history-step';
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
      currentUserId="me"
      side="agency"
      seenMs={null}
      focusTaskId={null}
      timeZone="UTC"
      weekStartDay={1}
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
const sheetOpen = () => q('[data-task-sheet]') !== null;

async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await wait(60);
  });
}

async function addDraft(title: string): Promise<void> {
  const input = q('[data-task-add] input') as HTMLInputElement;
  act(() => input.focus());
  act(() => x4Type(input, title));
  act(() => q('[data-task-add]')?.dispatchEvent(new Event('submit', { bubbles: true })));
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
  it('with new tasks: Back saves them, then closes; the parent close never runs', async () => {
    const tasks = x4FakeTasks([]);
    const { onParentBack } = await mount(tasks);
    await addDraft('Hook');
    await addDraft('Grid');
    await pressBack();
    await settle();
    await act(async () => wait(DUR_BASE_MS + 40));
    expect(confirmDialog()).toBeNull();
    expect(tasks.saveBatch).toHaveBeenCalledTimes(1);
    const payload = (tasks.saveBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as BatchPayload;
    expect(payload.creates.map((c) => c.title)).toEqual(['Hook', 'Grid']);
    expect(sheetOpen()).toBe(false);
    expect(onParentBack).not.toHaveBeenCalled();
  });

  it('a failed save keeps the sheet open with Retry, and the tick stays', async () => {
    const saveBatch = vi.fn(async (): Promise<SaveOutcome> => ({ ok: false }));
    const { onParentBack } = await mount(x4FakeTasks([x4Task({})], { saveBatch }));
    act(() => q('[data-task-row-id="t1"] [data-task-tick]')?.click());
    await settle();
    await pressBack();
    await settle();
    expect(saveBatch).toHaveBeenCalledTimes(1);
    expect(sheetOpen()).toBe(true);
    expect(q('[data-task-retry]')).not.toBeNull();
    expect(onParentBack).not.toHaveBeenCalled();
    expect(q('[data-task-row-id="t1"] [data-task-tick]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('a clean sheet: Back closes through the parent step as before', async () => {
    const { onParentBack } = await mount(x4FakeTasks([]));
    await pressBack();
    expect(confirmDialog()).toBeNull();
    expect(onParentBack).toHaveBeenCalledTimes(1);
  });
});
