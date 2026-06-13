import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLongPressController,
  LONG_PRESS_MS,
  MOVE_CANCEL_PX,
} from '@/components/ui/useLongPress';

function at(x: number, y: number): { clientX: number; clientY: number } {
  return { clientX: x, clientY: y };
}

describe('createLongPressController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onLongPress after the threshold and then suppresses the trailing click', () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress });

    c.handlers.onPointerDown(at(0, 0));
    expect(onLongPress).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    // The trailing pointer up must not undo the pending suppression.
    c.handlers.onPointerUp();
    expect(c.consumeClickSuppression()).toBe(true);
    // Consuming it resets, so a later genuine click is not swallowed.
    expect(c.consumeClickSuppression()).toBe(false);

    c.dispose();
  });

  it('cancels when the pointer moves beyond the tolerance', () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress });

    c.handlers.onPointerDown(at(0, 0));
    c.handlers.onPointerMove(at(MOVE_CANCEL_PX + 1, 0));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(c.consumeClickSuppression()).toBe(false);

    c.dispose();
  });

  it('a quick tap does not fire onLongPress and does not suppress a normal click', () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress });

    c.handlers.onPointerDown(at(0, 0));
    vi.advanceTimersByTime(LONG_PRESS_MS / 2);
    c.handlers.onPointerUp();
    // Even after the original threshold elapses, the cancelled timer stays dead.
    vi.advanceTimersByTime(LONG_PRESS_MS);

    expect(onLongPress).not.toHaveBeenCalled();
    expect(c.consumeClickSuppression()).toBe(false);

    c.dispose();
  });
});
