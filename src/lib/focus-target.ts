// The one way a link that points at a comment lands on it (Activity, toast,
// email, search): wait for the row to be in the DOM, centre it in its own
// scroller (scroll-margin on the row keeps it clear of sticky bars), tint it
// with the search glow (it wipes away left to right, wipeAway; never fades), and
// keep it centred while the screen settles: rows that load above it, images
// that take their size, a page that grows. The settle watch stops at
// FOCUS_SETTLE_MS or the moment the person touches, scrolls or types, so it
// never fights a finger. A target that never shows up calls onMissing once.
//
// Keyed by the target id (or targetKey when given): every new key runs again,
// so a second tap on the same comment lands again when the caller passes a
// fresh key; the same key twice in one mount never does. Nothing here depends
// on data arrival order or on a slide transition ending: a MutationObserver
// watches for the row for up to 8s.

import { useEffect, useRef } from 'react';
import { tintTarget } from '@/components/ui/SearchHighlight';
import { REASON_COPY } from '@/lib/error-copy';
import { prefersReducedMotion } from '@/lib/use-is-laptop';

/** How long a target may take to render before it counts as missing. */
export const FOCUS_WAIT_MS = 8000;

/**
 * After arrival: the row is kept centred through layout shifts (content
 * loading above it, images settling) for this long, then the watch stops.
 * Ceiling 2500ms; it never delays a paint, it only re-scrolls.
 */
export const FOCUS_SETTLE_MS = 2500;

/** How long the smooth landing scroll is given before its resting place is taken. */
const LANDING_SCROLL_MS = 450;

/** Changes landing within this beat (one frame) share one position check. */
const CHECK_BEAT_MS = 16;

/** A drift smaller than this (px) is not worth a re-scroll. */
const DRIFT_PX = 2;

/** Input that hands the scroll back to the person: the settle watch stops on it. */
const USER_INPUT = ['pointerdown', 'wheel', 'touchstart', 'keydown'] as const;

/** The one toast when a linked comment cannot be shown. */
export const FOCUS_MISSING_COPY = "Couldn't open that comment. It was deleted or you can't see it.";

/** The toast when the linked comment could not be read (the read failed twice). */
export const FOCUS_FAILED_COPY = `Couldn't open that comment. ${REASON_COPY.unknown}`;

/** A failed read of the linked comment is retried once, after this long. */
export const FOCUS_READ_RETRY_MS = 1200;

export interface FocusTargetOptions {
  /** The id to land on; null or empty waits for one. */
  targetId: string | null | undefined;
  /**
   * What makes a landing new (default: the id). A caller passes a fresh key
   * per link (e.g. per tap) so the same comment linked twice lands twice.
   */
  targetKey?: string | null;
  /** The rendered row for an id, or null while it is not in the DOM. */
  findElement: (id: string) => HTMLElement | null;
  /** The scroller to centre in; default the row's nearest scrollable ancestor. */
  scrollContainer?: () => HTMLElement | null;
  /** The target is known gone (deleted, not visible): give up now, not at the timeout. */
  absent?: boolean;
  /** Called once per id when the row never renders (or is absent). */
  onMissing: (id: string) => void;
  /** The arrival tint; returns its cleanup. Default: the search glow (tintTarget, wipeAway). */
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

/** The row's offset from the top of its scroller's view (px). */
function offsetInView(el: HTMLElement, container: HTMLElement | null): number {
  const top = container !== null ? container.getBoundingClientRect().top : 0;
  return el.getBoundingClientRect().top - top;
}

/**
 * Land on a target row: centre, tint, then keep it where it landed while the
 * screen settles (rows loading above it, images taking their size) for
 * FOCUS_SETTLE_MS, until the person touches, scrolls or types. A drift is
 * read from the row's own position, so a shift is caught whether or not the
 * scroller changes size. Returns the cleanup (observers, listeners, timer, tint).
 */
function arrive(
  el: HTMLElement,
  initialContainer: HTMLElement | null,
  highlight: (el: HTMLElement) => () => void,
): () => void {
  let container = initialContainer;
  centre(el, container, !prefersReducedMotion());
  const untint = highlight(el);
  let mutations: MutationObserver | null = null;
  let sizes: ResizeObserver | null = null;
  let stopTimer: number | null = null;
  let anchorTimer: number | null = null;
  let frame: number | null = null;
  // Where the row should sit once the first (possibly smooth) scroll ends.
  let anchor: number | null = null;
  const stop = (): void => {
    mutations?.disconnect();
    mutations = null;
    sizes?.disconnect();
    sizes = null;
    if (stopTimer !== null) window.clearTimeout(stopTimer);
    stopTimer = null;
    if (anchorTimer !== null) window.clearTimeout(anchorTimer);
    anchorTimer = null;
    if (frame !== null) window.clearTimeout(frame);
    frame = null;
    for (const type of USER_INPUT) window.removeEventListener(type, stop, true);
  };
  const check = (): void => {
    frame = null;
    if (!el.isConnected) {
      stop();
      return;
    }
    // A scroller that only became scrollable once rows loaded: use it now.
    if (container === null || !container.isConnected) container = scrollParent(el);
    if (anchor === null) {
      centre(el, container, false);
      anchor = offsetInView(el, container);
      return;
    }
    if (Math.abs(offsetInView(el, container) - anchor) > DRIFT_PX) {
      centre(el, container, false);
      anchor = offsetInView(el, container);
    }
  };
  const schedule = (): void => {
    // One check per frame-sized beat, however many changes land in it.
    if (frame === null) frame = window.setTimeout(check, CHECK_BEAT_MS);
  };
  for (const type of USER_INPUT) {
    window.addEventListener(type, stop, { capture: true, passive: true });
  }
  if (typeof MutationObserver !== 'undefined') {
    mutations = new MutationObserver(schedule);
    mutations.observe(container ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'src'],
    });
  }
  if (typeof ResizeObserver !== 'undefined') {
    sizes = new ResizeObserver(schedule);
    sizes.observe(container ?? document.body);
    sizes.observe(el);
  }
  // The anchor is taken once the landing scroll has had time to finish.
  anchorTimer = window.setTimeout(schedule, prefersReducedMotion() ? 0 : LANDING_SCROLL_MS);
  stopTimer = window.setTimeout(stop, FOCUS_SETTLE_MS);
  return () => {
    stop();
    untint();
  };
}

/**
 * The current history entry's router state (react-router keeps it under usr):
 * a caller that strips ?comment= in place passes it back so the entry keeps
 * what came with it (a post card's ref id). Pure read of window.history.
 */
export function currentEntryState(): unknown {
  const state: unknown = window.history.state;
  if (typeof state !== 'object' || state === null) return undefined;
  return (state as Record<string, unknown>).usr;
}

/** Scroll to, and tint, the row a link points at; see the file header. */
export function useFocusTarget(options: FocusTargetOptions): void {
  const { targetId, absent = false } = options;
  const runKey =
    targetId === null || targetId === undefined || targetId === ''
      ? null
      : (options.targetKey ?? targetId);
  const latest = useRef(options);
  latest.current = options;
  // The last id that landed or was reported missing: never run twice.
  const handled = useRef<string | null>(null);
  // The landed target's tint and re-centre watch, kept past effect re-runs.
  const arrival = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (runKey === null || targetId === null || targetId === undefined) return;
    if (handled.current === runKey) return;
    const id = targetId;
    const key = runKey;
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
      handled.current = key;
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
  }, [targetId, runKey, absent]);

  useEffect(
    () => () => {
      arrival.current?.();
      arrival.current = null;
    },
    [],
  );
}
