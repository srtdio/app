// Reads shared within this tab session. A keyed read started anywhere (a nav press, a card press, a
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
// Kept values are also saved on this device (src/lib/device-cache.ts,
// IndexedDB, never localStorage): every ok settle and primeRead is saved, and
// a cold open seeds the saved values back as kept but stale
// (hydrateSessionReads), so peekKept paints them at once and the first
// sharedRead still reads fresh. Signout and an account switch wipe the device
// copy too; losing a workspace drops its saved keys; invalidateReads leaves
// them (the kept value is still what the next visit paints).
//
// Keys always carry the user id and workspace id first
// (`${userId}:${workspaceId}:<what>`), so one person's rows are never served
// to another and RLS still decides every read that actually runs.

import { SIGNOUT_EVENT, WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';
import * as deviceCache from '@/lib/device-cache';

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
          deviceCache.put(key, value);
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
  deviceCache.put(key, value);
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
  void deviceCache.drop(prefix);
}

/**
 * Keep only the reads of `workspaceIds` for this user (a fresh workspace list
 * landed): every other workspace's reads are deleted, here and on the device.
 * User-level keys (empty workspace id) stay.
 */
export function retainWorkspaceReads(userId: string, workspaceIds: readonly string[]): void {
  const keep = new Set(workspaceIds);
  const lost = new Set<string>();
  for (const key of entries.keys()) {
    const parsed = deviceCache.parseKey(key);
    if (parsed === null || parsed.userId !== userId || parsed.workspaceId === null) continue;
    if (!keep.has(parsed.workspaceId)) lost.add(parsed.workspaceId);
  }
  for (const id of deviceCache.savedWorkspaceIds(userId)) {
    if (!keep.has(id)) lost.add(id);
  }
  for (const id of lost) dropWorkspaceReads(userId, id);
}

// The user whose values this tab holds (seeded at boot or signed in), for the
// account-switch wipe.
let heldUserId: string | null = null;
const hydratedListeners = new Set<() => void>();
let hydratedFor: string | null = null;

/**
 * Seed this user's saved values (device cache) as kept but stale: peekKept
 * paints them, the first sharedRead still reads. A value this tab already
 * holds is never overwritten; a read still running with no value takes the
 * saved one as its kept value. Started at boot, in parallel with the boot imports;
 * nothing waits on it. Never throws.
 */
export async function hydrateSessionReads(userId: string): Promise<void> {
  heldUserId = userId;
  const started = generation;
  const saved = await deviceCache.hydrate(userId);
  if (started !== generation || heldUserId !== userId) return;
  for (const [key, value] of saved) {
    const held = entries.get(key);
    if (held !== undefined) {
      // A read that started before the seed (a screen mounted on a cold open)
      // and has no value yet: the saved one becomes its kept value, so the
      // screen paints it now. The read still lands over it; a failed one
      // leaves it kept but stale.
      if (held.kept === null) held.kept = { value };
      continue;
    }
    entries.set(key, {
      promise: Promise.resolve(value),
      settledAt: 0,
      value,
      kept: { value },
      freshMs: READ_FRESH_MS,
      stale: true,
    });
  }
  hydratedFor = userId;
  for (const listener of [...hydratedListeners]) listener();
}

/** The user whose saved values were seeded, or null (none yet, or wiped since). */
export function hydratedUserId(): string | null {
  return hydratedFor;
}

/** Call `listener` once the device cache has seeded (late hydrate). Returns unsubscribe. */
export function onSessionReadsHydrated(listener: () => void): () => void {
  hydratedListeners.add(listener);
  return () => hydratedListeners.delete(listener);
}

/**
 * An auth event: a sign-in as a different user than the one this tab holds
 * wipes everything first (memory and device); a sign-out wipes too (paths
 * that sign out without SIGNOUT_EVENT).
 */
export function noteAuthUser(event: string, userId: string | null): void {
  if (event === 'SIGNED_OUT') {
    resetSessionReads();
    return;
  }
  if (userId === null) return;
  if (heldUserId !== null && heldUserId !== userId) resetSessionReads();
  heldUserId = userId;
}

/** Drop everything, here and on the device (signout; account switch; tests). */
export function resetSessionReads(): void {
  generation += 1;
  entries.clear();
  heldUserId = null;
  hydratedFor = null;
  void deviceCache.wipe();
}

if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, resetSessionReads);
  // Rows changed under every open screen (the tour's sample week, a member
  // change): every shared read is marked stale and re-read on next use.
  window.addEventListener(WORKSPACE_DATA_CHANGED_EVENT, () => invalidateReads(''));
}
