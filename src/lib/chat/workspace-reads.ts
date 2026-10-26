// The workspace-wide reads a chat open makes, shared by every chat in this tab
// session: the open posts list and its count (useOpenPosts), the current
// shared plan ids, the open briefs list and its count (useStatusCounts). They
// are the same in every chat of a workspace, so opening chat B right after A
// joins A's reads instead of asking again.
//
// They go through the session read store (src/lib/session-read.ts): in memory
// only, keyed by user id and workspace id, joined while running and for
// READ_FRESH_MS after settling ok. Older than that is absent: the open loads
// and holds its first paint as a cold open does, never painting the old
// answer. A failed read is never kept.
//
// Refreshed by the change events the hooks already refetch on: this module
// drops the keys first (its listeners are added when the module loads, before
// any hook's effect adds its own, so a hook's refetch never joins the read the
// event made old), then each mounted hook's refetch reads once and every other
// consumer joins that read. A post change drops all five (the ticker refetches
// on it too); a plan change drops the three ticker reads; a
// workspace-data-changed event (a brief closed or reopened) drops every
// session read already (session-read.ts).

import { invalidateReads, peekRead, readKey, sharedRead } from '@/lib/session-read';
import { POST_CHANGED_EVENT } from '@/components/chat/post-card';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';

/** The five shared reads, by what the key names. */
export type ChatWorkspaceRead = 'openPosts' | 'planIds' | 'briefs' | 'briefCount';

/** Which event drops a read: the ticker's three on a plan change too. */
const TICKER_READS: ReadonlySet<ChatWorkspaceRead> = new Set(['planIds', 'briefs', 'briefCount']);

/** Every key made this session, by read (the events drop exactly these). */
const made = new Map<string, ChatWorkspaceRead>();

/** The session read key of one of the shared reads. */
export function chatWorkspaceReadKey(
  userId: string,
  workspaceId: string,
  what: ChatWorkspaceRead,
): string {
  return readKey(userId, workspaceId, `chat-open:${what}`);
}

/**
 * Join the shared read when it runs or settled ok within the window, else
 * start `load`. `isOk` decides whether the settled value is kept for others.
 */
export function sharedChatRead<T>(
  userId: string,
  workspaceId: string,
  what: ChatWorkspaceRead,
  load: () => Promise<T>,
  isOk: (value: T) => boolean,
): Promise<T> {
  const key = chatWorkspaceReadKey(userId, workspaceId, what);
  made.set(key, what);
  return sharedRead(key, load, { isOk });
}

/** The shared read's settled ok value while fresh, else undefined (never reads). */
export function peekChatRead<T>(
  userId: string,
  workspaceId: string,
  what: ChatWorkspaceRead,
): T | undefined {
  return peekRead<T>(chatWorkspaceReadKey(userId, workspaceId, what));
}

/** A Result read is kept only when it succeeded. */
export function resultOk(value: { ok: boolean }): boolean {
  return value.ok;
}

/** Drop the shared reads a change made old (`only`: those reads; else all). */
export function invalidateChatReads(only?: ReadonlySet<ChatWorkspaceRead>): void {
  for (const [key, what] of [...made]) {
    if (only !== undefined && !only.has(what)) continue;
    // The key is exact: nothing else starts with `${userId}:${ws}:chat-open:<what>`.
    invalidateReads(key);
    made.delete(key);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(POST_CHANGED_EVENT, () => invalidateChatReads());
  window.addEventListener(PLAN_CHANGED_EVENT, () => invalidateChatReads(TICKER_READS));
}
