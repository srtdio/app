// @vitest-environment jsdom
// X3 / FT54 / FB2: the phone plan page (the Plan, Item and New plan screens'
// frame) is a modal dialog: focus moves in on open and returns to the opener
// on close.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { PlanPage } from '@/components/chat/PlanScreen';
import { modalLayerCount } from '@/lib/modal-focus';
import { DUR_SLOW_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let setOpen: ((open: boolean) => void) | null = null;

function Probe(): ReactElement {
  const [open, set] = useState(false);
  setOpen = set;
  return (
    <PlanPage
      open={open}
      testId="plan"
      title="Week of 12 Oct"
      backLabel="Back"
      onBack={() => set(false)}
    >
      <button type="button" data-row="">
        Row
      </button>
    </PlanPage>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  setOpen = null;
  document.body.innerHTML = '';
});

describe('PlanPage on a phone: modal focus', () => {
  it('focus moves into the page on open, and returns to the opener on close', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'Open plan';
    document.body.appendChild(opener);
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<Probe />);
    });
    opener.focus();
    expect(document.activeElement).toBe(opener);
    await act(async () => setOpen?.(true));
    await act(async () => wait(20));
    const page = document.querySelector<HTMLElement>('[data-plan-page="plan"]');
    expect(page).not.toBeNull();
    expect(page?.getAttribute('role')).toBe('dialog');
    expect(page?.getAttribute('aria-modal')).toBe('true');
    expect(page?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);
    expect(modalLayerCount()).toBe(1);
    await act(async () => setOpen?.(false));
    await act(async () => wait(DUR_SLOW_MS + 40));
    expect(document.activeElement).toBe(opener);
    expect(modalLayerCount()).toBe(0);
  });
});
