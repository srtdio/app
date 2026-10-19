// @vitest-environment jsdom
// X4 (FT50): the Tasks sheet while its list read is in flight shows a
// skeleton; a failed read shows the shared load error ("Couldn't load
// tasks.") and Retry; never a healthy-looking empty list.
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/components/ui/SearchHighlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/SearchHighlight')>()),
  glowTarget: () => () => {},
}));

import { TaskSheet } from '@/components/chat/tasks/TaskSheet';
import { useChatTasks, type UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { x4FakeTasks } from './x4-fake-tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function show(node: ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

function sheet(tasks: UseChatTasks): ReactElement {
  return (
    <TaskSheet
      open
      onClose={() => {}}
      tasks={tasks}
      currentUserId="me"
      side="agency"
      seenMs={null}
      focusTaskId={null}
    />
  );
}

const q = (s: string) => document.querySelector<HTMLElement>(s);
const text = () => document.body.textContent ?? '';

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('X4 Tasks sheet load states', () => {
  it('loading: a skeleton, no list', () => {
    show(sheet(x4FakeTasks([], { loadState: 'loading', loaded: false })));
    expect(q('[data-task-skeleton]')).not.toBeNull();
    expect(q('[data-task-list]')).toBeNull();
  });

  it('failed: "Couldn\'t load tasks." and Retry; never an empty list', () => {
    const tasks = x4FakeTasks([], { loadState: 'failed' });
    show(sheet(tasks));
    expect(q('[role="alert"]')?.textContent).toContain("Couldn't load tasks.");
    expect(q('[data-task-list]')).toBeNull();
    expect(q('[data-task-share]')).toBeNull();
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    act(() => retry?.click());
    expect(tasks.refetch).toHaveBeenCalledTimes(1);
  });

  it('the hook: a list read that fails (offline) reads failed, and the sheet shows Retry', async () => {
    const offline = {
      from: () => {
        throw new Error('Failed to fetch');
      },
      rpc: () => Promise.reject(new Error('Failed to fetch')),
    } as unknown as Client;
    function Probe(): ReactElement {
      const [profiles] = useState(() => new Map());
      const tasks = useChatTasks({
        channelId: 'c-offline',
        currentUserId: 'u1',
        target: null,
        profiles,
        db: offline,
      });
      return sheet(tasks);
    }
    show(<Probe />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(q('[role="alert"]')?.textContent).toContain("Couldn't load tasks.");
    expect(q('[data-task-list]')).toBeNull();
    expect(text()).not.toContain('Add a task');
  });
});
