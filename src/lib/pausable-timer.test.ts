// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPausableTimer, holdHandlers } from '@/lib/pausable-timer';

describe('createPausableTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after ms when never held', () => {
    const done = vi.fn();
    createPausableTimer(done, 4000);
    vi.advanceTimersByTime(3999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a hold freezes the clock; release resumes with the time left', () => {
    const done = vi.fn();
    const timer = createPausableTimer(done, 4000);
    vi.advanceTimersByTime(1500);
    timer.hold('hover');
    expect(timer.held()).toBe(true);
    expect(timer.remaining()).toBe(2500);
    vi.advanceTimersByTime(60_000);
    expect(done).not.toHaveBeenCalled();
    expect(timer.remaining()).toBe(2500);
    timer.release('hover');
    vi.advanceTimersByTime(2499);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('runs again only when every reason is released', () => {
    const done = vi.fn();
    const timer = createPausableTimer(done, 1000);
    timer.hold('hover');
    timer.hold('focus');
    timer.release('hover');
    vi.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
    timer.release('focus');
    vi.advanceTimersByTime(1000);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a repeated hold or a stray release changes nothing', () => {
    const done = vi.fn();
    const timer = createPausableTimer(done, 1000);
    timer.release('press');
    vi.advanceTimersByTime(400);
    timer.hold('press');
    timer.hold('press');
    vi.advanceTimersByTime(400);
    timer.release('press');
    vi.advanceTimersByTime(599);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('cancel stops it for good', () => {
    const done = vi.fn();
    const timer = createPausableTimer(done, 1000);
    timer.hold('hover');
    timer.cancel();
    timer.release('hover');
    vi.advanceTimersByTime(5000);
    expect(done).not.toHaveBeenCalled();
    expect(timer.remaining()).toBe(0);
  });

  it('holds after it fired are ignored', () => {
    const done = vi.fn();
    const timer = createPausableTimer(done, 100);
    vi.advanceTimersByTime(100);
    timer.hold('focus');
    expect(timer.held()).toBe(false);
    timer.release('focus');
    vi.advanceTimersByTime(1000);
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe('holdHandlers', () => {
  it('hover holds for a mouse only', () => {
    const onHold = vi.fn();
    const h = holdHandlers(onHold);
    h.onPointerEnter({ pointerType: 'touch' });
    expect(onHold).not.toHaveBeenCalled();
    h.onPointerEnter({ pointerType: 'mouse' });
    h.onPointerLeave({ pointerType: 'mouse' });
    expect(onHold.mock.calls).toEqual([
      ['hover', true],
      ['hover', false],
    ]);
  });

  it('a press holds until the pointer is released anywhere', () => {
    const onHold = vi.fn();
    const h = holdHandlers(onHold);
    h.onPointerDown();
    expect(onHold).toHaveBeenLastCalledWith('press', true);
    window.dispatchEvent(new Event('pointerup'));
    expect(onHold).toHaveBeenLastCalledWith('press', false);
    // The window listener goes with the release.
    window.dispatchEvent(new Event('pointerup'));
    expect(onHold).toHaveBeenCalledTimes(2);
  });

  it('a cancelled press releases too', () => {
    const onHold = vi.fn();
    holdHandlers(onHold).onPointerDown();
    window.dispatchEvent(new Event('pointercancel'));
    expect(onHold).toHaveBeenLastCalledWith('press', false);
  });

  it('focus holds until it leaves the surface', () => {
    const onHold = vi.fn();
    const h = holdHandlers(onHold);
    const root = document.createElement('div');
    const inner = document.createElement('button');
    root.appendChild(inner);
    h.onFocus();
    h.onBlur({ currentTarget: root, relatedTarget: inner });
    expect(onHold.mock.calls).toEqual([['focus', true]]);
    h.onBlur({ currentTarget: root, relatedTarget: null });
    expect(onHold).toHaveBeenLastCalledWith('focus', false);
  });
});

describe('holdHandlers: a tap that focuses the card', () => {
  it('holds while pressed, then lets the countdown run once released', () => {
    const calls: [string, boolean][] = [];
    const h = holdHandlers((reason, held) => calls.push([reason, held]));
    h.onPointerDown();
    h.onFocus();
    window.dispatchEvent(new Event('pointerup'));
    expect(calls).toEqual([
      ['press', true],
      ['press', false],
    ]);
  });

  it('keyboard focus (no press) still holds', () => {
    const calls: [string, boolean][] = [];
    holdHandlers((reason, held) => calls.push([reason, held])).onFocus();
    expect(calls).toEqual([['focus', true]]);
  });
});
