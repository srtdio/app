// Whether the last older-page load of a list failed (FT41), keyed by list
// ("channel:<id>" for a chat, "thread:<rootId>" for a thread view). The
// loaders (use-chat-thread, use-thread-view) write it; the thread body reads
// it to show "Couldn't load earlier messages." with a Retry in place of the
// Load older row. In memory only; a new attempt clears it.

import { useSyncExternalStore } from 'react';

const failed = new Set<string>();
const listeners = new Set<() => void>();

export const OLDER_LOAD_FAILED = "Couldn't load earlier messages.";

export function channelOlderKey(channelId: string): string {
  return `channel:${channelId}`;
}

export function threadOlderKey(rootId: string): string {
  return `thread:${rootId}`;
}

/** Record the outcome of an older-page load (true: it failed). */
export function setOlderPageFailed(key: string, value: boolean): void {
  if (failed.has(key) === value) return;
  if (value) failed.add(key);
  else failed.delete(key);
  for (const listener of listeners) listener();
}

export function olderPageFailed(key: string | null): boolean {
  return key !== null && failed.has(key);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The list's failed flag, re-read on every change. Null key: never failed. */
export function useOlderPageFailed(key: string | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => olderPageFailed(key),
    () => false,
  );
}

/** Test seam. */
export function resetOlderPageStatus(): void {
  failed.clear();
  for (const listener of listeners) listener();
}
