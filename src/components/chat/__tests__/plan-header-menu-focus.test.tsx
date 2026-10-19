// @vitest-environment jsdom
// X3 / FN27: the laptop header menu: focus moves to its first row on open,
// Up/Down move between rows (wrapping), and focus returns to the title button
// on close.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { PlanHeaderMenu } from '@/components/chat/PlanScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let setOpen: ((open: boolean) => void) | null = null;

function Probe(): ReactElement {
  const [open, set] = useState(false);
  setOpen = set;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" data-plan-title-menu="" onClick={() => set((v) => !v)}>
        Week of 12 Oct
      </button>
      <PlanHeaderMenu
        open={open}
        canDelete
        onRename={() => undefined}
        onDelete={() => undefined}
        onClose={() => set(false)}
      />
    </div>
  );
}

const key = (name: string): void => {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
  );
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  setOpen = null;
  document.body.innerHTML = '';
});

describe('PlanHeaderMenu focus', () => {
  it('moves in, arrows cycle, returns on close', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Probe />);
    });
    const title = document.querySelector<HTMLButtonElement>('[data-plan-title-menu]');
    title?.focus();
    await act(async () => setOpen?.(true));
    const rename = document.querySelector<HTMLElement>('[data-plan-menu-rename]');
    const del = document.querySelector<HTMLElement>('[data-plan-menu-delete]');
    expect(rename).not.toBeNull();
    expect(document.activeElement).toBe(rename);
    await act(async () => key('ArrowDown'));
    expect(document.activeElement).toBe(del);
    await act(async () => key('ArrowDown'));
    expect(document.activeElement).toBe(rename);
    await act(async () => key('ArrowUp'));
    expect(document.activeElement).toBe(del);
    await act(async () => key('Escape'));
    expect(document.querySelector('[data-plan-header-menu]')).toBeNull();
    expect(document.activeElement).toBe(title);
  });
});
