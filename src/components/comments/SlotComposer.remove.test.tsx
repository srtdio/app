// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));

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
    act(() => button('+ Another')?.click());
    act(() => button('+ Another')?.click());
    expect(host?.querySelectorAll('textarea')).toHaveLength(3);
    expect(button('Remove checkpoint 1')).toBeUndefined();
    expect(button('Remove checkpoint 2')).toBeDefined();

    act(() => button('Remove checkpoint 2')?.click());
    expect(host?.querySelectorAll('textarea')).toHaveLength(2);
  });
});

describe('SlotComposer composer row', () => {
  it('one slot: no slot number, a 44px "+ Another" ghost and "Send"', () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    act(() => root?.render(<SlotComposer onSubmit={onSubmit} canAttach={false} />));
    expect(host?.querySelector('[data-slot-number]')).toBeNull();
    expect(button('Add checkpoint')).toBeUndefined();
    const another = button('+ Another');
    expect(another).toBeDefined();
    expect(another?.className).toContain('h-11');
    expect(another?.className).toContain('rounded-lg');
    expect(another?.className).not.toContain('h-8');
    expect(another?.className).toContain('min-h-[44px]');
    expect(another?.className).toContain('min-w-[44px]');
    expect(button('Send')).toBeDefined();
  });

  it('two filled slots: numbers show and the primary reads "Send 2 checkpoints"', () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    act(() => root?.render(<SlotComposer onSubmit={onSubmit} canAttach={false} />));
    act(() => button('+ Another')?.click());
    expect(host?.querySelectorAll('[data-slot-number]')).toHaveLength(2);
    const areas = Array.from(host?.querySelectorAll('textarea') ?? []);
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    for (const [i, area] of areas.entries()) {
      act(() => {
        setValue?.call(area, `point ${i + 1}`);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    expect(button('Send 2 checkpoints')).toBeDefined();
    expect(button('Send')).toBeUndefined();
  });
});
