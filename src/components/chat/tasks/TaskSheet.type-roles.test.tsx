// @vitest-environment jsdom
// Type roles on the Tasks sheet: the sheet title (15/20, 600), a task row's
// title as the row title (14, 500), the number column as mono meta (12) and
// the add field at 16px on a phone (iOS never zooms), 14 from md up.

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

import { ADD_PLACEHOLDER, TASK_SHEET_TITLE, TaskSheet } from '@/components/chat/tasks/TaskSheet';
import { x4FakeTasks, x4Task } from './__tests__/x4-fake-tasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function show(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const tasks = x4FakeTasks([
    x4Task({ id: 'a', number: 1, title: 'Hook' }),
    x4Task({ id: 'b', number: 2, title: 'Grid' }),
  ]);
  act(() =>
    root?.render(
      <TaskSheet
        open
        onClose={() => {}}
        tasks={tasks}
        currentUserId="me"
        side="agency"
        seenMs={null}
        focusTaskId={null}
      />,
    ),
  );
}

/** The first element matching `selector` whose trimmed text is exactly `text`. */
function byText(selector: string, text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (e) => (e.textContent ?? '').trim() === text,
  );
  if (el === undefined) throw new Error(`no ${selector} reading "${text}"`);
  return el;
}

const classes = (el: Element): string[] => el.className.split(/\s+/);

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Tasks sheet type roles', () => {
  it('sheet title: lg, 600', () => {
    show();
    const title = byText('h2', TASK_SHEET_TITLE);
    expect(classes(title)).toEqual(expect.arrayContaining(['text-lg', 'font-semibold', 'text-fg']));
  });

  it('row title: base, 500 (was 16px)', () => {
    show();
    const title = byText('[data-task-list] button', 'Hook');
    expect(classes(title)).toEqual(expect.arrayContaining(['text-base', 'font-medium', 'text-fg']));
    expect(classes(title)).not.toContain('text-lg');
  });

  it('meta: the task number column is mono sm', () => {
    show();
    const number = byText('[data-task-list] span', '1');
    expect(classes(number)).toEqual(expect.arrayContaining(['font-mono', 'text-sm']));
    expect(classes(number)).not.toContain('font-semibold');
  });

  it('add field: 16px on a phone, base from md up', () => {
    show();
    const input = document.querySelector<HTMLInputElement>(
      `input[aria-label="${ADD_PLACEHOLDER}"]`,
    );
    expect(input).not.toBeNull();
    expect(classes(input as Element)).toEqual(
      expect.arrayContaining(['text-input', 'md:text-base']),
    );
  });
});
