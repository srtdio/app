// Device cache: the session reads (src/lib/session-read.ts) saved on this
// device in IndexedDB, so a cold open paints every screen and the shell from
// the last view, then refreshes quietly. One database ("sorted-cache"), one
// store, one record per session-read key.
//
// hydrate(userId) is the only read: once at boot, it returns this user's
// records saved under this build and younger than MAX_AGE_MS, and deletes the
// rest (another build's records wipe everything). put and drop are queued and
// written off the paint path in one batch. Nothing here throws: any
// IndexedDB failure (private mode, quota, blocked) logs once and the app runs
// exactly as it does without the cache.
//
// Keys carry the user id and workspace id first (`${userId}:${workspaceId}:…`;
// an empty workspace id is a user-level record, the shell's own). Chat keys
// are not saved here (part B).

import { mark } from '@/lib/perf-marks';
import { logger } from '@/lib/logger';

export const DB_NAME = 'sorted-cache';
const STORE = 'records';
/** Saved screens are shown up to 72 h old, never older. */
export const MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** A single value larger than this is not saved. */
export const MAX_VALUE_BYTES = 2 * 1024 * 1024;
/** The whole store is held under this; the oldest records go first. */
export const MAX_STORE_BYTES = 50 * 1024 * 1024;
/** Writes wait this long for more writes, then go in one batch when idle. */
export const FLUSH_DELAY_MS = 300;

export interface CacheRecord {
  key: string;
  value: unknown;
  savedAt: number;
  userId: string;
  /** null for a user-level record. */
  workspaceId: string | null;
  appVersion: string;
  /** Approximate size in bytes (JSON length), for the store cap. */
  size: number;
}

/** The storage under the cache. IndexedDB in the app; an in-memory fake in tests. */
export interface CacheBackend {
  getAll(): Promise<CacheRecord[]>;
  putMany(records: CacheRecord[]): Promise<void>;
  deleteKeys(keys: string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  clear(): Promise<void>;
}

/** The build's release id (the value Sentry uses); 'dev' without one. */
export function appVersion(): string {
  const release = (import.meta.env as Record<string, unknown>).VITE_SENTRY_RELEASE;
  return typeof release === 'string' && release !== '' ? release : 'dev';
}

/** The user id and workspace id a key starts with, or null when it has neither. */
export function parseKey(key: string): { userId: string; workspaceId: string | null } | null {
  const first = key.indexOf(':');
  if (first <= 0) return null;
  const second = key.indexOf(':', first + 1);
  if (second < 0) return null;
  const workspaceId = key.slice(first + 1, second);
  return { userId: key.slice(0, first), workspaceId: workspaceId === '' ? null : workspaceId };
}

/** Whether a key is saved on the device: user-scoped, and not a chat store (part B). */
export function isPersistable(key: string): boolean {
  const parsed = parseKey(key);
  if (parsed === null) return false;
  const what = key.slice(key.indexOf(':', key.indexOf(':') + 1) + 1);
  return !what.startsWith('chat');
}

// No IndexedDB at all (an old browser, tests): a quiet no-op, nothing to report.
const MISSING = new Error('indexedDB missing');

const warned = new Set<string>();
function warnOnce(reason: string, error?: unknown): void {
  if (error === MISSING || warned.has(reason)) return;
  warned.add(reason);
  logger.warn('device cache off', {
    reason,
    ...(error !== undefined ? { error: String(error) } : {}),
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The IndexedDB backend. Opens lazily; every call rejects when IndexedDB is unusable. */
export function indexedDbBackend(): CacheBackend {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (opened !== null) return opened;
    opened = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(MISSING);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading closes this one cleanly; the next call reopens.
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    });
    opened.catch(() => {
      opened = null;
    });
    return opened;
  };
  const write = async (run: (store: IDBObjectStore) => void): Promise<void> => {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    run(tx.objectStore(STORE));
    await done(tx);
  };
  return {
    async getAll() {
      const db = await open();
      return request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll()) as Promise<
        CacheRecord[]
      >;
    },
    putMany(records) {
      return write((store) => {
        for (const record of records) {
          try {
            store.put(record);
          } catch (err) {
            // Not structured-clone safe: this one value is skipped.
            warnOnce('value not cloneable', err);
          }
        }
      });
    },
    deleteKeys(keys) {
      return write((store) => {
        for (const key of keys) store.delete(key);
      });
    },
    deletePrefix(prefix) {
      return write((store) => store.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)));
    },
    clear() {
      return write((store) => store.clear());
    },
  };
}

let backend: CacheBackend | null = null;
function getBackend(): CacheBackend {
  if (backend === null) backend = indexedDbBackend();
  return backend;
}

/** Swap the storage (tests). Also resets the queue and the index. */
export function setDeviceCacheBackend(next: CacheBackend | null): void {
  backend = next;
  pending.clear();
  index.clear();
  queue = Promise.resolve();
  epoch += 1;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  warned.clear();
}

// Writes waiting for the next flush: a record to save, or null to delete.
const pending = new Map<string, CacheRecord | null>();
// What this tab knows is stored: key to (savedAt, size), for the store cap.
const index = new Map<string, { savedAt: number; size: number }>();
// Every storage call runs in order on this chain, so a wipe is never undone
// by a write queued before it.
let queue: Promise<void> = Promise.resolve();
// Bumped on every wipe: a hydrate that started before it returns nothing.
let epoch = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function enqueue(run: (store: CacheBackend) => Promise<void>, reason: string): Promise<void> {
  queue = queue.then(
    () => run(getBackend()).catch((err: unknown) => warnOnce(reason, err)),
    () => undefined,
  );
  return queue;
}

function idle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 0);
}

function schedule(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    idle(() => void flushDeviceCache());
  }, FLUSH_DELAY_MS);
}

function sizeOf(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : json.length;
  } catch {
    return null;
  }
}

/** The keys to delete so the store fits under MAX_STORE_BYTES, oldest first. Pure. */
export function overCapKeys(
  entries: ReadonlyMap<string, { savedAt: number; size: number }>,
  cap: number = MAX_STORE_BYTES,
): string[] {
  let total = 0;
  for (const entry of entries.values()) total += entry.size;
  if (total <= cap) return [];
  const oldest = [...entries].sort((a, b) => a[1].savedAt - b[1].savedAt);
  const out: string[] = [];
  for (const [key, entry] of oldest) {
    if (total <= cap) break;
    total -= entry.size;
    out.push(key);
  }
  return out;
}

/** Write every queued put and delete now, in one batch. Never throws. */
export function flushDeviceCache(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return queue;
  const puts: CacheRecord[] = [];
  const deletes: string[] = [];
  for (const [key, record] of pending) {
    if (record === null) {
      deletes.push(key);
      index.delete(key);
      continue;
    }
    const size = sizeOf(record.value);
    if (size === null) {
      warnOnce('value not serialisable');
      continue;
    }
    if (size > MAX_VALUE_BYTES) {
      warnOnce('value over 2 MB');
      continue;
    }
    record.size = size;
    puts.push(record);
    index.set(key, { savedAt: record.savedAt, size });
  }
  pending.clear();
  for (const key of overCapKeys(index)) {
    deletes.push(key);
    index.delete(key);
  }
  if (puts.length > 0) void enqueue((store) => store.putMany(puts), 'write failed');
  if (deletes.length > 0) void enqueue((store) => store.deleteKeys(deletes), 'delete failed');
  return queue;
}

/**
 * This user's saved values: one storage read, at boot. Returns only records
 * for `userId` saved by this build and younger than MAX_AGE_MS; deletes
 * expired ones and other users' ones, and wipes everything when any record
 * is from another build. An empty map on any failure.
 */
export async function hydrate(
  userId: string,
  opts: { nowMs?: number; version?: string } = {},
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const started = epoch;
  const version = opts.version ?? appVersion();
  let records: CacheRecord[] = [];
  mark('device-cache:hydrate:start');
  await enqueue(async (store) => {
    records = await store.getAll();
  }, 'read failed');
  const nowMs = opts.nowMs ?? Date.now();
  if (started !== epoch) return out;
  if (records.some((r) => r.appVersion !== version)) {
    mark('device-cache:hydrated');
    await wipe();
    return out;
  }
  const remove: string[] = [];
  for (const record of records) {
    const expired = nowMs - record.savedAt > MAX_AGE_MS || record.savedAt > nowMs + MAX_AGE_MS;
    if (record.userId !== userId || expired) {
      remove.push(record.key);
      continue;
    }
    // A write this tab already queued is newer than the stored one.
    if (pending.has(record.key)) continue;
    index.set(record.key, { savedAt: record.savedAt, size: record.size ?? 0 });
    out.set(record.key, record.value);
  }
  if (remove.length > 0) void enqueue((store) => store.deleteKeys(remove), 'delete failed');
  mark('device-cache:hydrated');
  return out;
}

/** Save `value` under `key` (queued, written off the paint path). Skips keys that are not saved. */
export function put(key: string, value: unknown, nowMs: number = Date.now()): void {
  if (!isPersistable(key)) return;
  const parsed = parseKey(key);
  if (parsed === null) return;
  pending.set(key, {
    key,
    value,
    savedAt: nowMs,
    userId: parsed.userId,
    workspaceId: parsed.workspaceId,
    appVersion: appVersion(),
    size: 0,
  });
  schedule();
}

/** The workspace ids this tab knows have saved records for `userId` (stored or queued). */
export function savedWorkspaceIds(userId: string): string[] {
  const out = new Set<string>();
  for (const key of [...index.keys(), ...pending.keys()]) {
    const parsed = parseKey(key);
    if (parsed !== null && parsed.userId === userId && parsed.workspaceId !== null) {
      out.add(parsed.workspaceId);
    }
  }
  return [...out];
}

/** Delete every saved record whose key starts with `prefix`. */
export function drop(prefix: string): Promise<void> {
  for (const key of [...pending.keys()]) {
    if (key.startsWith(prefix)) pending.delete(key);
  }
  for (const key of [...index.keys()]) {
    if (key.startsWith(prefix)) index.delete(key);
  }
  return enqueue((store) => store.deletePrefix(prefix), 'delete failed');
}

/** Delete everything saved on this device (sign-out, account switch, new build). */
export function wipe(): Promise<void> {
  epoch += 1;
  pending.clear();
  index.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  return enqueue((store) => store.clear(), 'wipe failed');
}

/**
 * The user id in supabase-js's stored session (the sb-*-auth-token key), or
 * null. Read at boot only, so the cache can start before the auth client
 * loads. Never throws.
 */
export function storedSessionUserId(storage: Storage | null = safeLocalStorage()): string | null {
  if (storage === null) return null;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === null || !key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const parsed = JSON.parse(raw) as { user?: { id?: unknown } } | null;
      const id = parsed?.user?.id;
      if (typeof id === 'string' && id !== '') return id;
    }
  } catch {
    return null;
  }
  return null;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// Closing the tab or the app writes what is queued (best effort).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushDeviceCache());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushDeviceCache();
  });
}
