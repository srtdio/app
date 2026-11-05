// On laptop every task row ends with a bin button (Delete: <title>), a 44px
// IconButton in fg-3 ink that turns bad on hover; a row queued for delete
// shows Undo instead. The row menu keeps Delete too.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));

import { TaskRow, type TaskRowProps } from '@/components/chat/tasks/TaskRow';

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

describe('task row on laptop', () => {
  it('ends with a 44px bin button named for the task', () => {
    const html = renderToStaticMarkup(<TaskRow {...props()} />);
    const bin = /<button[^>]*data-task-delete=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(bin).toContain('aria-label="Delete: Write the caption"');
    expect(bin).toContain('h-11');
    expect(bin).toContain('rounded-lg');
    expect(bin).toContain('text-fg-3');
    expect(bin).toContain('hover:text-bad');
    // After the chip, at the row's end.
    expect(html.indexOf('data-task-chip=""')).toBeLessThan(html.indexOf('data-task-delete=""'));
  });

  it('a queued row shows Undo and no bin', () => {
    const html = renderToStaticMarkup(<TaskRow {...props({ queuedDelete: true })} />);
    expect(html).not.toContain('data-task-delete=');
    expect(html).toContain('data-task-undo-delete=""');
  });
});
