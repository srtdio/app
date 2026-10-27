// The Cockpit's refresh clock. One timer, never two:
//   closed: one light status fetch every 60 s while the tab is visible; the
//           first only once the app is idle after first paint
//           (requestIdleCallback, 2 s fallback).
//   open:   one full fetch on open (and on a tab pick), then every 30 s while
//           the tab is visible.
// A hidden tab never polls: the timer is dropped on hide and re-armed on show
// for whatever is still due. Nothing on a paint path ever awaits it.

import { mark } from '@/lib/perf-marks';
import type { CockpitFull, CockpitStatus, CockpitTab } from '@/lib/cockpit/types';
import { getCockpitState, setCockpitState } from '@/lib/cockpit/store';

export const OPEN_POLL_MS = 30_000;
export const CLOSED_POLL_MS = 60_000;
/** requestIdleCallback's timeout and the fallback delay without it. */
export const IDLE_FALLBACK_MS = 2_000;

export interface PollerDeps {
  fetchStatus: () => Promise<CockpitStatus>;
  fetchFull: (tab: CockpitTab, open: boolean) => Promise<CockpitFull>;
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  /** Run once the app is idle; returns a cancel. */
  whenIdle: (run: () => void) => () => void;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
}

export interface CockpitPoller {
  start: () => void;
  stop: () => void;
  open: () => void;
  close: () => void;
  selectTab: (tab: CockpitTab) => void;
}

export function createCockpitPoller(deps: PollerDeps): CockpitPoller {
  let running = false;
  let idleReady = false;
  let timer: unknown = null;
  let lastFetchAt: number | null = null;
  let cancelIdle: (() => void) | null = null;
  let stopVisibility: (() => void) | null = null;

  function clear(): void {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  }

  function applyStatus(res: CockpitStatus): void {
    mark('cockpit:status');
    setCockpitState({ level: res.level, alerts: res.alerts, checkedAt: res.checked_at });
  }

  function applyFull(res: CockpitFull): void {
    mark('cockpit:full');
    const current = getCockpitState();
    setCockpitState({
      level: res.level,
      alerts: res.alerts,
      checkedAt: res.checked_at,
      latest: res,
      byTab: { ...current.byTab, [res.tab]: res },
    });
  }

  // A failed fetch keeps the last answer on screen: no connection-state UI.
  function fetchNow(open: boolean): void {
    lastFetchAt = deps.now();
    const { open: panelOpen, tab } = getCockpitState();
    const work = panelOpen
      ? deps.fetchFull(tab, open).then(applyFull)
      : deps.fetchStatus().then(applyStatus);
    void work.catch(() => undefined).then(schedule);
  }

  function schedule(): void {
    clear();
    if (!running || !idleReady || !deps.isVisible()) return;
    const interval = getCockpitState().open ? OPEN_POLL_MS : CLOSED_POLL_MS;
    const due = lastFetchAt === null ? 0 : Math.max(0, lastFetchAt + interval - deps.now());
    timer = deps.setTimer(() => {
      timer = null;
      if (running && deps.isVisible()) fetchNow(false);
    }, due);
  }

  return {
    start() {
      if (running) return;
      running = true;
      stopVisibility = deps.onVisibilityChange(schedule);
      cancelIdle = deps.whenIdle(() => {
        cancelIdle = null;
        idleReady = true;
        schedule();
      });
    },
    stop() {
      running = false;
      clear();
      cancelIdle?.();
      cancelIdle = null;
      stopVisibility?.();
      stopVisibility = null;
    },
    open() {
      setCockpitState({ open: true });
      idleReady = true;
      cancelIdle?.();
      cancelIdle = null;
      clear();
      fetchNow(true);
    },
    close() {
      setCockpitState({ open: false });
      // The next status check is a full minute after the last fetch.
      schedule();
    },
    selectTab(tab) {
      setCockpitState({ tab });
      if (!getCockpitState().open) return;
      clear();
      fetchNow(true);
    },
  };
}

/** The browser's idle hook: requestIdleCallback (2 s timeout) or a 2 s timer. */
export function browserWhenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: IDLE_FALLBACK_MS });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(run, IDLE_FALLBACK_MS);
  return () => window.clearTimeout(id);
}

export function browserVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}
