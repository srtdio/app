// Catch up's state: where in the fixed queue of ITEMS the person is, what they
// decided, and the one Undo (4 s, like every Undo). A decision covers every
// entry of the item (one inbox_mark_read_ids call; Undo one
// inbox_mark_unread_ids call). A skipped card (deleted, access lost, read on
// another device) is marked read silently and never offered to Undo. Mark as read and Undo are
// optimistic: the screen moves at once, the write runs behind it with its own
// trace id, and a failure toasts and puts that card back (never a stuck
// stack). Keep unread writes nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';
import {
  markAllCatchUpRead,
  markCatchUpRead,
  markCatchUpSkipped,
  markThreadsCatchUpRead,
  undoCatchUpRead,
} from '@/lib/catch-up/writes';
import { unreadIdsOf, type CatchUpItem } from '@/lib/catch-up/queue';
import { patchThreadUnread } from '@/lib/catch-up/threads';

/** How long Undo stays offered after a decision (the app's Undo window). */
export const CATCH_UP_UNDO_MS = 4000;

/** One decision on a card. */
export interface CatchUpDecision {
  item: CatchUpItem;
  read: boolean;
  /** Skipped silently: counts as gone through, never undone. */
  skipped?: boolean;
}

/** What the screen's owner hears: entries now read or unread (the Activity list follows), and failures. */
export interface CatchUpHooks {
  workspaceId: string;
  onRead: (ids: readonly string[]) => void;
  onUnread: (ids: readonly string[]) => void;
  /** Every write's failure: the screen toasts "Couldn't ...". */
  onFailed: (action: 'mark as read' | 'undo') => void;
  /** Long-press Mark as read saved: every entry read. */
  onAllRead: () => void;
}

/**
 * Whether Mark as read on `item` writes: an inbox card with unread entries, or
 * any Threads card (its read point is the write; it holds no inbox ids). Pure.
 */
export function decisionWrites(item: CatchUpItem): boolean {
  return item.source === 'threads' || unreadIdsOf(item).length > 0;
}

/** A Threads card's read state in the held threads list (its count follows at once). */
function patchThread(item: CatchUpItem, unread: boolean): void {
  if (item.source !== 'threads' || item.threadRootId === null) return;
  patchThreadUnread(item.workspaceId, item.entityId, item.threadRootId, unread);
}

/** Who hears each card read or put back (a tab's chat count follows at once, 13 Nov 2026). */
type ItemListener = (item: CatchUpItem, read: boolean) => void;
const itemListeners = new Set<ItemListener>();

/** Hear every card marked read (true) or put back unread (false); returns the unsubscribe. */
export function onCatchUpItem(listener: ItemListener): () => void {
  itemListeners.add(listener);
  return () => {
    itemListeners.delete(listener);
  };
}

function tellItem(item: CatchUpItem, read: boolean): void {
  for (const listener of itemListeners) listener(item, read);
}

/** The state after `decisions` on `queue`: the next card's index. Pure. */
export function nextIndex(queueLength: number, decisions: number): number {
  return Math.min(queueLength, Math.max(0, decisions));
}

export function useCatchUp(queue: readonly CatchUpItem[], hooks: CatchUpHooks) {
  const [decisions, setDecisions] = useState<CatchUpDecision[]>([]);
  const [undoUntil, setUndoUntil] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const index = nextIndex(queue.length, decisions.length);
  const current = queue[index] ?? null;
  const next = queue[index + 1] ?? null;

  // Undo's window closes on its own (one timer, only while it is open).
  useEffect(() => {
    if (undoUntil <= nowMs) return undefined;
    const timer = window.setTimeout(() => setNowMs(Date.now()), undoUntil - nowMs);
    return () => window.clearTimeout(timer);
  }, [undoUntil, nowMs]);

  /** Put the decision on `id` back (its write failed), only while it is still the last one. */
  const putBack = useCallback((id: string) => {
    setDecisions((prev) => (prev[prev.length - 1]?.item.key === id ? prev.slice(0, -1) : prev));
  }, []);

  const decide = useCallback(
    (read: boolean, latestReplyId: string | null = null): void => {
      const item = queue[decisions.length];
      if (item === undefined) return;
      setDecisions((prev) => [...prev, { item, read }]);
      const now = Date.now();
      setNowMs(now);
      setUndoUntil(now + CATCH_UP_UNDO_MS);
      // Keep unread writes nothing; an item with nothing unread only moves on.
      const ids = unreadIdsOf(item);
      if (!read || !decisionWrites(item)) return;
      const h = hooksRef.current;
      h.onRead(ids);
      patchThread(item, false);
      tellItem(item, true);
      const traceId = generateTraceId();
      void markCatchUpRead(supabase, {
        workspaceId: h.workspaceId,
        item,
        latestReplyId,
        traceId,
      }).then((result) => {
        if (result.ok) return;
        logger.warn('catch-up: mark read failed', { trace_id: traceId, error: result.message });
        patchThread(item, true);
        tellItem(item, false);
        hooksRef.current.onUnread(ids);
        hooksRef.current.onFailed('mark as read');
        putBack(item.key);
      });
    },
    [queue, decisions.length, putBack],
  );

  /** Skip the current card silently (deleted, access lost, read elsewhere): its entries read, no Undo. */
  const skip = useCallback(
    (key: string): void => {
      const item = queue[decisions.length];
      if (item === undefined || item.key !== key) return;
      setDecisions((prev) => [...prev, { item, read: true, skipped: true }]);
      const ids = unreadIdsOf(item);
      if (ids.length === 0) return;
      const h = hooksRef.current;
      h.onRead(ids);
      const traceId = generateTraceId();
      void markCatchUpSkipped(supabase, { workspaceId: h.workspaceId, item, traceId }).then(
        (result) => {
          if (!result.ok) {
            logger.warn('catch-up: skip read failed', { trace_id: traceId, error: result.message });
          }
        },
      );
    },
    [queue, decisions.length],
  );

  const lastDecision = decisions[decisions.length - 1];
  const canUndo = lastDecision !== undefined && lastDecision.skipped !== true && undoUntil > nowMs;

  const undo = useCallback((): void => {
    const last = decisions[decisions.length - 1];
    if (last === undefined || last.skipped === true || undoUntil <= Date.now()) return;
    setDecisions((prev) => prev.slice(0, -1));
    setUndoUntil(0);
    const ids = unreadIdsOf(last.item);
    if (!last.read || !decisionWrites(last.item)) return;
    const h = hooksRef.current;
    h.onUnread(ids);
    patchThread(last.item, true);
    tellItem(last.item, false);
    const traceId = generateTraceId();
    void undoCatchUpRead(supabase, { workspaceId: h.workspaceId, item: last.item, traceId }).then(
      (result) => {
        if (result.ok) return;
        logger.warn('catch-up: undo failed', { trace_id: traceId, error: result.message });
        patchThread(last.item, false);
        hooksRef.current.onRead(ids);
        hooksRef.current.onFailed('undo');
      },
    );
  }, [decisions, undoUntil]);

  /**
   * Long-press Mark as read: every queued entry read (one inbox_mark_all_read),
   * then the end screen. The Threads queue reads every queued thread instead
   * (its read points; the inbox is untouched).
   */
  const markAll = useCallback((): void => {
    const rest = queue.slice(decisions.length);
    if (rest.length === 0) return;
    const h = hooksRef.current;
    const unread = rest.flatMap(unreadIdsOf);
    const threads = rest.every((item) => item.source === 'threads');
    setDecisions((prev) => [...prev, ...rest.map((item) => ({ item, read: true }))]);
    setUndoUntil(0);
    h.onRead(unread);
    for (const item of rest) patchThread(item, false);
    const traceId = generateTraceId();
    const write = threads
      ? markThreadsCatchUpRead(supabase, { items: rest, traceId })
      : markAllCatchUpRead(supabase, { workspaceId: h.workspaceId, traceId });
    void write.then((result) => {
      if (result.ok) {
        hooksRef.current.onAllRead();
        return;
      }
      logger.warn('catch-up: mark all read failed', { trace_id: traceId, error: result.message });
      for (const item of rest) patchThread(item, true);
      hooksRef.current.onUnread(unread);
      hooksRef.current.onFailed('mark as read');
      setDecisions((prev) => prev.slice(0, prev.length - rest.length));
    });
  }, [queue, decisions.length]);

  return {
    index,
    current,
    next,
    /** Cards still to go, the current one included ("<N> left"). */
    left: Math.max(0, queue.length - index),
    /** How many cards were gone through (the end screen's count; skipped cards left out). */
    wentThrough: decisions.filter((d) => d.skipped !== true).length,
    /** How many cards were kept unread (the end screen's other count; Undo pops them). */
    keptUnread: decisions.filter((d) => !d.read && d.skipped !== true).length,
    done: queue.length > 0 && index >= queue.length,
    decide,
    skip,
    undo,
    canUndo,
    markAll,
  };
}

export type CatchUpState = ReturnType<typeof useCatchUp>;
