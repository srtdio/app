// Button system regression: the task row's Undo, delete, Keep mine / Keep
// theirs and the Not saved Retry render the shared 44px, 8px-radius recipe.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotSaved, TaskRow, type TaskRowProps } from '@/components/chat/tasks/TaskRow';

const noop = (): void => {};

function props(over: Partial<TaskRowProps> = {}): TaskRowProps {
  return {
    id: 't1',
    number: 3,
    title: 'Write the caption',
    done: false,
    priority: 2,
    dot: false,
    marks: [],
    queuedDelete: false,
    notice: null,
    onToggle: noop,
    onTitle: noop,
    onPriority: noop,
    onDelete: noop,
    onUndoDelete: noop,
    ...over,
  };
}

function tag(html: string, attr: string): string {
  return new RegExp(`<button[^>]*${attr}[^>]*>`).exec(html)?.[0] ?? '';
}

function expectOnSystem(t: string): void {
  expect(t).toContain('h-11');
  expect(t).toContain('rounded-lg');
  expect(t).not.toMatch(/\bh-9\b|\bh-12\b|rounded-md|rounded-\[8px\]|text-\[13px\]|font-semibold/);
}

describe('task row buttons', () => {
  it('delete is the 44x44 IconButton', () => {
    const html = renderToStaticMarkup(<TaskRow {...props()} />);
    const del = tag(html, 'data-task-delete=""');
    expectOnSystem(del);
    expect(del).toContain('h-11 w-11');
    expect(del).toContain('aria-label="Delete Write the caption"');
  });

  it('Undo is the link Button', () => {
    const html = renderToStaticMarkup(<TaskRow {...props({ queuedDelete: true })} />);
    const undo = tag(html, 'data-task-undo-delete=""');
    expectOnSystem(undo);
    expect(undo).toContain('text-accent');
  });

  it('Keep mine and Keep theirs are secondary Buttons', () => {
    const html = renderToStaticMarkup(
      <TaskRow
        {...props({
          notice: { text: 'Both edited', deleted: false, onMine: noop, onTheirs: noop },
        })}
      />,
    );
    for (const attr of ['data-task-keep-mine=""', 'data-task-keep-theirs=""']) {
      const t = tag(html, attr);
      expectOnSystem(t);
      expect(t).toContain('border-border');
    }
  });

  it('Not saved Retry is a 44px Button in bad ink', () => {
    const html = renderToStaticMarkup(<NotSaved onRetry={noop} />);
    const [retry] = html.match(/<button[^>]*>/g) ?? [];
    expectOnSystem(retry ?? '');
    expect(retry).toContain('text-bad');
  });
});
