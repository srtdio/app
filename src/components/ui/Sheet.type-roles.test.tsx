// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/Sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Sheet type roles', () => {
  it('title is the sheet title: text-lg font-semibold', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <Sheet open onClose={vi.fn()} title="New post">
          <p>body</p>
        </Sheet>,
      );
      await new Promise((r) => setTimeout(r, 30));
    });
    const sheet = document.querySelector<HTMLElement>('[role="dialog"]');
    const title = [...(sheet?.querySelectorAll('h2') ?? [])].find(
      (h) => h.textContent === 'New post',
    );
    const classes = (title?.className ?? '').split(/\s+/);
    expect(classes).toContain('text-lg');
    expect(classes).toContain('font-semibold');
    expect(classes.some((c) => /^text-(\[|legacy-)/.test(c))).toBe(false);
  });
});
