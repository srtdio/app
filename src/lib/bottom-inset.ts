import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

/**
 * The one marker for a fixed or sticky bottom bar (the tab bar, the chat
 * composer, the decision bar, a sheet footer). Anything else fixed to the
 * bottom (the Undo strip, a selection bar) reads the shared inset below and
 * sits above every marked bar, so no bar covers the tab bar or another bar.
 */
export const BOTTOM_ANCHOR_ATTR = 'data-undo-anchor';

/** Spread on a bottom bar so floating elements stack above it. */
export const bottomAnchorProps = { [BOTTOM_ANCHOR_ATTR]: '' } as const;

/**
 * Pixels from the viewport bottom to the top of the highest visible marked
 * bar, 0 when none. `exclude` (the caller's own element, or one it contains)
 * is skipped so a marked bar never stacks above itself. Pure DOM read.
 */
export function measureBottomInset(exclude?: Element | null): number {
  if (typeof document === 'undefined') return 0;
  let top = Number.POSITIVE_INFINITY;
  for (const el of document.querySelectorAll(`[${BOTTOM_ANCHOR_ATTR}]`)) {
    if (exclude != null && (el === exclude || exclude.contains(el) || el.contains(exclude))) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.height > 0 && rect.width > 0) top = Math.min(top, rect.top);
  }
  if (!Number.isFinite(top)) return 0;
  return Math.max(0, window.innerHeight - top);
}

/**
 * The shared bottom inset, kept current on resize and whenever a marked bar
 * mounts, unmounts or changes size. Use it as the `bottom` of a fixed element.
 */
export function useBottomInset(self?: RefObject<Element | null>): number {
  const [inset, setInset] = useState(0);

  const measure = useCallback((): void => {
    setInset(measureBottomInset(self?.current ?? null));
  }, [self]);

  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(measure) : null;
    observer?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [BOTTOM_ANCHOR_ATTR, 'class', 'style'],
    });
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [measure]);

  return inset;
}
