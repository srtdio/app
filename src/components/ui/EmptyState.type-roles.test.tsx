// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconFileText } from '@/components/ui/icons';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function classesOf(text: string): string[] {
  const el = [...document.querySelectorAll<HTMLElement>('body *')].find(
    (node) => node.textContent === text && node.children.length === 0,
  );
  if (el === undefined) throw new Error(`no element with text ${text}`);
  return el.className.split(/\s+/);
}

describe('EmptyState type roles', () => {
  it('title text-lg font-semibold, description text-base text-fg-2', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <EmptyState
          icon={<IconFileText size={20} />}
          title="No briefs yet"
          description="Briefs from the client show up here."
        />,
      );
    });
    const title = classesOf('No briefs yet');
    expect(title).toContain('text-lg');
    expect(title).toContain('font-semibold');
    const description = classesOf('Briefs from the client show up here.');
    expect(description).toContain('text-base');
    expect(description).toContain('text-fg-2');
    expect(description).not.toContain('text-fg-3');
  });
});
