// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHead } from '@/components/shell/PageHead';

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

describe('PageHead type roles', () => {
  it('title is the screen header: text-lg font-semibold', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<PageHead title="Settings" />);
    });
    const title = classesOf('Settings');
    expect(title).toContain('text-lg');
    expect(title).toContain('font-semibold');
    expect(title.some((c) => /^text-(\[|legacy-)/.test(c))).toBe(false);
  });
});
