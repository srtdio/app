// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

async function mount(message?: string): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ConfirmDialog
        title="2 comments are still open. Send anyway?"
        {...(message !== undefined ? { message } : {})}
        confirmLabel="Send anyway"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  });
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
  if (dialog === null) throw new Error('no dialog');
  return dialog;
}

describe('ConfirmDialog optional message', () => {
  it('renders no body element (and no gap) when message is absent', async () => {
    const dialog = await mount();
    expect(dialog.querySelector('[data-confirm-message]')).toBeNull();
    expect(dialog.querySelector('p')).toBeNull();
    // The title is followed directly by the actions row.
    expect(dialog.querySelector('h2')?.nextElementSibling?.querySelectorAll('button')).toHaveLength(
      2,
    );
  });

  it('an existing caller with a message still renders its body exactly as before', async () => {
    const dialog = await mount('This cannot be undone.');
    const body = dialog.querySelector<HTMLParagraphElement>('[data-confirm-message]');
    expect(body?.tagName).toBe('P');
    expect(body?.textContent).toBe('This cannot be undone.');
    expect(body?.className).toBe('mt-2 text-base text-fg-2');
  });
});
