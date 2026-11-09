// The reactions a list (a comments page, a plan thread, a catch-up card) shows:
// ONE batched read for the ids on screen, started after paint (an effect,
// never awaited by a render), then one more per page that adds ids (only the
// new ones). A bump of `epoch` (the list's own refresh) re-reads every id in
// one query: that is how others' reactions arrive (no new realtime channel).
// A tap toggles the viewer's reaction optimistically; a failed write rolls
// back and shows the standard error toast. Reacting never reads or writes
// anything else (it never marks read).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalToast } from '@/components/ui/toast';
import { errorText } from '@/lib/error-copy';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import {
  NO_REACTIONS,
  NO_ROWS,
  applyOp,
  groupByTarget,
  summarize,
  toggleOp,
  type ReactionKind,
  type ReactionRow,
  type ReactionSummary,
} from '@/lib/reactions/model';
import { readReactions } from '@/lib/reactions/reads';
import { writeReaction } from '@/lib/reactions/writes';

/** What a list's rows read and call. */
export interface ReactionsApi {
  /** One target's chips (first reaction order); the shared empty array when none. */
  of: (id: string) => readonly ReactionSummary[];
  /** One target's rows (who reacted). */
  rowsOf: (id: string) => readonly ReactionRow[];
  /** Toggle the viewer's `emoji` on a target (a chip tap). */
  toggle: (id: string, emoji: string) => void;
  /** The viewer (null until known): who-reacted names them "You". */
  me: string | null;
  /** A drawer pick: adds it (already mine: nothing changes). */
  pick: (id: string, emoji: string) => void;
}

/** The ids a page-add needs: the ones never read. Pure. */
export function idsToRead(
  ids: readonly string[],
  read: ReadonlySet<string>,
  full: boolean,
): string[] {
  const unique = [...new Set(ids)];
  return full ? unique : unique.filter((id) => !read.has(id));
}

export function useReactions(params: {
  kind: ReactionKind;
  ids: readonly string[];
  /** The list's refresh: a new value re-reads every id (one query). */
  epoch?: unknown;
  /** The viewer; absent: read once from the session, after paint. */
  me?: string | null;
  /** Chat only: the channel the messages are in. */
  channelId?: string | null;
  /** Off (a list that shows no reactions): no read at all. */
  enabled?: boolean;
}): ReactionsApi {
  const { kind, epoch } = params;
  const enabled = params.enabled !== false;
  const toast = useOptionalToast();
  const [rows, setRows] = useState<ReadonlyMap<string, readonly ReactionRow[]>>(() => new Map());
  const [sessionMe, setSessionMe] = useState<string | null>(null);
  const me = params.me !== undefined ? params.me : sessionMe;
  const readIds = useRef(new Set<string>());
  const lastEpoch = useRef<unknown>(epoch);
  // Ids written since a read started keep their local rows when it lands.
  const touched = useRef(new Map<string, number>());
  const seq = useRef(0);
  const idsKey = params.ids.join(',');
  const latest = useRef({ me, channelId: params.channelId ?? null, rows });
  latest.current = { me, channelId: params.channelId ?? null, rows };

  useEffect(() => {
    if (params.me !== undefined) return;
    let active = true;
    // The session the client already holds (no network); a failure leaves no viewer.
    void Promise.resolve()
      .then(() => supabase.auth.getSession())
      .then(({ data }) => {
        if (active) setSessionMe(data.session?.user.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [params.me]);

  useEffect(() => {
    if (!enabled || idsKey === '') return;
    const full = lastEpoch.current !== epoch;
    lastEpoch.current = epoch;
    const ids = idsToRead(idsKey.split(','), readIds.current, full);
    if (ids.length === 0) return;
    for (const id of ids) readIds.current.add(id);
    const startedAt = ++seq.current;
    let active = true;
    void readReactions(supabase, kind, ids).then((result) => {
      if (!active) return;
      if (!result.ok) {
        for (const id of ids) readIds.current.delete(id);
        logger.warn('reactions: read failed', { kind, error: result.error.message });
        return;
      }
      const grouped = groupByTarget(result.data, ids);
      setRows((prev) => {
        const next = new Map(prev);
        for (const [id, list] of grouped) {
          // A write after this read started keeps its own optimistic rows.
          if ((touched.current.get(id) ?? 0) > startedAt) continue;
          next.set(id, list);
        }
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, [kind, idsKey, epoch, enabled]);

  const run = useCallback(
    (id: string, emoji: string, forced: 'add' | null): void => {
      const { me: viewer, channelId, rows: held } = latest.current;
      if (viewer === null) return;
      if (kind === 'chat' && channelId === null) return;
      const current = held.get(id) ?? NO_ROWS;
      const op = forced ?? toggleOp(current, viewer, emoji);
      touched.current.set(id, ++seq.current);
      const at = new Date().toISOString();
      setRows((prev) => {
        const next = new Map(prev);
        next.set(id, applyOp(prev.get(id) ?? NO_ROWS, { targetId: id, me: viewer, emoji, op, at }));
        return next;
      });
      const traceId = generateTraceId();
      const target = kind === 'chat' ? { kind, id, channelId: channelId ?? '' } : { kind, id };
      void writeReaction(supabase, target, emoji, op, traceId).then((result) => {
        if (result.ok) return;
        logger.warn('reactions: write failed', {
          trace_id: traceId,
          kind,
          op,
          error: result.message,
        });
        touched.current.set(id, ++seq.current);
        setRows((prev) => {
          const next = new Map(prev);
          const back = op === 'add' ? 'remove' : 'add';
          next.set(
            id,
            applyOp(prev.get(id) ?? NO_ROWS, { targetId: id, me: viewer, emoji, op: back, at }),
          );
          return next;
        });
        toast?.show({
          title: errorText(op === 'add' ? 'add the reaction' : 'remove the reaction', null),
          tone: 'error',
        });
      });
    },
    [kind, toast],
  );

  const toggle = useCallback((id: string, emoji: string) => run(id, emoji, null), [run]);
  // The drawer (ui/EmojiSheet) feeds Frequently used itself on every pick.
  const pick = useCallback((id: string, emoji: string) => run(id, emoji, 'add'), [run]);
  const of = useCallback(
    (id: string): readonly ReactionSummary[] => {
      const list = rows.get(id);
      return list === undefined ? NO_REACTIONS : summarize(list, me);
    },
    [rows, me],
  );
  const rowsOf = useCallback((id: string) => rows.get(id) ?? NO_ROWS, [rows]);
  return { of, rowsOf, toggle, pick, me };
}
