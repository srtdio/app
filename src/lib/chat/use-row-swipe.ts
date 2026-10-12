// Plan rows (agency side): swipe left to reveal Remove, the delayed remove
// with Undo, and the one-time peek that teaches the swipe. Framework-free
// cores (unit-tested in node); the Plan screen wires them to its rows, its
// toast and plan_item_remove. Motion: translateX on the row content only.

import { useRef } from 'react';

/** Movement (px) that decides the axis; the long-press cancels at the same distance. */
export const ROW_SWIPE_LOCK_PX = 10;
/** The red Remove action's width (px); the row opens to exactly this. */
export const ROW_ACTION_PX = 88;
/** How far the one-time peek slides the first row (px). */
export const ROW_PEEK_PX = 72;
/** The peek starts this long after the list first paints (ms)... */
export const ROW_PEEK_DELAY_MS = 600;
/** ...holds open this long (ms)... */
export const ROW_PEEK_HOLD_MS = 500;
/** ...and each slide takes this long (ms), the --dur-slow token. */
export const ROW_PEEK_SLIDE_MS = 200;
/** This device has seen the peek (or the reduced-motion tip). */
export const PLAN_SWIPE_PEEK_KEY = 'sorted:plan-swipe-peek-seen';

/** What a press has become: still deciding, a row swipe, or not ours (a scroll). */
export type SwipeAxis = 'pending' | 'swipe' | 'none';

/**
 * The axis lock: under ROW_SWIPE_LOCK_PX of travel the press is pending.
 * Mostly vertical is the list's scroll. Mostly horizontal and leftward is a
 * swipe; rightward only on an open row (it closes it). Pure.
 */
export function lockAxis(dx: number, dy: number, open: boolean): SwipeAxis {
  if (dx * dx + dy * dy <= ROW_SWIPE_LOCK_PX * ROW_SWIPE_LOCK_PX) return 'pending';
  if (Math.abs(dx) <= Math.abs(dy)) return 'none';
  return dx < 0 || open ? 'swipe' : 'none';
}

/** The row's translateX for a travel from where it started: 1:1, never past the action, never right. Pure. */
export function rowSwipeOffset(base: number, dx: number): number {
  return Math.min(0, Math.max(-ROW_ACTION_PX, base + dx));
}

/** A release past half the action's width stays open; anything less springs back. Pure. */
export function rowSwipeSettlesOpen(offset: number): boolean {
  return -offset > ROW_ACTION_PX / 2;
}

/** Only the agency side swipes, and never a row the viewer sees by name only. Pure. */
export function rowSwipeEnabled(side: string, locked: boolean): boolean {
  return side === 'agency' && !locked;
}

/** One open row: a swipe starting on `id` closes any other open row. Pure. */
export function openRowOnStart(prev: string | null, id: string): string | null {
  return prev === id ? prev : null;
}

/** One open row: `id` came to rest open (it is the one) or closed. Pure. */
export function openRowOnSettle(prev: string | null, id: string, open: boolean): string | null {
  if (open) return id;
  return prev === id ? null : prev;
}

/** The pointer fields the controller reads; React's PointerEvent satisfies it. */
export interface RowSwipeSample {
  clientX: number;
  clientY: number;
  pointerId?: number;
}

export interface RowSwipeOptions {
  /** The row is open (the press starts from -ROW_ACTION_PX). */
  isOpen: () => boolean;
  /** False ignores presses (a drag is running, the row is not swipeable). */
  enabled?: () => boolean;
  /** The swipe locked in: cancel the long-press, capture the pointer, close other rows. */
  onStart: (pointerId: number | undefined) => void;
  /** The finger moved the row (translateX, px). */
  onDrag: (offset: number) => void;
  /** The release: the row rests open or closed. */
  onSettle: (open: boolean) => void;
}

export interface RowSwipeController {
  handlers: {
    onPointerDown: (event: RowSwipeSample) => void;
    onPointerMove: (event: RowSwipeSample) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** True (once) when the click is the tail of a swipe and must be ignored. */
  consumeClickSuppression: () => boolean;
  /** True while a swipe owns the pointer. */
  swiping: () => boolean;
  /** Drop the press (a long-press fired): a running swipe springs back to where it was. */
  cancel: () => void;
}

/**
 * The row swipe: a press is pending until it travels ROW_SWIPE_LOCK_PX, then
 * the axis locks once (lockAxis). A vertical press is left to the native
 * scroll for the rest of the gesture; a swipe follows the finger and settles
 * open or closed on release. A tap never moves the row.
 */
export function createRowSwipeController(opts: RowSwipeOptions): RowSwipeController {
  let phase: 'idle' | 'pending' | 'swiping' | 'released' = 'idle';
  let startX = 0;
  let startY = 0;
  let base = 0;
  let offset = 0;
  let suppressClick = false;
  const enabled = opts.enabled ?? (() => true);

  return {
    handlers: {
      onPointerDown(event) {
        suppressClick = false;
        if (!enabled()) {
          phase = 'idle';
          return;
        }
        phase = 'pending';
        startX = event.clientX;
        startY = event.clientY;
        base = opts.isOpen() ? -ROW_ACTION_PX : 0;
        offset = base;
      },
      onPointerMove(event) {
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (phase === 'pending') {
          const axis = lockAxis(dx, dy, base !== 0);
          if (axis === 'pending') return;
          if (axis === 'none') {
            phase = 'released';
            return;
          }
          phase = 'swiping';
          suppressClick = true;
          opts.onStart(event.pointerId);
        }
        if (phase !== 'swiping') return;
        offset = rowSwipeOffset(base, dx);
        opts.onDrag(offset);
      },
      onPointerUp() {
        if (phase === 'swiping') opts.onSettle(rowSwipeSettlesOpen(offset));
        phase = 'idle';
      },
      onPointerCancel() {
        if (phase === 'swiping') opts.onSettle(base !== 0);
        phase = 'idle';
      },
    },
    consumeClickSuppression() {
      const value = suppressClick;
      suppressClick = false;
      return value;
    },
    swiping: () => phase === 'swiping',
    cancel() {
      if (phase === 'swiping') opts.onSettle(base !== 0);
      phase = 'idle';
    },
  };
}

/** One controller per row for its life, always calling the latest options. */
export function useRowSwipe(opts: RowSwipeOptions): RowSwipeController {
  const latest = useRef(opts);
  latest.current = opts;
  const ref = useRef<RowSwipeController | null>(null);
  ref.current ??= createRowSwipeController({
    isOpen: () => latest.current.isOpen(),
    enabled: () => latest.current.enabled?.() ?? true,
    onStart: (pointerId) => latest.current.onStart(pointerId),
    onDrag: (offset) => latest.current.onDrag(offset),
    onSettle: (open) => latest.current.onSettle(open),
  });
  return ref.current;
}

// ---------------------------------------------------------------------------
// Remove with Undo: the write waits for the toast
// ---------------------------------------------------------------------------

export interface DelayedRemoverOptions {
  /** How long Undo is offered (ms); the write goes out when it ends. */
  delayMs: number;
  /** The write (plan_item_remove); true when it landed. */
  send: (id: string) => Promise<boolean>;
  /** The write is about to go out (any cause): the Undo toast is over. */
  onSend?: (id: string) => void;
  /** The write landed. */
  onSent?: (id: string) => void;
  /** The write failed: restore the row and say so. */
  onFailed: (id: string) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DelayedRemover {
  /** Hide now, send after delayMs; any removal still waiting goes out first. */
  schedule: (id: string) => void;
  /** Cancel the waiting removal (no request); true when there was one. */
  undo: () => boolean;
  /** Send the waiting removal now (close, background, a drag). */
  flush: () => void;
  /** The removal waiting on Undo, or null. */
  pending: () => string | null;
  /** Flush, then resolve once every removal sent so far has settled. */
  settled: () => Promise<void>;
}

/**
 * One removal waits at a time. The id leaves `pending` before its write goes
 * out, so a removal is sent exactly once (timer, flush or a new removal,
 * whichever comes first) or never (Undo).
 */
export function createDelayedRemover(opts: DelayedRemoverOptions): DelayedRemover {
  const setTimer = opts.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer =
    opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let waiting: string | null = null;
  let timer: unknown = null;
  const inFlight = new Set<Promise<void>>();

  const stopTimer = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const flush = (): void => {
    const id = waiting;
    if (id === null) return;
    waiting = null;
    stopTimer();
    opts.onSend?.(id);
    const write = opts
      .send(id)
      .catch(() => false)
      .then((ok) => {
        if (ok) opts.onSent?.(id);
        else opts.onFailed(id);
      })
      .finally(() => {
        inFlight.delete(write);
      });
    inFlight.add(write);
  };
  return {
    schedule(id) {
      flush();
      waiting = id;
      timer = setTimer(flush, opts.delayMs);
    },
    undo() {
      if (waiting === null) return false;
      waiting = null;
      stopTimer();
      return true;
    },
    flush,
    pending: () => waiting,
    async settled() {
      flush();
      await Promise.all([...inFlight]);
    },
  };
}

/** The slices of document and window flushOnLeave listens on. */
export interface LeaveTargets {
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * The app going to the background (visibilitychange to hidden, pagehide)
 * sends the waiting removal now; the returned cleanup (the screen unmounting)
 * stops listening and sends it too.
 */
export function flushOnLeave(
  remover: Pick<DelayedRemover, 'flush'>,
  targets: LeaveTargets,
): () => void {
  const { doc, win } = targets;
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') remover.flush();
  };
  const onHide = (): void => remover.flush();
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onHide);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onHide);
    remover.flush();
  };
}

// ---------------------------------------------------------------------------
// The one-time peek
// ---------------------------------------------------------------------------

/** Shown in this page load (covers storage that throws). */
let peekShownThisLoad = false;

/** The device's storage, or null; reading it can throw (blocked site data). */
export type StorageRead = () => Pick<Storage, 'getItem' | 'setItem'> | null;

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  return typeof window !== 'undefined' ? window.localStorage : null;
}

/** The peek is still owed on this device (at most once per load when storage throws). */
export function peekWanted(storage: StorageRead = defaultStorage): boolean {
  if (peekShownThisLoad) return false;
  try {
    const s = storage();
    return s === null || s.getItem(PLAN_SWIPE_PEEK_KEY) === null;
  } catch {
    return true;
  }
}

/** Never again on this device (and never again in this load if storage throws). */
export function markPeekSeen(storage: StorageRead = defaultStorage): void {
  peekShownThisLoad = true;
  try {
    storage()?.setItem(PLAN_SWIPE_PEEK_KEY, '1');
  } catch {
    // Storage is blocked: the in-memory flag holds it for this load.
  }
}

/** Tests only: a fresh page load. */
export function resetPeekLoadForTests(): void {
  peekShownThisLoad = false;
}

export interface PlanPeekOptions {
  /** A drag, a swipe, a press, a sheet or a menu is active: try again later. */
  blocked: () => boolean;
  /** The first visible swipeable row, or null. */
  firstRow: () => string | null;
  reducedMotion: () => boolean;
  /** The peek's row offset (px); null when it is over. */
  onOffset: (id: string, offset: number | null) => void;
  /** Reduced motion: the tip toast instead of the slide. */
  onTip: () => void;
  storage?: StorageRead;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * About ROW_PEEK_DELAY_MS after the list paints: when the peek is still owed
 * and nothing is active, the first visible row slides ROW_PEEK_PX left, holds,
 * slides back (or, under reduced motion, the tip shows) and the device is
 * marked. Blocked: it waits another delay. Returns the cancel (which also
 * puts a running peek back at rest).
 */
export function runPlanPeek(opts: PlanPeekOptions): () => void {
  const setTimer = opts.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer =
    opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let showing: string | null = null;
  let done = false;
  const later = (run: () => void, ms: number): void => {
    timer = setTimer(() => {
      timer = null;
      run();
    }, ms);
  };
  const fire = (): void => {
    if (done || !peekWanted(opts.storage)) return;
    if (opts.blocked()) {
      later(fire, ROW_PEEK_DELAY_MS);
      return;
    }
    const id = opts.firstRow();
    if (id === null) return;
    done = true;
    markPeekSeen(opts.storage);
    if (opts.reducedMotion()) {
      opts.onTip();
      return;
    }
    showing = id;
    opts.onOffset(id, -ROW_PEEK_PX);
    later(() => {
      opts.onOffset(id, 0);
      later(() => {
        showing = null;
        opts.onOffset(id, null);
      }, ROW_PEEK_SLIDE_MS);
    }, ROW_PEEK_SLIDE_MS + ROW_PEEK_HOLD_MS);
  };
  later(fire, ROW_PEEK_DELAY_MS);
  return () => {
    done = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (showing !== null) {
      const id = showing;
      showing = null;
      opts.onOffset(id, null);
    }
  };
}
