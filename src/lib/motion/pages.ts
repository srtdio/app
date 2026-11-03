// growFromCard wiring for pages (move 2, docs/motion.md). A list card calls
// rememberCard in its tap handler; the detail page grows out of that rect on
// mount; the page's own Back remembers the page rect so the card grows back
// into its place when the list paints again. Kept on laptop.
//
// Never on a paint gate: every hook here is a layout effect on an element that
// is already rendered at its final state, with no await. Never on a kept-view
// tab return: takeCard/takePage are consumed once and expire after 4 s, and a
// page remembers its rect only from its own Back (never on unmount), so a tab
// switch away and back finds nothing to grow from.
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { growBackIntoCard, growFromCard } from './moves';
import { rememberPage, takeCard, takePage } from './react';

/** The surface that grows: the app's route container (<main>), else the element itself. */
export function pageSurface(el: Element | null): Element | null {
  if (el === null) return null;
  return el.closest('main') ?? el;
}

/**
 * On mount (and on a new key), when the card for `key` was just tapped, grow
 * the page out of it. `anchor` is any element of the page; the route container
 * around it is what grows. Pass enabled=false where the page is embedded.
 */
export function useGrowFromCard(
  key: string | null | undefined,
  anchor: RefObject<Element>,
  enabled = true,
): void {
  useLayoutEffect(() => {
    if (!enabled || key === null || key === undefined) return;
    const box = takeCard(key);
    if (box === null) return;
    growFromCard(pageSurface(anchor.current), box);
    // Mount and key change only: the move belongs to the tap that opened the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Call from the page's own Back, before navigating: the card grows back from here. */
export function leaveIntoCard(key: string | null | undefined, anchor: Element | null): void {
  if (key === null || key === undefined) return;
  rememberPage(key, pageSurface(anchor));
}

/**
 * A list card: on mount, when its page just closed through Back, grow back
 * from the page rect into the card. Returns the ref for the card's root.
 */
export function useGrowBackIntoCard<T extends Element>(key: string): RefObject<T> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const page = takePage(key);
    if (page === null) return;
    growBackIntoCard(ref.current, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return ref;
}
