// Small per-device caches kept in localStorage so a reopened app paints at once:
// the chat lists' post covers and their small pictures' signed URLs. Both are
// conveniences only: every read is wrapped (private mode, full or blocked
// storage just means no cache), entries are capped, and both are wiped on
// sign-out so the next person on this device starts clean.

import type {
  LinkKeyStore,
  PresignedUrl,
  StoredLinkKey,
  ThumbnailUrlStore,
} from '@/lib/asset-presign';
import { SIGNOUT_EVENT } from '@/lib/events';

/** Most entries a cache keeps; the newest win. */
export const LOCAL_CACHE_MAX_ENTRIES = 600;

export const THUMB_URLS_KEY = 'sorted:thumb-urls:v1';
export const POST_COVERS_KEY = 'sorted:post-covers:v1';
export const LINK_KEY_KEY = 'sorted:file-link-key:v1';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Parse a stored array of [key, value] pairs; anything malformed is an empty cache. Pure. */
export function parseEntries<T>(
  raw: string | null,
  isValue: (value: unknown) => value is T,
): Array<[string, T]> {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is [string, T] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        isValue(entry[1]),
    );
  } catch {
    return [];
  }
}

/** Read a cache's entries; [] when storage is unavailable. */
export function readEntries<T>(
  key: string,
  isValue: (value: unknown) => value is T,
): Array<[string, T]> {
  const store = storage();
  if (store === null) return [];
  try {
    return parseEntries(store.getItem(key), isValue);
  } catch {
    return [];
  }
}

/** Write a cache's newest LOCAL_CACHE_MAX_ENTRIES entries; a failed write is ignored. */
export function writeEntries<T>(key: string, entries: ReadonlyArray<readonly [string, T]>): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(key, JSON.stringify(entries.slice(-LOCAL_CACHE_MAX_ENTRIES)));
  } catch {
    // Full or blocked storage: the cache is a convenience, the app works without it.
  }
}

/** Wipe every device cache this module owns. */
export function clearLocalCaches(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(THUMB_URLS_KEY);
    store.removeItem(POST_COVERS_KEY);
    store.removeItem(LINK_KEY_KEY);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

let watchingSignOut = false;

/** Wipe the caches on sign-out (registered once, on first use). */
export function clearLocalCachesOnSignOut(): void {
  if (watchingSignOut || typeof window === 'undefined') return;
  watchingSignOut = true;
  window.addEventListener(SIGNOUT_EVENT, clearLocalCaches);
}

function isPresignedUrl(value: unknown): value is PresignedUrl {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { url?: unknown; expiresAt?: unknown };
  return typeof v.url === 'string' && typeof v.expiresAt === 'number';
}

/** The small pictures' signed URLs, kept on this device until they expire. */
export const localThumbnailUrlStore: ThumbnailUrlStore = {
  load: () => {
    clearLocalCachesOnSignOut();
    return readEntries(THUMB_URLS_KEY, isPresignedUrl);
  },
  save: (entries) => {
    const now = Date.now();
    writeEntries(
      THUMB_URLS_KEY,
      entries.filter(([, url]) => url.expiresAt > now),
    );
  },
};

/** Parse a stored link key; anything malformed is no key. Pure. */
export function parseLinkKey(raw: string | null): StoredLinkKey | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const v = parsed as { key?: unknown; expiresAt?: unknown };
    return typeof v.key === 'string' && v.key !== '' && typeof v.expiresAt === 'number'
      ? { key: v.key, expiresAt: v.expiresAt }
      : null;
  } catch {
    return null;
  }
}

/** The day's file link key, kept on this device (wiped on sign-out). */
export const localLinkKeyStore: LinkKeyStore = {
  load: () => {
    clearLocalCachesOnSignOut();
    const store = storage();
    if (store === null) return null;
    try {
      return parseLinkKey(store.getItem(LINK_KEY_KEY));
    } catch {
      return null;
    }
  },
  save: (key) => {
    const store = storage();
    if (store === null) return;
    try {
      if (key === null) store.removeItem(LINK_KEY_KEY);
      else store.setItem(LINK_KEY_KEY, JSON.stringify(key));
    } catch {
      // Full or blocked storage: the key is minted again next time.
    }
  },
};
