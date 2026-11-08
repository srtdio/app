// @vitest-environment jsdom
// Comment to task: a task made from a post or brief comment shows one line
// under its title, `From a comment on "<title>"` (secondary role, one line,
// truncated, a 44 tall PressableRow), and a tap opens that comment's deep link
// in the app (after the sheet's flush). A row with no source reserves nothing.

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRow, type TaskRowProps } from '@/components/chat/tasks/TaskRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = (): void => {};

function props(over: Partial<TaskRowProps> = {}): TaskRowProps {
  return {
    id: 't1',
    title: 'Fix the caption',
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

const SOURCE = { text: 'From a comment on "Launch reel"', href: '/posts/p1?comment=cm1' };

function Where(): ReactElement {
  const loc = useLocation();
  return <p data-where="">{`${loc.pathname}${loc.search}`}</p>;
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('task row source line', () => {
  it('a row with no source has no line and needs no router', () => {
    const html = renderToStaticMarkup(<TaskRow {...props()} />);
    expect(html).not.toContain('data-task-source');
    expect(renderToStaticMarkup(<TaskRow {...props({ source: null })} />)).not.toContain(
      'data-task-source',
    );
  });

  it('shows the line under the title: secondary, one line, a 44 tall row', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskRow {...props({ source: SOURCE })} />
      </MemoryRouter>,
    );
    const button = /<button[^>]*data-task-source=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toContain('min-h-11');
    expect(html).toContain('From a comment on &quot;Launch reel&quot;');
    // ui/Text secondary: one line, truncated, fg-2.
    const text = /<span class="([^"]*)">From a comment on/.exec(html)?.[1] ?? '';
    expect(text).toContain('truncate');
    expect(text).toContain('text-fg-2');
    // Under the title (after the row's slider).
    expect(html.indexOf('data-task-title=""')).toBeLessThan(html.indexOf('data-task-source=""'));
  });

  it('a row queued for delete hides the line', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TaskRow {...props({ source: SOURCE, queuedDelete: true })} />
      </MemoryRouter>,
    );
    expect(html).not.toContain('data-task-source');
  });

  it('a tap flushes first, then opens the comment', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const order: string[] = [];
    const onBefore = vi.fn(() => order.push('flush'));
    act(() =>
      root?.render(
        <MemoryRouter initialEntries={['/chat?channel=c1']}>
          <Routes>
            <Route
              path="/chat"
              element={
                <ul>
                  <TaskRow {...props({ source: SOURCE, onBeforeOpenSource: onBefore })} />
                </ul>
              }
            />
            <Route path="/posts/:id" element={<Where />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    const line = document.querySelector<HTMLButtonElement>('[data-task-source]');
    expect(line).not.toBeNull();
    act(() => line?.click());
    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['flush']);
    expect(document.querySelector('[data-where]')?.textContent).toBe('/posts/p1?comment=cm1');
  });
});
