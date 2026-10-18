// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlotComposer } from '@/components/comments/SlotComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
}

describe('SlotComposer removable slots', () => {
  it('gives every slot after the first a remove X and drops that slot', () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    act(() => root?.render(<SlotComposer onSubmit={onSubmit} canAttach={false} />));
    act(() => button('Add point')?.click());
    act(() => button('Add point')?.click());
    expect(host?.querySelectorAll('textarea')).toHaveLength(3);
    expect(button('Remove point 1')).toBeUndefined();
    expect(button('Remove point 2')).toBeDefined();

    act(() => button('Remove point 2')?.click());
    expect(host?.querySelectorAll('textarea')).toHaveLength(2);
  });
});
