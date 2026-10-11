// What a chat open starts and what it leaves behind, for this tab session only.
//
// Reads started at the tap (kickoffChatOpen in ChatConnected) are stashed here
// per chat and joined by the hooks' first round, so a read the tap started is
// never asked again by the thread's mount (one read per open, StrictMode's
// double mount included). A stashed read can be joined while it runs and for
// JOIN_WINDOW_MS after it settles; only an open's first round joins, never a
// refetch (a plan change, a post change, a tab returning).
//
// The last settled state of each chat (marks, ticker counts, scheduled rows,
// the plan card cache with its bundles and draft rows) is remembered so a
// reopen paints it at once and then revalidates in the background. Memory is
// keyed by user id, workspace id and channel id, capped at OPEN_CACHE_LIMIT
// chats (least recently used goes first), never persisted, and cleared in
// full when the user or the workspace changes (checked on every access, so a
// sign-out that never fired the event still never shows the next user the
// last one's chats) and on sign-out (the auth state change and the sorted
// sign-out event, listened to while anything is held). RLS still decides
// every fresh read. A remembered plan card cache outlives its chat's screen
// (its reads and retries run on, so a reopen finds them in); eviction and
// every clear dispose it, its timers included.

import type { Result } from '@srtdio/rpc';
import type { ChatMark } from '@/lib/chat/marks';
import { createPlanCardCache, readPlanBundles, type PlanCardCache } from '@/lib/chat/plans';
import type { OpenPostsData, OpenPostsView } from '@/lib/chat/use-open-posts';
import type { StatusReadResults, StatusRoundView } from '@/lib/chat/use-status-counts';
import type { ThreadMessage } from '@/lib/chat/thread';
import { clearMessagePrefetch } from '@/lib/chat/history';
import { resetViewerSideCache } from '@/lib/chat/viewer-role';
import { SIGNOUT_EVENT } from '@/lib/events';
import { supabase } from '@/lib/supabase';

/** Chats remembered per session (least recently opened goes first). */
export const OPEN_CACHE_LIMIT = 20;
/** How long after it settles a read started at the tap can still be joined. */
export const JOIN_WINDOW_MS = 2_000;
/** The longest a chat open holds its first paint for the parts still loading. */
export const OPEN_HOLD_MS = 1_000;

/** Whose chat: the memory and every stashed read are keyed by all three. */
export interface ChatKey {
  userId: string;
  workspaceId: string;
  channelId: string;
}

/** The reads an open starts at the tap, by name. */
export interface OpenReads extends StatusReadResults {
  marks: Result<ChatMark[]>;
  openPosts: OpenPostsData;
}

/** A chat's last settled state. */
export interface ChatMemory {
  marks: { marks: Map<string, ChatMark>; markedMessages: Map<string, ThreadMessage> };
  openPosts: OpenPostsView;
  status: StatusRoundView;
}

interface Stashed {
  promise: Promise<unknown>;
  settledAt: number | null;
}

interface Slot {
  memory: Partial<ChatMemory>;
  reads: Map<keyof OpenReads, Stashed>;
  planCache: PlanCardCache | null;
  /** When this chat was last opened (tap or mount), for the hold and the plan revalidation. */
  openedAt: number | null;
}

export interface OpenCache {
  /** Remember a part of a chat's settled state. */
  remember: <K extends keyof ChatMemory>(key: ChatKey, part: K, value: ChatMemory[K]) => void;
  /** A part of a chat's last settled state, or undefined. */
  recall: <K extends keyof ChatMemory>(key: ChatKey, part: K) => ChatMemory[K] | undefined;
  /** Stash a read the tap started (replaces one that can no longer be joined). */
  stash: <K extends keyof OpenReads>(key: ChatKey, name: K, promise: Promise<OpenReads[K]>) => void;
  /** The stashed read while it runs or for JOIN_WINDOW_MS after; null otherwise. */
  join: <K extends keyof OpenReads>(key: ChatKey, name: K) => Promise<OpenReads[K]> | null;
  /**
   * An open's first round: the stashed read when one can be joined, else
   * `start()` stashed (so StrictMode's second mount, or the next hook of the
   * same open, joins it rather than reading again).
   */
  joinOrStart: <T>(key: ChatKey, name: keyof OpenReads, start: () => Promise<T>) => Promise<T>;
  /** Whether a read of this name can be joined (a tap already started it). */
  joinable: (key: ChatKey, name: keyof OpenReads) => boolean;
  /** This chat's plan card cache, made once and kept while the chat is remembered. */
  planCache: (key: ChatKey, make: () => PlanCardCache) => PlanCardCache;
  /** Note an open; true when it is a new one (none within JOIN_WINDOW_MS). */
  opened: (key: ChatKey) => boolean;
  /** When this chat was last opened, or null. */
  openedAt: (key: ChatKey) => number | null;
  /** Forget everything (each plan cache is disposed). */
  clear: () => void;
  /** Chats held (tests). */
  size: () => number;
  /** The user whose chats are held, or null. */
  heldUser: () => string | null;
  /** Called after every clear that dropped something (the module stops listening). */
  onEmpty: (listener: () => void) => void;
  /** Called on the first chat held after empty (the module starts listening). */
  onHeld: (listener: () => void) => void;
}

function slotKey(key: ChatKey): string {
  return `${key.userId}\n${key.workspaceId}\n${key.channelId}`;
}

/** The store itself; the module holds one, tests make their own. */
export function createOpenCache(
  opts: { limit?: number; now?: () => number; onClear?: () => void } = {},
): OpenCache {
  const limit = opts.limit ?? OPEN_CACHE_LIMIT;
  const now = opts.now ?? (() => Date.now());
  const slots = new Map<string, Slot>();
  let scope: { userId: string; workspaceId: string } | null = null;
  const emptyListeners: Array<() => void> = [];
  const heldListeners: Array<() => void> = [];

  const clear = (): void => {
    const had = slots.size > 0;
    for (const slot of slots.values()) slot.planCache?.dispose();
    slots.clear();
    scope = null;
    opts.onClear?.();
    if (had) for (const l of emptyListeners) l();
  };

  /** Another user or workspace than the one held: everything held goes first. */
  const enter = (key: ChatKey): void => {
    if (scope !== null && (scope.userId !== key.userId || scope.workspaceId !== key.workspaceId)) {
      clear();
    }
    scope = { userId: key.userId, workspaceId: key.workspaceId };
  };

  /** The chat's slot (made when `make`), moved to the most recently used end. */
  function slotOf(key: ChatKey, make: true): Slot;
  function slotOf(key: ChatKey, make: false): Slot | undefined;
  function slotOf(key: ChatKey, make: boolean): Slot | undefined {
    enter(key);
    const k = slotKey(key);
    let slot = slots.get(k);
    if (slot !== undefined) {
      slots.delete(k);
      slots.set(k, slot);
      return slot;
    }
    if (!make) return undefined;
    slot = { memory: {}, reads: new Map(), planCache: null, openedAt: null };
    const wasEmpty = slots.size === 0;
    slots.set(k, slot);
    while (slots.size > limit) {
      const oldest = slots.keys().next().value;
      if (oldest === undefined) break;
      slots.get(oldest)?.planCache?.dispose();
      slots.delete(oldest);
    }
    if (wasEmpty) for (const l of heldListeners) l();
    return slot;
  }

  const live = (s: Stashed): boolean =>
    s.settledAt === null || now() - s.settledAt < JOIN_WINDOW_MS;

  const stash = <K extends keyof OpenReads>(
    key: ChatKey,
    name: K,
    promise: Promise<OpenReads[K]>,
  ): void => {
    const slot = slotOf(key, true);
    const prev = slot.reads.get(name);
    if (prev !== undefined && live(prev)) return;
    const entry: Stashed = { promise, settledAt: null };
    slot.reads.set(name, entry);
    const settle = (): void => {
      entry.settledAt = now();
    };
    void promise.then(settle, settle);
  };

  const join = <K extends keyof OpenReads>(key: ChatKey, name: K): Promise<OpenReads[K]> | null => {
    const entry = slotOf(key, false)?.reads.get(name);
    if (entry === undefined || !live(entry)) return null;
    return entry.promise as Promise<OpenReads[K]>;
  };

  return {
    remember(key, part, value) {
      slotOf(key, true).memory[part] = value;
    },
    recall(key, part) {
      return slotOf(key, false)?.memory[part];
    },
    stash,
    join,
    joinOrStart<T>(key: ChatKey, name: keyof OpenReads, start: () => Promise<T>): Promise<T> {
      // What is stashed under a name is always that name's read.
      const joined = join(key, name) as Promise<T> | null;
      if (joined !== null) return joined;
      const promise = start();
      stash(key, name, promise as Promise<OpenReads[typeof name]>);
      return promise;
    },
    joinable(key, name) {
      return join(key, name) !== null;
    },
    planCache(key, make) {
      const slot = slotOf(key, true);
      slot.planCache ??= make();
      return slot.planCache;
    },
    opened(key) {
      const slot = slotOf(key, true);
      const at = now();
      const fresh = slot.openedAt === null || at - slot.openedAt >= JOIN_WINDOW_MS;
      if (fresh) slot.openedAt = at;
      return fresh;
    },
    openedAt(key) {
      return slotOf(key, false)?.openedAt ?? null;
    },
    clear,
    size: () => slots.size,
    heldUser: () => (slots.size > 0 ? (scope?.userId ?? null) : null),
    onEmpty: (l) => void emptyListeners.push(l),
    onHeld: (l) => void heldListeners.push(l),
  };
}

/**
 * The tab's one store. A clear also forgets the other module-level stores a
 * chat open fills: the viewer side per workspace and the prefetched pages.
 */
export const openCache = createOpenCache({
  onClear: () => {
    resetViewerSideCache();
    clearMessagePrefetch();
  },
});

/** The key for a chat, or null without a signed-in user, a workspace or a chat. */
export function chatKey(
  userId: string | null | undefined,
  workspaceId: string | null | undefined,
  channelId: string | null | undefined,
): ChatKey | null {
  if (!userId || !workspaceId || !channelId) return null;
  return { userId, workspaceId, channelId };
}

/** A plan card cache over the batched bundle reads (the app's Supabase client). */
export function makePlanCardCache(): PlanCardCache {
  return createPlanCardCache((ids, signal) => readPlanBundles(supabase, ids, signal));
}

/**
 * The chat's plan card cache for an open (made on its first). A fresh open
 * (none within JOIN_WINDOW_MS: the tap's kickoff, else the provider's mount)
 * re-reads every plan it already holds in the background; `fresh` says so.
 */
export function openChatPlans(
  key: ChatKey,
  store: OpenCache = openCache,
  make: () => PlanCardCache = makePlanCardCache,
): { cache: PlanCardCache; fresh: boolean } {
  const cache = store.planCache(key, make);
  const fresh = store.opened(key);
  if (fresh) {
    cache.resume();
    cache.revalidate();
  }
  return { cache, fresh };
}

/** The reads a tap starts (the app's: ChatConnected; tests pass fakes). */
export interface OpenKickoffReads {
  /** Start the latest messages page (history's prefetch; the thread joins it). */
  messages: (channelId: string) => void;
  /** Start (or join) the viewer's side in the workspace. */
  viewerSide: () => void;
  marks: (channelId: string) => Promise<OpenReads['marks']>;
  openPosts: (workspaceId: string) => Promise<OpenReads['openPosts']>;
  planIds: (channelId: string) => Promise<OpenReads['planIds']>;
  briefs: (workspaceId: string) => Promise<OpenReads['briefs']>;
  briefCount: (workspaceId: string) => Promise<OpenReads['briefCount']>;
}

/**
 * A chat tap: every read the open needs starts now, together, before the
 * thread mounts: the messages page, this channel's marks, the viewer side,
 * the open posts list and count, the open briefs list and count and the
 * shared plan ids; the plan bundles start the moment the plan ids are in,
 * through the chat's one plan card cache (a reopen re-reads what it holds).
 * Nothing waits for the messages page. Reads already started for this open
 * are joined, never asked twice.
 */
export function kickoffChatOpen(
  key: ChatKey,
  reads: OpenKickoffReads,
  store: OpenCache = openCache,
  make: () => PlanCardCache = makePlanCardCache,
): void {
  const { cache } = openChatPlans(key, store, make);
  reads.messages(key.channelId);
  reads.viewerSide();
  void store.joinOrStart(key, 'marks', () => reads.marks(key.channelId));
  void store.joinOrStart(key, 'openPosts', () => reads.openPosts(key.workspaceId));
  void store
    .joinOrStart(key, 'planIds', () => reads.planIds(key.channelId))
    .then((result) => {
      if (result.ok && result.data.length > 0) cache.request(result.data);
    });
  void store.joinOrStart(key, 'briefs', () => reads.briefs(key.workspaceId));
  void store.joinOrStart(key, 'briefCount', () => reads.briefCount(key.workspaceId));
}

/** Forget everything: every chat, every stashed read, the viewer sides, the prefetched pages. */
export function clearOpenCache(): void {
  openCache.clear();
}

/**
 * The sign-out watch: subscribed while something is held, so nothing listens
 * for a user who never opened a chat. Injected so tests never touch auth.
 */
export interface SignOutSource {
  /** Calls back with the signed-in user id (null: signed out) on each auth change; returns the unsubscribe. */
  onAuthUser: (listener: (userId: string | null) => void) => () => void;
  /** The window the sorted sign-out event fires on (null: none). */
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  /** The sign-out event's name. */
  signOutEvent: string;
}

let stopWatching: (() => void) | null = null;

/** Clear on sign-out or a user change while held; stop listening once empty. */
export function watchSignOut(source: SignOutSource, held: () => string | null): void {
  if (stopWatching !== null) return;
  const onSignOut = (): void => clearOpenCache();
  const unsubscribe = source.onAuthUser((userId) => {
    const holder = held();
    if (userId === null || (holder !== null && holder !== userId)) clearOpenCache();
  });
  source.target?.addEventListener(source.signOutEvent, onSignOut);
  stopWatching = () => {
    unsubscribe();
    source.target?.removeEventListener(source.signOutEvent, onSignOut);
  };
}

/** Stop the sign-out watch (on empty). */
export function unwatchSignOut(): void {
  stopWatching?.();
  stopWatching = null;
}

// The tab's store listens for a sign-out while it holds anything.
openCache.onHeld(() =>
  watchSignOut(
    {
      onAuthUser: (listener) => {
        const { data } = supabase.auth.onAuthStateChange((_event, session) =>
          listener(session?.user.id ?? null),
        );
        return () => data.subscription.unsubscribe();
      },
      target: typeof window !== 'undefined' ? window : null,
      signOutEvent: SIGNOUT_EVENT,
    },
    openCache.heldUser,
  ),
);
openCache.onEmpty(unwatchSignOut);
