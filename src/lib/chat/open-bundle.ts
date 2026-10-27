// One chat open is ONE chat_open_bundle call. It replaces the separate open
// reads (the latest page and its paging floor, the quoted and cursor
// messages, reactions, read cursors, reply counts, marks, scheduled rows,
// open posts with their thumbnails and count, the current shared plan ids,
// open briefs and their count).
//
// The call is started once per open (the tap's kickoff, else the thread's
// switch while it renders, so it is in flight before any child's effect asks
// for a part) and stashed in the open cache as 'bundle'. The parts the other
// hooks read first are stashed beside it at the same moment, each derived
// from that one call and bounded at READ_TIMEOUT_MS as their own reads were:
// 'marks', 'scheduled' and 'positions' in the open cache, and the
// workspace-wide parts (open posts, plan ids, briefs, brief count) as the
// workspace's shared session reads, so the hooks' first rounds join them and
// never ask again. A failed bundle fails every part (all or nothing).
//
// A reopen of a chat whose page is remembered asks the same call with
// p_since (the remembered page's contiguous end): rows at or after it, max
// 200 (more is a gap), plus every other part as of now.
//
// Plan bundles are not in it: listeners (onChatBundle) hear each bundle
// settle and the plan cards start their own read then (PlanCardsProvider).

import { mark } from '@/lib/perf-marks';
import type { Result } from '@srtdio/rpc';
import { LATE_READ_GRACE_MS, withReadTimeout } from '@/lib/chat-reads';
import {
  readChatOpenBundle,
  type ChatOpenBundle,
  type ChatOpenBundleInput,
} from '@/lib/chat/history';
import { openCache, type ChatKey, type OpenCache } from '@/lib/chat/open-cache';
import type { OpenPostsData } from '@/lib/chat/use-open-posts';
import { resultOk, sharedChatRead, type ChatWorkspaceRead } from '@/lib/chat/workspace-reads';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

/** What the bundle's start needs (the app's; tests pass fakes). */
export interface ChatBundleDeps {
  store: OpenCache;
  read: (input: ChatOpenBundleInput, signal: AbortSignal) => Promise<Result<ChatOpenBundle>>;
  /** The workspace's shared session reads (workspace-reads.ts). */
  share: <T>(
    userId: string,
    workspaceId: string,
    what: ChatWorkspaceRead,
    load: () => Promise<T>,
    isOk: (value: T) => boolean,
  ) => Promise<T>;
  traceId: () => string;
  /** How long a part waits on the bundle before it reads as failed. */
  partTimeoutMs?: number;
}

const APP_DEPS: ChatBundleDeps = {
  store: openCache,
  read: (input, signal) => readChatOpenBundle(supabase, input, signal),
  share: sharedChatRead,
  traceId: generateTraceId,
};

/** The p_since each store's stashed bundle was started with, by chat. */
const startedSince = new WeakMap<OpenCache, Map<string, string | null>>();

function slotKey(key: ChatKey): string {
  return `${key.userId}\n${key.workspaceId}\n${key.channelId}`;
}

type BundleListener = (key: ChatKey, result: Result<ChatOpenBundle>) => void;
const listeners = new Set<BundleListener>();

/** Hear every bundle settle (ok or failed). Returns the unsubscribe. */
export function onChatBundle(listener: BundleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The p_since an open of this chat asks: the remembered page's contiguous end, else none. */
export function rememberedSince(key: ChatKey, store: OpenCache = openCache): string | null {
  return store.recall(key, 'thread')?.through?.createdAt ?? null;
}

/** A part of the bundle as its own Result, bounded at `timeoutMs`. */
function partOf<T>(
  bundle: Promise<Result<ChatOpenBundle>>,
  pick: (data: ChatOpenBundle) => T,
  timeoutMs: number | undefined,
): Promise<Result<T>> {
  return withReadTimeout<T>(
    () => bundle.then((r): Result<T> => (r.ok ? { ok: true, data: pick(r.data) } : r)),
    timeoutMs,
  );
}

function openPostsOk(data: OpenPostsData): boolean {
  return data.posts !== null && data.count !== null;
}

/**
 * Start a new bundle for this open (a cold open, a reopen's catch-up, a
 * Retry), replacing any stashed one, and stash every derived part beside it.
 * Bounded at LATE_READ_GRACE_MS so it always settles; callers apply their own
 * 5s deadline (a late answer may still win for the thread).
 */
export function startChatBundle(
  key: ChatKey,
  opts: { since?: string | null; deps?: ChatBundleDeps } = {},
): Promise<Result<ChatOpenBundle>> {
  const deps = opts.deps ?? APP_DEPS;
  const store = deps.store;
  const since = opts.since !== undefined ? opts.since : rememberedSince(key, store);
  const traceId = deps.traceId();
  mark('chat:bundle:start');
  const promise = withReadTimeout(
    (signal) =>
      deps.read({ traceId, workspaceId: key.workspaceId, channelId: key.channelId, since }, signal),
    LATE_READ_GRACE_MS,
  );
  store.stash(key, 'bundle', promise, true);
  let byChat = startedSince.get(store);
  if (byChat === undefined) {
    byChat = new Map();
    startedSince.set(store, byChat);
  }
  byChat.set(slotKey(key), since);
  const t = deps.partTimeoutMs;
  store.stash(
    key,
    'marks',
    partOf(promise, (b) => b.marks, t),
    true,
  );
  store.stash(
    key,
    'scheduled',
    partOf(promise, (b) => b.scheduled, t),
    true,
  );
  store.stash(
    key,
    'positions',
    partOf(promise, (b) => b.readPositions, t),
    true,
  );
  const { userId, workspaceId } = key;
  void deps.share<OpenPostsData>(
    userId,
    workspaceId,
    'openPosts',
    () =>
      partOf(promise, (b) => ({ posts: b.openPosts, count: b.openPostCount }), t).then((r) =>
        r.ok ? r.data : { posts: null, count: null },
      ),
    openPostsOk,
  );
  void deps.share(
    userId,
    workspaceId,
    'planIds',
    () => partOf(promise, (b) => b.sharedPlanIds, t),
    resultOk,
  );
  void deps.share(
    userId,
    workspaceId,
    'briefs',
    () => partOf(promise, (b) => b.openBriefs, t),
    resultOk,
  );
  void deps.share(
    userId,
    workspaceId,
    'briefCount',
    () => partOf(promise, (b) => b.openBriefCount, t),
    resultOk,
  );
  void promise.then((result) => {
    mark('chat:bundle:end');
    for (const l of [...listeners]) l(key, result);
  });
  return promise;
}

/**
 * The open's bundle: the stashed one while it can be joined (started with the
 * same p_since), else a new one. `since` defaults to what an open of this chat
 * asks (rememberedSince), so the tap and the thread agree.
 */
export function joinChatBundle(
  key: ChatKey,
  opts: { since?: string | null; deps?: ChatBundleDeps } = {},
): Promise<Result<ChatOpenBundle>> {
  const deps = opts.deps ?? APP_DEPS;
  const since = opts.since !== undefined ? opts.since : rememberedSince(key, deps.store);
  const joined = deps.store.join(key, 'bundle');
  if (joined !== null && startedSince.get(deps.store)?.get(slotKey(key)) === since) return joined;
  return startChatBundle(key, { since, deps });
}

/** The open's bundle while one can be joined, else null (never starts one). */
export function joinableChatBundle(
  key: ChatKey,
  store: OpenCache = openCache,
): Promise<Result<ChatOpenBundle>> | null {
  return store.join(key, 'bundle');
}
