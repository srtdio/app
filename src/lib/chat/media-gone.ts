// Messages whose media must never surface again on this device: messages
// deleted for everyone (a tombstone in the thread) and messages hidden for me
// once that hide is committed (chat_messages_hide held; a hide still inside
// its Undo window is the hides store's local set, filtered at render by
// MediaResults, so an Undo brings its items back).
//
// A tiny subscribable id set, no reads, no awaits: the chat home chips
// (media-items flatten), the device-cached first page (media-cache-drop.ts),
// the search runner's loaded hits (search.ts) and the chat info tabs
// (channel-media.ts) all skip these ids with one Set lookup per item.
//
// Kept pure of React, the Supabase client and session-read so the pure
// modules that import it stay importable in node tests.

import { SIGNOUT_EVENT } from '@/lib/events';

const gone = new Set<string>();
const listeners = new Set<() => void>();

/** Whether a message's media must not surface (deleted for everyone, or hidden for me and committed). */
export function isMediaGone(messageId: string): boolean {
  return gone.has(messageId);
}

/** Add these message ids; listeners hear once when any id is new. Returns whether any was. */
export function markMediaGone(messageIds: readonly string[]): boolean {
  let changed = false;
  for (const id of messageIds) {
    if (id === '' || gone.has(id)) continue;
    gone.add(id);
    changed = true;
  }
  if (changed) for (const listener of [...listeners]) listener();
  return changed;
}

/** Listen for new gone ids. Returns unsubscribe. */
export function subscribeMediaGone(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keep only items whose message is not gone; the same array when nothing goes. */
export function withoutGone<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  if (gone.size === 0) return items as T[];
  let dropped = false;
  const kept = items.filter((item) => {
    const keep = !gone.has(idOf(item));
    if (!keep) dropped = true;
    return keep;
  });
  return dropped ? kept : (items as T[]);
}

/** Forget every gone id (sign-out; tests). */
export function resetMediaGone(): void {
  gone.clear();
}

if (typeof window !== 'undefined') window.addEventListener(SIGNOUT_EVENT, resetMediaGone);
