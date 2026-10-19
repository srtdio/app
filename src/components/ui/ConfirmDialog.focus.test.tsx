// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount() {
  // Outside the React tree, so it survives the unmount; its label never
  // collides with the dialog's own buttons (button() looks up by text).
  const opener = document.createElement('button');
  opener.textContent = 'Open confirm';
  document.body.appendChild(opener);
  opener.focus();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ConfirmDialog
        title="Delete this post?"
        message="This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Keep"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
  });
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
  if (dialog === null) throw new Error('no dialog');
  return { opener, dialog, onConfirm, onCancel };
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);

async function tab(shift = false): Promise<void> {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('ConfirmDialog focus', () => {
  it('is an aria-modal alertdialog whose dismiss action takes focus on open', async () => {
    const { dialog } = await mount();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(button('Keep'));
  });

  it('Tab wraps between its two actions', async () => {
    await mount();
    button('Delete')?.focus();
    await tab();
    expect(document.activeElement).toBe(button('Keep'));
    await tab(true);
    expect(document.activeElement).toBe(button('Delete'));
  });

  it('returns focus to the opener when it goes', async () => {
    const { opener } = await mount();
    act(() => root?.unmount());
    root = null;
    expect(document.activeElement).toBe(opener);
  });

  it('clears the iPhone home bar at its bottom edge', async () => {
    const { dialog } = await mount();
    expect(dialog.parentElement?.className).toContain('pb-[max(16px,env(safe-area-inset-bottom))]');
  });
});
