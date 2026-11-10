// The thread view's data: one card's thread (its root and every reply whose
// thread_root_message_id is that card), paged newest first with the history
// page size over the (channel_id, thread_root_message_id, created_at) index,
// Load older at the top. When the root is already loaded the view opens in the
// same frame (loading, placeholder rows) and the first page fills it; only an
// unknown root waits for its root read. A failed page read shows in the view
// (failed + retry). Rows the
// open chat already has loaded win over the view's own copies, so live
// arrivals, own sends, reactions, edits and deletes show in both. The view
// never reads or writes read cursors.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import {
  loadMessagesByIds,
  loadReactions,
  loadThreadPage,
  type HistoryPage,
} from '@/lib/chat/history';
import {
  compareMessages,
  mergeReactions,
  oldestCursor,
  rowToThreadMessage,
  type ChatMessageRow,
  type MessageCursor,
  type MessageReaction,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { setOlderPageFailed, threadOlderKey } from '@/lib/chat/older-page-status';
import { withRootCards } from '@/lib/chat/thread-rail';

/** The reads the view makes; injected in tests. */
interface ThreadViewReads {
  loadRoot: (rootId: string) => Promise<Result<ChatMessageRow[]>>;
  loadPage: (
    channelId: string,
    rootId: string,
    before?: MessageCursor,
  ) => Promise<Result<HistoryPage>>;
  loadReactions: (ids: readonly string[]) => Promise<Result<Map<string, MessageReaction[]>>>;
}

/** What one open thread holds: its root and the replies it read itself. */
interface ThreadViewState {
  rootId: string;
  root: ThreadMessage;
  /** Replies read by the view (oldest first), before the loaded rows are laid over. */
  fetched: ThreadMessage[];
  hasMore: boolean;
  /** The first page is still being read (placeholder rows show). */
  loading?: boolean;
  /** The first page read failed ("Couldn't load this thread." + Retry). */
  failed?: boolean;
}

/**
 * The view's rows: its root, then its replies oldest first, the open chat's
 * loaded rows winning over the view's copies and adding the replies it has
 * (live arrivals, own sends) that the view did not read. Pure.
 */
export function threadViewRows(
  view: ThreadViewState,
  loaded: readonly ThreadMessage[],
): { root: ThreadMessage; replies: ThreadMessage[] } {
  const byId = new Map(view.fetched.map((m) => [m.id, m] as const));
  let root = view.root;
  for (const m of loaded) {
    if (m.id === view.rootId) root = withRootCards(m, view.root);
    else if (m.threadRootId === view.rootId) byId.set(m.id, m);
  }
  return { root, replies: [...byId.values()].sort(compareMessages) };
}

/** Lay one page's reactions onto its rows; a failed read leaves them bare. */
async function withReactions(
  reads: ThreadViewReads,
  rows: ThreadMessage[],
): Promise<ThreadMessage[]> {
  if (rows.length === 0) return rows;
  const result = await reads.loadReactions(rows.map((m) => m.id));
  if (!result.ok) {
    logger.warn('chat: thread reactions load failed', { error: result.error.message });
    return rows;
  }
  return mergeReactions(rows, result.data);
}

interface UseThreadView {
  view: ThreadViewState | null;
  loadingOlder: boolean;
  /**
   * Open at once when the root is loaded (loading), else after its root read;
   * the first page then fills it, or marks it failed. Resolves false only
   * when the root cannot be found (the caller toasts); an open superseded by
   * a newer open or a close resolves true (nothing to report).
   */
  open: (rootId: string, loaded: readonly ThreadMessage[]) => Promise<boolean>;
  /** Re-read the first page of the open thread after a failure. */
  retry: () => void;
  close: () => void;
  loadOlder: () => void;
  /** Apply an own action (reaction, edit, delete) to the view's own copies. */
  update: (fn: (rows: ThreadMessage[]) => ThreadMessage[]) => void;
}

function defaultThreadViewReads(client: Client, currentUserId: string): ThreadViewReads {
  return {
    loadRoot: (rootId) => loadMessagesByIds(client, [rootId]),
    loadPage: (channelId, rootId, before) => loadThreadPage(client, channelId, rootId, before),
    loadReactions: (ids) => loadReactions(client, ids, currentUserId),
  };
}

export function useThreadView(params: {
  channelId: string | undefined;
  currentUserId: string;
  reads?: ThreadViewReads;
}): UseThreadView {
  const { channelId, currentUserId } = params;
  const injected = params.reads;
  const reads = useMemo(
    () => injected ?? defaultThreadViewReads(supabase, currentUserId),
    [injected, currentUserId],
  );
  const [view, setView] = useState<ThreadViewState | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Each open or close starts a new attempt; a slower read of an older one is dropped.
  const attemptRef = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  const olderRef = useRef(false);

  const fillFirstPage = useCallback(
    async (attempt: number, rootId: string): Promise<void> => {
      if (channelId === undefined) return;
      const pageRead = await reads.loadPage(channelId, rootId);
      if (attempt !== attemptRef.current) return;
      if (!pageRead.ok) {
        logger.warn('chat: thread page failed', { root_id: rootId, error: pageRead.error.message });
        setView((prev) =>
          prev !== null && prev.rootId === rootId
            ? { ...prev, loading: false, failed: true }
            : prev,
        );
        return;
      }
      const fetched = await withReactions(
        reads,
        pageRead.data.rows.map((row) => rowToThreadMessage(row, currentUserId)),
      );
      if (attempt !== attemptRef.current) return;
      setView((prev) =>
        prev !== null && prev.rootId === rootId
          ? { ...prev, fetched, hasMore: pageRead.data.hasMore, loading: false, failed: false }
          : prev,
      );
    },
    [channelId, currentUserId, reads],
  );

  const open = useCallback(
    async (rootId: string, loaded: readonly ThreadMessage[]): Promise<boolean> => {
      if (channelId === undefined) return false;
      attemptRef.current += 1;
      const attempt = attemptRef.current;
      let root = loaded.find((m) => m.id === rootId);
      if (root === undefined) {
        const rootRead = await reads.loadRoot(rootId);
        if (attempt !== attemptRef.current) return true;
        const row = rootRead.ok ? rootRead.data[0] : undefined;
        if (row === undefined) {
          logger.warn('chat: thread open failed', { root_id: rootId, error: 'root not found' });
          return false;
        }
        root = rowToThreadMessage(row, currentUserId);
      }
      olderRef.current = false;
      setLoadingOlder(false);
      setView({ rootId, root, fetched: [], hasMore: false, loading: true, failed: false });
      void fillFirstPage(attempt, rootId);
      return true;
    },
    [channelId, currentUserId, reads, fillFirstPage],
  );

  const retry = useCallback((): void => {
    const current = viewRef.current;
    if (current === null) return;
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    setView((prev) =>
      prev !== null && prev.rootId === current.rootId
        ? { ...prev, loading: true, failed: false }
        : prev,
    );
    void fillFirstPage(attempt, current.rootId);
  }, [fillFirstPage]);

  const close = useCallback((): void => {
    attemptRef.current += 1;
    olderRef.current = false;
    setLoadingOlder(false);
    setView(null);
  }, []);

  const loadOlder = useCallback((): void => {
    const current = viewRef.current;
    if (current === null || channelId === undefined || olderRef.current) return;
    const cursor = oldestCursor(current.fetched);
    if (cursor === undefined) return;
    olderRef.current = true;
    setLoadingOlder(true);
    setOlderPageFailed(threadOlderKey(current.rootId), false);
    const attempt = attemptRef.current;
    void (async (): Promise<void> => {
      const page = await reads.loadPage(channelId, current.rootId, cursor);
      const rows = page.ok
        ? await withReactions(
            reads,
            page.data.rows.map((row) => rowToThreadMessage(row, currentUserId)),
          )
        : [];
      if (attempt !== attemptRef.current) return;
      olderRef.current = false;
      setLoadingOlder(false);
      if (!page.ok) {
        logger.warn('chat: thread older page failed', { error: page.error.message });
        // FT41: the thread view shows "Couldn't load earlier messages." + Retry.
        setOlderPageFailed(threadOlderKey(current.rootId), true);
        return;
      }
      setView((prev) =>
        prev !== null && prev.rootId === current.rootId
          ? { ...prev, fetched: [...rows, ...prev.fetched], hasMore: page.data.hasMore }
          : prev,
      );
    })();
  }, [channelId, currentUserId, reads]);

  const update = useCallback((fn: (rows: ThreadMessage[]) => ThreadMessage[]): void => {
    setView((prev) => (prev !== null ? { ...prev, fetched: fn(prev.fetched) } : prev));
  }, []);

  return { view, loadingOlder, open, retry, close, loadOlder, update };
}
