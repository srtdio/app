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
   * Repeat calls while leaving are ignored.
   */
  cancel: (then?: () => void) => void;
  /** The layer closed another way, or unmounts: its entry is popped (or buried). */
  dispose: () => void;
  /** Keep the entry where it is and stop owning it (a landing may reopen it). */
  detach: () => void;
}

/** How many buried markers the guard remembers (the most recent ones). */
export const BURIED_STEPS_LIMIT = 20;

// Seeded from the clock so a marker never matches one left in history.state
// from before a reload.
let markerSeq = Date.now();
const stepKeys = new Set<string>();
// Open steps, oldest first: the last one is on top of history.
const openSteps: HistoryStep[] = [];
// Markers buried under a later navigation ("key:marker"), bounded.
const buried = new Set<string>();
let buriedGuard: (() => void) | null = null;
// Pops a dispose issued that have not landed yet; work waiting on them.
let inflight = 0;
let settleOff: (() => void) | null = null;
const waiters: (() => void)[] = [];

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

/** Whether the state is a buried (dead) step entry the guard will skip. */
export function isBuriedStep(state: unknown): boolean {
  const id = buriedIdOf(state);
  return id !== null && buried.has(id);
}

/** The state for a new step entry: the router's own fields, one marker only. */
function stepState(base: unknown, key: string, marker: number): Record<string, unknown> {
  const next: Record<string, unknown> =
    typeof base === 'object' && base !== null ? { ...(base as Record<string, unknown>) } : {};
  for (const k of stepKeys) delete next[k];
  next[key] = marker;
  return next;
}

function bury(win: HistoryStepWindow, id: string): void {
  buried.add(id);
  if (buried.size > BURIED_STEPS_LIMIT) {
    const oldest = buried.values().next().value;
    if (oldest !== undefined) buried.delete(oldest);
  }
  if (buriedGuard !== null) return;
  const guard = (): void => {
    const landed = buriedIdOf(win.history.state);
    if (landed === null || !buried.has(landed)) return;
    buried.delete(landed);
    win.history.back();
  };
  win.addEventListener('popstate', guard);
  buriedGuard = () => win.removeEventListener('popstate', guard);
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
  top.cancel(() => leaveSteps(then));
}

function syncLeave(): void {
  if (openSteps.length > 0 || inflight > 0) setSelectionLeave(leaveSteps);
  else clearSelectionLeave(leaveSteps);
}

function forget(step: HistoryStep): void {
  const at = openSteps.indexOf(step);
  if (at >= 0) openSteps.splice(at, 1);
  syncLeave();
}

/** Run `run` once no pop a dispose issued is still landing. */
function whenSettled(run: () => void): void {
  if (inflight === 0) run();
  else waiters.push(run);
}

/** Pop our own entry; anything that would push meanwhile waits for the landing. */
function popOwn(win: HistoryStepWindow): void {
  inflight += 1;
  if (settleOff === null) {
    const onSettle = (): void => {
      inflight -= 1;
      if (inflight > 0) return;
      settleOff?.();
      settleOff = null;
      syncLeave();
      for (const run of waiters.splice(0)) run();
    };
    win.addEventListener('popstate', onSettle);
    settleOff = () => win.removeEventListener('popstate', onSettle);
  }
  syncLeave();
  win.history.back();
}

/**
 * Open one step under `key`. It pushes an entry at the same URL (the
 * ?channel= included) whose state carries a fresh marker, after any pop still
 * landing; `adopt` takes the current entry instead (a landing on a kept entry,
 * the bell). A popstate off the entry runs onExit once.
 */
export function enterHistoryStep(
  win: HistoryStepWindow,
  key: string,
  onExit: () => void,
  options: { adopt?: boolean } = {},
): HistoryStep {
  stepKeys.add(key);
  const adopted = options.adopt === true ? stepMarkerOf(win.history.state, key) : null;
  markerSeq += 1;
  const marker = adopted ?? markerSeq;
  let active = true;
  let pushed = false;
  let leaving = false;
  let afterExit: (() => void) | null = null;
  const onTop = (): boolean => pushed && stepMarkerOf(win.history.state, key) === marker;
  const finish = (): void => {
    active = false;
    win.removeEventListener('popstate', onPop);
    forget(handle);
    onExit();
    const then = afterExit;
    afterExit = null;
    then?.();
  };
  function onPop(): void {
    if (!active || onTop()) return;
    finish();
  }
  const place = (): void => {
    if (!active) return;
    if (adopted === null)
      win.history.pushState(stepState(win.history.state, key, marker), '', win.location.href);
    pushed = true;
    win.addEventListener('popstate', onPop);
  };
  const handle: HistoryStep = {
    cancel: (then) => {
      if (!active) {
        then?.();
        return;
      }
      if (then !== undefined) {
        const prior = afterExit;
        afterExit =
          prior === null
            ? then
            : () => {
                prior();
                then();
              };
      }
      if (leaving) return;
      if (onTop()) {
        leaving = true;
        win.history.back();
        return;
      }
      if (pushed) bury(win, `${key}:${marker}`);
      finish();
    },
    dispose: () => {
      win.removeEventListener('popstate', onPop);
      if (!active) return;
      active = false;
      const pending = afterExit;
      afterExit = null;
      forget(handle);
      if (leaving) {
        // A switch waiting on history.back() still runs once that pop lands.
        // Landed already: this dispose runs inside that popstate (React
        // flushes the close there), where a listener added now would miss it.
        if (pending !== null && !onTop()) {
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
      if (!pushed) return;
      if (onTop()) popOwn(win);
      else bury(win, `${key}:${marker}`);
    },
    detach: () => {
      win.removeEventListener('popstate', onPop);
      if (!active) return;
      active = false;
      afterExit = null;
      forget(handle);
    },
  };
  openSteps.push(handle);
  syncLeave();
  if (adopted !== null) place();
  else whenSettled(place);
  return handle;
}

/** How many markers are buried (tests). */
export function buriedStepCount(): number {
  return buried.size;
}

/** Test seam: forget open steps, buried markers, pending pops and the guards. */
export function resetHistorySteps(): void {
  openSteps.splice(0);
  buried.clear();
  buriedGuard?.();
  buriedGuard = null;
  settleOff?.();
  settleOff = null;
  inflight = 0;
  waiters.splice(0);
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
 * entry instead of pushing another. One popstate listener per open layer;
 * every listener is removed on close and unmount.
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
// ('chatSelection', MessageThread's SELECTION_HISTORY_KEY) included.
for (const key of [...Object.values(HISTORY_STEP_KEYS), 'chatSelection']) stepKeys.add(key);

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
