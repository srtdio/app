import { useSyncExternalStore } from 'react';

// The one shared minute clock for relative times ("just now" ages to "1 min
// ago"). One interval for the whole app, started by the first subscriber and
// stopped with the last; every card reads the same instant. No timer per card.

const MINUTE = 60 * 1000;

let nowMs = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function tick(): void {
  nowMs = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    nowMs = Date.now();
    timer = setInterval(tick, MINUTE);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

// A read a minute or more off the device clock (the module loaded long before
// the first card mounted, or a background tab throttled the interval) catches
// up on the read itself, so the first paint never shows a stale "5m"
// and then repaints. Within a minute the snapshot is the same value (stable
// for useSyncExternalStore).
function snapshot(): number {
  const t = Date.now();
  if (Math.abs(t - nowMs) >= MINUTE) nowMs = t;
  return nowMs;
}

/** The shared clock in epoch ms, updated once a minute. Pure read on render. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
