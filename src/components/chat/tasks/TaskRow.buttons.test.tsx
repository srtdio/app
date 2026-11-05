// Button system regression: the task row's Undo, Keep mine / Keep theirs and
// the Not saved Retry render the shared 44px, 8px-radius recipe; the title is
// one 44px PressableRow carrying the date line; the row menu's rows end with
// Delete and offer No date only once dated.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NotSaved,
  TaskRow,
  rowMenuItems,
  type RowMenu,
  type TaskRowProps,
} from '@/components/chat/tasks/TaskRow';

const noop = (): void => {};

function props(over: Partial<TaskRowProps> = {}): TaskRowProps {
  return {
    id: 't1',
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
  it('no delete button on the row: Delete is the last row of its menu', () => {
    const html = renderToStaticMarkup(<TaskRow {...props()} />);
    expect(html).not.toContain('data-task-delete');
    const menu: RowMenu = {
      choices: [
        { key: 'today', label: 'Today', dueOn: '2026-11-05' },
        { key: 'tomorrow', label: 'Tomorrow', dueOn: '2026-11-06' },
        { key: 'none', label: 'No date', dueOn: null },
      ],
      hasDate: false,
      onDay: noop,
      onPickDate: noop,
    };
    expect(rowMenuItems(menu, noop).map((i) => i.label)).toEqual([
      'Today',
      'Tomorrow',
      'Pick a date',
      'Delete',
    ]);
    const dated = rowMenuItems({ ...menu, hasDate: true }, noop);
    expect(dated.map((i) => i.label)).toEqual([
      'Today',
      'Tomorrow',
      'Pick a date',
      'No date',
      'Delete',
    ]);
    expect(dated.at(-1)?.tone).toBe('danger');
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
      expect(t).toContain('lit-btn-secondary');
    }
  });

  it('the title is a 44px PressableRow; the date line sits under it, mono, bad when overdue', () => {
    const none = renderToStaticMarkup(<TaskRow {...props()} />);
    const title = tag(none, 'data-task-title=""');
    expect(title).toContain('min-h-[44px]');
    expect(title).toContain('rounded-lg');
    expect(none).not.toContain('data-task-when');
    const late = renderToStaticMarkup(
      <TaskRow {...props({ dateLine: { text: '3 Nov', bad: true } })} />,
    );
    const when = /<span[^>]*data-task-when=""[^>]*>/.exec(late)?.[0] ?? '';
    expect(when).toContain('font-mono');
    expect(when).toContain('text-bad');
    expect(late).toContain('>3 Nov</span>');
  });

  it('Not saved Retry is a 44px Button in bad ink', () => {
    const html = renderToStaticMarkup(<NotSaved onRetry={noop} />);
    const [retry] = html.match(/<button[^>]*>/g) ?? [];
    expectOnSystem(retry ?? '');
    expect(retry).toContain('text-bad');
  });
});
