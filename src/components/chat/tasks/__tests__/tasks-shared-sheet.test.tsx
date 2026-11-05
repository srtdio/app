// @vitest-environment jsdom
// The shared Tasks page: nothing writes until Save (in the ⋯ menu, only while
// something changed); Save is one saveBatch with only the changed fields;
// change-then-revert leaves no Save; a conflicting edit stays dirty with Keep
// mine / Keep theirs; a deleted one offers Restore mine / OK; marks show other
// people's changes; Cmd+S saves; the sections, the row menu's days, Done
// folded, and search across every section.
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
async function menuLabels(): Promise<string[]> {
  await openMenu();
  const labels = menuRows().map(rowLabel);
  await closeMenu();
  return labels;
}
/** Save from the ⋯ menu. */
async function save(): Promise<void> {
  await openMenu();
  const row = menuRows().find((r) => rowLabel(r) === 'Save');
  if (row === undefined) throw new Error('no Save');
  await act(async () => {
    row.click();
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
/** The sections on the page, in order. */
const sectionKeys = (): string[] =>
  [...document.querySelectorAll('[data-task-section]')].map(
    (el) => el.getAttribute('data-task-section') ?? '',
  );
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
  it('nothing writes until Save; the menu offers Save only while something changed', async () => {
    const tasks = x4FakeTasks([A, B]);
    render(tasks);
    expect(await menuLabels()).toEqual(['Search tasks']);
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    expect(await menuLabels()).toEqual(['Save', 'Search tasks']);
    act(() => q('[data-task-row-id="a"] [data-task-tick]')?.click());
    expect(await menuLabels()).toEqual(['Search tasks']);
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
    submitAdd();
    // A new task has no date until one is given: the create carries no due_on.
    await save();
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

  it('a new task lands in No date; its menu gives it a day, and the row moves to that section', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T10:00:00.000Z'));
    try {
      const tasks = x4FakeTasks([A, B]);
      render(tasks);
      expect(sectionKeys()).toEqual(['none']);
      const input = q('[data-task-add] input') as HTMLInputElement;
      act(() => x4Type(input, 'Story'));
      submitAdd();
      const fresh = q('[data-task-section="none"] [data-task-marked]');
      expect(fresh?.textContent).toContain('Story');
      const key = fresh?.getAttribute('data-task-row-id') ?? '';
      const rows = await openRowMenu(key);
      expect(rows.map(rowLabel)).toEqual(['Today', 'Tomorrow', 'Pick a date', 'Delete']);
      await pickRow(rows, 'Today');
      expect(sectionKeys()).toEqual(['today', 'none']);
      expect(q(`[data-task-section="today"] [data-task-row-id="${key}"]`)).not.toBeNull();
      await save();
      const payload = (tasks.saveBatch as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as BatchPayload;
      expect(payload.creates).toEqual([
        { title: 'Story', priority: 1, side: 'client', due_on: '2026-11-05' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sections in page order, Done folded; search lists matches across every section', async () => {
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
      expect(sectionKeys()).toEqual(['overdue', 'later', 'none', 'done']);
      expect(q('[data-task-row-id="p1"] [data-task-when]')?.textContent).toBe('3 Nov');
      expect(q('[data-task-row-id="l1"] [data-task-when]')?.textContent).toBe('20 Nov');
      expect(q('[data-task-row-id="a"] [data-task-when]')).toBeNull();
      // Done is folded: its count shows, its rows open on a tap.
      expect(q('[data-task-row-id="p2"]')).toBeNull();
      expect(q('[data-task-done-fold]')?.textContent).toContain('Done');
      act(() => q('[data-task-done-fold]')?.click());
      expect(q('[data-task-row-id="p2"] [data-task-when]')?.textContent).toContain(
        'Due 2 Nov · done',
      );
      // Search: across every section, by word prefix, one flat list.
      await openMenu();
      await pickRow(menuRows(), 'Search tasks');
      const field = q('[data-task-search] input') as HTMLInputElement;
      act(() => x4Type(field, 'log'));
      expect(q('[data-task-list]')?.getAttribute('data-task-chip')).toBe('search');
      expect(sectionKeys()).toEqual([]);
      expect(q('[data-task-row-id="l1"]')).not.toBeNull();
      expect(q('[data-task-row-id="p1"]')).toBeNull();
      expect(q('[data-task-add]')).toBeNull();
      act(() => q('[data-task-search-cancel]')?.click());
      expect(q('[data-task-search]')).toBeNull();
      expect(sectionKeys()).toEqual(['overdue', 'later', 'none', 'done']);
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
      expect(sectionKeys()).toEqual(['week']);
      expect(q('[data-task-row-id="a"] [data-task-when]')?.textContent).toBe('6 Nov');
      rows = await openRowMenu('a');
      expect(rows.map(rowLabel)).toEqual(['Today', 'Tomorrow', 'Pick a date', 'No date', 'Delete']);
      await closeMenu();
      await save();
      const payload = (tasks.saveBatch as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as BatchPayload;
      expect(payload.edits).toEqual([
        { task_id: 'a', base_updated_at: A.updatedAt, changes: { due_on: '2026-11-06' } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the row menu's Delete queues the task into Save, with Undo on the row", async () => {
    render(x4FakeTasks([A, B]));
    await pickRow(await openRowMenu('a'), 'Delete');
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-deleting')).toBe(true);
    expect(await menuLabels()).toEqual(['Save', 'Search tasks']);
    act(() => q('[data-task-undo-delete]')?.click());
    expect(q('[data-task-row-id="a"]')?.hasAttribute('data-task-deleting')).toBe(false);
    expect(await menuLabels()).toEqual(['Search tasks']);
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
    await save();
    expect(q('[data-task-conflict]')?.textContent).toContain('Leo changed this to "Hook (Leo)"');
    expect(await menuLabels()).toEqual(['Save', 'Search tasks']);
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
    await save();
    expect(q('[data-task-conflict]')?.textContent).toContain('deleted this');
    expect(q('[data-task-keep-mine]')?.textContent).toBe('Restore mine');
    expect(q('[data-task-keep-theirs]')?.textContent).toBe('OK');
    act(() => q('[data-task-keep-theirs]')?.click());
    expect(q('[data-task-conflict]')).toBeNull();
    expect(await menuLabels()).toEqual(['Search tasks']);
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
