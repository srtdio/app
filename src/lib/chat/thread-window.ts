/**
 * The chat thread's mounted window: which of the loaded messages are rendered
 * as rows (MessageThread's list). A chat opens on the latest STEP; reading up
 * mounts STEP older rows at a time (loaded rows first, then the older page the
 * thread already reads); at most MAX_MOUNTED rows are ever mounted, and the
 * rows farthest from the viewport are the ones let go. The window is kept by
 * message id, so older pages and live rows landing never move it. The math is
 * pure; useThreadWindow holds it for a component.
 */
import { useCallback, useRef, useState } from 'react';

/** The most message rows mounted at once. */
export const MAX_MOUNTED = 300;

/** How many rows open the chat, and how many each step up or down mounts. */
export const STEP = 50;

/** Mounted rows as indices into the loaded messages: [start, end). */
export interface ThreadWindow {
  start: number;
  end: number;
}

/**
 * The window's edges by id. A null start is the first loaded row (an older
 * page that lands is inside the window); a null end is the newest (live rows
 * land inside it). An id edge stays on its message as rows arrive around it.
 */
export interface WindowKeys {
  startId: string | null;
  endId: string | null;
}

/** The latest STEP rows (the open window, and Scroll to latest). Pure. */
export function latestWindow(total: number): ThreadWindow {
  return { start: Math.max(0, total - STEP), end: total };
}

/** A window as edge ids over `ids` (an edge at either end follows that end). Pure. */
export function keysFor(ids: readonly string[], win: ThreadWindow): WindowKeys {
  return {
    startId: win.start <= 0 ? null : (ids[win.start] ?? null),
    endId: win.end >= ids.length ? null : (ids[win.end - 1] ?? null),
  };
}

/**
 * The window over the current ids. An edge whose message is gone (discarded,
 * or a list read afresh) falls back: the end to the newest, the start to STEP
 * rows above the end. Pure.
 */
export function resolveWindow(ids: readonly string[], keys: WindowKeys): ThreadWindow {
  const total = ids.length;
  let end = total;
  if (keys.endId !== null) {
    const at = ids.indexOf(keys.endId);
    end = at >= 0 ? at + 1 : total;
  }
  let start = 0;
  if (keys.startId !== null) {
    const at = ids.indexOf(keys.startId);
    start = at >= 0 ? at : Math.max(0, end - STEP);
  }
  if (start >= end) start = Math.max(0, end - STEP);
  return { start, end };
}

/** Whether the window holds the newest loaded row. Pure. */
export function isLive(win: ThreadWindow, total: number): boolean {
  return win.end >= total;
}

/** Whether a loaded index is mounted. Pure. */
export function isMounted(win: ThreadWindow, index: number): boolean {
  return index >= win.start && index < win.end;
}

/** STEP more loaded rows above (none past the first loaded row). Pure. */
export function extendUp(win: ThreadWindow): ThreadWindow {
  if (win.start <= 0) return win;
  return { start: Math.max(0, win.start - STEP), end: win.end };
}

/** STEP more loaded rows below (none past the newest). Pure. */
export function extendDown(win: ThreadWindow, total: number): ThreadWindow {
  if (win.end >= total) return win;
  return { start: win.start, end: Math.min(total, win.end + STEP) };
}

/** A jump to a loaded row outside the window: STEP rows each side of it. Pure. */
export function centreOn(total: number, index: number): ThreadWindow {
  const at = Math.min(Math.max(0, index), Math.max(0, total - 1));
  return { start: Math.max(0, at - STEP), end: Math.min(total, at + STEP + 1) };
}

/**
 * Back to at most `max` rows: the excess goes from the side with more rows
 * past the reader's row (`visible`, a loaded index), so a reader paging up
 * loses rows at the bottom and one reading down (or pinned to the newest)
 * loses them at the top. The reader's row always stays mounted. Pure.
 */
export function trimWindow(
  win: ThreadWindow,
  visible: number,
  max: number = MAX_MOUNTED,
): ThreadWindow {
  const size = win.end - win.start;
  if (size <= max) return win;
  const at = Math.min(Math.max(visible, win.start), win.end - 1);
  const above = at - win.start;
  const below = win.end - at - 1;
  let excess = size - max;
  let start = win.start;
  let end = win.end;
  if (above >= below) {
    const cut = Math.min(excess, above);
    start += cut;
    excess -= cut;
    end -= excess;
  } else {
    const cut = Math.min(excess, below);
    end -= cut;
    excess -= cut;
    start += excess;
  }
  return { start, end };
}

/**
 * What a scroll near an edge of the window does: mount STEP more loaded rows
 * that way, within a viewport (at least `edgePx`) of it. 'up' only while
 * loaded rows sit above the window (the first loaded row's own edge is the
 * older page's); 'down' only while the newest is not mounted; else 'none'. Pure.
 */
export function windowEdge(input: {
  win: ThreadWindow;
  total: number;
  scrollTop: number;
  distanceFromBottom: number;
  viewport: number;
  edgePx: number;
}): 'up' | 'down' | 'none' {
  const margin = Math.max(input.edgePx, input.viewport);
  if (input.win.start > 0 && input.scrollTop <= margin) return 'up';
  if (input.win.end < input.total && input.distanceFromBottom <= margin) return 'down';
  return 'none';
}

/**
 * The window's rows from a grouping run over the window plus one loaded
 * message each side (so the edge rows keep their true head, tail and day
 * pill): drops the lead message and everything above it, and the trail
 * message with the pills and lines that sit just above it. Pure.
 */
export function cropToWindow<R>(
  rows: readonly R[],
  idOf: (row: R) => string | null,
  leadId: string | null,
  trailId: string | null,
): R[] {
  let from = 0;
  if (leadId !== null) {
    const at = rows.findIndex((row) => idOf(row) === leadId);
    if (at >= 0) from = at + 1;
  }
  let to = rows.length;
  if (trailId !== null) {
    const at = rows.findIndex((row) => idOf(row) === trailId);
    if (at >= 0) {
      let last = at - 1;
      while (last >= from) {
        const row = rows[last];
        if (row !== undefined && idOf(row) !== null) break;
        last -= 1;
      }
      to = last + 1;
    }
  }
  return rows.slice(from, Math.max(from, to));
}

/** Two prop values the same for a memoised row: identical, or plain objects/arrays of the same. */
export function samePropValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => samePropValue(v, b[i]));
  }
  if (
    Object.getPrototypeOf(a) !== Object.prototype ||
    Object.getPrototypeOf(b) !== Object.prototype
  )
    return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every(
    (k) => Object.prototype.hasOwnProperty.call(rb, k) && samePropValue(ra[k], rb[k]),
  );
}

/**
 * A per-row value cache: hands back the value it gave last time for that key
 * while the new one is the same (samePropValue), so a row's object props keep
 * their identity across renders and its memo holds.
 */
export function createStableCache<T>(): (key: string, value: T) => T {
  const last = new Map<string, T>();
  return (key, value) => {
    const prev = last.get(key);
    if (prev !== undefined && samePropValue(prev, value)) return prev;
    last.set(key, value);
    return value;
  };
}

/** One stable no-argument callback per id, each calling `call(id)` (read at call time). */
export function createIdCallbacks(call: (id: string) => void): (id: string) => () => void {
  const made = new Map<string, () => void>();
  return (id) => {
    let fn = made.get(id);
    if (fn === undefined) {
      fn = () => call(id);
      made.set(id, fn);
    }
    return fn;
  };
}

/** A callback whose identity never changes and which always runs the latest `fn`. */
export function useStableCallback<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * The same for an optional callback: undefined while `fn` is (an absent
 * callback hides its control), else one stable function running the latest.
 */
export function useOptionalCallback<A extends unknown[]>(
  fn: ((...args: A) => void) | undefined,
): ((...args: A) => void) | undefined {
  const ref = useRef(fn);
  ref.current = fn;
  const stable = useCallback((...args: A): void => {
    ref.current?.(...args);
  }, []);
  return fn === undefined ? undefined : stable;
}

/**
 * The window over `ids` (the loaded messages, oldest first). It starts on the
 * latest STEP once rows exist; `set` moves it, kept by id from then on.
 */
export function useThreadWindow(ids: readonly string[]): {
  win: ThreadWindow;
  set: (next: ThreadWindow) => void;
} {
  const [keys, setKeys] = useState<WindowKeys | null>(null);
  let current = keys;
  if (current === null && ids.length > 0) {
    // The first rows: fix the open window now (a render-time update, so no
    // frame ever shows another window).
    current = keysFor(ids, latestWindow(ids.length));
    setKeys(current);
  }
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const set = useCallback((next: ThreadWindow) => setKeys(keysFor(idsRef.current, next)), []);
  const win = current === null ? { start: 0, end: 0 } : resolveWindow(ids, current);
  return { win, set };
}
