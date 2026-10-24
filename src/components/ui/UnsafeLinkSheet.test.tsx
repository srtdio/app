// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SWIPE_CLOSE_PX, UnsafeLinkSheet } from '@/components/ui/UnsafeLinkSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const URL_TEXT = 'http://g00gle-docs-share.top:8080/login?next=x';
let root: Root | null = null;

async function open(onClose = vi.fn()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <UnsafeLinkSheet open url={URL_TEXT} reasons={['Uses an unusual port']} onClose={onClose} />,
    );
    await new Promise((r) => setTimeout(r, 60));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error('no dialog');
  return { dialog, onClose };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('UnsafeLinkSheet', () => {
  it('shows the copy, focuses "Don\'t open" and has no X button', async () => {
    const { dialog } = await open();
    expect(dialog.textContent).toContain('Check before opening');
    expect(dialog.querySelector('[data-unsafe-url]')?.className).toContain('font-mono');
    expect(document.activeElement?.textContent).toBe("Don't open");
    expect(dialog.querySelector('[aria-label="Close"]')).toBeNull();
    const buttons = [...dialog.querySelectorAll('button, a')];
    for (const b of buttons) {
      const cls = b.getAttribute('class') ?? '';
      expect(cls).toContain('h-11');
      expect(cls).toContain('rounded-lg');
      expect(cls).toContain('text-base');
      expect(cls).not.toContain('h-[46px]');
      expect(cls).not.toContain('rounded-xl');
      expect(cls).not.toContain('text-lg');
    }
  });

  it('"Don\'t open" and Esc close; "Open anyway" is a noopener noreferrer new-tab link', async () => {
    const { dialog, onClose } = await open();
    await act(async () => {
      dialog.querySelector<HTMLButtonElement>('[data-unsafe-dont-open]')?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    const anyway = dialog.querySelector('a[data-unsafe-open-anyway]');
    expect(anyway?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anyway?.getAttribute('target')).toBe('_blank');
  });

  it('traps Tab inside the sheet', async () => {
    const { dialog } = await open();
    const anyway = dialog.querySelector<HTMLElement>('a[data-unsafe-open-anyway]');
    anyway?.focus();
    await act(async () => {
      anyway?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement?.hasAttribute('data-unsafe-dont-open')).toBe(true);
  });

  it('a downward swipe past the threshold closes; motion is translateY only', async () => {
    const { dialog, onClose } = await open();
    expect(dialog.className).toContain('translate-y-0');
    expect(dialog.className).not.toMatch(/rotate|translate-x|scale-/);
    const handle = dialog.querySelector('[data-sheet-drag]');
    if (handle === null) throw new Error('no handle');
    expect(dialog.className).toContain('touch-pan-y');
    expect(dialog.className).toContain('overflow-y-auto');
    const fire = (type: string, y: number) =>
      handle.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { clientY: y }));
    await act(async () => {
      fire('pointerdown', 100);
      fire('pointermove', 100 + SWIPE_CLOSE_PX + 10);
    });
    expect(dialog.style.transform).toBe(`translateY(${SWIPE_CLOSE_PX + 10}px)`);
    await act(async () => {
      fire('pointerup', 100 + SWIPE_CLOSE_PX + 10);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
