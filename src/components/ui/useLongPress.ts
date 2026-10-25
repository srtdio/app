import { useEffect, useRef } from 'react';

/** Hold this long before a press counts as a long-press. */
export const LONG_PRESS_MS = 450;
/** Move this far (px) and the gesture is a drag/scroll, not a long-press. */
export const MOVE_CANCEL_PX = 10;

/** The only pointer fields the controller reads; React's PointerEvent satisfies it. */
interface PointerSample {
  clientX: number;
  clientY: number;
  /** 'mouse' | 'touch' | 'pen'; absent reads as touch. */
  pointerType?: string;
  /** The element the handler is on (React's currentTarget); scopes cancelPendingLongPressesWithin. */
  currentTarget?: unknown;
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
  /**
   * Call from the target's contextmenu handler: the menu opens from there, so
   * a still-running hold timer must not fire and reopen it (macOS fires
   * contextmenu on mousedown).
   */
  cancel: () => void;
  /**
   * Call once the long-press opened an overlay (menu with a backdrop): the
   * trailing pointerup lands on the overlay, so the click this flag guards
   * never reaches the target and the next real click must not be swallowed.
   */
  clearClickSuppression: () => void;
  /** The pointerType of the last pointerdown ('' before any). */
  lastPointerType: () => string;
  /** Clear any pending timer and listeners. */
  dispose: () => void;
}

export interface LongPressOptions {
  onLongPress: () => void;
  thresholdMs?: number;
  moveTolerancePx?: number;
  /**
   * Mouse presses never start the timer (the pointer has right-click and a
   * hover control instead). Touch and pen behave exactly as without it.
   */
  ignoreMouse?: boolean;
}

/** Controllers with a hold timer running right now, with the element each was pressed on. */
const pendingHolds = new Map<() => void, unknown>();

/** The slice of a DOM element the scoped cancel needs (a test fake satisfies it). */
export interface HoldScope {
  contains: (other: Node | null) => boolean;
}

/**
 * Cancel the running hold timers pressed on `root` or inside it; holds
 * anywhere else run on. A gesture that claims the pointer (a chat
 * swipe-to-reply) calls this so a hold nested inside the swiped element (a post
 * card's own hold) never fires mid-gesture: pointer capture sends the moves to
 * the capturing element, so the nested hold would never see its 10px move
 * cancel. Holds that already fired are untouched. An additive hook: the
 * controller and hook API are unchanged for every caller.
 */
export function cancelPendingLongPressesWithin(root: HoldScope): void {
  for (const [cancelHold, target] of [...pendingHolds]) {
    if (target !== null && target !== undefined && root.contains(target as Node)) cancelHold();
  }
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
  ignoreMouse = false,
}: LongPressOptions): LongPressController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let suppressClick = false;
  let pointerType = '';

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pendingHolds.delete(cancel);
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
    pointerType = event.pointerType ?? '';
    if (ignoreMouse && pointerType === 'mouse') return;
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => {
      timer = null;
      pendingHolds.delete(cancel);
      suppressClick = true;
      detachScroll();
      onLongPress();
    }, thresholdMs);
    pendingHolds.set(cancel, event.currentTarget ?? null);
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
    cancel,
    clearClickSuppression(): void {
      suppressClick = false;
    },
    lastPointerType(): string {
      return pointerType;
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
  cancel: () => void;
  clearClickSuppression: () => void;
}

/**
 * Pointer-based long-press hook. Spread `handlers` on the target; in a trailing
 * onClick call `consumeClickSuppression()` first and bail when it returns true,
 * so the click that trails a long-press is swallowed. Timer and listeners are
 * cleaned up on unmount in the same effect.
 */
export function useLongPress(
  onLongPress: () => void,
  options?: { thresholdMs?: number; moveTolerancePx?: number; ignoreMouse?: boolean },
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
    cancel: controller.cancel,
    clearClickSuppression: controller.clearClickSuppression,
  };
}

export interface MenuGestureHandlers extends LongPressHandlers {
  onContextMenu: (event: { preventDefault: () => void }) => void;
}

export interface UseMenuGestureResult {
  /** Spread onto the row, card, tile or bubble. */
  handlers: MenuGestureHandlers;
  /** Call first in the target's onClick; true means swallow the click that trailed a long-press. */
  consumeClickSuppression: () => boolean;
}

/**
 * The one way to open an item's ActionMenu by gesture: long-press on touch
 * (LONG_PRESS_MS) and right-click on laptop open the same menu. Mouse presses
 * never start the hold timer; a right-click cancels any pending hold so the
 * menu opens once.
 */
export function useMenuGesture(onOpen: () => void): UseMenuGestureResult {
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const press = useLongPress(() => onOpenRef.current(), { ignoreMouse: true });
  return {
    handlers: {
      ...press.handlers,
      onContextMenu(event) {
        event.preventDefault();
        press.cancel();
        press.clearClickSuppression();
        onOpenRef.current();
      },
    },
    consumeClickSuppression: press.consumeClickSuppression,
  };
}
