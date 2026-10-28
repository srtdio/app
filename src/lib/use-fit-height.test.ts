// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { RefObject } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIT_GAP_PX, FIT_MIN_PX, fitHeight, useFitHeight } from './use-fit-height';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mounts the hook; `result.current` is its latest value. */
function mountHook(
  target: RefObject<HTMLElement | null>,
  watch: RefObject<HTMLElement | null>,
): { result: { current: number | null }; unmount: () => void } {
  const result: { current: number | null } = { current: null };
  function Probe(): null {
    result.current = useFitHeight(target, watch);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Probe)));
  return { result, unmount: () => act(() => root.unmount()) };
}

describe('fitHeight', () => {
  it('takes the window under the top, less the gap', () => {
    expect(fitHeight(180, 900)).toBe(900 - 180 - FIT_GAP_PX);
  });

  it('never goes under the minimum', () => {
    expect(fitHeight(500, 720)).toBe(FIT_MIN_PX);
  });
});

class FakeObserver {
  static instances: FakeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

function setViewport(height: number): void {
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    configurable: true,
    writable: true,
  });
}

describe('useFitHeight', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeObserver.instances = [];
  });

  it('measures before paint, follows resize and the watched root, and cleans up', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver);
    setViewport(900);
    let top = 200;
    const target = { current: document.createElement('div') };
    target.current.getBoundingClientRect = () => ({ top }) as DOMRect;
    const watch = { current: document.createElement('div') };
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');

    const { result, unmount } = mountHook(target, watch);
    expect(result.current).toBe(900 - 200 - FIT_GAP_PX);
    expect(add).toHaveBeenCalledWith('resize', expect.any(Function));
    const observer = FakeObserver.instances[0];
    expect(observer?.observed).toEqual([watch.current]);

    act(() => {
      setViewport(720);
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current).toBe(720 - 200 - FIT_GAP_PX);

    act(() => {
      top = 260;
      observer?.cb();
    });
    expect(result.current).toBe(720 - 260 - FIT_GAP_PX);

    act(() => {
      top = 600;
      observer?.cb();
    });
    expect(result.current).toBe(FIT_MIN_PX);

    unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(observer?.disconnected).toBe(true);
    add.mockRestore();
    remove.mockRestore();
  });

  it('stays null with nothing to measure', () => {
    const { result, unmount } = mountHook({ current: null }, { current: null });
    expect(result.current).toBeNull();
    unmount();
  });
});
