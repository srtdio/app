// Deleted messages leave the chat home chips' device-cached first pages
// (`chat:media:{kind}`, saved by ChannelList) at once: on Delete for everyone
// (every path the open thread reports: own delete, a live delete signal, a
// re-read that finds tombstones) and on Delete for me once its write holds.
// Each saved page is rewritten without the messages' items (primeRead also
// puts it on the device), so the next chip tap never paints them. No read,
// no await: a peek, a filter and a put per chip.

import { peekKept, primeRead, readKey } from '@/lib/session-read';
import { isMediaCacheValue, mediaCacheWhat } from '@/lib/chat/media-items';
import { markMediaGone } from '@/lib/chat/media-gone';
import type { SearchKind } from '@/lib/chat/search';

/** Every chip with a saved first page. */
export const MEDIA_CACHE_KINDS: readonly SearchKind[] = ['photo', 'video', 'link', 'file', 'voice'];

/** Rewrite each chip's saved first page without these messages' items. */
export function dropFromMediaCaches(
  userId: string,
  workspaceId: string,
  messageIds: readonly string[],
): void {
  if (messageIds.length === 0) return;
  const ids = new Set(messageIds);
  for (const kind of MEDIA_CACHE_KINDS) {
    const key = readKey(userId, workspaceId, mediaCacheWhat(kind));
    const raw = peekKept<unknown>(key);
    if (!isMediaCacheValue(raw, kind)) continue;
    const items = raw.items.filter((item) => !ids.has(item.messageId));
    if (items.length !== raw.items.length) primeRead(key, { kind, items });
  }
}

/**
 * Messages left for good (deleted for everyone, or hidden for me and written):
 * mark them gone (every chip, the runner's hits and the chat info tabs skip
 * them) and drop them from the saved first pages when the user and workspace
 * are known.
 */
export function mediaMessagesGone(input: {
  userId: string | null | undefined;
  workspaceId: string | null | undefined;
  messageIds: readonly string[];
}): void {
  if (input.messageIds.length === 0) return;
  // The cache first: the gone listeners re-render the chat home, which re-peeks it.
  if (input.userId != null && input.workspaceId != null) {
    dropFromMediaCaches(input.userId, input.workspaceId, input.messageIds);
  }
  markMediaGone(input.messageIds);
}
