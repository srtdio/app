// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidePanel } from '@/components/ui/SidePanel';
import { ICON_SIZE, IconChevronLeft } from '@/components/ui/icons';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

/** The inner markup of IconChevronLeft at the control size. */
function chevronPaths(): string {
  const box = document.createElement('div');
  box.innerHTML = renderToStaticMarkup(<IconChevronLeft size={ICON_SIZE.control} />);
  return box.querySelector('svg')?.innerHTML ?? 'missing';
}

async function mount(headerExtra?: string) {
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <SidePanel
        open
        onClose={onClose}
        title="Cockpit"
        {...(headerExtra !== undefined ? { headerExtra: <span>{headerExtra}</span> } : {})}
      >
        <p>body</p>
      </SidePanel>,
    );
  });
  const panel = document.querySelector<HTMLElement>('[data-side-panel]');
  if (panel === null) throw new Error('no panel');
  return { panel, onClose };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('SidePanel header', () => {
  it('"<" back on the leading edge, then the title; no X', async () => {
    const { panel } = await mount('Live');
    const back = panel.querySelector<HTMLButtonElement>('[aria-label="Back"]');
    expect(back).not.toBeNull();
    // Leading: the header row's first child, the title right after it.
    expect(back?.parentElement?.firstElementChild).toBe(back);
    expect(back?.nextElementSibling?.tagName).toBe('H2');
    expect(back?.nextElementSibling?.textContent).toBe('Cockpit');
    // The part applies the leading pull (LEADING_PULL), never the trailing one.
    expect(back?.className).toContain('-ml-3');
    expect(back?.className).not.toContain('-mr-3');
    // The glyph is IconChevronLeft at the control size.
    const svg = back?.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.innerHTML).toBe(chevronPaths());
    // One exit per panel.
    expect(panel.querySelectorAll('[aria-label="Back"]')).toHaveLength(1);
    expect(panel.querySelector('[aria-label="Close"]')).toBeNull();
  });

  it('the "<" back and Escape close', async () => {
    const { panel, onClose } = await mount();
    await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
