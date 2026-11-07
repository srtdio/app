// Overlay helpers for the motion module (G3: sheets, menus, lightboxes).
// Re-export from index.ts once reviewed. Nothing here animates by itself: it
// only remembers where the last press happened, so a menu can grow from the
// cursor and a lightbox can grow from the thumbnail that opened it, without
// any caller passing a rect. One passive capture listener, no reads on a paint
// or tap path beyond one getBoundingClientRect at open.
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { growFromCard, type Box } from './moves';
import { trackDim } from './react';
import type { Played } from './run';

/** A press older than this is not the one that opened the overlay. */
const PRESS_MEMORY_MS = 800;

interface Press {
  x: number;
  y: number;
  at: number;
  target: Element | null;
  right: boolean;
}

let lastPress: Press | null = null;
let installed = false;

function remember(event: MouseEvent, right: boolean): void {
  lastPress = {
    x: event.clientX,
    y: event.clientY,
    at: Date.now(),
    target: event.target instanceof Element ? event.target : null,
    right,
  };
}

/** Install once (idempotent). Called at import and again by every reader. */
export function watchPresses(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerdown', (event) => remember(event, event.button === 2), {
    capture: true,
    passive: true,
  });
  document.addEventListener('contextmenu', (event) => remember(event, true), {
    capture: true,
    passive: true,
  });
}

watchPresses();

function fresh(): Press | null {
  if (lastPress === null || Date.now() - lastPress.at > PRESS_MEMORY_MS) return null;
  return lastPress;
}

/** The cursor point of a right-click (or long-press contextmenu) that just happened, or null. */
export function recentRightClick(): { x: number; y: number } | null {
  const press = fresh();
  return press !== null && press.right ? { x: press.x, y: press.y } : null;
}

const THUMB =
  'img, video, picture, canvas, [data-thumb], [data-thumbnail], button, a, [role="button"]';

/**
 * The box of the thumbnail (or tile) the last press landed on, viewport px,
 * or null when there was no recent press or it hit nothing measurable.
 */
export function recentPressBox(): Box | null {
  const press = fresh();
  if (press === null || press.target === null || !press.target.isConnected) return null;
  const el = press.target.closest(THUMB) ?? press.target;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Test seam: forget the last press. */
export function resetPressesForTests(): void {
  lastPress = null;
}

/** Layout effect in the browser; a plain effect where there is no DOM (server render, node tests). */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The element a media viewer grows on open: only the media itself, never the
 * viewer's root, pane or bars. `target` picks it inside `root`; no target, or
 * a target that finds nothing (the image has not mounted yet, a spinner or an
 * error card shows), is null: the viewer simply shows, with no move. Growing
 * the whole viewer from a thumbnail box once left the full viewer, its arrows
 * and bars, sitting at the bubble's size inside the thread. Pure.
 */
export function growTarget<T extends Element>(
  root: T | null,
  target: ((root: T) => Element | null) | undefined,
): Element | null {
  if (root === null || target === undefined) return null;
  const el = target(root);
  return el !== null && el !== root ? el : null;
}

/**
 * growFromCard for a media viewer: on the first frame after mount (the viewer
 * already painted at its final place), the media grows out of `from` (the
 * opener's rect when it has one), else out of the thumbnail the last press hit.
 * No box or no media element (growTarget): no move, the viewer simply shows.
 * The move runs with fill none (its end pose is the element's own), and is
 * cancelled on unmount, so nothing can stay at the thumbnail's transform.
 */
export function useGrowFromThumb<T extends HTMLElement>(
  ref: RefObject<T>,
  from?: Box | null,
  target?: (root: T) => Element | null,
): void {
  const args = useRef({ from, target });
  args.current = { from, target };
  useBrowserLayoutEffect(() => {
    const el = growTarget(ref.current, args.current.target);
    if (el === null) return;
    const box = args.current.from ?? recentPressBox();
    if (box === null) return;
    const played = growFromCard(el, box);
    return () => played.cancel();
    // Mount only: the ref and args are read at that moment.
  }, []);
}

/**
 * The backdrop dim follows `panel` for as long as `played` runs (trackDim), so
 * it is never a timed fade of its own. Instant (motion off): the dim simply
 * rests at full. Returns `played` for chaining.
 */
export function dimWith(
  panel: HTMLElement | null,
  dim: HTMLElement | null,
  played: Played,
): Played {
  if (played.instant) {
    if (dim !== null) dim.style.opacity = '';
    return played;
  }
  trackDim(panel, dim, played);
  return played;
}
