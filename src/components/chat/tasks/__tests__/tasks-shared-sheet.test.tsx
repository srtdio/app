// @vitest-environment jsdom
// The shared Tasks sheet: every change saves itself TASK_AUTOSAVE_MS after the
// last one, as one saveBatch with only the changed fields; change-then-revert
// writes nothing; the header reads Saving… / Saved; a conflicting edit waits
// with Keep mine / Keep theirs; a deleted one offers Restore mine / OK; marks
// show other people's changes; Cmd+S saves at once;
// the chips, the row menu's days, Past's Not done / Done, full screen, a
// swipe left to delete, and search (from the ⋯ menu) across every chip.
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

import { TASK_AUTOSAVE_MS, TaskSheet } from '@/components/chat/tasks/TaskSheet';
import type { SaveOutcome, UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import type { BatchPayload, TaskEvent } from '@/lib/chat/tasks';
import { x4FakeTasks, x4Task, x4Type } from './x4-fake-tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const q = (s: string) => document.querySelector<HTMLElement>(s);
/** The header's save state: 'saving' (a change waits or is in flight), 'saved', or null. */
const saveState = (): string | null =>
  q('[data-task-save-state]')?.getAttribute('data-task-save-state') ?? null;
/** Cmd+S: save at once instead of waiting for the changes to settle. */
async function saveNow(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The ⋯ menu's rows by label (open it first). */
const menuRows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
];
const rowLabel = (row: HTMLButtonElement): string =>
  row.querySelector('span.truncate')?.textContent ?? row.textContent ?? '';
async function openMenu(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
  if (trigger === null) throw new Error('no ⋯');
  await act(async () => {
    trigger.click();
    await wait(30);
  });
}
async function closeMenu(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await wait(30);
  });
}
/** A row's own menu (a right-click on its title), its rows. */
async function openRowMenu(id: string): Promise<HTMLButtonElement[]> {
  const title = q(`[data-task-row-id="${id}"] [data-task-title]`);
  if (title === null) throw new Error(`no row ${id}`);
  await act(async () => {
    title.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await wait(30);
  });
  return menuRows();
}
async function pickRow(rows: HTMLButtonElement[], label: string): Promise<void> {
  const row = rows.find((r) => rowLabel(r) === label);
  if (row === undefined) throw new Error(`no ${label}`);
  await act(async () => {
    row.click();
    await wait(30);
  });
}
const chipOf = (): string | null => q('[data-task-list]')?.getAttribute('data-task-chip') ?? null;
/** One touch pointer event on a row's slider (jsdom has no PointerEvent: a MouseEvent carrying its fields). */
function touch(el: Element, type: string, x: number, t: number): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 20 });
  Object.defineProperty(e, 'pointerType', { value: 'touch' });
  Object.defineProperty(e, 'pointerId', { value: 7 });
  Object.defineProperty(e, 'timeStamp', { value: t });
  el.dispatchEvent(e);
}
/** A finger drags a row's title by dx px (left when negative) and lets go. */
async function swipeRow(id: string, dx: number): Promise<void> {
  const title = q(`[data-task-row-id="${id}"] [data-task-title]`);
  if (title === null) throw new Error(`no row ${id}`);
  await act(async () => {
    touch(title, 'pointerdown', 200, 0);
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) {
      touch(title, 'pointermove', 200 + (dx * i) / steps, i * 16);
    }
    touch(title, 'pointerup', 200 + dx, steps * 16 + 16);
    await wait(30);
  });
}
const submitAdd = (): void => {
  act(() => q('[data-task-add]')?.dispatchEvent(new Event('submit', { bubbles: true })));
};

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
        timeZone="UTC"
        weekStartDay={1}
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
  it('a change saves itself once changes settle; change-then-revert writes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const tasks = x4FakeTasks([A, B]);
      render(tasks);
      expect(q('[data-task-save]')).toBeNull();
      expect(saveState()).toBeNull();
      act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
      expect(saveState()).toBe('saving');
      act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
      expect(saveState()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(TASK_AUTOSAVE_MS);
      });
      expect(tasks.saveBatch).not.toHaveBeenCalled();
      act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
      act(() => {
        vi.advanceTimersByTime(TASK_AUTOSAVE_MS - 1);
      });
      expect(tasks.saveBatch).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(tasks.saveBatch).toHaveBeenCalledTimes(1);
      expect(saveState()).toBe('saved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('one saveBatch: edits with only changed fields, the new task on my side at P1', async () => {
    const tasks = x4FakeTasks([A, B]);
    render(tasks);
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    act(() => q('[data-task-row-id="b"] [data-task-chip]')?.click());
    act(() => q('[data-task-menu-p="0"]')?.click());
    const input = q('[data-task-add] input') as HTMLInputElement;
    act(() => x4Type(input, 'Story'));
    // No date: the create carries no due_on.
    act(() => q('[data-task-days="add"] [data-task-day="none"]')?.click());
    submitAdd();
    await saveNow();
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

  it('the round Add task button beside the well adds like Enter; it waits for text', () => {
    render(x4FakeTasks([A]));
    const add = q('[data-task-add-submit]') as HTMLButtonElement;
    expect(add.getAttribute('aria-label')).toBe('Add task');
    expect(add.disabled).toBe(true);
    const input = q('[data-task-add] input') as HTMLInputElement;
    act(() => x4Type(input, 'Story'));
    expect(add.disabled).toBe(false);
    act(() => add.click());
    expect(q('[data-task-row-id] [data-task-title]')?.textContent).toContain('Story');
    expect(input.value).toBe('');
    expect(add.disabled).toBe(true);
    expect(saveState()).toBe('saving');
  });

  it('a new task takes Today by default, sends due_on, and the sheet moves to Today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
    try {
      const tasks = x4FakeTasks([A, B]);
      render(tasks);
      // Nothing is dated: the sheet opens on No date, where A and B sit.
      expect(chipOf()).toBe('none');
      expect(q('[data-task-row-id="a"]')).not.toBeNull();
      const input = q('[data-task-add] input') as HTMLInputElement;
      act(() => x4Type(input, 'Story'));
      submitAdd();
      expect(chipOf()).toBe('today');
      expect(q('[data-task-row-id="a"]')).toBeNull();
      expect(q('[data-task-list] [data-task-marked]')?.textContent).toContain('Story');
      await saveNow();
      const payload = (tasks.saveBatch as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as BatchPayload;
      expect(payload.creates).toEqual([
        { title: 'Story', priority: 1, side: 'client', due_on: '2026-11-05' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('chips: Past splits Not done above Done; search (from the menu) finds tasks across every chip', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
    try {
      const late = x4Task({ id: 'p1', number: 4, title: 'Approve plan', dueOn: '2026-11-03' });
      const shipped = x4Task({
        id: 'p2',
        number: 5,
        title: 'Invoice copy',
        dueOn: '2026-11-02',
        status: 'done',
        doneAt: '2026-11-01T09:00:00.000Z',
      });
      const later = x4Task({ id: 'l1', number: 6, title: 'Logo files', dueOn: '2026-11-20' });
      render(x4FakeTasks([A, late, shipped, later]));
      act(() => q('[data-task-when-chip="past"]')?.click());
      expect(chipOf()).toBe('past');
      const sections = [...document.querySelectorAll('[data-task-section]')].map((el) =>
        el.getAttribute('data-task-section'),
      );
      expect(sections).toEqual(['open', 'done']);
      expect(q('[data-task-row-id="p1"] [data-task-when]')?.textContent).toBe('Overdue 2 days');
      expect(q('[data-task-row-id="p2"] [data-task-when]')?.textContent).toContain(
        'Due 2 Nov · done',
      );
      expect(q('[data-task-row-id="l1"]')).toBeNull();
      // Today holds nothing: one positive line.
      act(() => q('[data-task-when-chip="today"]')?.click());
      expect(q('[data-task-zero]')?.textContent).toBe('Tasks due today show up here.');
      // Search: from the menu, across every chip, by word prefix.
      await openMenu();
      await pickRow(menuRows(), 'Search tasks');
      const field = q('[data-task-search] input') as HTMLInputElement;
      act(() => x4Type(field, 'log'));
      expect(chipOf()).toBe('search');
      expect(q('[data-task-chips]')).toBeNull();
      expect(q('[data-task-row-id="l1"]')).not.toBeNull();
      expect(q('[data-task-row-id="p1"]')).toBeNull();
      expect(q('[data-task-add]')).toBeNull();
      act(() => q('[data-task-search-cancel]')?.click());
      expect(q('[data-task-search]')).toBeNull();
      expect(chipOf()).toBe('today');
    } finally {
      vi.useRealTimers();
    }
  });

  it("a task's menu: Tomorrow edits due_on and moves it to This week; No date shows once dated", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
    try {
      const tasks = x4FakeTasks([A]);
      render(tasks);
      let rows = await openRowMenu('a');
      expect(rows.map(rowLabel)).toEqual(['Today', 'Tomorrow', 'Pick a date', 'Delete']);
      await pickRow(rows, 'Tomorrow');
      // The sheet follows the row to This week.
      expect(chipOf()).toBe('week');
      expect(q('[data-task-row-id="a"] [data-task-when]')?.textContent).toBe('Due tomorrow');
      rows = await openRowMenu('a');
      expect(rows.map(rowLabel)).toEqual(['Today', 'Tomorrow', 'Pick a date', 'No date', 'Delete']);
      await closeMenu();
      await saveNow();
      const payload = (tasks.saveBatch as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as BatchPayload;
      expect(payload.edits).toEqual([
        { task_id: 'a', base_updated_at: A.updatedAt, changes: { due_on: '2026-11-06' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the row menu's Delete queues the task for the save, with Undo on the row", async () => {
    render(x4FakeTasks([A, B]));
    await pickRow(await openRowMenu('a'), 'Delete');
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-deleting')).toBe(true);
    expect(saveState()).toBe('saving');
    act(() => q('[data-task-undo-delete]')?.click());
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-deleting')).toBe(false);
    expect(saveState()).toBeNull();
  });

  it('a swipe left past the trigger queues the task; a swipe right or a short one does not', async () => {
    render(x4FakeTasks([A, B]));
    await swipeRow('a', 40);
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-deleting')).toBe(false);
    await swipeRow('a', -30);
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-deleting')).toBe(false);
    await swipeRow('a', -90);
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-deleting')).toBe(true);
    expect(saveState()).toBe('saving');
    // The queued row holds Undo, and B is untouched.
    expect(q('[data-task-row-id="a"] [data-task-undo-delete]')).not.toBeNull();
    expect(q('[data-task-row-id="b"]')?.hasAttribute('data-task-deleting')).toBe(false);
    // A tap on Undo (its own press, then its click) is not the swipe's trailing click.
    const undo = q('[data-task-undo-delete]');
    if (undo === null) throw new Error('no Undo');
    act(() => {
      touch(undo, 'pointerdown', 300, 500);
      touch(undo, 'pointerup', 300, 520);
      undo.click();
    });
    expect(saveState()).toBeNull();
  });

  it('full screen from the menu fills the screen; Half screen returns', async () => {
    render(x4FakeTasks([A]));
    const dialog = () => q('[role="dialog"][aria-label="Tasks"]');
    expect(dialog()?.hasAttribute('data-task-full')).toBe(false);
    await openMenu();
    await pickRow(menuRows(), 'Full screen');
    expect(dialog()?.hasAttribute('data-task-full')).toBe(true);
    await openMenu();
    expect(menuRows().map(rowLabel)).toEqual(['Search tasks', 'Half screen']);
    await pickRow(menuRows(), 'Half screen');
    expect(dialog()?.hasAttribute('data-task-full')).toBe(false);
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

  it('a conflict waits with Keep mine / Keep theirs (never auto-sent); Keep mine re-sends with the new base', async () => {
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
          dueOn: null,
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
    await saveNow();
    expect(q('[data-task-conflict]')?.textContent).toContain('Leo changed this to "Hook (Leo)"');
    // The conflicting row is held back: nothing waits to be sent.
    expect(saveState()).toBe('saved');
    await saveNow();
    expect(saveBatch).toHaveBeenCalledTimes(1);
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
            dueOn: null,
            updatedAt: '2026-10-19T10:00:00.000Z',
          },
        ],
      }),
    );
    render(x4FakeTasks([A], { saveBatch }));
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    await saveNow();
    expect(q('[data-task-conflict]')?.textContent).toContain('deleted this');
    expect(q('[data-task-keep-mine]')?.textContent).toBe('Restore mine');
    expect(q('[data-task-keep-theirs]')?.textContent).toBe('OK');
    act(() => q('[data-task-keep-theirs]')?.click());
    expect(q('[data-task-conflict]')).toBeNull();
    expect(saveState()).toBe('saved');
    expect(saveBatch).toHaveBeenCalledTimes(1);
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

  it('"<Name> is editing…" under the title; Cmd+S saves at once', async () => {
    const tasks = x4FakeTasks([A], { editors: ['u2'] });
    render(tasks);
    expect(q('[data-task-editing]')?.textContent).toBe('Leo is editing…');
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    expect(tasks.setEditing).toHaveBeenLastCalledWith(true);
    await saveNow();
    expect(tasks.saveBatch).toHaveBeenCalledTimes(1);
  });

  it('a failed save shows Retry and the error; Retry sends again', async () => {
    const saveBatch = vi
      .fn<(p: BatchPayload) => Promise<SaveOutcome>>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({ ok: true, createdIds: [], conflicts: [], batchId: 'b2' });
    render(x4FakeTasks([A], { saveBatch }));
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    await saveNow();
    expect(q('[data-task-save-failed]')).not.toBeNull();
    const retry = q('[data-task-retry]');
    expect(retry?.textContent).toBe('Retry');
    await act(async () => retry?.click());
    expect(saveBatch).toHaveBeenCalledTimes(2);
    expect(q('[data-task-retry]')).toBeNull();
    expect(saveState()).toBe('saved');
  });
});
