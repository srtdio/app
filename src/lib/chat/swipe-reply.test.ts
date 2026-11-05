import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPendingLongPressesWithin,
  createLongPressController,
} from '@/components/ui/useLongPress';
import {
  createSwipeReplyController,
  defaultVibrate,
  swipeOffset,
  swipeTriggers,
  SWIPE_EDGE_PX,
  SWIPE_FLICK_MIN_PX,
  SWIPE_FLICK_VELOCITY,
  SWIPE_LOCK_PX,
  SWIPE_MAX_PX,
  SWIPE_REST,
  SWIPE_TRIGGER_PX,
  SWIPE_VIBRATE_MS,
  type SwipeFrame,
  type SwipeReplyOptions,
} from '@/lib/chat/swipe-reply';

// Presses start well clear of the left edge (the iOS back gesture's).
const X0 = 100;
// The controller's clock follows the last sample, so a release lands right
// after the last move unless a test moves it on.
let clock = 0;
const touch = (x: number, y: number, timeStamp = 0, pointerId = 1) => {
  clock = timeStamp;
  return { clientX: X0 + x, clientY: y, pointerType: 'touch', pointerId, timeStamp };
};

function setup(over: Partial<SwipeReplyOptions> = {}) {
  const frames: SwipeFrame[] = [];
  const onReply = vi.fn();
  const onStart = vi.fn();
  const vibrate = vi.fn();
  // Synchronous animation frames: each queued drag frame paints at once.
  const raf = vi.fn((paint: () => void) => {
    paint();
    return 1;
  });
  const c = createSwipeReplyController({
    onReply,
    onStart,
    vibrate,
    raf,
    cancelRaf: () => {},
    now: () => clock,
    onFrame: (f) => frames.push(f),
    ...over,
  });
  return { c, frames, onReply, onStart, vibrate, raf, last: () => frames[frames.length - 1] };
}

/** A slow drag: 1 px per 10 ms, never a flick. */
function drag(c: ReturnType<typeof setup>['c'], to: number, y = 0): void {
  c.handlers.onPointerDown(touch(0, 0, 0));
  for (let x = 1; x <= to; x += 1) c.handlers.onPointerMove(touch(x, y, x * 10));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('swipeOffset (resistance curve)', () => {
  it('1:1 to 64px, then 0.3px per px, capped at 120px, never leftward', () => {
    expect(swipeOffset(-20)).toBe(0);
    expect(swipeOffset(0)).toBe(0);
    expect(swipeOffset(40)).toBe(40);
    expect(swipeOffset(SWIPE_TRIGGER_PX)).toBe(64);
    expect(swipeOffset(74)).toBeCloseTo(67);
    expect(swipeOffset(164)).toBeCloseTo(94);
    expect(swipeOffset(250)).toBeCloseTo(119.8);
    expect(swipeOffset(400)).toBe(SWIPE_MAX_PX);
  });
});

describe('swipeTriggers', () => {
  it('by distance, or by a fast rightward flick past 24px', () => {
    expect(swipeTriggers(SWIPE_TRIGGER_PX, 0)).toBe(true);
    expect(swipeTriggers(SWIPE_TRIGGER_PX - 1, 0)).toBe(false);
    expect(swipeTriggers(SWIPE_FLICK_MIN_PX, SWIPE_FLICK_VELOCITY)).toBe(true);
    expect(swipeTriggers(SWIPE_FLICK_MIN_PX - 1, 2)).toBe(false);
    expect(swipeTriggers(40, SWIPE_FLICK_VELOCITY - 0.01)).toBe(false);
    expect(swipeTriggers(40, -2)).toBe(false);
  });
});

describe('createSwipeReplyController', () => {
  it('locks at 8px horizontal and paints translateX-only drag frames', () => {
    const { c, onStart, last } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(SWIPE_LOCK_PX - 1, 0, 10));
    expect(onStart).not.toHaveBeenCalled();
    c.handlers.onPointerMove(touch(30, 4, 400));
    expect(onStart).toHaveBeenCalledWith(1);
    expect(c.swiping()).toBe(true);
    expect(last()).toEqual({
      offset: 30,
      armed: false,
      progress: 30 / 64,
      animate: false,
      dragging: true,
    });
    c.dispose();
  });

  it('drag frames go through requestAnimationFrame, one paint per frame, latest wins', () => {
    const queued: Array<() => void> = [];
    const { c, frames } = setup({
      raf: (paint) => {
        queued.push(paint);
        return queued.length;
      },
    });
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(20, 0, 100));
    c.handlers.onPointerMove(touch(30, 0, 200));
    c.handlers.onPointerMove(touch(40, 0, 300));
    expect(frames).toEqual([]);
    expect(queued).toHaveLength(1);
    queued[0]?.();
    expect(frames.map((f) => f.offset)).toEqual([40]);
    c.dispose();
  });

  it('release past 64px replies once and springs back with will-change dropped', () => {
    const { c, onReply, last } = setup();
    drag(c, 70);
    c.handlers.onPointerUp();
    c.handlers.onPointerUp();
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ ...SWIPE_REST, animate: true });
    expect(last()?.dragging).toBe(false);
  });

  it('a fast flick past 24px replies below the trigger distance', () => {
    const { c, onReply } = setup();
    c.handlers.onPointerDown(touch(0, 0, 0));
    c.handlers.onPointerMove(touch(10, 0, 10));
    c.handlers.onPointerMove(touch(30, 0, 40));
    c.handlers.onPointerUp();
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('a slow short drag springs back without replying', () => {
    const { c, onReply, last } = setup();
    drag(c, 40);
    c.handlers.onPointerUp();
    expect(onReply).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ offset: 0, animate: true, dragging: false });
  });

  it('a fast flick shorter than 24px does not reply', () => {
    const { c, onReply } = setup();
    c.handlers.onPointerDown(touch(0, 0, 0));
    c.handlers.onPointerMove(touch(SWIPE_FLICK_MIN_PX - 2, 0, 5));
    c.handlers.onPointerUp();
    expect(onReply).not.toHaveBeenCalled();
  });

  it('a press within 20px of the left edge is ignored (iOS back gesture)', () => {
    const { c, onStart, onReply, frames } = setup();
    const at = (x: number) => ({ clientX: x, clientY: 0, pointerType: 'touch', pointerId: 1 });
    c.handlers.onPointerDown(at(SWIPE_EDGE_PX - 1));
    c.handlers.onPointerMove(at(200));
    c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
    c.handlers.onPointerDown(at(SWIPE_EDGE_PX));
    c.handlers.onPointerMove(at(SWIPE_EDGE_PX + 30));
    expect(onStart).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it('a vertical-first gesture is left to the list to scroll', () => {
    const { c, onStart, onReply, frames } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(3, 12, 10));
    c.handlers.onPointerMove(touch(120, 12, 20));
    c.handlers.onPointerUp();
    // Leftward first is not ours either.
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(-12, 0, 10));
    c.handlers.onPointerMove(touch(120, 0, 20));
    c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
    expect(c.consumeClickSuppression()).toBe(false);
  });

  it('horizontal lock cancels the bubble hold and a post card hold inside it', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    const bubbleHold = vi.fn();
    const cardHold = vi.fn();
    const bubble = createLongPressController({ onLongPress: bubbleHold, ignoreMouse: true });
    const card = createLongPressController({ onLongPress: cardHold, thresholdMs: 450 });
    // A fake DOM: the card element sits inside the bubble element.
    const cardEl = { id: 'card' };
    const bubbleEl = { contains: (n: unknown) => n === cardEl || n === bubbleEl };
    const { c } = setup({
      onStart: () => {
        bubble.cancel();
        cancelPendingLongPressesWithin(bubbleEl);
      },
    });
    // One press lands on the card (inner) and the bubble (outer).
    card.handlers.onPointerDown({ ...touch(0, 0), currentTarget: cardEl });
    bubble.handlers.onPointerDown({ ...touch(0, 0), currentTarget: bubbleEl });
    c.handlers.onPointerDown(touch(0, 0));
    // Pointer capture: the moves reach the bubble only, never the card.
    bubble.handlers.onPointerMove(touch(9, 0, 50));
    c.handlers.onPointerMove(touch(9, 0, 50));
    vi.advanceTimersByTime(2000);
    expect(bubbleHold).not.toHaveBeenCalled();
    expect(cardHold).not.toHaveBeenCalled();
    expect(card.consumeClickSuppression()).toBe(false);
    c.dispose();
  });

  it('E15: a hold outside the swiped bubble is not cancelled', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    const elsewhere = vi.fn();
    const other = createLongPressController({ onLongPress: elsewhere });
    const otherEl = { id: 'row-in-another-list' };
    other.handlers.onPointerDown({ ...touch(0, 0), currentTarget: otherEl });
    cancelPendingLongPressesWithin({ contains: () => false });
    vi.advanceTimersByTime(1000);
    expect(elsewhere).toHaveBeenCalledTimes(1);
  });

  it('T6: a flick that paused over 100ms before release does not reply', () => {
    const { c, onReply } = setup();
    c.handlers.onPointerDown(touch(0, 0, 0));
    c.handlers.onPointerMove(touch(15, 0, 10));
    c.handlers.onPointerMove(touch(40, 0, 40));
    // Finger holds still, then lifts 150ms after the last move.
    c.handlers.onPointerUp({ timeStamp: 190 });
    expect(onReply).not.toHaveBeenCalled();
  });

  it('T6: velocity counts only the last 100ms of samples before release', () => {
    const { c, onReply } = setup();
    c.handlers.onPointerDown(touch(0, 0, 0));
    // Fast early, then slow for the last 100ms: no flick.
    c.handlers.onPointerMove(touch(20, 0, 10));
    c.handlers.onPointerMove(touch(30, 0, 150));
    c.handlers.onPointerMove(touch(34, 0, 240));
    c.handlers.onPointerUp({ timeStamp: 245 });
    expect(onReply).not.toHaveBeenCalled();
    // A fast flick released at once still replies.
    c.handlers.onPointerDown(touch(0, 0, 1000));
    c.handlers.onPointerMove(touch(10, 0, 1010));
    c.handlers.onPointerMove(touch(30, 0, 1040));
    c.handlers.onPointerUp({ timeStamp: 1045 });
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('the click that trails a swipe is suppressed once; a tap is not', () => {
    const { c } = setup();
    drag(c, 30);
    c.handlers.onPointerUp();
    expect(c.consumeClickSuppression()).toBe(true);
    expect(c.consumeClickSuppression()).toBe(false);
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(5, 3, 10));
    c.handlers.onPointerUp();
    expect(c.consumeClickSuppression()).toBe(false);
  });

  it('disabled (sending, failed, selecting) never swipes', () => {
    const { c, onStart, onReply, frames } = setup({ enabled: () => false });
    drag(c, 90);
    c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
  });

  it('mouse never swipes; pen does', () => {
    const { c, onStart, onReply } = setup();
    c.handlers.onPointerDown({ clientX: X0, clientY: 0, pointerType: 'mouse', pointerId: 1 });
    c.handlers.onPointerMove({ clientX: X0 + 90, clientY: 0, pointerType: 'mouse', pointerId: 1 });
    c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
    c.handlers.onPointerDown({ ...touch(0, 0), pointerType: 'pen' });
    c.handlers.onPointerMove({ ...touch(70, 0, 700), pointerType: 'pen' });
    c.handlers.onPointerUp();
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('vibrates once on crossing the trigger, not again after pulling back and re-crossing', () => {
    const { c, vibrate, last } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(SWIPE_TRIGGER_PX - 1, 0, 600));
    expect(vibrate).not.toHaveBeenCalled();
    expect(last()?.armed).toBe(false);
    c.handlers.onPointerMove(touch(SWIPE_TRIGGER_PX, 0, 700));
    expect(last()).toMatchObject({ armed: true, progress: 1 });
    c.handlers.onPointerMove(touch(90, 0, 800));
    c.handlers.onPointerMove(touch(30, 0, 900));
    c.handlers.onPointerMove(touch(90, 0, 1000));
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(SWIPE_VIBRATE_MS);
    c.dispose();
  });

  it('default vibrate: navigator.vibrate(10) once where it exists', () => {
    const vib = vi.fn();
    vi.stubGlobal('navigator', { vibrate: vib });
    const { c } = setup({ vibrate: defaultVibrate });
    drag(c, 100);
    c.handlers.onPointerUp();
    expect(vib).toHaveBeenCalledTimes(1);
    expect(vib).toHaveBeenCalledWith(10);
  });

  it('default vibrate: nothing (and no throw) where navigator.vibrate is absent', () => {
    vi.stubGlobal('navigator', {});
    const { c, onReply } = setup({ vibrate: defaultVibrate });
    expect(() => drag(c, 100)).not.toThrow();
    c.handlers.onPointerUp();
    expect(onReply).toHaveBeenCalledTimes(1);
    expect('vibrate' in navigator).toBe(false);
  });

  it('pointercancel and window scroll cancel without replying', () => {
    const listeners: Array<() => void> = [];
    vi.stubGlobal('window', {
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    });
    const { c, onReply, last } = setup();
    drag(c, 70);
    listeners.forEach((fn) => fn());
    expect(last()?.offset).toBe(0);
    c.handlers.onPointerUp();
    drag(c, 70);
    c.handlers.onPointerCancel();
    c.handlers.onPointerUp();
    expect(onReply).not.toHaveBeenCalled();
  });

  it('reduced motion resets instantly', () => {
    const { c, last } = setup({ reducedMotion: () => true });
    drag(c, 70);
    c.handlers.onPointerUp();
    expect(last()).toEqual(SWIPE_REST);
  });

  it('cancel (a completed long-press) stops a pending press from becoming a swipe', () => {
    const { c, onStart } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.cancel();
    c.handlers.onPointerMove(touch(90, 0, 10));
    c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("direction left (a task row's swipe to delete)", () => {
  it('mirrors the gesture: leftward locks and fires, rightward releases', () => {
    const { c, onReply, last } = setup({ direction: 'left' });
    c.handlers.onPointerDown(touch(0, 0, 0));
    for (let x = 1; x <= 70; x += 1) c.handlers.onPointerMove(touch(-x, 0, x * 10));
    expect(c.swiping()).toBe(true);
    // The frame carries the magnitude; the view mirrors it.
    expect(last()?.offset).toBe(64 + (70 - 64) * 0.3);
    expect(last()?.armed).toBe(true);
    c.handlers.onPointerUp(touch(-70, 0, 700));
    expect(onReply).toHaveBeenCalledTimes(1);

    const right = setup({ direction: 'left' });
    drag(right.c, 30);
    expect(right.c.swiping()).toBe(false);
    right.c.handlers.onPointerUp();
    expect(right.onReply).not.toHaveBeenCalled();
  });

  it('a press at the right screen edge belongs to the system gesture', () => {
    vi.stubGlobal('window', {
      innerWidth: 400,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const { c } = setup({ direction: 'left' });
    c.handlers.onPointerDown({
      clientX: 390,
      clientY: 0,
      pointerType: 'touch',
      pointerId: 1,
      timeStamp: 0,
    });
    for (let x = 1; x <= 40; x += 1) {
      c.handlers.onPointerMove({
        clientX: 390 - x,
        clientY: 0,
        pointerType: 'touch',
        pointerId: 1,
        timeStamp: x * 10,
      });
    }
    expect(c.swiping()).toBe(false);
  });
});
