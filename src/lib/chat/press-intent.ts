// Press-in for a chat row: the open's bundle read may start before the tap,
// but only once the press has settled. A press that moves more than
// PRESS_SLOP_PX, is cancelled (pointercancel, which a browser fires when a
// pan starts), lifts, or sees any scroll before PRESS_SETTLE_MS is a scroll or
// a tap, never a press-in: it reads nothing (a tap starts or joins the one
// read itself, as before). Only a pointerdown arms it: a mouse hovering, moving
// or entering a row never reads.
//
// PRESS_SETTLE_MS is a ceiling on how early a still finger starts the read,
// not a wait on any paint or tap path: nothing paints or opens later because
// of it (the tap's own read is unchanged; the press read is only ever
// earlier, and shared with the tap's).

/** Move farther than this (px) from the press point and it is a scroll, not a press. */
export const PRESS_SLOP_PX = 8;
/** A press held still this long (ms) starts the open's read (a ceiling, off the paint path). */
export const PRESS_SETTLE_MS = 80;

/** The only pointer fields the intent reads; React's PointerEvent satisfies it. */
export interface PressSample {
  clientX: number;
  clientY: number;
}

/** Timers and the scroll watch (the app's: window; tests pass fakes). */
export interface PressIntentDeps {
  /** Run `fn` after `ms`; returns the cancel. */
  setTimer: (fn: () => void, ms: number) => () => void;
  /** Call `onScroll` on any scroll (the list's, the page's); returns the stop. */
  watchScroll: (onScroll: () => void) => () => void;
}

export interface PressIntent {
  /** pointerdown: arm (a press already armed is dropped first). */
  down: (event: PressSample) => void;
  /** pointermove: past the slop, disarm. */
  move: (event: PressSample) => void;
  /** pointerup, pointercancel, unmount: disarm. */
  cancel: () => void;
  /** Whether a press is armed now (tests). */
  armed: () => boolean;
}

const APP_DEPS: PressIntentDeps = {
  setTimer: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  watchScroll: (onScroll) => {
    if (typeof window === 'undefined') return () => {};
    // Capture: element scrolls (the chat list, the main pane) do not bubble.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  },
};

/** One row's press-in: `onSettle` runs once per press that stayed still for PRESS_SETTLE_MS. */
export function createPressIntent(
  onSettle: () => void,
  deps: PressIntentDeps = APP_DEPS,
): PressIntent {
  let stopTimer: (() => void) | null = null;
  let stopScroll: (() => void) | null = null;
  let startX = 0;
  let startY = 0;

  const cancel = (): void => {
    stopTimer?.();
    stopScroll?.();
    stopTimer = null;
    stopScroll = null;
  };

  return {
    down(event) {
      cancel();
      startX = event.clientX;
      startY = event.clientY;
      stopScroll = deps.watchScroll(cancel);
      stopTimer = deps.setTimer(() => {
        stopTimer = null;
        stopScroll?.();
        stopScroll = null;
        onSettle();
      }, PRESS_SETTLE_MS);
    },
    move(event) {
      if (stopTimer === null) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (dx * dx + dy * dy > PRESS_SLOP_PX * PRESS_SLOP_PX) cancel();
    },
    cancel,
    armed: () => stopTimer !== null,
  };
}
