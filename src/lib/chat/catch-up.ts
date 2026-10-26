// Catch-up from Postgres, independent of the Agora connection. Live delivery
// can drop messages silently (a gap, a missed event, a message verified after
// a reload), so the open thread re-reads the record on its own schedule: when
// the tab becomes visible, when the browser comes back online, on every
// transition to 'connected', and every CATCH_UP_INTERVAL_MS while the tab is
// visible. Each run carries its reason. None of this looks at whether Agora is live. Framework-free and
// fully injected, so both the paging loop and the trigger wiring are
// unit-tested without a DOM.

import type { Result } from '@srtdio/rpc';
import { CATCH_UP_LIMIT, type HistoryPage } from '@/lib/chat/history';
import {
  compareCursors,
  rowCursor,
  type ChatMessageRow,
  type MessageCursor,
  type MessageReaction,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { READ_TIMEOUT_MS, withReadTimeout } from '@/lib/chat-reads';

/** Periodic catch-up while the tab is visible. */
export const CATCH_UP_INTERVAL_MS = 60_000;

/** Upper bound on pages one catch-up reads, so a runaway loop cannot spin forever. */
export const CATCH_UP_MAX_PAGES = 20;

export interface CatchUpLoaders {
  loadLatest: () => Promise<Result<HistoryPage>>;
  loadNewer: (cursor: MessageCursor) => Promise<Result<ChatMessageRow[]>>;
}

/**
 * What one catch-up read: every row found (oldest-first), the cursor of the
 * last page read (`through`: the record is contiguous up to it), whether the
 * run stopped at CATCH_UP_MAX_PAGES with more possibly waiting (`capped`), and
 * the latest-page hasMore when the latest page was read instead.
 */
type CatchUpOutcome =
  | {
      ok: true;
      rows: ChatMessageRow[];
      through: MessageCursor | undefined;
      capped: boolean;
      latestPage: { hasMore: boolean } | undefined;
    }
  | { ok: false; error: string; rows: ChatMessageRow[]; through: MessageCursor | undefined };

/**
 * Read everything newer than `cursor` (the thread's contiguousThrough). With
 * no cursor (nothing contiguous is loaded yet) the latest page is loaded
 * instead of skipping. A page that hits CATCH_UP_LIMIT means more may follow,
 * so the next page is read from the newest row until one comes back under the
 * cap. After CATCH_UP_MAX_PAGES the run stops `capped`; the next run resumes
 * from `through`, so no row is skipped across runs. A failed page keeps the
 * rows (and `through`) of the pages before it.
 */
export async function catchUpRows(
  loaders: CatchUpLoaders,
  cursor: MessageCursor | undefined,
): Promise<CatchUpOutcome> {
  if (cursor === undefined) {
    const page = await loaders.loadLatest();
    if (!page.ok) return { ok: false, error: page.error.message, rows: [], through: undefined };
    const newest = page.data.rows[page.data.rows.length - 1];
    return {
      ok: true,
      rows: page.data.rows,
      through: newest === undefined ? undefined : rowCursor(newest),
      capped: false,
      latestPage: { hasMore: page.data.hasMore },
    };
  }
  const rows: ChatMessageRow[] = [];
  let from = cursor;
  for (let pageIndex = 0; pageIndex < CATCH_UP_MAX_PAGES; pageIndex += 1) {
    const page = await loaders.loadNewer(from);
    if (!page.ok) return { ok: false, error: page.error.message, rows, through: from };
    rows.push(...page.data);
    const last = page.data[page.data.length - 1];
    if (last !== undefined) from = rowCursor(last);
    if (page.data.length < CATCH_UP_LIMIT || last === undefined) {
      return { ok: true, rows, through: from, capped: false, latestPage: undefined };
    }
  }
  return { ok: true, rows, through: from, capped: true, latestPage: undefined };
}

/**
 * The thread's contiguousThrough: the newest row up to which every recorded
 * row of the open chat is loaded. Only the latest-page load and catch-up pages
 * move it (forward only); live folds, own recorded sends, older pages and
 * by-id hydration never do, so a live row that skipped past a dropped one
 * cannot hide the dropped row from the next catch-up. Each reset (thread
 * switch, reopen, Retry) starts a new epoch: a read begun before it can no
 * longer move the cursor. Framework-free.
 */
interface ContiguityTracker {
  /** Forget the cursor with the rows; returns the new epoch. */
  reset: () => number;
  /** The current epoch, taken when a read starts. */
  epoch: () => number;
  /** Where the next catch-up reads from; undefined until a latest page or catch-up lands. */
  through: () => MessageCursor | undefined;
  /** The latest page (readLatestMessages) was applied: contiguous through its newest row. */
  latestPageApplied: (epoch: number, rows: readonly ChatMessageRow[]) => void;
  /** A catch-up run's pages were applied: contiguous through its last page. */
  catchUpApplied: (epoch: number, through: MessageCursor | undefined) => void;
}

export function createContiguityTracker(): ContiguityTracker {
  let epoch = 0;
  let cursor: MessageCursor | undefined;
  const advance = (forEpoch: number, next: MessageCursor | undefined): void => {
    if (forEpoch !== epoch || next === undefined) return;
    if (cursor === undefined || compareCursors(next, cursor) > 0) cursor = next;
  };
  return {
    reset: () => {
      epoch += 1;
      cursor = undefined;
      return epoch;
    },
    epoch: () => epoch,
    through: () => cursor,
    latestPageApplied: (forEpoch, rows) => {
      const newest = rows[rows.length - 1];
      advance(forEpoch, newest === undefined ? undefined : rowCursor(newest));
    },
    catchUpApplied: advance,
  };
}

/**
 * Whether `next` holds an id that was not in `previous` and sits between two
 * rows that were (a row filled into a gap, e.g. a dropped live row a catch-up
 * read back), as opposed to an older page on top or new rows at the bottom.
 * Pure.
 */
export function insertedInside(
  previous: readonly string[],
  next: readonly { id: string }[],
): boolean {
  const known = new Set(previous);
  let seenKnown = false;
  let pendingNew = false;
  for (const m of next) {
    if (known.has(m.id)) {
      if (pendingNew && seenKnown) return true;
      seenKnown = true;
      pendingNew = false;
    } else {
      pendingNew = true;
    }
  }
  return false;
}

/** What started a catch-up; the caller decides what each one reads. */
export type CatchUpReason = 'connected' | 'visible' | 'online' | 'interval';

interface CatchUpTriggerDeps {
  /** Run one catch-up (the caller guards against overlap). */
  run: (reason: CatchUpReason) => void;
  isVisible: () => boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibilityChange: (handler: () => void) => () => void;
  /** Subscribe to the browser coming back online; returns the unsubscribe. */
  onOnline: (handler: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  intervalMs?: number;
}

/**
 * Wire the catch-up triggers and return the teardown. Visible: run now and
 * (re)start the interval. Hidden: clear the interval. Online: run. The
 * interval is cleared on teardown and whenever the tab is hidden.
 */
export function startCatchUpTriggers(deps: CatchUpTriggerDeps): () => void {
  const intervalMs = deps.intervalMs ?? CATCH_UP_INTERVAL_MS;
  let handle: unknown = undefined;
  let active = false;
  const stopInterval = (): void => {
    if (!active) return;
    deps.clearInterval(handle);
    handle = undefined;
    active = false;
  };
  const startInterval = (): void => {
    if (active) return;
    handle = deps.setInterval(() => {
      if (deps.isVisible()) deps.run('interval');
    }, intervalMs);
    active = true;
  };
  if (deps.isVisible()) startInterval();
  const removeVisibility = deps.onVisibilityChange(() => {
    if (deps.isVisible()) {
      deps.run('visible');
      startInterval();
    } else {
      stopInterval();
    }
  });
  const removeOnline = deps.onOnline(() => deps.run('online'));
  return () => {
    stopInterval();
    removeVisibility();
    removeOnline();
  };
}

/** The browser wiring for startCatchUpTriggers. */
export function browserCatchUpTriggers(run: (reason: CatchUpReason) => void): () => void {
  return startCatchUpTriggers({
    run,
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: (handler) => {
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
    onOnline: (handler) => {
      window.addEventListener('online', handler);
      return () => window.removeEventListener('online', handler);
    },
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
  });
}

/**
 * Window focus runs a catch-up (notes: other devices' notes land when this
 * window is picked up again, with no live delivery). Returns the teardown,
 * which removes the listener.
 */
export function windowFocusTrigger(
  run: () => void,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onFocus = (): void => run();
  target.addEventListener('focus', onFocus);
  return () => target.removeEventListener('focus', onFocus);
}

/** Ids per reactions re-read (one IN read each). */
export const REACTION_RECHECK_CHUNK = 100;
/** At most this many reactions chunk reads in flight at once. */
export const REACTION_RECHECK_CONCURRENCY = 3;

/**
 * Whether a catch-up re-reads the loaded rows' reactions: on 'connected' and
 * the foreground triggers (visible, online), never on the 60s interval.
 */
export function reactionRecheckWanted(reason: CatchUpReason): boolean {
  return reason !== 'interval';
}

/** The loaded rows whose reactions a re-read covers: recorded, not deleted. */
export function reactionRecheckIds(messages: readonly ThreadMessage[]): string[] {
  return messages.filter((m) => m.state === 'sent' && m.deleted !== true).map((m) => m.id);
}

/**
 * Re-read the reactions of these ids, chunked by REACTION_RECHECK_CHUNK, at
 * most REACTION_RECHECK_CONCURRENCY chunks in flight, each with the 5s read
 * timeout. Any failed chunk fails the whole re-read (no further chunk starts),
 * so the caller keeps what it shows. Never throws.
 */
export async function rereadReactions(
  load: (
    ids: readonly string[],
    signal: AbortSignal,
  ) => Promise<Result<Map<string, MessageReaction[]>>>,
  ids: readonly string[],
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<Result<Map<string, MessageReaction[]>>> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += REACTION_RECHECK_CHUNK) {
    chunks.push(ids.slice(i, i + REACTION_RECHECK_CHUNK));
  }
  const merged = new Map<string, MessageReaction[]>();
  let failure: Result<Map<string, MessageReaction[]>> | null = null;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failure === null && next < chunks.length) {
      const chunk = chunks[next] ?? [];
      next += 1;
      const result = await withReadTimeout((signal) => load(chunk, signal), timeoutMs);
      if (!result.ok) {
        failure = result;
        return;
      }
      for (const [id, reactions] of result.data) merged.set(id, reactions);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(REACTION_RECHECK_CONCURRENCY, chunks.length) }, worker),
  );
  return failure ?? { ok: true, data: merged };
}

/**
 * The re-read ids whose reactions may be applied: those not toggled locally
 * after the re-read started (`touched` maps an id to its last toggle number,
 * `startedAt` is the toggle number when the re-read began). Pure.
 */
export function untouchedSince(
  ids: readonly string[],
  touched: ReadonlyMap<string, number>,
  startedAt: number,
): string[] {
  return ids.filter((id) => (touched.get(id) ?? 0) <= startedAt);
}
