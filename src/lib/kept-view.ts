// Kept views: a screen read this session paints its last view at once when the
// person comes back, then refreshes quietly (src/lib/session-read.ts keeps the
// rows). This module keeps the rest of the view, per screen key
// (`${userId}:${workspaceId}:view:<screen>`): the scroll position and the
// chosen chip, tab or filter. It lives in the session reads, so it is saved
// on the device and comes back on a cold open with them (src/lib/device-cache.ts),
// and signout, an account switch and losing the workspace clear it with them.
//
// A quiet refresh is applied only while the person has not touched, scrolled
// or typed on the screen since arriving (useUntouched). A refresh that lands
// later is not applied: sharedRead already kept it, so the next visit paints
// it. Content never moves under the person's finger.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
import { mark } from '@/lib/perf-marks';
import { peekKept, primeRead, readKey } from '@/lib/session-read';

/** The kept-view key of one screen part for a user and workspace. */
export function keptViewKey(userId: string, workspaceId: string, screen: string): string {
  return readKey(userId, workspaceId, `view:${screen}`);
}

/** Pure: the kept value for `key`, else `initial`. */
export function keptOr<T>(key: string | null, initial: T): T {
  if (key === null) return initial;
  const kept = peekKept<T>(key);
  return kept === undefined ? initial : kept;
}

/**
 * useState that keeps its value for the session under `key` (a chip, tab or
 * filter), so a return to the screen lands on the same choice. A null key
 * (no user or workspace yet) keeps nothing. A key change takes that key's
 * kept value, else `initial`.
 */
export function useKeptState<T>(
  key: string | null,
  initial: T,
): [T, (next: SetStateAction<T>) => void] {
  const [state, setState] = useState<{ key: string | null; value: T }>(() => ({
    key,
    value: keptOr(key, initial),
  }));
  const current = state.key === key ? state.value : keptOr(key, initial);
  if (state.key !== key) setState({ key, value: current });
  const latest = useRef(current);
  latest.current = current;
  const set = useCallback(
    (next: SetStateAction<T>) => {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(latest.current) : next;
      latest.current = value;
      if (key !== null) primeRead(key, value);
      setState({ key, value });
    },
    [key],
  );
  return [current, set];
}

// The input that counts as the person acting on the screen. A scroll by
// finger, wheel or key starts with one of these; a scroll the page makes
// itself (restoring a position) does not.
const TOUCH_EVENTS = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const;

/**
 * Whether the person has not touched, scrolled or typed since this screen
 * mounted (arrived). Call the returned function when a quiet refresh lands:
 * true means apply it, false means hold it for the next visit.
 */
export function useUntouched(): () => boolean {
  const touched = useRef(false);
  useEffect(() => {
    touched.current = false;
    const mark = (): void => {
      touched.current = true;
    };
    for (const name of TOUCH_EVENTS) {
      window.addEventListener(name, mark, { capture: true, passive: true });
    }
    return () => {
      for (const name of TOUCH_EVENTS) {
        window.removeEventListener(name, mark, { capture: true });
      }
    };
  }, []);
  return useCallback(() => !touched.current, []);
}

/** The shell's page scroller (AppLayout's main). */
function shellScroller(): HTMLElement | null {
  return document.querySelector('main');
}

/**
 * How long a kept scroll position waits for the page to grow tall enough to
 * hold it (covers, status lines and late rows landing under kept rows). Not a
 * paint wait: the page paints at once; only the catch-up stops here.
 */
export const SCROLL_CATCH_UP_MS = 1_500;

/** Pure: whether `el` sits at `top` (1px slack for fractional layout). */
export function atKeptTop(el: Pick<HTMLElement, 'scrollTop'>, top: number): boolean {
  return Math.abs(el.scrollTop - top) <= 1;
}

/**
 * Keep the screen's scroll position for the session under `key` and put it
 * back once `ready` (the kept rows are painted). Restores once per mount, in
 * a layout effect, so the first painted frame is already at the kept position.
 * `scroller` names the element that scrolls (default: the shell's main).
 *
 * When the page is not yet tall enough to hold the kept position (the browser
 * clamps the write), the target is held, not lost: every size change of the
 * scroller's content re-applies it before that frame paints (ResizeObserver
 * runs after layout, before paint), until it lands, the person touches, or
 * SCROLL_CATCH_UP_MS passes. A clamped position is never saved over the kept
 * one meanwhile.
 */
export function useKeptScroll(
  key: string | null,
  ready: boolean,
  scroller: () => HTMLElement | null = shellScroller,
): void {
  const restored = useRef(false);
  // The kept position still being caught up to, else null.
  const pending = useRef<number | null>(null);
  const getScroller = useRef(scroller);
  getScroller.current = scroller;

  useLayoutEffect(() => {
    if (key === null || !ready || restored.current) return;
    restored.current = true;
    const el = getScroller.current();
    const top = peekKept<number>(key);
    if (el === null || top === undefined || top <= 0) return;
    el.scrollTop = top;
    mark('kept-view:scroll-restore');
    if (atKeptTop(el, top) || typeof ResizeObserver === 'undefined') return;
    pending.current = top;
    const stop = (): void => {
      pending.current = null;
      observer.disconnect();
      window.clearTimeout(timer);
      for (const name of TOUCH_EVENTS) window.removeEventListener(name, stop, { capture: true });
    };
    const observer = new ResizeObserver(() => {
      if (pending.current === null) return;
      el.scrollTop = pending.current;
      if (atKeptTop(el, pending.current)) {
        mark('kept-view:scroll-caught-up');
        stop();
      }
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    const timer = window.setTimeout(stop, SCROLL_CATCH_UP_MS);
    for (const name of TOUCH_EVENTS) {
      window.addEventListener(name, stop, { capture: true, passive: true });
    }
    return stop;
  }, [key, ready]);

  useLayoutEffect(() => {
    if (key === null) return;
    const el = getScroller.current();
    if (el === null) return;
    const save = (): void => {
      if (restored.current && pending.current === null) primeRead(key, el.scrollTop);
    };
    el.addEventListener('scroll', save, { passive: true });
    return () => el.removeEventListener('scroll', save);
  }, [key]);
}
