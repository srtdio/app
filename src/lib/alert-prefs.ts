// Per-device alert prefs: Sound, Notifications and Pause (1 to 6 hours). They
// live in localStorage under a key that carries the user id, so a second
// account on the same device never inherits the first one's choices, and they
// never touch the network (the device is the only owner).
//
// Every sound (chat tone, Activity tone, reminder chime) and every tab flash
// and favicon dot asks the gates below at the moment it would play, so a pause
// set in another tab or a moment ago is obeyed without a reload. A gate check
// is one synchronous getItem plus a cached parse (by raw string): cheap enough
// for the arrival path, and no await is added anywhere.
//
// The hook (useAlertPrefs) is the Settings surface's view: first frame reads
// synchronously, other tabs' writes arrive by the "storage" event, same-tab
// writes by a module listener, and a running pause re-renders once when it
// ends so the screen shows "not paused" without a poll.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { logger } from '@/lib/logger';

export type PauseHours = 1 | 2 | 3 | 4 | 5 | 6;
export const PAUSE_HOURS: readonly PauseHours[] = [1, 2, 3, 4, 5, 6];

export interface AlertPrefs {
  sound: boolean;
  notifications: boolean;
  pausedUntilMs: number | null;
  pausedHours: PauseHours | null;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = Object.freeze({
  sound: true,
  notifications: true,
  pausedUntilMs: null,
  pausedHours: null,
});

const HOUR_MS = 3_600_000;
const KEY_PREFIX = 'sorted:alert-prefs:v1:';

export function alertPrefsKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

function isPauseHours(value: unknown): value is PauseHours {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6;
}

/** Stored JSON to prefs. Anything unreadable falls back per field to the default. Pure. */
export function parseAlertPrefs(raw: string | null): AlertPrefs {
  if (raw === null) return DEFAULT_ALERT_PREFS;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_ALERT_PREFS;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return DEFAULT_ALERT_PREFS;
  const o = data as Record<string, unknown>;
  const until = o.pausedUntilMs;
  const hours = o.pausedHours;
  // The pause is one fact in two fields: half a pause is no pause.
  let pausedUntilMs: number | null = null;
  let pausedHours: PauseHours | null = null;
  if (typeof until === 'number' && Number.isFinite(until) && isPauseHours(hours)) {
    pausedUntilMs = until;
    pausedHours = hours;
  }
  return {
    sound: typeof o.sound === 'boolean' ? o.sound : DEFAULT_ALERT_PREFS.sound,
    notifications:
      typeof o.notifications === 'boolean' ? o.notifications : DEFAULT_ALERT_PREFS.notifications,
    pausedUntilMs,
    pausedHours,
  };
}

// ---------------------------------------------------------------------------
// Storage. A write the browser refuses (private mode, quota) is kept in memory
// for this tab, so the switch still sticks until reload.

const memory = new Map<string, string>();
// Last raw string and its parse per key: a stable snapshot between changes
// (useSyncExternalStore loops on a fresh object every read) and a cheap gate.
const parsed = new Map<string, { raw: string | null; prefs: AlertPrefs }>();

function readRaw(key: string): string | null {
  const kept = memory.get(key);
  if (kept !== undefined) return kept;
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readAlertPrefs(userId: string | null): AlertPrefs {
  if (userId === null) return DEFAULT_ALERT_PREFS;
  const key = alertPrefsKey(userId);
  const raw = readRaw(key);
  const hit = parsed.get(key);
  if (hit !== undefined && hit.raw === raw) return hit.prefs;
  const prefs = parseAlertPrefs(raw);
  parsed.set(key, { raw, prefs });
  return prefs;
}

type KeyListener = (key: string) => void;
const keyListeners = new Set<KeyListener>();

function notify(key: string): void {
  for (const fn of [...keyListeners]) fn(key);
}

export function writeAlertPrefs(userId: string, prefs: AlertPrefs): void {
  const key = alertPrefsKey(userId);
  const raw = JSON.stringify({
    sound: prefs.sound,
    notifications: prefs.notifications,
    pausedUntilMs: prefs.pausedUntilMs,
    pausedHours: prefs.pausedHours,
  });
  try {
    if (typeof localStorage === 'undefined') throw new Error('no localStorage');
    localStorage.setItem(key, raw);
    memory.delete(key);
  } catch (error) {
    memory.set(key, raw);
    logger.warn('alert prefs: write kept in memory only', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  notify(key);
}

// ---------------------------------------------------------------------------
// Rules. Pure.

/** Paused until pausedUntilMs; at or after it the pause has ended. */
export function isPaused(prefs: AlertPrefs, nowMs: number): boolean {
  return prefs.pausedUntilMs !== null && nowMs < prefs.pausedUntilMs;
}

/** Sound plays only with Sound on, Notifications on and no pause. */
export function soundAllowed(prefs: AlertPrefs, nowMs: number): boolean {
  return prefs.sound && prefs.notifications && !isPaused(prefs, nowMs);
}

/** The tab flash and favicon dot: Notifications on and no pause. */
export function tabAlertAllowed(prefs: AlertPrefs, nowMs: number): boolean {
  return prefs.notifications && !isPaused(prefs, nowMs);
}

export function pauseFor(prefs: AlertPrefs, hours: PauseHours, nowMs: number): AlertPrefs {
  return { ...prefs, pausedUntilMs: nowMs + hours * HOUR_MS, pausedHours: hours };
}

export function resumeAlerts(prefs: AlertPrefs): AlertPrefs {
  return { ...prefs, pausedUntilMs: null, pausedHours: null };
}

// ---------------------------------------------------------------------------
// Hook.

/** Calls onChange when `key` changes here (same-tab write) or in another tab. */
function subscribeKey(key: string, onChange: () => void): () => void {
  const local: KeyListener = (k) => {
    if (k === key) onChange();
  };
  keyListeners.add(local);
  const onStorage = (event: StorageEvent): void => {
    // key null: another tab cleared all of storage.
    if (event.key === key || event.key === null) onChange();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    keyListeners.delete(local);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

const noopUnsubscribe = (): void => {};

export function useAlertPrefs(
  userId: string | null,
): readonly [AlertPrefs, (next: AlertPrefs) => void] {
  const subscribe = useCallback(
    (onChange: () => void) =>
      userId === null ? noopUnsubscribe : subscribeKey(alertPrefsKey(userId), onChange),
    [userId],
  );
  const getSnapshot = useCallback(() => readAlertPrefs(userId), [userId]);
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // A running pause ends on its own: one timer re-renders at that moment so the
  // consumer's isPaused(prefs, now) reads false. The stored value is untouched.
  const [, setExpired] = useState(0);
  const until = prefs.pausedUntilMs;
  useEffect(() => {
    if (until === null) return;
    const left = until - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setExpired((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [until]);

  const setPrefs = useCallback(
    (next: AlertPrefs) => {
      if (userId !== null) writeAlertPrefs(userId, next);
    },
    [userId],
  );
  return [prefs, setPrefs] as const;
}

// ---------------------------------------------------------------------------
// Global gates: the signed-in user the sounds and tab alerts obey.

let activeUser: string | null = null;
const activeListeners = new Set<() => void>();
let storageInstalled = false;

function notifyActive(): void {
  for (const fn of [...activeListeners]) fn();
}

// Same-tab writes for the active user reach the global listeners too.
keyListeners.add((key) => {
  if (activeUser !== null && key === alertPrefsKey(activeUser)) notifyActive();
});

export function setAlertPrefsUser(userId: string | null): void {
  if (activeUser === userId) return;
  activeUser = userId;
  notifyActive();
}

export function currentSoundAllowed(nowMs: number = Date.now()): boolean {
  return soundAllowed(readAlertPrefs(activeUser), nowMs);
}

export function currentTabAlertAllowed(nowMs: number = Date.now()): boolean {
  return tabAlertAllowed(readAlertPrefs(activeUser), nowMs);
}

/**
 * Calls onChange whenever the active user's prefs may have changed: a write in
 * this tab, a write in another tab, or a different signed-in user. Used by the
 * tab alert to stop a flash the moment it is no longer allowed.
 */
export function subscribeAlertPrefs(onChange: () => void): () => void {
  if (!storageInstalled && typeof window !== 'undefined') {
    storageInstalled = true;
    window.addEventListener('storage', (event: StorageEvent) => {
      if (activeUser === null) return;
      if (event.key === null || event.key === alertPrefsKey(activeUser)) notifyActive();
    });
  }
  activeListeners.add(onChange);
  return () => {
    activeListeners.delete(onChange);
  };
}
