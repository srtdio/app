// @vitest-environment jsdom
// The Plan tab calendar on a coarse pointer (U6, U7): the month cell holds
// 44px lines (fewer fit; a fine pointer is exactly monthCellCap), and a touch
// long-press (500ms, no drift) fires once and swallows the click after it.

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { monthCellCap } from '@/lib/plan-tab';
import {
  COARSE_LINE_PX,
  LONG_PRESS_MS,
  monthCellCapFor,
  useLongPress,
  withinDrift,
} from './plan-calendar-touch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('monthCellCapFor (U6)', () => {
  it('a fine pointer is monthCellCap, unchanged', () => {
    for (const rowHeight of [60, 90, 120, 160, 240]) {
      for (const count of [0, 1, 3, 6, 12]) {
        expect(monthCellCapFor({ rowHeight, count, coarse: false })).toBe(
          monthCellCap({ rowHeight, count }),
        );
      }
    }
  });

  it('a coarse pointer fits 44px lines: fewer than the 22px lines, the rest go to "+N more"', () => {
    expect(COARSE_LINE_PX).toBe(44);
    // 160px row: 120px for lines. Fine: 4 lines and "+N more"; coarse: 1 line and "+N more".
    expect(monthCellCapFor({ rowHeight: 160, count: 6, coarse: false })).toBe(4);
    expect(monthCellCapFor({ rowHeight: 160, count: 6, coarse: true })).toBe(1);
    // Everything that fits shows, with no "+N more".
    expect(monthCellCapFor({ rowHeight: 160, count: 2, coarse: true })).toBe(2);
    expect(monthCellCapFor({ rowHeight: 60, count: 3, coarse: true })).toBe(0);
  });
});

describe('useLongPress (U7)', () => {
  let root: Root | null = null;
  const fired = vi.fn();
  const clicked = vi.fn();

  function Probe(props: { enabled: boolean }): ReactElement {
    const lp = useLongPress<string>({ enabled: props.enabled, onFire: fired });
    return (
      <button
        type="button"
        data-probe=""
        onPointerDown={(e) => lp.press('entry-1', e)}
        onClick={() => {
          if (!lp.consumeClick()) clicked();
        }}
      />
    );
  }

  function pointer(type: string, init: { x?: number; y?: number; kind?: string } = {}): Event {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.x ?? 10,
      clientY: init.y ?? 10,
    });
    Object.defineProperty(event, 'pointerType', { value: init.kind ?? 'touch' });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
  }

  async function mount(enabled: boolean): Promise<HTMLButtonElement> {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Probe enabled={enabled} />));
    return document.querySelector('[data-probe]') as HTMLButtonElement;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fired.mockClear();
    clicked.mockClear();
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('a 500ms touch hold fires once; the click after it does not open', async () => {
    const el = await mount(true);
    act(() => {
      el.dispatchEvent(pointer('pointerdown'));
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 1));
    expect(fired).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(fired).toHaveBeenCalledWith('entry-1');
    act(() => {
      window.dispatchEvent(pointer('pointerup'));
      el.click();
    });
    expect(clicked).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    act(() => el.click());
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('a tap still opens; drift past 10px, a mouse press or disabled never fires', async () => {
    expect(withinDrift(3, 4)).toBe(true);
    expect(withinDrift(8, 8)).toBe(false);
    const el = await mount(true);
    act(() => {
      el.dispatchEvent(pointer('pointerdown'));
      window.dispatchEvent(pointer('pointerup'));
      el.click();
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2));
    expect(fired).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledTimes(1);
    act(() => {
      el.dispatchEvent(pointer('pointerdown'));
      window.dispatchEvent(pointer('pointermove', { x: 30, y: 10 }));
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    act(() => {
      el.dispatchEvent(pointer('pointerdown', { kind: 'mouse' }));
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(fired).not.toHaveBeenCalled();
  });

  it('approvers (disabled): a hold does nothing', async () => {
    const el = await mount(false);
    act(() => {
      el.dispatchEvent(pointer('pointerdown'));
    });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(fired).not.toHaveBeenCalled();
  });
});
