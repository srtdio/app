// The Plan tab calendar on a coarse pointer (iPad): 44px entry lines and
// "+N more" (so the month cell holds fewer lines, the rest go to "+N more"),
// and a long-press on an entry (creators only) that opens the day picker.
// A fine pointer keeps monthCellCap exactly as it is.

import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { monthCellCap } from '@/lib/plan-tab';

/** A coarse-pointer month line and "+N more" (the 44px touch target). */
export const COARSE_LINE_PX = 44;
// The month cell's fixed parts, as monthCellCap counts them (src/lib/plan-tab.ts).
const LINE_GAP_PX = 2;
const CELL_PAD_PX = 12;
const NUMBER_ROW_PX = 28;

/**
 * How many entries a month cell shows: monthCellCap on a fine pointer (22px
 * lines, unchanged); on a coarse pointer the same sum with 44px lines and a
 * 44px "+N more". Pure.
 */
export function monthCellCapFor(input: {
  rowHeight: number;
  count: number;
  coarse: boolean;
}): number {
  if (!input.coarse) return monthCellCap({ rowHeight: input.rowHeight, count: input.count });
  const step = COARSE_LINE_PX + LINE_GAP_PX;
  const avail = input.rowHeight - CELL_PAD_PX - NUMBER_ROW_PX;
  if (input.count * step <= avail) return input.count;
  return Math.max(0, Math.floor((avail - step) / step));
}

/** How long a touch holds still on an entry before the day picker opens. */
export const LONG_PRESS_MS = 500;
/** Travel (px) that cancels a long-press (a scroll, not a hold). */
export const LONG_PRESS_DRIFT_PX = 10;

/** Whether a press that travelled (dx, dy) is still a hold. Pure. */
export function withinDrift(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < LONG_PRESS_DRIFT_PX;
}

/**
 * A touch long-press: press() on pointerdown starts a LONG_PRESS_MS timer;
 * drift past LONG_PRESS_DRIFT_PX, release or cancel stops it. When it fires,
 * onFire runs and the click that follows the release is swallowed
 * (consumeClick() is true until the next tick after it). Touch only: a mouse
 * press does nothing here (the laptop drag owns it).
 */
export function useLongPress<T>(input: { enabled: boolean; onFire: (target: T) => void }): {
  press: (target: T, event: ReactPointerEvent<HTMLElement>) => void;
  consumeClick: () => boolean;
} {
  const onFireRef = useRef(input.onFire);
  onFireRef.current = input.onFire;
  const cleanup = useRef<(() => void) | null>(null);
  const swallow = useRef(false);
  useEffect(() => () => cleanup.current?.(), []);

  const press = (target: T, event: ReactPointerEvent<HTMLElement>): void => {
    if (!input.enabled || event.pointerType !== 'touch') return;
    cleanup.current?.();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const stop = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', stop);
      cleanup.current = null;
    };
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      if (!withinDrift(e.clientX - startX, e.clientY - startY)) stop();
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) stop();
    };
    const timer = window.setTimeout(() => {
      stop();
      swallow.current = true;
      // The click after this release (if any) lands first; then it clears.
      const clear = (): void => {
        window.setTimeout(() => {
          swallow.current = false;
        }, 0);
      };
      window.addEventListener('pointerup', clear, { once: true });
      window.addEventListener('pointercancel', clear, { once: true });
      onFireRef.current(target);
    }, LONG_PRESS_MS);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', stop);
    cleanup.current = stop;
  };

  return { press, consumeClick: () => swallow.current };
}
