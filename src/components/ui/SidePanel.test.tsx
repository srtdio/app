// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillBesidePlan, SidePanel } from '@/components/ui/SidePanel';
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

describe('SidePanel fill beside (Thread polish 1)', () => {
  it('runs from the content edge + 24 to the window edge; never under 380', () => {
    // 1440 window, post column ending at 824: panel 848..1440 (592).
    expect(fillBesidePlan(824, 1440)).toEqual({ left: 848, width: 592, squeeze: 0 });
    // Too little room: 380 at the window edge, the content gives up the rest.
    expect(fillBesidePlan(824, 1100)).toEqual({ left: 720, width: 380, squeeze: 104 });
  });

  it('default (Cockpit): 380 and the page pads by --side-panel-w', async () => {
    const { panel } = await mount();
    expect(panel.className).toContain('w-side-panel');
    expect(panel.hasAttribute('data-side-panel-fill')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--side-panel-w')).toBe('380px');
  });

  it('fill beside: measured left and width, no page padding', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const edge = (): number => window.innerWidth - 700;
    await act(async () => {
      root?.render(
        <SidePanel open bare onClose={() => {}} title="Thread" fillBeside={edge}>
          <p>body</p>
        </SidePanel>,
      );
    });
    const panel = document.querySelector<HTMLElement>('[data-side-panel]');
    expect(panel?.hasAttribute('data-side-panel-fill')).toBe(true);
    expect(panel?.style.left).toBe(`${window.innerWidth - 676}px`);
    expect(panel?.style.width).toBe('676px');
    expect(panel?.className).not.toContain('w-side-panel');
    expect(document.documentElement.style.getPropertyValue('--side-panel-w')).toBe('');
  });
});
