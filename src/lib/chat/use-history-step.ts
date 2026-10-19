// One history step per open layer: the one mechanism behind "every open is a
// history step; every back pops exactly one step" inside chat. Opening a layer
// (selection mode, the thread view, a sheet, the bell) pushes one entry at the
// same URL whose state carries a marker under the layer's key; a popstate off
// that entry closes the layer and stays put. Closing the layer itself (its X,
// Close, swipe-down) pops the entry, so none is left behind. An entry buried
// under a navigation (the chat was left with the layer open) is skipped if it
// is ever landed on. While any step is open (or its pop is still landing), the
// registered selection leave (forward.ts) closes the steps first, so a chat
// switch or close always runs from the chat's own entry.
//
// One popstate dispatcher serves every step: on each pop only the topmost
// open step reacts (never a step under it, whatever order the listeners were
// added in), so a step above another never races it. A guard step (the Back
// guard for unsaved work, src/lib/back-guard.ts) is a step that refuses to
// leave: popped, it re-pushes its own entry and runs its onExit as "Back was
// pressed" while the layer under it stays. Its dispose() pops its entry before
// the layer under it closes, so that layer's dispose() still pops its own
// entry and no dead entry is left behind.

import { useEffect, useMemo, useRef } from 'react';
import { clearSelectionLeave, setSelectionLeave } from '@/lib/chat/forward';

/** The slice of window history steps need (the real window, or a test fake). */
export interface HistoryStepWindow {
  history: {
    readonly state: unknown;
    pushState: (data: unknown, unused: string, url?: string | null) => void;
    back: () => void;
  };
  location: { href: string };
  addEventListener: (type: 'popstate', listener: () => void) => void;
  removeEventListener: (type: 'popstate', listener: () => void) => void;
}

/** One open layer's history entry. */
export interface HistoryStep {
  /**
   * Leave through history.back(): the pop closes the layer, then runs `then`.
   * Repeat calls while leaving are ignored. A guard step leaves silently (its
   * onExit is not run: the leave is programmatic, not a Back press).
   */
  cancel: (then?: () => void) => void;
  /** The layer closed another way, or unmounts: its entry is popped (or buried). */
  dispose: () => void;
  /** Keep the entry where it is and stop owning it (a landing may reopen it). */
  detach: () => void;
}

/** How many buried markers the guard remembers (the most recent ones). */
export const BURIED_STEPS_LIMIT = 20;

/** The history.state key of a Back guard's step (src/lib/back-guard.ts). */
export const BACK_GUARD_STEP_KEY = 'backGuard';

/** A step's private record. */
interface Step {
  win: HistoryStepWindow;
  key: string;
  marker: number;
  /** A guard refuses Back: popped, it re-pushes itself and reports the press. */
  guard: boolean;
  active: boolean;
  /** Its entry exists in history (pushed, or adopted). */
  pushed: boolean;
  /** Its cancel() issued history.back() and that pop has not landed yet. */
  leaving: boolean;
  onExit: () => void;
  afterExit: (() => void) | null;
  handle: HistoryStep;
}

// Seeded from the clock so a marker never matches one left in history.state
// from before a reload.
let markerSeq = Date.now();
const stepKeys = new Set<string>();
// Open steps, oldest first: the last pushed one is on top of history.
const openSteps: Step[] = [];
// Markers buried under a later navigation ("key:marker"), bounded.
const buried = new Set<string>();
// Pops a dispose issued that have not landed yet; work waiting on them.
let inflight = 0;
const waiters: (() => void)[] = [];
// Ids whose own pop is still landing: a landing on one is transient, not a step.
const popping = new Set<string>();
// The window the one popstate dispatcher is attached to, while anything needs it.
let dispatcherWin: HistoryStepWindow | null = null;

/** The marker the state carries under `key`, or null. */
export function stepMarkerOf(state: unknown, key: string): number | null {
  if (typeof state !== 'object' || state === null) return null;
  const marker = (state as Record<string, unknown>)[key];
  return typeof marker === 'number' ? marker : null;
}

function buriedIdOf(state: unknown): string | null {
  for (const key of stepKeys) {
    const marker = stepMarkerOf(state, key);
    if (marker !== null) return `${key}:${marker}`;
  }
  return null;
}

/** Whether the state is a dead step entry (buried, or its pop still landing) the guard will skip. */
export function isBuriedStep(state: unknown): boolean {
  const id = buriedIdOf(state);
  return id !== null && (buried.has(id) || popping.has(id));
}

/** The state for a new step entry: the router's own fields, one marker only. */
function stepState(base: unknown, key: string, marker: number): Record<string, unknown> {
  const next: Record<string, unknown> =
    typeof base === 'object' && base !== null ? { ...(base as Record<string, unknown>) } : {};
  for (const k of stepKeys) delete next[k];
  next[key] = marker;
  return next;
}

function idOf(step: Step): string {
  return `${step.key}:${step.marker}`;
}

function onTop(step: Step): boolean {
  return step.pushed && stepMarkerOf(step.win.history.state, step.key) === step.marker;
}

/** The open step whose entry is highest in history (the last pushed one). */
function topStep(): Step | undefined {
  for (let i = openSteps.length - 1; i >= 0; i -= 1) {
    const step = openSteps[i];
    if (step !== undefined && step.active && step.pushed) return step;
  }
  return undefined;
}

/** Attach the one popstate dispatcher while anything needs it; detach once nothing does. */
function syncDispatcher(win: HistoryStepWindow): void {
  const needed = inflight > 0 || buried.size > 0 || openSteps.some((s) => s.pushed);
  if (needed) {
    if (dispatcherWin === win) return;
    dispatcherWin?.removeEventListener('popstate', onPopstate);
    dispatcherWin = win;
    win.addEventListener('popstate', onPopstate);
    return;
  }
  if (dispatcherWin === null) return;
  dispatcherWin.removeEventListener('popstate', onPopstate);
  dispatcherWin = null;
}

/** Close every open step (top first, one pop at a time), then run `then`. */
function leaveSteps(then: () => void): void {
  if (inflight > 0) {
    waiters.push(() => leaveSteps(then));
    return;
  }
  const top = openSteps[openSteps.length - 1];
  if (top === undefined) {
    then();
    return;
  }
  top.handle.cancel(() => leaveSteps(then));
}

function syncLeave(): void {
  if (openSteps.length > 0 || inflight > 0) setSelectionLeave(leaveSteps);
  else clearSelectionLeave(leaveSteps);
}

function forget(step: Step): void {
  const at = openSteps.indexOf(step);
  if (at >= 0) openSteps.splice(at, 1);
  syncLeave();
  syncDispatcher(step.win);
}

/** Run `run` once no pop a dispose issued is still landing. */
function whenSettled(run: () => void): void {
  if (inflight === 0) run();
  else waiters.push(run);
}

/** Pop the step's own entry; anything that would push meanwhile waits for the landing. */
function popOwn(step: Step): void {
  inflight += 1;
  popping.add(idOf(step));
  syncLeave();
  syncDispatcher(step.win);
  step.win.history.back();
}

/** The step is gone: forget it, run its exit (a Back press) and whatever waited on it. */
function finish(step: Step, runExit: boolean): void {
  step.active = false;
  forget(step);
  if (runExit) step.onExit();
  const then = step.afterExit;
  step.afterExit = null;
  then?.();
}

function bury(win: HistoryStepWindow, id: string): void {
  buried.add(id);
  if (buried.size > BURIED_STEPS_LIMIT) {
    const oldest = buried.values().next().value;
    if (oldest !== undefined) buried.delete(oldest);
  }
  syncDispatcher(win);
}

/**
 * The one popstate listener. In order: a pop a dispose issued lands (and the
 * work waiting on it runs); a dead entry landed on is skipped; then only the
 * topmost open step reacts if its entry is gone: a guard re-pushes its entry
 * and reports the Back press, any other step closes.
 */
function onPopstate(): void {
  const win = dispatcherWin;
  if (win === null) return;
  if (inflight > 0) {
    inflight -= 1;
    if (inflight === 0) {
      popping.clear();
      syncLeave();
      syncDispatcher(win);
      for (const run of waiters.splice(0)) run();
    }
  }
  const state = win.history.state;
  const landed = buriedIdOf(state);
  if (landed !== null && buried.has(landed)) {
    buried.delete(landed);
    syncDispatcher(win);
    win.history.back();
    return;
  }
  const top = topStep();
  if (top === undefined || onTop(top)) {
    syncDispatcher(win);
    return;
  }
  if (top.guard && !top.leaving) {
    // Back on a guarded layer: stay (the entry comes back) and report the press.
    win.history.pushState(stepState(win.history.state, top.key, top.marker), '', win.location.href);
    top.onExit();
    return;
  }
  finish(top, !top.guard);
}

/**
 * Open one step under `key`. It pushes an entry at the same URL (the
 * ?channel= included) whose state carries a fresh marker, after any pop still
 * landing; `adopt` takes the current entry instead (a landing on a kept entry,
 * the bell). A popstate off the entry runs onExit once. With `guard`, a
 * popstate off the entry re-pushes it and runs onExit every time (the layer
 * stays); the guard leaves only through dispose() or cancel().
 */
export function enterHistoryStep(
  win: HistoryStepWindow,
  key: string,
  onExit: () => void,
  options: { adopt?: boolean; guard?: boolean } = {},
): HistoryStep {
  stepKeys.add(key);
  const adopted = options.adopt === true ? stepMarkerOf(win.history.state, key) : null;
  markerSeq += 1;
  const marker = adopted ?? markerSeq;
  const step: Step = {
    win,
    key,
    marker,
    guard: options.guard === true,
    active: true,
    pushed: false,
    leaving: false,
    onExit,
    afterExit: null,
    handle: {
      cancel: (then) => {
        if (!step.active) {
          then?.();
          return;
        }
        if (then !== undefined) {
          const prior = step.afterExit;
          step.afterExit =
            prior === null
              ? then
              : () => {
                  prior();
                  then();
                };
        }
        if (step.leaving) return;
        if (onTop(step)) {
          step.leaving = true;
          win.history.back();
          return;
        }
        if (step.pushed) bury(win, idOf(step));
        finish(step, !step.guard);
      },
      dispose: () => {
        if (!step.active) return;
        // Whether this step's entry is the highest one still owned by an open
        // step: a close while the entries above it are already being popped
        // pops its own too (no entry is left dead), see below.
        const highest = topStep() === step;
        step.active = false;
        const pending = step.afterExit;
        step.afterExit = null;
        forget(step);
        if (step.leaving) {
          // A switch waiting on history.back() still runs once that pop lands.
          // Landed already: this dispose runs inside that popstate (React
          // flushes the close there), where a listener added now would miss it.
          if (pending !== null && !onTop(step)) {
            pending();
            return;
          }
          if (pending !== null) {
            const onLanded = (): void => {
              win.removeEventListener('popstate', onLanded);
              pending();
            };
            win.addEventListener('popstate', onLanded);
          }
          return;
        }
        if (!step.pushed) return;
        if (onTop(step)) {
          popOwn(step);
          return;
        }
        const above = buriedIdOf(win.history.state);
        if (highest && inflight > 0 && above !== null && popping.has(above)) {
          // The entry on top is a step's whose pop is on its way (a guard
          // released just before this close): once it lands, ours is on top,
          // so pop it too rather than leaving it dead.
          popOwn(step);
          return;
        }
        bury(win, idOf(step));
      },
      detach: () => {
        if (!step.active) return;
        step.active = false;
        step.afterExit = null;
        forget(step);
      },
    },
  };
  const place = (): void => {
    if (!step.active) return;
    if (adopted === null)
      win.history.pushState(stepState(win.history.state, key, marker), '', win.location.href);
    step.pushed = true;
    syncDispatcher(win);
  };
  openSteps.push(step);
  syncLeave();
  if (adopted !== null) place();
  else whenSettled(place);
  return step.handle;
}

/** How many markers are buried (tests). */
export function buriedStepCount(): number {
  return buried.size;
}

/** Test seam: forget open steps, buried markers, pending pops and the dispatcher. */
export function resetHistorySteps(): void {
  openSteps.splice(0);
  buried.clear();
  popping.clear();
  inflight = 0;
  waiters.splice(0);
  dispatcherWin?.removeEventListener('popstate', onPopstate);
  dispatcherWin = null;
  clearSelectionLeave(leaveSteps);
}

/**
 * Whether the current entry has an in-app entry below it (React Router's
 * history index). False on a cold open from an outside link. Pure.
 */
export function hasPreviousEntry(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  const idx = (state as Record<string, unknown>).idx;
  return typeof idx === 'number' && idx > 0;
}

/** What a layer's hook hands back. */
export interface HistoryStepControl {
  /** Keep the entry (the layer is leaving by a navigation); see HistoryStep.detach. */
  detach: () => void;
}

/**
 * A layer's history step while `open`: back closes it through `onBack` (the
 * layer's own close, so its close motion runs). With `onLand`, landing on an
 * entry this key kept (detached) asks the layer to reopen; it then adopts that
 * entry instead of pushing another. One popstate dispatcher serves every open
 * layer; it is removed once no layer is open.
 */
export function useHistoryStep(
  open: boolean,
  key: string,
  onBack: () => void,
  onLand?: () => void,
): HistoryStepControl {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onLandRef = useRef(onLand);
  onLandRef.current = onLand;
  const stepRef = useRef<HistoryStep | null>(null);
  const adoptRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    const adopt = adoptRef.current && stepMarkerOf(window.history.state, key) !== null;
    adoptRef.current = false;
    const step = enterHistoryStep(window, key, () => onBackRef.current(), { adopt });
    stepRef.current = step;
    return () => {
      if (stepRef.current === step) stepRef.current = null;
      step.dispose();
    };
  }, [open, key]);
  const restores = onLand !== undefined;
  useEffect(() => {
    if (!restores) return;
    const onPop = (): void => {
      if (stepRef.current !== null) return;
      const state = window.history.state;
      if (stepMarkerOf(state, key) === null || isBuriedStep(state)) return;
      adoptRef.current = true;
      onLandRef.current?.();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [restores, key]);
  return useMemo(
    () => ({
      detach: () => {
        stepRef.current?.detach();
        stepRef.current = null;
      },
    }),
    [],
  );
}

/** The history.state keys of the chat's layers (selection keeps its own). */
export const HISTORY_STEP_KEYS = {
  threadView: 'chatThreadView',
  contact: 'chatContact',
  starred: 'chatStarred',
  marks: 'chatMarks',
  readInfo: 'chatReadInfo',
  search: 'chatSearch',
  groupInfo: 'chatGroupInfo',
  scheduledList: 'chatScheduledList',
  newChat: 'chatNewChat',
  bell: 'chatBell',
  bellScheduled: 'chatBellScheduled',
  planCompose: 'chatPlanCompose',
  plan: 'chatPlan',
  planItem: 'chatPlanItem',
} as const;

// Every layer key is known from load, so an entry a layer left before a reload
// still reads as a step (never as the bare list). Selection's own key
// ('chatSelection', MessageThread's SELECTION_HISTORY_KEY) and the Back
// guard's included.
for (const key of [...Object.values(HISTORY_STEP_KEYS), 'chatSelection', BACK_GUARD_STEP_KEY])
  stepKeys.add(key);

/**
 * Whether the entry is a layer's step (any key in use), not a screen's own
 * entry. The bell open over chat home is a step, not the bare list. Pure.
 */
export function isStepEntry(state: unknown): boolean {
  for (const key of stepKeys) if (stepMarkerOf(state, key) !== null) return true;
  return false;
}

/** What a chat entry remembers about the entry below it (React Router's location state). */
export interface ChatEntryState {
  /** The chat was pushed from the bare chat list (no chat open, no layer). */
  chatBelow: 'list';
}

/** React Router's location state on a history entry (`usr`), or undefined. */
export function entryUsr(state: unknown): unknown {
  if (typeof state !== 'object' || state === null) return undefined;
  return (state as Record<string, unknown>).usr;
}

/**
 * The location state for an entry pushed from the current one: marks it as
 * opened from the bare chat list when that is where it was pushed from. Pure.
 */
export function chatEntryFrom(onBareList: boolean, state: unknown): ChatEntryState | undefined {
  return onBareList && !isStepEntry(state) ? { chatBelow: 'list' } : undefined;
}

/** Whether the current entry was pushed from the bare chat list (one step below). Pure. */
export function openedFromList(state: unknown): boolean {
  if (!hasPreviousEntry(state)) return false;
  const usr = entryUsr(state);
  return (
    typeof usr === 'object' && usr !== null && (usr as Record<string, unknown>).chatBelow === 'list'
  );
}
