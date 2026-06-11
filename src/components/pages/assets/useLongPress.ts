import { useCallback, useEffect, useRef } from 'react';

/** Pointer handlers to spread onto an element to wire long-press + tap. */
export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

const MOVE_TOLERANCE = 10;

/**
 * Long-press (default 450ms) for both touch and mouse via pointer events. A
 * fired long-press suppresses the click that follows so a press never also
 * opens the viewer. A small drag past the tolerance cancels the timer so the
 * grid stays scrollable. Emits a light haptic via navigator.vibrate when the
 * platform supports it.
 */
export function useLongPress(
  onLongPress: () => void,
  onTap: () => void,
  ms = 450,
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback((): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(10);
        }
        onLongPress();
      }, ms);
    },
    [onLongPress, ms],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent): void => {
      if (origin.current === null) return;
      const dx = Math.abs(event.clientX - origin.current.x);
      const dy = Math.abs(event.clientY - origin.current.y);
      if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) clear();
    },
    [clear],
  );

  const onClick = useCallback((): void => {
    if (fired.current) {
      fired.current = false;
      return;
    }
    onTap();
  }, [onTap]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onClick,
    onContextMenu: (event) => event.preventDefault(),
  };
}
