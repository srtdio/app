import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Hold this long before a press counts as a long-press. */
export const LONG_PRESS_THRESHOLD_MS = 450;
/** Move further than this from the press origin and the long-press is cancelled. */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

interface PointerLike {
  clientX: number;
  clientY: number;
}

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
}

export interface LongPressController {
  /** Spread these onto the pressable element. */
  handlers: LongPressHandlers;
  /**
   * Call from a click handler that follows the same gesture. Returns true once
   * (then resets) when the click is the tail of a long-press, so the caller can
   * ignore it instead of treating the long-press as a tap.
   */
  shouldSuppressClick: () => boolean;
  /** Cancel any pending press (e.g. on scroll). */
  cancel: () => void;
  /** Cancel and release; safe to call on unmount. */
  dispose: () => void;
}

interface LongPressOptions {
  thresholdMs?: number;
  moveTolerancePx?: number;
}

/**
 * Framework-free long-press core. Holds the timer/threshold logic so it is unit
 * testable without a DOM renderer; the React hook below wraps one instance per
 * mounted element.
 */
export function createLongPress(
  onLongPress: () => void,
  options: LongPressOptions = {},
): LongPressController {
  const thresholdMs = options.thresholdMs ?? LONG_PRESS_THRESHOLD_MS;
  const moveTolerancePx = options.moveTolerancePx ?? LONG_PRESS_MOVE_TOLERANCE_PX;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: PointerLike | null = null;
  let suppressClick = false;

  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    origin = null;
  }

  function onPointerDown(event: PointerLike): void {
    cancel();
    origin = { clientX: event.clientX, clientY: event.clientY };
    timer = setTimeout(() => {
      timer = null;
      origin = null;
      suppressClick = true;
      onLongPress();
    }, thresholdMs);
  }

  function onPointerMove(event: PointerLike): void {
    if (origin === null) {
      return;
    }
    const dx = event.clientX - origin.clientX;
    const dy = event.clientY - origin.clientY;
    if (Math.hypot(dx, dy) > moveTolerancePx) {
      cancel();
    }
  }

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
    },
    shouldSuppressClick(): boolean {
      if (suppressClick) {
        suppressClick = false;
        return true;
      }
      return false;
    },
    cancel,
    dispose: cancel,
  };
}

/**
 * Pointer-based long-press hook. Fires `onLongPress` after a ~450ms hold and
 * cancels on pointer move past ~10px, an early pointer up, or a scroll. Returns
 * handler props to spread on an element plus `shouldSuppressClick`, which a
 * following click handler calls to drop the click that trails a long-press. No
 * external dependency; the scroll listener and pending timer are both torn down
 * in the one effect.
 */
export function useLongPress(
  onLongPress: () => void,
  options: LongPressOptions = {},
): Pick<LongPressController, 'handlers' | 'shouldSuppressClick'> {
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;

  const controllerRef = useRef<LongPressController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createLongPress(() => callbackRef.current(), options);
  }
  const controller = controllerRef.current;

  useEffect(() => {
    function onScroll(): void {
      controller.cancel();
    }
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      controller.dispose();
    };
  }, [controller]);

  return { handlers: controller.handlers, shouldSuppressClick: controller.shouldSuppressClick };
}
