import { useEffect, useRef } from 'react';

/** Hold this long before a press counts as a long-press. */
export const LONG_PRESS_MS = 450;
/** Move this far (px) and the gesture is a drag/scroll, not a long-press. */
export const MOVE_CANCEL_PX = 10;

/** The only pointer fields the controller reads; React's PointerEvent satisfies it. */
interface PointerSample {
  clientX: number;
  clientY: number;
}

export interface LongPressHandlers {
  onPointerDown: (event: PointerSample) => void;
  onPointerMove: (event: PointerSample) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

export interface LongPressController {
  /** Spread onto the target element. */
  handlers: LongPressHandlers;
  /**
   * Call at the start of a trailing click handler. Returns true (once) when the
   * click is the tail of a long-press and should be ignored, then resets.
   */
  consumeClickSuppression: () => boolean;
  /** Clear any pending timer and listeners. */
  dispose: () => void;
}

export interface LongPressOptions {
  onLongPress: () => void;
  thresholdMs?: number;
  moveTolerancePx?: number;
}

/**
 * Framework-free long-press core. Pointer-based, no external dependency. A
 * long-press fires after `thresholdMs` of holding still; moving past
 * `moveTolerancePx`, lifting early, or scrolling cancels it. Extracted from the
 * hook so it can be unit-tested without a DOM.
 */
export function createLongPressController({
  onLongPress,
  thresholdMs = LONG_PRESS_MS,
  moveTolerancePx = MOVE_CANCEL_PX,
}: LongPressOptions): LongPressController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let suppressClick = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function detachScroll(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', cancel, true);
    }
  }

  function cancel(): void {
    clearTimer();
    detachScroll();
  }

  function onPointerDown(event: PointerSample): void {
    cancel();
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      detachScroll();
      onLongPress();
    }, thresholdMs);
    // Any scroll while holding is a scroll gesture, not a press.
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', cancel, true);
    }
  }

  function onPointerMove(event: PointerSample): void {
    if (timer === null) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (dx * dx + dy * dy > moveTolerancePx * moveTolerancePx) {
      cancel();
    }
  }

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      // Lifting before the threshold leaves the timer pending; cancel it. A
      // long-press has already cleared the timer, so suppressClick survives.
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
    consumeClickSuppression(): boolean {
      const value = suppressClick;
      suppressClick = false;
      return value;
    },
    dispose(): void {
      cancel();
      suppressClick = false;
    },
  };
}

export interface UseLongPressResult {
  handlers: LongPressHandlers;
  consumeClickSuppression: () => boolean;
}

/**
 * Pointer-based long-press hook. Spread `handlers` on the target; in a trailing
 * onClick call `consumeClickSuppression()` first and bail when it returns true,
 * so the click that trails a long-press is swallowed. Timer and listeners are
 * cleaned up on unmount in the same effect.
 */
export function useLongPress(
  onLongPress: () => void,
  options?: { thresholdMs?: number; moveTolerancePx?: number },
): UseLongPressResult {
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;

  const controllerRef = useRef<LongPressController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createLongPressController({
      onLongPress: () => onLongPressRef.current(),
      ...options,
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  return {
    handlers: controller.handlers,
    consumeClickSuppression: controller.consumeClickSuppression,
  };
}
