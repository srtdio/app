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

describe('ConfirmDialog type roles', () => {
  it('sheet title text-lg font-semibold, body text-base text-fg-2, buttons text-base font-medium', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ConfirmDialog
          title="Discard this post?"
          message="Your caption and files will be lost."
          confirmLabel="Discard"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
    });
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    if (dialog === null) throw new Error('no dialog');

    const title = (dialog.querySelector('h2')?.className ?? '').split(/\s+/);
    expect(dialog.querySelector('h2')?.textContent).toBe('Discard this post?');
    expect(title).toContain('text-lg');
    expect(title).toContain('font-semibold');

    const body = (dialog.querySelector('[data-confirm-message]')?.className ?? '').split(/\s+/);
    expect(body).toContain('text-base');
    expect(body).toContain('text-fg-2');

    const confirm = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent === 'Discard',
    );
    const label = (confirm?.className ?? '').split(/\s+/);
    expect(label).toContain('text-base');
    expect(label).toContain('font-medium');
    expect(label).not.toContain('font-semibold');
  });
});
