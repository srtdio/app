import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createLongPress } from '@/components/ui/useLongPress';

// The hook wraps this framework-free core, so exercising the core covers the
// timing/threshold behaviour without a DOM renderer (the unit suite runs under
// the `node` environment).
function at(x: number, y: number): ReactPointerEvent {
  return { clientX: x, clientY: y } as unknown as ReactPointerEvent;
}

describe('createLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onLongPress after the hold threshold', () => {
    const onLongPress = vi.fn();
    const lp = createLongPress(onLongPress, { thresholdMs: 450 });

    lp.handlers.onPointerDown(at(0, 0));
    vi.advanceTimersByTime(449);
    expect(onLongPress).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    // The trailing click is suppressed exactly once.
    expect(lp.shouldSuppressClick()).toBe(true);
    expect(lp.shouldSuppressClick()).toBe(false);
    lp.dispose();
  });

  it('cancels when the pointer moves beyond tolerance', () => {
    const onLongPress = vi.fn();
    const lp = createLongPress(onLongPress, { thresholdMs: 450, moveTolerancePx: 10 });

    lp.handlers.onPointerDown(at(0, 0));
    lp.handlers.onPointerMove(at(20, 0));
    vi.advanceTimersByTime(500);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(lp.shouldSuppressClick()).toBe(false);
    lp.dispose();
  });

  it('a quick tap does not fire onLongPress and does not suppress a normal click', () => {
    const onLongPress = vi.fn();
    const lp = createLongPress(onLongPress, { thresholdMs: 450 });

    lp.handlers.onPointerDown(at(0, 0));
    vi.advanceTimersByTime(120);
    lp.handlers.onPointerUp();
    vi.advanceTimersByTime(500);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(lp.shouldSuppressClick()).toBe(false);
    lp.dispose();
  });
});
