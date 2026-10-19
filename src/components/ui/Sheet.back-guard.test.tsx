// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/Sheet';
import { BACK_GUARD_STEP_KEY } from '@/lib/back-guard';
import { resetHistorySteps, stepMarkerOf } from '@/lib/chat/use-history-step';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// jsdom traverses history on a queued task and fires popstate when it lands.
const settle = () => act(async () => wait(60));

interface Opts {
  dirty?: boolean;
  busy?: boolean;
}

async function mount(opts: Opts = {}) {
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Sheet
        open
        onClose={onClose}
        title="New post"
        discard={{ title: 'Discard this post?', message: 'Your caption and files will be lost.' }}
        {...opts}
      >
        <p>body</p>
      </Sheet>,
    );
  });
  // The guard places its step after the commit (a microtask).
  await settle();
  return { onClose };
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const guarded = () => stepMarkerOf(window.history.state, BACK_GUARD_STEP_KEY) !== null;

async function pressBack(): Promise<void> {
  await act(async () => {
    window.history.back();
    await wait(60);
  });
}

beforeEach(() => {
  resetHistorySteps();
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  // Let any pop a release issued land before the next test pushes.
  await settle();
  resetHistorySteps();
});

describe('Sheet and the Back guard', () => {
  it('a clean sheet places no guard', async () => {
    await mount();
    expect(guarded()).toBe(false);
  });

  it('Back on a dirty sheet shows the discard confirm and the sheet stays', async () => {
    const { onClose } = await mount({ dirty: true });
    expect(guarded()).toBe(true);
    await pressBack();
    expect(sheet()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    const dialog = confirm();
    expect(dialog?.textContent).toContain('Discard this post?');
    expect(button('Keep editing')).toBeDefined();
    expect(button('Discard')).toBeDefined();
    // The guard's entry is back on top: the next Back asks again.
    expect(guarded()).toBe(true);
  });

  it('Keep editing, then Back again asks again', async () => {
    const { onClose } = await mount({ dirty: true });
    await pressBack();
    await act(async () => {
      button('Keep editing')?.click();
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirm()).toBeNull();
    await pressBack();
    expect(confirm()).not.toBeNull();
    expect(sheet()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Discard releases the guard, then closes: no guard entry is left', async () => {
    const { onClose } = await mount({ dirty: true });
    await pressBack();
    await act(async () => button('Discard')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await settle();
    expect(guarded()).toBe(false);
  });

  it('Back on a busy sheet keeps it open: nothing lost, no confirm, busy label stays', async () => {
    const { onClose } = await mount({ busy: true, dirty: true });
    expect(guarded()).toBe(true);
    await pressBack();
    expect(sheet()).not.toBeNull();
    expect(sheet()?.textContent).toContain('Saving…');
    expect(confirm()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(guarded()).toBe(true);
  });

  it('a sheet that unmounts while guarded releases its step', async () => {
    await mount({ dirty: true });
    expect(guarded()).toBe(true);
    act(() => root?.unmount());
    root = null;
    await settle();
    expect(guarded()).toBe(false);
  });

  it('ConfirmDialog itself does not guard: the X path of a dirty sheet adds no second entry', async () => {
    await mount({ dirty: true });
    const marker = stepMarkerOf(window.history.state, BACK_GUARD_STEP_KEY);
    await act(async () =>
      sheet()?.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click(),
    );
    await settle();
    expect(confirm()).not.toBeNull();
    expect(stepMarkerOf(window.history.state, BACK_GUARD_STEP_KEY)).toBe(marker);
  });
});
