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
//
// A chat's messages page is remembered too, and it is the chat's one copy:
// while a thread shows the chat, the thread owns its rows (attach) and writes
// them back when it leaves (server rows only, the newest
// REMEMBERED_MESSAGES_LIMIT); while no thread shows it, every live event for
// it lands on the remembered rows through the same apply functions the open
// thread uses (thread.ts). Events stamped with another workspace are ignored.

import type { Result } from '@srtdio/rpc';
import type { ScheduledRow } from '@/lib/chat/scheduled';
import type { ChatMark } from '@/lib/chat/marks';
import { createPlanCardCache, readPlanBundles, type PlanCardCache } from '@/lib/chat/plans';
import type { OpenPostsData, OpenPostsView } from '@/lib/chat/use-open-posts';
import type { StatusReadResults, StatusRoundView } from '@/lib/chat/use-status-counts';
import {
  applyLiveDelete,
  applyLiveEditRow,
  applyLiveRead,
  applyLiveReaction,
  applyLiveRow,
  extWorkspaceId,
  liveEditWanted,
  parseLiveEvent,
  rowToThreadMessage,
  upsertMessage,
  type ChatMessageRow,
  type MessageCursor,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { clearMessagePrefetch, type ReadPositionsRead } from '@/lib/chat/history';
import { resetViewerSideCache } from '@/lib/chat/viewer-role';
import { SIGNOUT_EVENT } from '@/lib/events';
import { supabase } from '@/lib/supabase';

/** Chats remembered per session (least recently opened goes first). */
export const OPEN_CACHE_LIMIT = 20;
/** How long after it settles a read started at the tap can still be joined. */
export const JOIN_WINDOW_MS = 2_000;
/** The longest a chat open holds its first paint for the parts still loading. */
export const OPEN_HOLD_MS = 1_000;

/** The most rows a remembered messages page keeps (the newest; older ones are dropped). */
export const REMEMBERED_MESSAGES_LIMIT = 200;

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
  thread: RememberedThread;
  /** The viewer's scheduled messages in the chat as last read. */
  scheduled: ScheduledRow[];
}

/** A chat's messages page as its thread left it, kept live while closed. */
export interface RememberedThread {
  /** Server rows only, oldest first, at most REMEMBERED_MESSAGES_LIMIT. */
  rows: ThreadMessage[];
  /** Whether older rows than these may exist (also true once the window dropped some). */
  hasMore: boolean;
  /** The thread's contiguousThrough: the reopen's forward read starts here. */
  through: MessageCursor | undefined;
  /** The channel's cursors as last read, the viewer's own as last written; null: never read. */
  reads: ReadPositionsRead | null;
  /** Rows folded in while closed whose quotes and roots are not resolved yet. */
  unresolved: readonly string[];
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
  /** Threads showing this chat now (StrictMode can mount two for a moment). */
  owners: number;
  /** Bumped when the remembered page is forgotten: an older owner's write-back is void. */
  threadEpoch: number;
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
  /**
   * Change a part a chat remembers in place (no-op when it holds none), never
   * moving the chat in the least recently used order: a live event is not an open.
   */
  revise: <K extends keyof ChatMemory>(
    key: ChatKey,
    part: K,
    change: (value: ChatMemory[K]) => ChatMemory[K],
  ) => void;
  /** Forget one part of a chat's state (no-op when not held). */
  forget: (key: ChatKey, part: keyof ChatMemory) => void;
  /** Every held chat that remembers this part, with its key (the current scope only). */
  holding: <K extends keyof ChatMemory>(part: K) => Array<{ key: ChatKey; value: ChatMemory[K] }>;
  /**
   * A thread shows this chat now and owns its rows: `keep` writes them back
   * (ignored once the chat was forgotten, cleared or evicted since), `release`
   * hands the chat back to the live router.
   */
  attach: (key: ChatKey) => { keep: (thread: RememberedThread) => void; release: () => void };
  /** Whether a thread shows this chat now. */
  attached: (key: ChatKey) => boolean;
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
    slot = {
      memory: {},
      reads: new Map(),
      planCache: null,
      openedAt: null,
      owners: 0,
      threadEpoch: 0,
    };
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
    revise<K extends keyof ChatMemory>(
      key: ChatKey,
      part: K,
      change: (value: ChatMemory[K]) => ChatMemory[K],
    ) {
      if (scope === null || scope.userId !== key.userId || scope.workspaceId !== key.workspaceId) {
        return;
      }
      const slot = slots.get(slotKey(key));
      const value = slot?.memory[part];
      if (slot === undefined || value === undefined) return;
      slot.memory[part] = change(value as ChatMemory[K]);
    },
    forget(key, part) {
      const slot = slots.get(slotKey(key));
      if (slot === undefined) return;
      delete slot.memory[part];
      if (part === 'thread') slot.threadEpoch += 1;
    },
    holding<K extends keyof ChatMemory>(part: K) {
      const out: Array<{ key: ChatKey; value: ChatMemory[K] }> = [];
      if (scope === null) return out;
      for (const [k, slot] of slots) {
        const value = slot.memory[part];
        if (value === undefined) continue;
        const [userId = '', workspaceId = '', channelId = ''] = k.split('\n');
        out.push({ key: { userId, workspaceId, channelId }, value: value as ChatMemory[K] });
      }
      return out;
    },
    attach(key) {
      const slot = slotOf(key, true);
      const epoch = slot.threadEpoch;
      slot.owners += 1;
      let released = false;
      // A slot cleared or evicted meanwhile is not this one: nothing to keep or release.
      const current = (): boolean => slots.get(slotKey(key)) === slot;
      return {
        keep: (thread) => {
          if (current() && slot.threadEpoch === epoch) slot.memory.thread = thread;
        },
        release: () => {
          if (released) return;
          released = true;
          if (current()) slot.owners = Math.max(0, slot.owners - 1);
        },
      };
    },
    attached(key) {
      return (slots.get(slotKey(key))?.owners ?? 0) > 0;
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

/**
 * A row as remembered: no local file previews (the thread releases them when
 * it leaves), so its attachments read from the record like any loaded row.
 * The same object when it holds none. Pure.
 */
export function withoutLocalFiles(message: ThreadMessage): ThreadMessage {
  if (!message.attachments.some((a) => a.local !== undefined)) return message;
  return {
    ...message,
    attachments: message.attachments.map((a) => {
      if (a.local === undefined) return a;
      const kept = { ...a };
      delete kept.local;
      return kept;
    }),
  };
}

/**
 * What a thread leaves behind: its server rows only (never a sending or failed
 * bubble: the outbox lays those back on a reopen), the newest `limit`, without
 * local file previews; older rows may exist once any were dropped. Pure.
 */
export function rememberedWindow(
  messages: readonly ThreadMessage[],
  hasMore: boolean,
  limit: number = REMEMBERED_MESSAGES_LIMIT,
): { rows: ThreadMessage[]; hasMore: boolean } {
  const recorded = messages.filter((m) => m.state === 'sent' && m.createdAt !== '');
  const kept = recorded.length > limit ? recorded.slice(recorded.length - limit) : recorded;
  const rows = kept.some((m) => withoutLocalFiles(m) !== m) ? kept.map(withoutLocalFiles) : kept;
  return { rows, hasMore: hasMore || kept.length < recorded.length };
}

/**
 * The viewer's own cursor moved to a message (this thread wrote it): the
 * remembered cursors read so, so a reopen's unread run starts after it. Pure.
 */
export function withOwnCursor(
  reads: ReadPositionsRead,
  viewerId: string,
  message: { id: string; time: number },
  atIso: string,
): ReadPositionsRead {
  const rows = reads.rows.filter((row) => row.userId !== viewerId);
  rows.push({ userId: viewerId, lastReadMessageId: message.id, lastReadAt: atIso });
  const times = new Map(reads.times);
  times.set(message.id, message.time);
  return { rows, times };
}

/** Apply a live change to a closed chat's remembered rows; the window cap holds. */
function reviseClosed(
  store: OpenCache,
  key: ChatKey,
  change: (rows: ThreadMessage[]) => ThreadMessage[],
  resolve: readonly string[] = [],
): void {
  if (store.attached(key)) return;
  store.revise(key, 'thread', (thread) => {
    const next = change(thread.rows);
    if (next === thread.rows) return thread;
    const window = rememberedWindow(next, thread.hasMore);
    const kept = new Set(window.rows.map((m) => m.id));
    const unresolved = [...new Set([...thread.unresolved, ...resolve])].filter((id) =>
      kept.has(id),
    );
    return { ...thread, rows: window.rows, hasMore: window.hasMore, unresolved };
  });
}

/** The closed chats that remember a page, for the signed-in user in the open workspace. */
function closedThreads(
  store: OpenCache,
  userId: string,
  workspaceId: string,
): Array<{ key: ChatKey; value: RememberedThread }> {
  return store
    .holding('thread')
    .filter(
      ({ key }) => key.userId === userId && key.workspaceId === workspaceId && !store.attached(key),
    );
}

/** What routing live events to remembered chats needs (the provider's; tests pass fakes). */
export interface RememberedLiveDeps {
  userId: string;
  /** The open workspace: an event stamped with any other is ignored. */
  workspaceId: string;
  /** The shared live verifier: the row a live text names, or null (discarded). */
  verify: (messageId: string) => Promise<ChatMessageRow | null>;
  /** One row re-read for a live edit (never the Agora payload), or null. */
  loadRow: (messageId: string) => Promise<ChatMessageRow | null>;
  store?: OpenCache;
}

/**
 * A live text for a chat that is remembered and closed: its verified row is
 * folded into the remembered rows (the open thread's fold). A text stamped
 * with another workspace, or whose row is of another chat or workspace, is
 * ignored.
 */
export async function routeRememberedText(
  deps: RememberedLiveDeps,
  input: { channelId: string; messageId: string; ext: unknown },
): Promise<void> {
  const store = deps.store ?? openCache;
  const named = extWorkspaceId(input.ext);
  if (named !== null && named !== deps.workspaceId) return;
  const key: ChatKey = {
    userId: deps.userId,
    workspaceId: deps.workspaceId,
    channelId: input.channelId,
  };
  if (!closedThreads(store, deps.userId, deps.workspaceId).some((t) => sameKey(t.key, key))) {
    return;
  }
  const row = await deps.verify(input.messageId);
  if (row === null || row.channel_id !== input.channelId || row.workspace_id !== deps.workspaceId) {
    return;
  }
  const message = rowToThreadMessage(row, deps.userId);
  reviseClosed(store, key, (rows) => applyLiveRow(rows, message), [message.id]);
}

/**
 * A live command for remembered, closed chats: reaction, read, delete and edit
 * land on the rows through the open thread's apply functions. Only a command
 * stamped with the open workspace counts (a closed chat catches up on reopen
 * either way).
 */
export async function routeRememberedCmd(
  deps: RememberedLiveDeps,
  input: { ext: unknown; fromUserId: string | undefined },
): Promise<void> {
  const store = deps.store ?? openCache;
  const fromUserId = input.fromUserId;
  if (fromUserId === undefined || extWorkspaceId(input.ext) !== deps.workspaceId) return;
  const event = parseLiveEvent(input.ext);
  const closed = closedThreads(store, deps.userId, deps.workspaceId);
  if (event.kind === 'reaction') {
    for (const { key, value } of closed) {
      if (!value.rows.some((m) => m.id === event.messageId)) continue;
      reviseClosed(store, key, (rows) =>
        applyLiveReaction(rows, { ...event, fromUserId }, deps.userId),
      );
    }
    return;
  }
  if (event.kind === 'read') {
    if (fromUserId === deps.userId) return;
    for (const { key } of closed) {
      if (key.channelId !== event.channelId) continue;
      reviseClosed(store, key, (rows) => applyLiveRead(rows, event.messageId));
    }
    return;
  }
  if (event.kind === 'delete') {
    for (const { key } of closed) {
      reviseClosed(
        store,
        key,
        (rows) => applyLiveDelete(rows, { messageIds: event.messageIds, fromUserId }).messages,
      );
    }
    return;
  }
  if (event.kind !== 'edit') return;
  const hit = closed.find(({ value }) =>
    liveEditWanted(value.rows, { messageId: event.messageId, fromUserId }),
  );
  if (hit === undefined) return;
  const row = await deps.loadRow(event.messageId);
  if (row === null) return;
  reviseClosed(store, hit.key, (rows) =>
    applyLiveEditRow(rows, { row, channelId: hit.key.channelId, fromUserId }),
  );
}

/**
 * An own send recorded while its chat is closed (the outbox's recorded row):
 * it lands on the remembered rows as it would in the open thread, so a
 * reopen shows it where its bubble was.
 */
export function rememberRecordedSend(
  key: ChatKey | null,
  message: ThreadMessage,
  store: OpenCache = openCache,
): void {
  if (key === null) return;
  reviseClosed(store, key, (rows) => upsertMessage(rows, withoutLocalFiles(message)));
}

function sameKey(a: ChatKey, b: ChatKey): boolean {
  return a.userId === b.userId && a.workspaceId === b.workspaceId && a.channelId === b.channelId;
}

/** Forget a chat's remembered page (cleared, left, removed, unknown). */
export function forgetRememberedThread(key: ChatKey | null, store: OpenCache = openCache): void {
  if (key !== null) store.forget(key, 'thread');
}

/**
 * The roster for this user and workspace was read: a remembered chat it no
 * longer lists (left, removed, deleted) is forgotten. `keep` says which other
 * chats stay (Personal notes are never in the roster).
 */
export function forgetThreadsOutside(
  userId: string,
  workspaceId: string,
  listed: ReadonlySet<string>,
  keep: (channelId: string) => boolean,
  store: OpenCache = openCache,
): void {
  for (const { key } of store.holding('thread')) {
    if (key.userId !== userId || key.workspaceId !== workspaceId) continue;
    if (!listed.has(key.channelId) && !keep(key.channelId)) store.forget(key, 'thread');
  }
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
  // A remembered page paints at once and revalidates itself: no latest page.
  if (store.recall(key, 'thread') === undefined) reads.messages(key.channelId);
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
