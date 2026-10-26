// The bytes behind unrecorded sends. localStorage keeps a pending send's text
// and attachment fields (chat-store.ts) but cannot hold a File, so the picked
// files and recorded voice notes of pending outbox entries are kept here, in
// IndexedDB, keyed by entry id + attachment index. On boot the provider reads
// them back onto the restored entries so their uploads resume; a send whose
// blob is gone (or a browser with no usable IndexedDB) falls back to the
// filesMissing state ("Photos not sent", Remove only).
//
// Blobs are deleted when their entry leaves the outbox (recorded, settled by
// catch-up, removed, chat dropped) and all of them on sign-out; blobs of
// entries no longer in the persisted outbox are pruned on boot.
//
// The store sits behind a small adapter so tests drive a fake. Every call here
// is wrapped: nothing throws, a failure only means "no file" (null / false).

import type { MessageAttachment } from '@/lib/chat/attachments';
import type { OutboxEntry } from '@/lib/chat/chat-store';

/** One stored file: the bytes plus what rebuilding the File needs. */
export interface StoredOutboxFile {
  entryId: string;
  index: number;
  name: string;
  type: string;
  lastModified: number;
  blob: Blob;
}

/** The key/value slice of IndexedDB the file store uses. Methods may reject. */
export interface OutboxFileAdapter {
  put: (key: string, value: StoredOutboxFile) => Promise<void>;
  get: (key: string) => Promise<StoredOutboxFile | undefined>;
  keys: () => Promise<string[]>;
  delete: (keys: readonly string[]) => Promise<void>;
  clear: () => Promise<void>;
  /** Release the connection (provider teardown). */
  close: () => void;
}

/** The key of one attachment's bytes. */
export function outboxFileKey(entryId: string, index: number): string {
  return `${entryId}:${index}`;
}

/** The entry id a key belongs to. */
function entryIdOf(key: string): string {
  const cut = key.lastIndexOf(':');
  return cut === -1 ? key : key.slice(0, cut);
}

/** True when an attachment's bytes still have to be uploaded (no version id yet). */
function needsFile(attachment: MessageAttachment): boolean {
  return attachment.assetId === '';
}

/**
 * Keep the files of one just-queued entry (each attachment with a local file
 * and no version id). True when every such file was stored; false on any
 * failure or with no store.
 */
export async function saveOutboxFiles(
  adapter: OutboxFileAdapter | null,
  entry: Pick<OutboxEntry, 'id' | 'local'>,
): Promise<boolean> {
  if (adapter === null) return false;
  try {
    const writes: Promise<void>[] = [];
    entry.local.attachments.forEach((attachment, index) => {
      const file = attachment.local?.file ?? null;
      if (!needsFile(attachment) || file === null) return;
      writes.push(
        adapter.put(outboxFileKey(entry.id, index), {
          entryId: entry.id,
          index,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          blob: file,
        }),
      );
    });
    await Promise.all(writes);
    return true;
  } catch {
    return false;
  }
}

/** Reading a restored entry's files back gives up after this long (filesMissing). */
export const RESTORE_TIMEOUT_MS = 5_000;

/**
 * A restored entry's attachments with their files read back: each attachment
 * without a version id gets its File (and a preview when `previewFor` makes
 * one). Null when the store is unavailable, any file is missing or
 * unreadable, or the read takes longer than `timeoutMs`: the filesMissing
 * fallback, so a restoring entry never holds its chat's queue for longer.
 * Previews are made only once every file is back in time.
 */
export async function restoreOutboxFiles(
  adapter: OutboxFileAdapter | null,
  entry: Pick<OutboxEntry, 'id' | 'local'>,
  previewFor: (file: File) => string | null = () => null,
  timeoutMs: number = RESTORE_TIMEOUT_MS,
): Promise<MessageAttachment[] | null> {
  if (adapter === null) return null;
  const read = async (): Promise<(StoredOutboxFile | null)[] | null> => {
    const attachments = entry.local.attachments;
    const stored: (StoredOutboxFile | null)[] = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      if (attachment === undefined) return null;
      if (!needsFile(attachment)) {
        stored.push(null);
        continue;
      }
      const found = await adapter.get(outboxFileKey(entry.id, index));
      if (found === undefined || !(found.blob instanceof Blob)) return null;
      stored.push(found);
    }
    return stored;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  let stored: (StoredOutboxFile | null)[] | null;
  try {
    stored = await Promise.race([read().catch(() => null), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (stored === null) return null;
  try {
    return entry.local.attachments.map((attachment, index) => {
      const found = stored[index] ?? null;
      if (found === null) return attachment;
      const file = new File([found.blob], found.name, {
        type: found.type,
        lastModified: found.lastModified,
      });
      return {
        ...attachment,
        local: {
          key: `restored-${outboxFileKey(entry.id, index)}`,
          file,
          previewUrl: previewFor(file),
          progress: 0,
        },
      };
    });
  } catch {
    return null;
  }
}

/** Drop every stored file of these entries. Never throws. */
export async function deleteOutboxFiles(
  adapter: OutboxFileAdapter | null,
  entryIds: readonly string[],
): Promise<void> {
  if (adapter === null || entryIds.length === 0) return;
  try {
    const drop = new Set(entryIds);
    const keys = (await adapter.keys()).filter((key) => drop.has(entryIdOf(key)));
    if (keys.length > 0) await adapter.delete(keys);
  } catch {
    // Nothing more to do: an orphan is pruned on the next boot.
  }
}

/**
 * Drop the files of every entry `keep` rejects (boot: not in the persisted
 * outbox and not queued since). `keep` is asked after the keys are read, so a
 * send queued while the prune runs keeps its files. Never throws.
 */
export async function pruneOutboxFiles(
  adapter: OutboxFileAdapter | null,
  keep: (entryId: string) => boolean,
): Promise<void> {
  if (adapter === null) return;
  try {
    const keys = (await adapter.keys()).filter((key) => !keep(entryIdOf(key)));
    if (keys.length > 0) await adapter.delete(keys);
  } catch {
    // Unreadable store: leave it.
  }
}

/** Sign-out: no pending file outlives the session. Never throws. */
export async function clearOutboxFiles(adapter: OutboxFileAdapter | null): Promise<void> {
  if (adapter === null) return;
  try {
    await adapter.clear();
  } catch {
    // Blocked store has nothing to clear.
  }
}

/** The IndexedDB database and object store the files live in. */
const OUTBOX_FILES_DB = 'sorted-chat-outbox-files';
const STORE = 'files';

/** Settle a request's promise from its transaction (completion, error or abort). */
function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = body(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request === null ? undefined : request.result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * The real adapter over IndexedDB, or null where there is none (or it throws
 * on access). The connection opens on first use; close() refuses new calls and
 * closes it once the calls already running have settled (so a sign-out clear
 * started just before teardown still completes). Another tab upgrading the
 * database closes it too.
 */
export function openIndexedDbFiles(factory?: IDBFactory): OutboxFileAdapter | null {
  let idb: IDBFactory;
  try {
    const found = factory ?? globalThis.indexedDB;
    if (found === undefined || found === null) return null;
    idb = found;
  } catch {
    return null;
  }
  let closing = false;
  let running = 0;
  let opening: Promise<IDBDatabase> | null = null;
  let opened: IDBDatabase | null = null;
  const release = (): void => {
    if (!closing || running > 0) return;
    opened?.close();
    opened = null;
  };
  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(OUTBOX_FILES_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          if (opened === db) opened = null;
          opening = null;
        };
        opened = db;
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    // A failed open is retried on the next call.
    opening.catch(() => {
      opening = null;
    });
    return opening;
  };
  /** One call: refused once closing; the connection closes after the last one settles. */
  const call = async <T>(work: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    if (closing) throw new Error('outbox files closed');
    running += 1;
    try {
      return await work(await open());
    } finally {
      running -= 1;
      release();
    }
  };
  return {
    put: (key, value) =>
      call(async (db) => {
        await run(db, 'readwrite', (store) => store.put(value, key));
      }),
    get: (key) =>
      call(async (db) => {
        const value = await run<unknown>(db, 'readonly', (store) => store.get(key));
        return value as StoredOutboxFile | undefined;
      }),
    keys: () =>
      call(async (db) => {
        const keys = await run(db, 'readonly', (store) => store.getAllKeys());
        return (keys ?? []).filter((key): key is string => typeof key === 'string');
      }),
    delete: (keys) =>
      call(async (db) => {
        await run(db, 'readwrite', (store) => {
          for (const key of keys) store.delete(key);
          return null;
        });
      }),
    clear: () =>
      call(async (db) => {
        await run(db, 'readwrite', (store) => store.clear());
      }),
    close: () => {
      closing = true;
      release();
    },
  };
}
