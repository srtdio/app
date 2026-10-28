// The laptop Plan calendar's one-screen height: the element measures its own
// top and takes the rest of the window, less a 24px bottom gap, never under
// 360px (below that the page may scroll). Layout reads only, no screen-size
// detection, no network: one getBoundingClientRect in a layout effect, so the
// first paint is already the fitted height, then again on window resize and
// when the watched root changes size (chip row, header).

import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export const FIT_GAP_PX = 24;
export const FIT_MIN_PX = 360;

/** The fitted height for an element whose top is `top` in a `viewport`-tall window. Pure. */
export function fitHeight(top: number, viewport: number): number {
  return Math.max(FIT_MIN_PX, Math.floor(viewport - top - FIT_GAP_PX));
}

/** The fitted height of `target` (null until measured, before the first paint). */
export function useFitHeight(
  target: RefObject<HTMLElement | null>,
  watch: RefObject<HTMLElement | null>,
): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return undefined;
    const measure = (): void => {
      const next = fitHeight(el.getBoundingClientRect().top, window.innerHeight);
      setHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const root = watch.current;
    const observer =
      root !== null && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (observer !== null && root !== null) observer.observe(root);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [target, watch]);
  return height;
}
