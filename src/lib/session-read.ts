// Reads shared within this tab session, in memory only (never localStorage or
// IndexedDB). A keyed read started anywhere (a nav press, a card press, a
// mount) is joined by every caller with the same key while it runs and, once
// it settles, while it is fresh (younger than its window and not marked
// stale). A failed read is never kept, so the next caller retries.
//
// Fresh and kept are apart. Freshness only decides whether sharedRead starts a
// new read; a settled ok value is kept for the whole session (peekKept), so a
// screen coming back paints its last view at once and refreshes quietly. A
// newer read replaces the kept value only when it settles ok. Change events
// mark keys stale (invalidateReads) and never delete them; signout deletes
// everything (resetSessionReads) and losing a workspace deletes its keys
// (dropWorkspaceReads).
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
  /** The last ok value at any age (this read's, or the one before it while it runs). */
  kept: { value: unknown } | null;
  freshMs: number;
  /** A change event said the value may differ: the next sharedRead reads again. */
  stale: boolean;
}

const entries = new Map<string, Entry>();
// Bumped on every clear: a read that left before a clear never lands after it.
let generation = 0;

function isFresh(entry: Entry, nowMs: number): boolean {
  if (entry.stale) return false;
  return entry.settledAt === null || nowMs - entry.settledAt <= entry.freshMs;
}

/** The session read key: user, workspace, then what is read. */
export function readKey(userId: string, workspaceId: string, what: string): string {
  return `${userId}:${workspaceId}:${what}`;
}

/**
 * Join the read for `key` when one runs or settled fresh, else start `load`.
 * `isOk` decides whether a settled value is kept (default: every resolved
 * value; a rejection is never kept). The value kept before this read stays
 * until this one settles ok.
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
    kept: hit?.kept ?? null,
    freshMs: opts.freshMs ?? READ_FRESH_MS,
    stale: false,
  };
  const prior = (): void => {
    if (entry.kept === null) entries.delete(key);
    else entries.set(key, { ...entry, settledAt: 0, value: entry.kept.value, stale: true });
  };
  entry.promise = load().then(
    (value) => {
      if (started === generation && entries.get(key) === entry) {
        if (opts.isOk === undefined || opts.isOk(value)) {
          entry.settledAt = Date.now();
          entry.value = value;
          entry.kept = { value };
        } else {
          prior();
        }
      }
      return value;
    },
    (err: unknown) => {
      if (started === generation && entries.get(key) === entry) prior();
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

/**
 * The last ok value this session read or wrote for `key`, at any age, stale
 * or not, even while a newer read runs; undefined when never kept. What a
 * screen paints on a return. Never reads.
 */
export function peekKept<T>(key: string): T | undefined {
  const kept = entries.get(key)?.kept;
  return kept === null || kept === undefined ? undefined : (kept.value as T);
}

/** Store a value this session just produced (a write's result) as a fresh, kept read. */
export function primeRead<T>(key: string, value: T, freshMs: number = READ_FRESH_MS): void {
  entries.set(key, {
    promise: Promise.resolve(value),
    settledAt: Date.now(),
    value,
    kept: { value },
    freshMs,
    stale: false,
  });
}

/**
 * Mark every key that starts with `prefix` stale (a change event; '' marks
 * all). The kept value stays for the next paint; the next sharedRead reads again.
 */
export function invalidateReads(prefix: string): void {
  for (const [key, entry] of entries) {
    if (key.startsWith(prefix)) entry.stale = true;
  }
}

/** Delete every read of one user's workspace (that workspace was lost: removed or deleted). */
export function dropWorkspaceReads(userId: string, workspaceId: string): void {
  const prefix = readKey(userId, workspaceId, '');
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
  // change): every shared read is marked stale and re-read on next use.
  window.addEventListener(WORKSPACE_DATA_CHANGED_EVENT, () => invalidateReads(''));
}
