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

  it('ignoreMouse: a mouse press never starts the timer, touch still does', () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress, ignoreMouse: true });

    c.handlers.onPointerDown({ ...at(0, 0), pointerType: 'mouse' });
    expect(c.lastPointerType()).toBe('mouse');
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(c.consumeClickSuppression()).toBe(false);

    c.handlers.onPointerDown({ ...at(0, 0), pointerType: 'touch' });
    expect(c.lastPointerType()).toBe('touch');
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    c.dispose();
  });

  it('touch behaviour is unchanged with ignoreMouse: 450ms, 10px move cancel, scroll cancel', () => {
    expect(LONG_PRESS_MS).toBe(450);
    expect(MOVE_CANCEL_PX).toBe(10);
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress, ignoreMouse: true });
    const touch = (x: number, y: number) => ({ ...at(x, y), pointerType: 'touch' });

    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(MOVE_CANCEL_PX, 0));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(c.consumeClickSuppression()).toBe(true);

    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(MOVE_CANCEL_PX + 1, 0));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);

    const listeners: Array<() => void> = [];
    vi.stubGlobal('window', {
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    });
    c.handlers.onPointerDown(touch(0, 0));
    listeners.forEach((fn) => fn());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    c.dispose();
  });

  it('contextmenu cancels a running hold so the menu is not reopened', () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress });

    c.handlers.onPointerDown(at(0, 0));
    c.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();

    c.dispose();
  });

  it('a hold with no trailing click never swallows the next tap (12 Nov 2026)', () => {
    const c = createLongPressController({ onLongPress: vi.fn(), ignoreMouse: true });
    const touch = { ...at(0, 0), pointerType: 'touch' };
    c.handlers.onPointerDown(touch);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    c.handlers.onPointerUp();
    // iPhone sent no click after the hold; the next press is a clean tap.
    c.handlers.onPointerDown(touch);
    c.handlers.onPointerUp();
    expect(c.consumeClickSuppression()).toBe(false);
    c.dispose();
  });

  it('a click after the menu opened is not suppressed', () => {
    const c = createLongPressController({
      onLongPress: () => c.clearClickSuppression(),
    });

    c.handlers.onPointerDown(at(0, 0));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    c.handlers.onPointerUp();
    expect(c.consumeClickSuppression()).toBe(false);

    c.dispose();
  });
});
