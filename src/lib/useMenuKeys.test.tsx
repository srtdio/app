// @vitest-environment jsdom
// The shared popover-menu keyboard: focus to the first (or checked) item on
// open, arrows move and wrap, Home/End jump, a key a nested handler took is
// left alone.
import { act, useRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { menuInitialItem, moveMenuItemFocus, useMenuKeys } from '@/lib/useMenuKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(() => {
  // Run the open frame at once.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function Menu(props: { open: boolean; checked?: number }): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(ref, props.open);
  if (!props.open) return null;
  return (
    <div ref={ref} role="menu" aria-label="Sort" onKeyDown={keys.onKeyDown}>
      {['One', 'Two', 'Three'].map((label, i) => (
        <button key={label} type="button" role="menuitemradio" aria-checked={props.checked === i}>
          {label}
        </button>
      ))}
    </div>
  );
}

function mount(node: ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

const focused = (): string | null => document.activeElement?.textContent ?? null;

function press(key: string): void {
  const target = document.activeElement ?? document.body;
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('useMenuKeys', () => {
  it('focuses the first item on open', () => {
    mount(<Menu open />);
    expect(focused()).toBe('One');
  });

  it('focuses the checked item of a radio menu on open', () => {
    mount(<Menu open checked={2} />);
    expect(focused()).toBe('Three');
  });

  it('arrows move and wrap; Home and End jump', () => {
    mount(<Menu open />);
    press('ArrowDown');
    expect(focused()).toBe('Two');
    press('ArrowDown');
    press('ArrowDown');
    expect(focused()).toBe('One');
    press('ArrowUp');
    expect(focused()).toBe('Three');
    press('Home');
    expect(focused()).toBe('One');
    press('End');
    expect(focused()).toBe('Three');
  });

  it('does nothing while closed', () => {
    const before = document.activeElement;
    mount(<Menu open={false} />);
    expect(document.activeElement).toBe(before);
  });
});

describe('menu helpers', () => {
  it('skip disabled items and ignore other keys', () => {
    const panel = document.createElement('div');
    panel.innerHTML =
      '<button role="menuitem" disabled>A</button><button role="menuitem">B</button><button role="menuitem" aria-disabled="true">C</button>';
    document.body.appendChild(panel);
    expect(menuInitialItem(panel)?.textContent).toBe('B');
    expect(moveMenuItemFocus(panel, 'ArrowDown')).toBe(true);
    expect(document.activeElement?.textContent).toBe('B');
    expect(moveMenuItemFocus(panel, 'a')).toBe(false);
    expect(moveMenuItemFocus(null, 'ArrowDown')).toBe(false);
  });
});
