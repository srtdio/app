// Reads shared within this tab session, in memory only (never localStorage or
// IndexedDB). A keyed read started anywhere (a nav press, a card press, a
// mount) is joined by every caller with the same key while it runs and, once
// it settles, while it is younger than its freshness window. A settled value
// older than the window is treated as absent: the caller loads and paints the
// new result, never the old one (peekRead returns undefined). A failed read is
// never kept, so the next caller retries. Signout and workspace-data-changed
// drop everything, and the other change events callers already listen to drop their keys (invalidateReads).
//
// Keys always carry the user id and workspace id first
// (`${userId}:${workspaceId}:<what>`), so one person's rows are never served
// to another and RLS still decides every read that actually runs.

import { SIGNOUT_EVENT, WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';

/** Default freshness window for a settled read. */
export const READ_FRESH_MS = 30_000;

interface Entry {
  promise: Promise<unknown>;
  /** When the read settled ok; null while it runs. */
  settledAt: number | null;
  value: unknown;
  freshMs: number;
}

const entries = new Map<string, Entry>();
// Bumped on every clear: a read that left before a clear never lands after it.
let generation = 0;

function isFresh(entry: Entry, nowMs: number): boolean {
  return entry.settledAt === null || nowMs - entry.settledAt <= entry.freshMs;
}

/** The session read key: user, workspace, then what is read. */
export function readKey(userId: string, workspaceId: string, what: string): string {
  return `${userId}:${workspaceId}:${what}`;
}

/**
 * Join the read for `key` when one runs or settled within its window, else
 * start `load`. `isOk` decides whether a settled value is kept (default: every
 * resolved value; a rejection is never kept).
 */
export function sharedRead<T>(
  key: string,
  load: () => Promise<T>,
  opts: { freshMs?: number; isOk?: (value: T) => boolean; nowMs?: number } = {},
): Promise<T> {
  const nowMs = opts.nowMs ?? Date.now();
  const hit = entries.get(key);
  if (hit !== undefined && isFresh(hit, nowMs)) return hit.promise as Promise<T>;
  const started = generation;
  const entry: Entry = {
    promise: Promise.resolve(),
    settledAt: null,
    value: undefined,
    freshMs: opts.freshMs ?? READ_FRESH_MS,
  };
  entry.promise = load().then(
    (value) => {
      if (started === generation && entries.get(key) === entry) {
        if (opts.isOk === undefined || opts.isOk(value)) {
          entry.settledAt = Date.now();
          entry.value = value;
        } else {
          entries.delete(key);
        }
      }
      return value;
    },
    (err: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    },
  );
  entries.set(key, entry);
  return entry.promise as Promise<T>;
}

/** A settled, fresh value for `key`, or undefined (running, stale, failed or never read). */
export function peekRead<T>(key: string, nowMs: number = Date.now()): T | undefined {
  const entry = entries.get(key);
  if (entry === undefined || entry.settledAt === null) return undefined;
  if (!isFresh(entry, nowMs)) return undefined;
  return entry.value as T;
}

/** Store a value this session just produced (a write's result) as a fresh read. */
export function primeRead<T>(key: string, value: T, freshMs: number = READ_FRESH_MS): void {
  entries.set(key, { promise: Promise.resolve(value), settledAt: Date.now(), value, freshMs });
}

/** Drop every key that starts with `prefix` (a change event; '' drops all). */
export function invalidateReads(prefix: string): void {
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/** Drop everything (signout; tests). */
export function resetSessionReads(): void {
  generation += 1;
  entries.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, resetSessionReads);
  // Rows changed under every open screen (the tour's sample week, a member
  // change): every shared read is dropped and re-read on next use.
  window.addEventListener(WORKSPACE_DATA_CHANGED_EVENT, () => invalidateReads(''));
}
