// Kept views: a screen read this session paints its last view at once when the
// person comes back, then refreshes quietly (src/lib/session-read.ts keeps the
// rows). This module keeps the rest of the view in memory only, per screen key
// (`${userId}:${workspaceId}:view:<screen>`): the scroll position and the
// chosen chip, tab or filter. It lives in the session reads, so signout and
// losing the workspace clear it with them.
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
 * Keep the screen's scroll position for the session under `key` and put it
 * back once `ready` (the kept rows are painted). Restores once per mount.
 * `scroller` names the element that scrolls (default: the shell's main).
 */
export function useKeptScroll(
  key: string | null,
  ready: boolean,
  scroller: () => HTMLElement | null = shellScroller,
): void {
  const restored = useRef(false);
  const getScroller = useRef(scroller);
  getScroller.current = scroller;

  useLayoutEffect(() => {
    if (key === null || !ready || restored.current) return;
    restored.current = true;
    const el = getScroller.current();
    const top = peekKept<number>(key);
    if (el !== null && top !== undefined && top > 0) el.scrollTop = top;
  }, [key, ready]);

  useLayoutEffect(() => {
    if (key === null) return;
    const el = getScroller.current();
    if (el === null) return;
    const save = (): void => {
      if (restored.current) primeRead(key, el.scrollTop);
    };
    el.addEventListener('scroll', save, { passive: true });
    return () => el.removeEventListener('scroll', save);
  }, [key]);
}
