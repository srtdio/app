// @vitest-environment jsdom
// Stuck deletes (regression). A queued delete waits UNDO_MS (4 s) before the
// autosave sends it. The countdown used to restart whenever the sheet's `save`
// changed identity, and that follows the whole `tasks` object, so a parent
// that hands a new object more often than every 4 s (a live re-read, Catch
// up's `profiles: new Map()` re-rendering each second while someone else is
// editing) kept it from ever firing: the row stayed queued and the header sat
// on "Saving…". A save that rejected or never answered left `saving` on for
// good the same way. Both now end: the countdown restarts only on a draft
// change, a rejected save lands as Retry, and the hook's Save has a ceiling.
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { TaskSheet } from '@/components/chat/tasks/TaskSheet';
import {
  SAVE_TIMEOUT_MS,
  useChatTasks,
  type SaveOutcome,
  type UseChatTasks,
} from '@/components/chat/tasks/useChatTasks';
import { UNDO_MS } from '@/lib/undo';
import { x4FakeTasks, x4Task } from './x4-fake-tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const q = (s: string) => document.querySelector<HTMLElement>(s);
const A = x4Task({ id: 'a', number: 1, title: 'Hook' });

function sheet(tasks: UseChatTasks): ReactElement {
  return (
    <TaskSheet
      open
      onClose={() => {}}
      tasks={tasks}
      currentUserId="me"
      side="client"
      seenMs={null}
      focusTaskId={null}
      timeZone="UTC"
      weekStartDay={1}
    />
  );
}

function mount(tasks: UseChatTasks): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(sheet(tasks)));
}

/** Delete row `id` from its own menu (right-click on the title). */
async function deleteRow(id: string): Promise<void> {
  const title = q(`[data-task-row-id="${id}"] [data-task-title]`);
  if (title === null) throw new Error(`no row ${id}`);
  await act(async () => {
    title.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(30);
  });
  const del = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((r) =>
    (r.textContent ?? '').includes('Delete'),
  );
  if (del === undefined) throw new Error('no Delete');
  await act(async () => {
    del.click();
    vi.advanceTimersByTime(30);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('stuck task deletes', () => {
  it('a queued delete saves after UNDO_MS even while the tasks object changes every second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const tasks = x4FakeTasks([A]);
    mount(tasks);
    await deleteRow('a');
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-deleting')).toBe(true);
    // A parent re-render with a fresh hook object (new nameOf) each second.
    for (let k = 0; k < Math.ceil(UNDO_MS / 1000) + 2; k += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      act(() => root?.render(sheet({ ...tasks, nameOf: (id: string) => id })));
    }
    const calls = (tasks.saveBatch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({
      creates: [],
      edits: [],
      deletes: [{ task_id: 'a', base_updated_at: A.updatedAt }],
    });
  });

  it('a save that rejects ends saving: Retry shows and the next save still goes out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const saveBatch = vi
      .fn<(p: unknown) => Promise<SaveOutcome>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ ok: true, createdIds: [], conflicts: [], batchId: 'b1' });
    const tasks = x4FakeTasks([A], { saveBatch });
    mount(tasks);
    await deleteRow('a');
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS + 10);
    });
    expect(saveBatch).toHaveBeenCalledTimes(1);
    expect(q('[data-task-save-state="saving"]')).toBeNull();
    const retry = q('[data-task-retry]');
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      vi.advanceTimersByTime(10);
    });
    expect(saveBatch).toHaveBeenCalledTimes(2);
  });
});

describe('useChatTasks saveBatch ceiling', () => {
  it('a Save that never answers lands as failed at SAVE_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ready = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    const builder: Record<string, unknown> = { then: ready };
    for (const m of ['select', 'eq', 'is', 'in', 'gt', 'lt', 'order', 'limit', 'abortSignal']) {
      builder[m] = () => builder;
    }
    const db = { from: () => builder, rpc: () => new Promise(() => {}) } as unknown as Client;
    let hook: UseChatTasks | null = null;
    function Probe(): ReactElement {
      const [profiles] = useState(() => new Map());
      hook = useChatTasks({
        channelId: 'stuck-delete-c1',
        currentUserId: 'u1',
        target: null,
        profiles,
        db,
      });
      return <span />;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Probe />);
    });
    let outcome: SaveOutcome | null = null;
    await act(async () => {
      void (hook as UseChatTasks | null)
        ?.saveBatch({ creates: [], edits: [], deletes: [{ task_id: 'a', base_updated_at: 'x' }] })
        .then((o) => {
          outcome = o;
        });
    });
    expect(outcome).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SAVE_TIMEOUT_MS + 1);
    });
    expect(outcome).toEqual({ ok: false });
  });
});
