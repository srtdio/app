// How far the on-screen keyboard covers the bottom of the layout viewport, in
// px (0 with no on-screen keyboard: laptop, iPad with a hardware keyboard).
// Read from visualViewport: inset = innerHeight - vv.height - vv.offsetTop.
// Listeners are added only while `active` (the format strip is open) and are
// removed in the same hook, so a closed strip costs nothing on any paint path.
// Read-only: src/lib/viewport-lock.ts keeps owning the keyboard-gap repair.

import { useEffect, useState } from 'react';

/** The keyboard inset for a window and its visualViewport. Pure; never negative. */
export function keyboardInset(
  innerHeight: number,
  vv: { height: number; offsetTop: number } | null | undefined,
): number {
  if (vv === null || vv === undefined) return 0;
  const inset = Math.round(innerHeight - vv.height - vv.offsetTop);
  // Sub-pixel and browser-bar jitter is not a keyboard.
  return inset > 40 ? inset : 0;
}

function read(): number {
  if (typeof window === 'undefined') return 0;
  return keyboardInset(window.innerHeight, window.visualViewport);
}

/** The live keyboard inset while `active`; 0 while inactive. */
export function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState<number>(() => (active ? read() : 0));
  useEffect(() => {
    if (!active) {
      setInset(0);
      return undefined;
    }
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    const update = (): void => setInset(read());
    update();
    if (vv === null || vv === undefined) return undefined;
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return inset;
}
