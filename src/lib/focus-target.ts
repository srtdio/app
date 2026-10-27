// The one way a link that points at a comment lands on it (Activity, toast,
// email, search): wait for the row to be in the DOM, centre it in its own
// scroller (scroll-margin on the row keeps it clear of sticky bars), tint it
// with the search glow, and re-centre once if the layout shifts while images
// settle. A target that never shows up calls onMissing once.
//
// Keyed by the target id: every new id runs again, the same id twice in one
// mount never does. Nothing here depends on data arrival order or on a slide
// transition ending: a MutationObserver watches for the row for up to 8s.

import { useEffect, useRef } from 'react';
import { tintTarget } from '@/components/ui/SearchHighlight';
import { prefersReducedMotion } from '@/lib/use-is-laptop';

/** How long a target may take to render before it counts as missing. */
export const FOCUS_WAIT_MS = 8000;

/** After arrival: one re-centre on a layout shift inside this window, then stop. */
export const FOCUS_RECENTRE_MS = 1500;

/** The one toast when a linked comment cannot be shown. */
export const FOCUS_MISSING_COPY = "Couldn't open that comment. It was deleted or you can't see it.";

export interface FocusTargetOptions {
  /** The id to land on; null or empty waits for one. */
  targetId: string | null | undefined;
  /** The rendered row for an id, or null while it is not in the DOM. */
  findElement: (id: string) => HTMLElement | null;
  /** The scroller to centre in; default the row's nearest scrollable ancestor. */
  scrollContainer?: () => HTMLElement | null;
  /** The target is known gone (deleted, not visible): give up now, not at the timeout. */
  absent?: boolean;
  /** Called once per id when the row never renders (or is absent). */
  onMissing: (id: string) => void;
  /** The arrival tint; returns its cleanup. Default: the search glow. */
  highlight?: (el: HTMLElement) => () => void;
}

const SCROLLABLE = /(auto|scroll|overlay)/;

/** The nearest ancestor that scrolls vertically; null for the page itself. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) return null;
    const scrolls = SCROLLABLE.test(getComputedStyle(node).overflowY);
    if (scrolls && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** The scroll offset that centres `el` in its scroller, inside its scroll margins. Pure. */
export function centredTop(args: {
  scrollTop: number;
  viewTop: number;
  viewHeight: number;
  elTop: number;
  elHeight: number;
  marginTop: number;
  marginBottom: number;
}): number {
  const room = args.viewHeight - args.marginTop - args.marginBottom;
  const offset = args.elTop - args.viewTop - args.marginTop - (room - args.elHeight) / 2;
  return Math.max(0, Math.round(args.scrollTop + offset));
}

function centre(el: HTMLElement, container: HTMLElement | null, smooth: boolean): void {
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const page = { top: 0, height: window.innerHeight };
  const view = container !== null ? container.getBoundingClientRect() : page;
  const top = centredTop({
    scrollTop: container !== null ? container.scrollTop : window.scrollY,
    viewTop: view.top,
    viewHeight: view.height,
    elTop: rect.top,
    elHeight: rect.height,
    marginTop: parseFloat(style.scrollMarginTop) || 0,
    marginBottom: parseFloat(style.scrollMarginBottom) || 0,
  });
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  if (container !== null) container.scrollTo?.({ top, behavior });
  else window.scrollTo?.({ top, behavior });
}

/**
 * Land on a target row: centre, tint, one re-centre on a layout shift within
 * FOCUS_RECENTRE_MS. Returns the cleanup (observer, timer, tint).
 */
function arrive(
  el: HTMLElement,
  container: HTMLElement | null,
  highlight: (el: HTMLElement) => () => void,
): () => void {
  centre(el, container, !prefersReducedMotion());
  const untint = highlight(el);
  let observer: ResizeObserver | null = null;
  let stopTimer: number | null = null;
  const stop = (): void => {
    observer?.disconnect();
    observer = null;
    if (stopTimer !== null) window.clearTimeout(stopTimer);
    stopTimer = null;
  };
  if (typeof ResizeObserver !== 'undefined') {
    let first = true;
    observer = new ResizeObserver(() => {
      // Observing reports the current size once: that is not a shift.
      if (first) {
        first = false;
        return;
      }
      stop();
      if (el.isConnected) centre(el, container, false);
    });
    observer.observe(container ?? document.body);
    stopTimer = window.setTimeout(stop, FOCUS_RECENTRE_MS);
  }
  return () => {
    stop();
    untint();
  };
}

/** Scroll to, and tint, the row a link points at; see the file header. */
export function useFocusTarget(options: FocusTargetOptions): void {
  const { targetId, absent = false } = options;
  const latest = useRef(options);
  latest.current = options;
  // The last id that landed or was reported missing: never run twice.
  const handled = useRef<string | null>(null);
  // The landed target's tint and re-centre watch, kept past effect re-runs.
  const arrival = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (targetId === null || targetId === undefined || targetId === '') return;
    if (handled.current === targetId) return;
    const id = targetId;
    // A new id: the previous target's tint and watch end now.
    arrival.current?.();
    arrival.current = null;

    let observer: MutationObserver | null = null;
    let timer: number | null = null;
    const stopWaiting = (): void => {
      observer?.disconnect();
      observer = null;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const settle = (): void => {
      handled.current = id;
      stopWaiting();
    };
    const missing = (): void => {
      settle();
      latest.current.onMissing(id);
    };
    const find = (): boolean => {
      const el = latest.current.findElement(id);
      if (el === null) return false;
      settle();
      const opts = latest.current;
      const container = opts.scrollContainer?.() ?? scrollParent(el);
      arrival.current = arrive(el, container, opts.highlight ?? tintTarget);
      return true;
    };

    if (find()) return stopWaiting;
    if (absent) {
      missing();
      return stopWaiting;
    }
    observer = new MutationObserver(() => {
      find();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timer = window.setTimeout(missing, FOCUS_WAIT_MS);
    return stopWaiting;
  }, [targetId, absent]);

  useEffect(
    () => () => {
      arrival.current?.();
      arrival.current = null;
    },
    [],
  );
}
