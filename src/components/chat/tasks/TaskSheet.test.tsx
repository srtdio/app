// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The shared Sheet and confirm surface are covered by their own tests: plain stand-ins here.
vi.mock('@/components/ui/Sheet', () => ({
  Sheet: (props: { open: boolean; children: ReactNode; footer?: ReactNode }) =>
    props.open ? (
      <div role="dialog">
        {props.children}
        {props.footer}
      </div>
    ) : null,
}));
vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    title: string;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <div data-confirm="">
      <p>{props.title}</p>
      <button type="button" onClick={props.onCancel}>
        {props.cancelLabel}
      </button>
      <button type="button" onClick={props.onConfirm}>
        {props.confirmLabel}
      </button>
    </div>
  ),
}));
vi.mock('@/components/ui/SearchHighlight', () => ({
  Highlight: (props: { text: string }) => props.text,
  glowTarget: () => () => {},
}));
vi.mock('@/components/chat/ForwardPicker', () => ({ ForwardPicker: () => null }));

import { DISCARD_TITLE, TaskSheet } from '@/components/chat/tasks/TaskSheet';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import type { ChatTask } from '@/lib/chat/tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 13 Oct 2026, 2 pm UTC.
const NOW = Date.parse('2026-10-13T14:00:00.000Z');

function task(over: Partial<ChatTask>): ChatTask {
  return {
    id: 't1',
    channelId: 'c1',
    number: 3,
    title: 'Reel cut',
    note: null,
    side: 'agency',
    status: 'todo',
    priority: 2,
    dueAt: '2026-10-13T20:00:00.000Z',
    dueSetBy: 'u1',
    dueSetAt: '2026-10-13T10:00:00.000Z',
    duePassedAt: null,
    createdBy: 'u1',
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-12T09:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

function fakeTasks(list: ChatTask[], extra: ChatTask[] = []): UseChatTasks {
  return {
    tasks: list,
    events: [],
    lineTasks: new Map([...extra, ...list].map((t) => [t.id, t] as const)),
    loaded: true,
    covers: () => true,
    pending: [],
    failed: new Map(),
    nameOf: () => 'Chitra',
    refetch: vi.fn(),
    ensureEventsSince: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    retryField: vi.fn(),
    remove: vi.fn(),
    ensureTask: vi.fn(),
    retryCreate: vi.fn(),
    removeCreate: vi.fn(),
  };
}

let host: HTMLDivElement;
let root: Root;

function render(el: ReactElement): void {
  act(() => root.render(el));
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return host.querySelector<T>(selector);
}

function click(selector: string): void {
  const el = q(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function clickText(text: string): void {
  const el = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`missing button ${text}`);
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function type(selector: string, value: string): void {
  const input = q<HTMLInputElement>(selector);
  if (input === null) throw new Error(`missing ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function sheet(tasks: UseChatTasks, focusTaskId: string | null = 't1'): ReactElement {
  return (
    <TaskSheet open onClose={() => {}} tasks={tasks} timeZone="UTC" focusTaskId={focusTaskId} />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('W9 fix 1: edit mode, Save sends only changed fields, Cancel asks', () => {
  it('nothing is written until Save; Save sends only the changed field', () => {
    const t = task({});
    const tasks = fakeTasks([t]);
    render(sheet(tasks));
    expect(q('[data-task-expanded]')).not.toBeNull();
    click('[data-task-opt="p0"]');
    expect(tasks.save).not.toHaveBeenCalled();
    click('[data-task-save]');
    expect(tasks.save).toHaveBeenCalledTimes(1);
    expect(tasks.save).toHaveBeenCalledWith(t, { priority: 0 });
  });
  it('Cancel with changes asks "Discard your changes?" (Keep editing / Discard)', () => {
    const tasks = fakeTasks([task({})]);
    render(sheet(tasks));
    click('[data-task-opt="p1"]');
    click('[data-task-cancel]');
    expect(q('[data-confirm]')?.textContent).toContain(DISCARD_TITLE);
    clickText('Keep editing');
    expect(q('[data-confirm]')).toBeNull();
    expect(q('[data-task-expanded]')).not.toBeNull();
    click('[data-task-cancel]');
    clickText('Discard');
    expect(q('[data-task-expanded]')).toBeNull();
    expect(tasks.save).not.toHaveBeenCalled();
  });
});

describe('W9 fix 2: the add row takes priority and Today / Tomorrow', () => {
  it('one create carries the picked priority and a 9 pm due', () => {
    const tasks = fakeTasks([task({})], []);
    render(sheet(tasks, null));
    type('[data-task-add="agency"] input', 'Hook');
    click('[data-task-add="agency"] [data-task-add-p="0"]');
    click('[data-task-add="agency"] [data-task-add-day="tomorrow"]');
    const form = q<HTMLFormElement>('[data-task-add="agency"]');
    act(() => form?.requestSubmit());
    expect(tasks.create).toHaveBeenCalledTimes(1);
    expect(tasks.create).toHaveBeenCalledWith('agency', 'Hook', 4, {
      priority: 0,
      dueAt: '2026-10-14T21:00:00.000Z',
    });
  });
});

describe('W9 fix 4: Delete hands the row to the undoable delete', () => {
  it('collapses and calls remove once', () => {
    const t = task({});
    const tasks = fakeTasks([t]);
    render(sheet(tasks));
    click('[data-task-delete]');
    expect(tasks.remove).toHaveBeenCalledWith(t);
    expect(q('[data-task-expanded]')).toBeNull();
  });
  it('a deleted row is not listed', () => {
    render(sheet(fakeTasks([task({ deletedAt: '2026-10-13T13:00:00Z' })]), null));
    expect(q('[data-task-row-id="t1"]')).toBeNull();
  });
});

describe('W9 fix 5: tapping the selected day keeps it; Clear date clears', () => {
  it('keeps the due on a second tap, clears only on Clear date', () => {
    const t = task({});
    const tasks = fakeTasks([t]);
    render(sheet(tasks));
    expect(q('[data-task-opt="today"]')?.getAttribute('aria-pressed')).toBe('true');
    click('[data-task-opt="today"]');
    expect(q('[data-task-opt="today"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-task-due-summary]')?.textContent).toBe('Due 8 pm');
    click('[data-task-save]');
    expect(tasks.save).not.toHaveBeenCalled();
  });
  it('a day without a time is 9 pm, and Clear date removes the due', () => {
    const t = task({ dueAt: null, dueSetBy: null, dueSetAt: null });
    const tasks = fakeTasks([t]);
    render(sheet(tasks));
    click('[data-task-opt="tomorrow"]');
    expect(q('[data-task-due-summary]')?.textContent).toBe('Due 9 pm');
    click('[data-task-clear-due]');
    expect(q('[data-task-due-summary]')).toBeNull();
    click('[data-task-opt="tomorrow"]');
    click('[data-task-save]');
    expect(tasks.save).toHaveBeenCalledWith(t, { due: '2026-10-14T21:00:00.000Z' });
  });
});

describe('W9 fix 6: opened for a closed item, the sheet shows it', () => {
  it('shows a closed item the lines hold, expanded', () => {
    const closed = task({ id: 'old', status: 'approved', updatedAt: '2026-10-01T09:00:00Z' });
    const tasks = fakeTasks([], [closed]);
    render(sheet(tasks, 'old'));
    expect(q('[data-task-group="closed"] [data-task-row-id="old"]')).not.toBeNull();
    expect(q('[data-task-row-id="old"]')?.hasAttribute('data-task-expanded')).toBe(true);
    expect(tasks.ensureTask).not.toHaveBeenCalled();
  });
  it('reads the item when nothing holds it', () => {
    const tasks = fakeTasks([]);
    render(sheet(tasks, 'missing'));
    expect(tasks.ensureTask).toHaveBeenCalledWith('missing');
  });
});

describe('W9 fix 7: counts and the next number', () => {
  it('reads the counts and shows the number only in the row being typed in', () => {
    const list = [
      task({ id: 'a', number: 1 }),
      task({ id: 'b', number: 2 }),
      task({ id: 'c', number: 3, side: 'client' }),
      task({ id: 'd', number: 4, side: 'client' }),
    ];
    render(sheet(fakeTasks(list), null));
    expect(q('[data-task-counts]')?.textContent).toBe('2 open for creators · 2 for approvers');
    expect(q('[data-task-add="agency"] [data-task-preview]')?.textContent).toBe('');
    type('[data-task-add="client"] input', 'Grid');
    expect(q('[data-task-add="client"] [data-task-preview]')?.textContent).toBe('5');
    expect(q('[data-task-add="agency"] [data-task-preview]')?.textContent).toBe('');
  });
});
