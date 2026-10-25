// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from '@/components/ui/Sheet';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  dirty?: boolean;
  busy?: boolean;
  busyLabel?: string;
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
    await wait(30);
  });
  const sheet = document.querySelector<HTMLElement>('[role="dialog"]');
  if (sheet === null) throw new Error('no sheet');
  const x = sheet.querySelector<HTMLButtonElement>('[aria-label="Close"]');
  if (x === null) throw new Error('no X');
  return { sheet, x, backdrop: sheet.parentElement!, onClose };
}

const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Sheet header', () => {
  it('title left, close X right at the control size, no Cancel in the header', async () => {
    const { sheet, x } = await mount();
    const header = x.closest('.border-b');
    expect(header?.firstElementChild?.tagName).toBe('H2');
    expect(x.querySelector('svg')?.getAttribute('width')).toBe('20');
    expect(header?.textContent).not.toContain('Cancel');
    expect(sheet.querySelectorAll('[aria-label="Close"]')).toHaveLength(1);
  });
});

describe('Sheet (clean)', () => {
  it('X, backdrop and Escape close straight away', async () => {
    const { x, backdrop, onClose } = await mount();
    await act(async () => x.click());
    await act(async () => backdrop.click());
    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(confirm()).toBeNull();
  });
});

describe('Sheet dirty', () => {
  it.each(['x', 'backdrop', 'escape'] as const)('%s opens the discard confirm', async (path) => {
    const { x, backdrop, onClose } = await mount({ dirty: true });
    if (path === 'x') await act(async () => x.click());
    if (path === 'backdrop') await act(async () => backdrop.click());
    if (path === 'escape') await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    const dialog = confirm();
    expect(dialog?.textContent).toContain('Discard this post?');
    expect(dialog?.textContent).toContain('Your caption and files will be lost.');
    expect(button('Keep editing')).toBeDefined();
    expect(button('Discard')).toBeDefined();
  });

  it('Discard closes the sheet', async () => {
    const { x, onClose } = await mount({ dirty: true });
    await act(async () => x.click());
    await act(async () => button('Discard')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Keep editing keeps the sheet open and returns focus to it', async () => {
    const { sheet, x, onClose } = await mount({ dirty: true });
    await act(async () => x.click());
    await act(async () => {
      button('Keep editing')?.click();
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirm()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(sheet);
  });

  it('Escape in the confirm closes only the confirm', async () => {
    const { onClose } = await mount({ dirty: true });
    await pressEscape();
    expect(confirm()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirm()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Sheet busy', () => {
  it('ignores X, backdrop and Escape', async () => {
    const { x, backdrop, onClose } = await mount({ busy: true, dirty: true });
    await act(async () => x.click());
    await act(async () => backdrop.click());
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm()).toBeNull();
  });

  it('shows the busy label and a muted, aria-disabled 44px X', async () => {
    const { sheet, x } = await mount({ busy: true });
    expect(sheet.textContent).toContain('Saving…');
    expect(x.getAttribute('aria-disabled')).toBe('true');
    expect(x.hasAttribute('disabled')).toBe(false);
    expect(x.className).toContain('h-11');
    expect(x.className).toContain('w-11');
    expect(x.className).toContain('!text-fg-3');
  });

  it('uses a custom busy label', async () => {
    const { sheet } = await mount({ busy: true, busyLabel: 'Uploading…' });
    expect(sheet.textContent).toContain('Uploading…');
  });
});
