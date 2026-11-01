// The Plan tab calendar on a coarse pointer (iPad): 44px entry lines and
// "+N more" (so the month cell holds fewer lines, the rest go to "+N more"),
// and a long-press on an entry (creators only, the shared ui/useLongPress
// duration) that opens the day picker.
// A fine pointer keeps monthCellCap exactly as it is.

import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { monthCellCap } from '@/lib/plan-tab';
import { MOVE_CANCEL_PX, useLongPress as useSharedLongPress } from '@/components/ui/useLongPress';

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

/** Whether a press that travelled (dx, dy) is still a hold (the shared MOVE_CANCEL_PX). Pure. */
export function withinDrift(dx: number, dy: number): boolean {
  return dx * dx + dy * dy <= MOVE_CANCEL_PX * MOVE_CANCEL_PX;
}

/**
 * A touch long-press on a calendar entry, on the shared long-press
 * (ui/useLongPress: LONG_PRESS_MS, MOVE_CANCEL_PX, mouse ignored). press() on
 * pointerdown starts it for that entry; moves and the release are followed on
 * the window; when it fires, onFire gets the entry and the click that follows
 * the release is swallowed (consumeClick() is true until the tick after it).
 * A mouse press does nothing here (the laptop drag owns it).
 */
export function useLongPress<T>(input: { enabled: boolean; onFire: (target: T) => void }): {
  press: (target: T, event: ReactPointerEvent<HTMLElement>) => void;
  consumeClick: () => boolean;
} {
  const onFireRef = useRef(input.onFire);
  onFireRef.current = input.onFire;
  const targetRef = useRef<{ value: T } | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const hold = useSharedLongPress(
    () => {
      detach.current?.();
      const target = targetRef.current;
      if (target === null) return;
      // The release after the hold: its click is swallowed, then the next tap counts.
      const clear = (): void => {
        window.setTimeout(() => hold.clearClickSuppression(), 0);
      };
      window.addEventListener('pointerup', clear, { once: true });
      window.addEventListener('pointercancel', clear, { once: true });
      onFireRef.current(target.value);
    },
    { ignoreMouse: true },
  );
  useEffect(() => () => detach.current?.(), []);

  const press = (target: T, event: ReactPointerEvent<HTMLElement>): void => {
    if (!input.enabled || event.pointerType === 'mouse') return;
    detach.current?.();
    targetRef.current = { value: target };
    hold.handlers.onPointerDown(event);
    const move = (e: PointerEvent): void => hold.handlers.onPointerMove(e);
    const up = (): void => {
      hold.handlers.onPointerUp();
      stop();
    };
    const cancel = (): void => {
      hold.handlers.onPointerCancel();
      stop();
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      detach.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    detach.current = stop;
  };

  return { press, consumeClick: hold.consumeClickSuppression };
}
