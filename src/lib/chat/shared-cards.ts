// One thread's shared post and brief cards, read in batches instead of once
// per bubble. Every card in a thread asks this cache for its ids; asks made in
// the same tick (a page of bubbles mounting, or the thread asking for every id
// across its loaded messages) coalesce into ONE posts read and ONE briefs read,
// chunked at 100 ids, each chunk bounded at 5s (aborted where the reader takes
// a signal). The approvers of the posts read come back in ONE profile read.
// Ids already read or in flight are never asked again, so a new message only
// adds its missing ids.
//
// Outcomes per id: a row, or absent under RLS (the card's existing "not
// visible" / "Brief unavailable" fallback). A read that errors or times out is
// neither: the card keeps its skeleton and the id is re-read on the next
// trigger (tab visible, online, connected, the card scrolled into view), up to
// CARD_READ_TRIES tries in the session; after that the card shows a neutral
// "Couldn't load" that re-reads on tap. A refresh asked while a read is in
// flight runs once more after it (a post-changed event is never lost); a failed
// refresh keeps what is shown. Framework-free (readers injected), so the
// batching is unit-tested without React or a database.

import type { Result } from '@srtdio/rpc';
import {
  READ_TIMEOUT_MS,
  withLinkedSignal,
  withReadTimeout,
  type ChatProfile,
} from '@/lib/chat-reads';

/** Ids per IN read (PostgREST URL length stays small). */
export const CARD_READ_CHUNK = 100;

/** Failed reads of one id before its card gives up and offers a tap to retry. */
export const CARD_READ_TRIES = 3;

/**
 * A failed read is also retried on its own this long after it failed, so a
 * card already on screen with no other trigger still reaches its answer or
 * "Couldn't load" (about 3 x 10s at most), never a skeleton forever.
 */
const CARD_RETRY_DELAY_MS = READ_TIMEOUT_MS;

/** The batched readers the cache runs; the app binds the existing readers. */
export interface SharedCardReaders<P, B> {
  /** One IN read of posts by id (readPostCards). Absent rows are not visible. */
  readPosts: (ids: string[], signal: AbortSignal) => Promise<Result<P[]>>;
  /** One IN read of briefs by id (readBriefsByIds). Absent rows are unavailable. */
  readBriefs: (ids: string[], signal: AbortSignal) => Promise<Result<B[]>>;
  /** One IN read of profiles (readProfiles), for the "Approved by" names. */
  readNames: (userIds: string[], signal: AbortSignal) => Promise<Result<ChatProfile[]>>;
  postId: (post: P) => string;
  briefId: (brief: B) => string;
  /** The user ids a post's footer names (its approver). */
  approverIds: (posts: readonly P[]) => string[];
}

interface SharedCardCacheOptions {
  /** Runs a flush after the current tick; defaults to queueMicrotask. */
  schedule?: (flush: () => void) => void;
  timeoutMs?: number;
  now?: () => number;
  /** How long after a failed read it is retried on its own (default CARD_RETRY_DELAY_MS). */
  retryDelayMs?: number;
}

/** What a card with these post ids shows right now. */
export interface PostCardsSnapshot<P> {
  /** Some id has not settled yet (first read in flight, or failed and still retrying): skeleton. */
  loading: boolean;
  /** The visible posts among the ids (absent = not visible under RLS). */
  posts: P[];
  /** Ids whose reads failed CARD_READ_TRIES times: "Couldn't load", tap to retry. */
  failed: string[];
  /** Approver display names by user id. */
  names: Map<string, string>;
}

export interface BriefCardsSnapshot<B> {
  loading: boolean;
  briefs: B[];
  failed: string[];
}

export interface SharedCardCache<P, B> {
  /** Ask for these ids; only ids never tried and not in flight are read. */
  request: (ids: { postIds?: readonly string[]; briefIds?: readonly string[] }) => void;
  /** Re-read these posts (post changed, tab back after a minute); current cards stay meanwhile. */
  refreshPosts: (ids: readonly string[]) => void;
  /**
   * A retry trigger (tab visible, online, connected, a card scrolled into
   * view): re-read the ids whose reads failed and still have tries left (all
   * of them when `ids` is absent).
   */
  retryFailed: (ids?: { postIds?: readonly string[]; briefIds?: readonly string[] }) => void;
  /** The "Couldn't load" tap: these ids get a fresh set of tries, starting now. */
  retry: (ids: { postIds?: readonly string[]; briefIds?: readonly string[] }) => void;
  posts: (ids: readonly string[]) => PostCardsSnapshot<P>;
  briefs: (ids: readonly string[]) => BriefCardsSnapshot<B>;
  /** When these posts were last read (ms; 0 when never). */
  postsFetchedAt: (ids: readonly string[]) => number;
  /** React subscription (useSyncExternalStore): the listener runs after each applied read. */
  subscribe: (listener: () => void) => () => void;
  /** Bumped on every applied read; the snapshot key. */
  version: () => number;
  /** Channel or workspace switch, unmount: drop listeners, ignore every read in flight. */
  dispose: () => void;
  /**
   * Undo a dispose for the same owner (React StrictMode mounts, cleans up and
   * mounts an effect again with the same cache): reads work again.
   */
  resume: () => void;
}

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CARD_READ_CHUNK) {
    out.push(ids.slice(i, i + CARD_READ_CHUNK));
  }
  return out;
}

/** Run a chunked read, each chunk bounded (and aborted) at its own deadline. */
async function readChunked<T>(
  ids: readonly string[],
  read: (chunk: string[], signal: AbortSignal) => Promise<Result<T[]>>,
  timeoutMs: number,
  cancel: AbortSignal,
): Promise<Array<{ ids: string[]; result: Result<T[]> }>> {
  return Promise.all(
    chunks(ids).map(async (chunk) => ({
      ids: chunk,
      result: await withReadTimeout(
        (deadline) => withLinkedSignal(deadline, cancel, (signal) => read(chunk, signal)),
        timeoutMs,
      ),
    })),
  );
}

/** One kind's per-id read state (posts or briefs). */
interface Track<T> {
  /** Settled ids: the row, or null (absent under RLS). */
  rows: Map<string, T | null>;
  /** Failed reads per unsettled id. */
  tries: Map<string, number>;
  inFlight: Set<string>;
  queued: Set<string>;
  /** Refreshes asked while the id was in flight: one more read after it. */
  again: Set<string>;
}

function track<T>(): Track<T> {
  return {
    rows: new Map(),
    tries: new Map(),
    inFlight: new Set(),
    queued: new Set(),
    again: new Set(),
  };
}

function gaveUp<T>(t: Track<T>, id: string): boolean {
  return !t.rows.has(id) && (t.tries.get(id) ?? 0) >= CARD_READ_TRIES;
}

function snapshot<T>(
  t: Track<T>,
  ids: readonly string[],
): { loading: boolean; found: T[]; failed: string[] } {
  const found: T[] = [];
  const failed: string[] = [];
  let loading = false;
  for (const id of ids) {
    if (t.rows.has(id)) {
      const row = t.rows.get(id);
      if (row != null) found.push(row);
    } else if (gaveUp(t, id)) {
      failed.push(id);
    } else {
      loading = true;
    }
  }
  return { loading, found, failed };
}

export function createSharedCardCache<P, B>(
  readers: SharedCardReaders<P, B>,
  options: SharedCardCacheOptions = {},
): SharedCardCache<P, B> {
  const schedule = options.schedule ?? ((flush: () => void) => queueMicrotask(flush));
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const posts = track<P>();
  const briefs = track<B>();
  const postReadAt = new Map<string, number>();
  const names = new Map<string, string>();
  const namesAsked = new Set<string>();
  /** Name reads in flight, per approver id (another batch waits on them). */
  const namesInFlight = new Map<string, Promise<void>>();
  let scheduled = false;
  let disposed = false;
  // Dispose aborts every read in flight; the retry timers go with it.
  let abort = new AbortController();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const retryDelayMs = options.retryDelayMs ?? CARD_RETRY_DELAY_MS;
  /** Retry this kind's failed ids on their own after a delay. */
  function retryLater(which: 'posts' | 'briefs', ids: readonly string[]): void {
    if (ids.length === 0 || disposed) return;
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      retry(which === 'posts' ? { postIds: ids } : { briefIds: ids });
    }, retryDelayMs);
    retryTimers.add(timer);
  }
  let version = 0;
  const listeners = new Set<() => void>();

  function notify(): void {
    if (disposed) return;
    version += 1;
    for (const listener of [...listeners]) listener();
  }

  function kick(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      void flush();
    });
  }

  /** Queue an id for the next flush; an id in flight gets one read after it instead. */
  function enqueue<T>(t: Track<T>, id: string): boolean {
    if (id === '' || t.queued.has(id)) return false;
    if (t.inFlight.has(id)) {
      t.again.add(id);
      return false;
    }
    t.queued.add(id);
    return true;
  }

  /** Settle one chunk's outcome into its track; returns the rows it found. */
  function settle<T>(
    t: Track<T>,
    chunk: readonly string[],
    result: Result<T[]>,
    idOf: (row: T) => string,
  ): T[] {
    for (const id of chunk) t.inFlight.delete(id);
    if (!result.ok) {
      // Not "absent": a first read keeps its skeleton and counts a try; a
      // failed refresh keeps the row it has.
      for (const id of chunk) {
        if (!t.rows.has(id)) t.tries.set(id, (t.tries.get(id) ?? 0) + 1);
      }
      return [];
    }
    const byId = new Map(result.data.map((row) => [idOf(row), row]));
    const found: T[] = [];
    for (const id of chunk) {
      const row = byId.get(id) ?? null;
      t.rows.set(id, row);
      t.tries.delete(id);
      if (row !== null) found.push(row);
    }
    return found;
  }

  /** Follow-up reads asked for while these ids were in flight. */
  function requeueAgain<T>(t: Track<T>, chunk: readonly string[]): void {
    let added = false;
    for (const id of chunk) {
      if (!t.again.delete(id)) continue;
      added = enqueue(t, id) || added;
    }
    if (added) kick();
  }

  async function readPostBatch(ids: string[]): Promise<void> {
    for (const id of ids) posts.inFlight.add(id);
    const results = await readChunked(ids, readers.readPosts, timeoutMs, abort.signal);
    if (disposed) return;
    const found: P[] = [];
    for (const { ids: chunk, result } of results) {
      const rows = settle(posts, chunk, result, readers.postId);
      if (result.ok) for (const id of chunk) postReadAt.set(id, now());
      else retryLater('posts', chunk);
      found.push(...rows);
    }
    // One profile read for every approver not asked before (chunked, bounded).
    // An approver another batch is still reading is waited for, so no card
    // paints "Approved · <time>" and then flips to "Approved by X".
    const wanted = [...new Set(readers.approverIds(found))];
    const approvers = wanted.filter((id) => !namesAsked.has(id));
    const pending = [
      ...new Set(wanted.map((id) => namesInFlight.get(id)).filter((p) => p !== undefined)),
    ];
    let own: Promise<void> | null = null;
    if (approvers.length > 0) {
      for (const id of approvers) namesAsked.add(id);
      own = readChunked(approvers, readers.readNames, timeoutMs, abort.signal).then((named) => {
        for (const { ids: chunk, result } of named) {
          if (!result.ok) {
            // The footer reads "Approved · <time>" without a name; a later read may ask again.
            for (const id of chunk) namesAsked.delete(id);
            continue;
          }
          for (const p of result.data) names.set(p.userId, p.displayName);
        }
      });
      const mine = own;
      for (const id of approvers) namesInFlight.set(id, mine);
      void mine.finally(() => {
        for (const id of approvers) if (namesInFlight.get(id) === mine) namesInFlight.delete(id);
      });
    }
    await Promise.all([...pending, ...(own !== null ? [own] : [])]);
    if (disposed) return;
    for (const { ids: chunk } of results) requeueAgain(posts, chunk);
  }

  async function readBriefBatch(ids: string[]): Promise<void> {
    for (const id of ids) briefs.inFlight.add(id);
    const results = await readChunked(ids, readers.readBriefs, timeoutMs, abort.signal);
    if (disposed) return;
    for (const { ids: chunk, result } of results) {
      settle(briefs, chunk, result, readers.briefId);
      if (!result.ok) retryLater('briefs', chunk);
    }
    for (const { ids: chunk } of results) requeueAgain(briefs, chunk);
  }

  function take<T>(t: Track<T>): string[] {
    const ids = [...t.queued].filter((id) => !t.inFlight.has(id));
    t.queued = new Set();
    return ids;
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    const postIds = take(posts);
    const briefIds = take(briefs);
    const work: Promise<void>[] = [];
    if (postIds.length > 0) work.push(readPostBatch(postIds).then(notify));
    if (briefIds.length > 0) work.push(readBriefBatch(briefIds).then(notify));
    await Promise.all(work);
  }

  /** Ids never tried: not settled, no failed try, not in flight or queued. */
  function fresh<T>(t: Track<T>, id: string): boolean {
    return !t.rows.has(id) && !t.tries.has(id) && !t.inFlight.has(id);
  }

  /** Ids whose reads failed and still have tries left. */
  function retriable<T>(t: Track<T>, id: string): boolean {
    return !t.rows.has(id) && t.tries.has(id) && !gaveUp(t, id);
  }

  function queueWhere<T>(
    t: Track<T>,
    ids: Iterable<string>,
    when: (id: string) => boolean,
  ): boolean {
    let added = false;
    for (const id of ids) if (when(id)) added = enqueue(t, id) || added;
    return added;
  }

  function retry(ids: { postIds?: readonly string[]; briefIds?: readonly string[] }): void {
    const a = queueWhere(posts, ids.postIds ?? [], (id) => retriable(posts, id));
    const b = queueWhere(briefs, ids.briefIds ?? [], (id) => retriable(briefs, id));
    if (a || b) kick();
  }

  return {
    request({ postIds = [], briefIds = [] }) {
      const a = queueWhere(posts, postIds, (id) => fresh(posts, id));
      const b = queueWhere(briefs, briefIds, (id) => fresh(briefs, id));
      if (a || b) kick();
    },
    refreshPosts(ids) {
      if (queueWhere(posts, ids, () => true)) kick();
    },
    retryFailed(ids) {
      const a = queueWhere(posts, ids?.postIds ?? [...posts.tries.keys()], (id) =>
        retriable(posts, id),
      );
      const b = queueWhere(briefs, ids?.briefIds ?? [...briefs.tries.keys()], (id) =>
        retriable(briefs, id),
      );
      if (a || b) kick();
    },
    retry({ postIds = [], briefIds = [] }) {
      for (const id of postIds) if (gaveUp(posts, id)) posts.tries.set(id, 0);
      for (const id of briefIds) if (gaveUp(briefs, id)) briefs.tries.set(id, 0);
      notify();
      const a = queueWhere(posts, postIds, (id) => !posts.rows.has(id));
      const b = queueWhere(briefs, briefIds, (id) => !briefs.rows.has(id));
      if (a || b) kick();
    },
    posts(ids) {
      const { loading, found, failed } = snapshot(posts, ids);
      return { loading, posts: found, failed, names };
    },
    briefs(ids) {
      const { loading, found, failed } = snapshot(briefs, ids);
      return { loading, briefs: found, failed };
    },
    postsFetchedAt(ids) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const id of ids) oldest = Math.min(oldest, postReadAt.get(id) ?? 0);
      return Number.isFinite(oldest) ? oldest : 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    resume() {
      if (!disposed) return;
      disposed = false;
      abort = new AbortController();
      // Asks made while disposed (children's effects run before the owner's) go out now.
      if (posts.queued.size > 0 || briefs.queued.size > 0) kick();
    },
    dispose() {
      disposed = true;
      abort.abort();
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      listeners.clear();
      posts.queued.clear();
      briefs.queued.clear();
    },
  };
}
