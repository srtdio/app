import { useEffect, useRef, useState } from 'react';

export interface DelayedBusyOptions {
  /** Busy must last this long (ms, continuous) before the indicator shows. */
  delay: number;
  /** Once shown, the indicator stays at least this long (ms), so it never blinks. */
  minVisible: number;
}

/** Image spinners in the lightboxes and file viewer (docs/motion.md, Waits). */
export const SPINNER_BUSY = { delay: 200, minVisible: 400 } as const satisfies DelayedBusyOptions;
/** BoxSkeleton (docs/motion.md, Waits). */
export const SKELETON_BUSY = { delay: 150, minVisible: 300 } as const satisfies DelayedBusyOptions;

/**
 * Whether to show a busy indicator (spinner, loading boxes) for `busy`. A fast
 * load never shows it: it appears only after `delay` ms of continuous busy;
 * once it has appeared it stays at least `minVisible` ms so it never flashes.
 * It only gates the placeholder: content renders the moment it is ready.
 * No await, no read; timers only.
 */
export function useDelayedBusy(busy: boolean, { delay, minVisible }: DelayedBusyOptions): boolean {
  const [shown, setShown] = useState(() => busy && delay <= 0);
  // When the indicator appeared (Date.now()); null while hidden.
  const shownAt = useRef<number | null>(busy && delay <= 0 ? Date.now() : null);

  useEffect(() => {
    if (busy) {
      if (shown) return undefined;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, Math.max(0, delay));
      return () => clearTimeout(timer);
    }
    if (!shown) return undefined;
    const left = minVisible - (Date.now() - (shownAt.current ?? 0));
    const hide = (): void => {
      shownAt.current = null;
      setShown(false);
    };
    if (left <= 0) {
      hide();
      return undefined;
    }
    const timer = setTimeout(hide, left);
    return () => clearTimeout(timer);
  }, [busy, shown, delay, minVisible]);

  // Busy ended after the hold already ran out: hide in this very render.
  if (shown && !busy && Date.now() - (shownAt.current ?? 0) >= minVisible) return false;
  return shown;
}
