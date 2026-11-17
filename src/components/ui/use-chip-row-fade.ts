// Scroll-aware chip-row fades: a fade at each edge that still has chips past
// it, none when nothing is cut off. A mask is alpha only (the keyword colours
// carry no hue), so it reads the same in light and dark with no token. Used by
// Pipeline StageChips and the chat home's media chips.
import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

/** The fade's width at a cut edge. */
export const CHIP_ROW_FADE = '24px';

/** Sub-pixel scroll rounding: under this, an edge counts as not cut. */
const SLACK = 2;

/** Which edges of a row still have content past them. Pure. */
export function chipRowEdges(row: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): { start: boolean; end: boolean } {
  const max = row.scrollWidth - row.clientWidth;
  // RTL scrollLeft runs negative from 0.
  const scrolled = Math.abs(row.scrollLeft);
  return {
    start: max > SLACK && scrolled > SLACK,
    end: max > SLACK && scrolled < max - SLACK,
  };
}

/** The mask for the row's cut edges; 'none' when nothing is cut off. Pure. */
export function chipRowMask(fadeStart: boolean, fadeEnd: boolean, rtl = false): string {
  if (!fadeStart && !fadeEnd) return 'none';
  const from = fadeStart ? `transparent 0, black ${CHIP_ROW_FADE}` : 'black 0';
  const to = fadeEnd ? `black calc(100% - ${CHIP_ROW_FADE}), transparent 100%` : 'black 100%';
  return `linear-gradient(to ${rtl ? 'left' : 'right'}, ${from}, ${to})`;
}

/** The row's live mask: re-measured on scroll, resize and chip changes. */
export function useChipRowFade(ref: RefObject<HTMLElement | null>): string {
  const [state, setState] = useState({ start: false, end: false, rtl: false });

  useEffect(() => {
    const row = ref.current;
    if (row === null) return;
    const measure = (): void => {
      const next = { ...chipRowEdges(row), rtl: getComputedStyle(row).direction === 'rtl' };
      setState((prev) =>
        prev.start === next.start && prev.end === next.end && prev.rtl === next.rtl ? prev : next,
      );
    };
    measure();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const observeAll = (): void => {
      if (resize === null) return;
      resize.disconnect();
      resize.observe(row);
      for (const child of Array.from(row.children)) resize.observe(child);
    };
    observeAll();
    const mutation =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            observeAll();
            measure();
          });
    mutation?.observe(row, { childList: true, subtree: true, characterData: true });
    row.addEventListener('scroll', measure, { passive: true });
    return () => {
      resize?.disconnect();
      mutation?.disconnect();
      row.removeEventListener('scroll', measure);
    };
  }, [ref]);

  return chipRowMask(state.start, state.end, state.rtl);
}
