// @vitest-environment jsdom
// Cmd/Ctrl+S on the Tasks sheet: a keydown with no key (Android Chrome
// autofill, Sentry FRONTEND-G) never throws.

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

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Tasks sheet save shortcut', () => {
  it('a keydown with no key does not throw', () => {
    show();
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    const event = new KeyboardEvent('keydown', { ctrlKey: true, metaKey: true, bubbles: true });
    Object.defineProperty(event, 'key', { value: undefined });
    expect(() => document.dispatchEvent(event)).not.toThrow();
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
