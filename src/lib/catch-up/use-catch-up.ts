// Catch up's state: where in the fixed queue the person is, what they decided,
// and the one Undo (4 s, like every Undo). Mark as read and Undo are
// optimistic: the screen moves at once, the write runs behind it with its own
// trace id, and a failure toasts and puts that card back (never a stuck
// stack). Keep unread writes nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityItem } from '@/components/pages/activity/data';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';
import { markAllCatchUpRead, markCatchUpRead, undoCatchUpRead } from '@/lib/catch-up/writes';

/** How long Undo stays offered after a decision (the app's Undo window). */
export const CATCH_UP_UNDO_MS = 4000;

/** One decision on a card. */
export interface CatchUpDecision {
  item: ActivityItem;
  read: boolean;
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

/** The state after `decisions` on `queue`: the next card's index. Pure. */
export function nextIndex(queueLength: number, decisions: number): number {
  return Math.min(queueLength, Math.max(0, decisions));
}

export function useCatchUp(queue: readonly ActivityItem[], hooks: CatchUpHooks) {
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
    setDecisions((prev) => (prev[prev.length - 1]?.item.id === id ? prev.slice(0, -1) : prev));
  }, []);

  const decide = useCallback(
    (read: boolean, latestReplyId: string | null = null): void => {
      const item = queue[decisions.length];
      if (item === undefined) return;
      setDecisions((prev) => [...prev, { item, read }]);
      const now = Date.now();
      setNowMs(now);
      setUndoUntil(now + CATCH_UP_UNDO_MS);
      // Keep unread writes nothing; an entry already read only moves on.
      if (!read || item.readAt !== null) return;
      const h = hooksRef.current;
      h.onRead([item.id]);
      const traceId = generateTraceId();
      void markCatchUpRead(supabase, {
        workspaceId: h.workspaceId,
        item,
        latestReplyId,
        traceId,
      }).then((result) => {
        if (result.ok) return;
        logger.warn('catch-up: mark read failed', { trace_id: traceId, error: result.message });
        hooksRef.current.onUnread([item.id]);
        hooksRef.current.onFailed('mark as read');
        putBack(item.id);
      });
    },
    [queue, decisions.length, putBack],
  );

  const canUndo = decisions.length > 0 && undoUntil > nowMs;

  const undo = useCallback((): void => {
    const last = decisions[decisions.length - 1];
    if (last === undefined || undoUntil <= Date.now()) return;
    setDecisions((prev) => prev.slice(0, -1));
    setUndoUntil(0);
    if (!last.read || last.item.readAt !== null) return;
    const h = hooksRef.current;
    h.onUnread([last.item.id]);
    const traceId = generateTraceId();
    void undoCatchUpRead(supabase, { workspaceId: h.workspaceId, item: last.item, traceId }).then(
      (result) => {
        if (result.ok) return;
        logger.warn('catch-up: undo failed', { trace_id: traceId, error: result.message });
        hooksRef.current.onRead([last.item.id]);
        hooksRef.current.onFailed('undo');
      },
    );
  }, [decisions, undoUntil]);

  /** Long-press Mark as read: every queued entry read (one inbox_mark_all_read), then the end screen. */
  const markAll = useCallback((): void => {
    const rest = queue.slice(decisions.length);
    if (rest.length === 0) return;
    const h = hooksRef.current;
    const unread = rest.filter((item) => item.readAt === null).map((item) => item.id);
    setDecisions((prev) => [...prev, ...rest.map((item) => ({ item, read: true }))]);
    setUndoUntil(0);
    h.onRead(unread);
    const traceId = generateTraceId();
    void markAllCatchUpRead(supabase, { workspaceId: h.workspaceId, traceId }).then((result) => {
      if (result.ok) {
        hooksRef.current.onAllRead();
        return;
      }
      logger.warn('catch-up: mark all read failed', { trace_id: traceId, error: result.message });
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
    /** How many cards were gone through (the end screen's count). */
    wentThrough: decisions.length,
    done: queue.length > 0 && index >= queue.length,
    decide,
    undo,
    canUndo,
    markAll,
  };
}

export type CatchUpState = ReturnType<typeof useCatchUp>;
