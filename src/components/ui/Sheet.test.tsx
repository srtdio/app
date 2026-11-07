// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconChevronLeft } from '@/components/ui/icons';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The inner markup of IconChevronLeft at the control size. */
function chevronPaths(): string {
  const box = document.createElement('div');
  box.innerHTML = renderToStaticMarkup(<IconChevronLeft size={ICON_SIZE.control} />);
  return box.querySelector('svg')?.innerHTML ?? 'missing';
}

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
  // The one exit: the "<" back (kept as `x` below for the close-path tests).
  const x = sheet.querySelector<HTMLButtonElement>('[aria-label="Back"]');
  if (x === null) throw new Error('no Back');
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
  it('"<" back leading at the control size, then the title; no X, no Cancel in the header', async () => {
    const { sheet, x } = await mount();
    const header = x.closest('[data-sheet-grab]');
    // Leading edge: the Back is the header's first child, the title follows it.
    expect(header?.firstElementChild).toBe(x);
    expect(x.nextElementSibling?.tagName).toBe('H2');
    expect(x.className).toContain('-ml-3');
    expect(x.className).not.toContain('-mr-3');
    const svg = x.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    // The glyph is IconChevronLeft (same path), never a cross.
    expect(svg?.innerHTML).toBe(chevronPaths());
    expect(header?.textContent).not.toContain('Cancel');
    expect(sheet.querySelectorAll('[aria-label="Back"]')).toHaveLength(1);
    expect(sheet.querySelector('[aria-label="Close"]')).toBeNull();
  });

  it('a header verb sits trailing while the exit stays the leading "<"', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <Sheet open onClose={() => {}} title="Edit" headerAction={<button type="button">Save</button>}>
          <p>body</p>
        </Sheet>,
      );
      await wait(30);
    });
    const header = document.querySelector<HTMLElement>('[data-sheet-grab]');
    expect(header?.firstElementChild?.getAttribute('aria-label')).toBe('Back');
    expect(header?.lastElementChild?.textContent).toBe('Save');
    expect(document.querySelector('[aria-label="Close"]')).toBeNull();
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
    expect(x.className).toContain('aria-disabled:text-fg-3');
    expect(x.className).not.toContain('!');
  });

  it('uses a custom busy label', async () => {
    const { sheet } = await mount({ busy: true, busyLabel: 'Uploading…' });
    expect(sheet.textContent).toContain('Uploading…');
  });
});
