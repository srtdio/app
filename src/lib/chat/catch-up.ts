// Catch-up from Postgres, independent of the Agora connection. Live delivery
// can drop messages silently (a gap, a missed event, a message verified after
// a reload), so the open thread re-reads the record on its own schedule: when
// the tab becomes visible, when the browser comes back online, on every
// transition to 'connected', and every CATCH_UP_INTERVAL_MS while the tab is
// visible. None of this looks at whether Agora is live. Framework-free and
// fully injected, so both the paging loop and the trigger wiring are
// unit-tested without a DOM.

import type { Result } from '@srtdio/rpc';
import { CATCH_UP_LIMIT, type HistoryPage } from '@/lib/chat/history';
import type { ChatMessageRow, MessageCursor } from '@/lib/chat/thread';

/** Periodic catch-up while the tab is visible. */
export const CATCH_UP_INTERVAL_MS = 60_000;

/** Upper bound on pages one catch-up reads, so a runaway loop cannot spin forever. */
export const CATCH_UP_MAX_PAGES = 20;

export interface CatchUpLoaders {
  loadLatest: () => Promise<Result<HistoryPage>>;
  loadNewer: (cursor: MessageCursor) => Promise<Result<ChatMessageRow[]>>;
}

/** What one catch-up read: every row found (oldest-first) and the latest-page hasMore. */
export type CatchUpOutcome =
  | { ok: true; rows: ChatMessageRow[]; latestPage: { hasMore: boolean } | undefined }
  | { ok: false; error: string; rows: ChatMessageRow[] };

/**
 * Read everything newer than `cursor`. With no cursor (the thread holds no
 * recorded message yet) the latest page is loaded instead of skipping. A page
 * that hits CATCH_UP_LIMIT means more may follow, so the next page is read from
 * the newest row until one comes back under the cap.
 */
export async function catchUpRows(
  loaders: CatchUpLoaders,
  cursor: MessageCursor | undefined,
): Promise<CatchUpOutcome> {
  if (cursor === undefined) {
    const page = await loaders.loadLatest();
    if (!page.ok) return { ok: false, error: page.error.message, rows: [] };
    return { ok: true, rows: page.data.rows, latestPage: { hasMore: page.data.hasMore } };
  }
  const rows: ChatMessageRow[] = [];
  let from = cursor;
  for (let pageIndex = 0; pageIndex < CATCH_UP_MAX_PAGES; pageIndex += 1) {
    const page = await loaders.loadNewer(from);
    if (!page.ok) return { ok: false, error: page.error.message, rows };
    rows.push(...page.data);
    const last = page.data[page.data.length - 1];
    if (page.data.length < CATCH_UP_LIMIT || last === undefined) break;
    from = { createdAt: last.created_at, id: last.id };
  }
  return { ok: true, rows, latestPage: undefined };
}

export interface CatchUpTriggerDeps {
  /** Run one catch-up (the caller guards against overlap). */
  run: () => void;
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
      if (deps.isVisible()) deps.run();
    }, intervalMs);
    active = true;
  };
  if (deps.isVisible()) startInterval();
  const removeVisibility = deps.onVisibilityChange(() => {
    if (deps.isVisible()) {
      deps.run();
      startInterval();
    } else {
      stopInterval();
    }
  });
  const removeOnline = deps.onOnline(() => deps.run());
  return () => {
    stopInterval();
    removeVisibility();
    removeOnline();
  };
}

/** The browser wiring for startCatchUpTriggers. */
export function browserCatchUpTriggers(run: () => void): () => void {
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
