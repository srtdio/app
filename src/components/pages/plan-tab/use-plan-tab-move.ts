// A calendar drop (creators only): the entry shows on its new day at once
// (an override by entry key) and the write goes the way the Plan screen's
// moves go. A plan item: one 5-arg plan_item_move with the plan's full order
// (the item at the end of the new day), an Open plan's client-approved item
// asking "Keep the approval?" first; a move that resets nothing waits behind
// the Undo toast (Undo puts it back and nothing is written), a move that
// resets ticks writes at once with no Undo. A dated post in no plan: one
// post_update of its target_date (12:00 on the new day in the workspace zone),
// behind the same Undo toast. A failed write puts the entry back and toasts
// the existing move copy. The override goes once the re-read is in.

import { useCallback, useRef, useState } from 'react';
import { postUpdate } from '@srtdio/posts';
import { planItemMove } from '@srtdio/rpc';
import { planDayIds, planListGroups, MEMBER_NAME } from '@/components/chat/PlanScreen';
import {
  MOVE_FAILED,
  PLAN_UNDO_MS,
  approvedBy,
  dayHeaderOf,
  keepApprovalBody,
  keepApprovalTitle,
  moveAsksKeep,
  planWriteErrorCopy,
} from '@/components/chat/plan-card';
import { useToast } from '@/components/ui/toast';
import { readProfiles } from '@/lib/chat-reads';
import { flattenOrder, hasTicks, moveToEnd } from '@/lib/chat/plan-drag';
import { dayMoveToast } from '@/lib/chat/plan-keyboard-move';
import { dispatchPlanChanged } from '@/lib/chat/plans';
import { logger } from '@/lib/logger';
import type { CalendarEntry } from '@/lib/plan-tab';
import { civilNoonInZoneIso } from '@/lib/plan-week';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useUndoableAction } from '@/lib/use-undoable-action';

type ItemEntry = Extract<CalendarEntry, { kind: 'item' }>;

/** The keep-approval question for one drop. */
export interface KeepAsk {
  title: string;
  body: string;
  entry: ItemEntry;
  day: string;
}

export function usePlanTabMove(input: { timeZone: string; reload: () => Promise<void> }): {
  overrides: Readonly<Record<string, string>>;
  move: (entry: CalendarEntry, day: string) => void;
  keepAsk: KeepAsk | null;
  answerKeep: (keep: boolean) => void;
  cancelKeep: () => void;
} {
  const { timeZone, reload } = input;
  const toast = useToast();
  const undoable = useUndoableAction({ durationMs: PLAN_UNDO_MS });
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [keepAsk, setKeepAsk] = useState<KeepAsk | null>(null);
  const busy = useRef(new Set<string>());

  const place = useCallback((key: string, day: string | null): void => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (day === null) delete next[key];
      else next[key] = day;
      return next;
    });
  }, []);

  // The write landed: re-read, then drop the override (the data has the day).
  const settle = useCallback(
    async (key: string): Promise<void> => {
      await reload();
      busy.current.delete(key);
      place(key, null);
    },
    [reload, place],
  );
  const revert = useCallback(
    (key: string): void => {
      busy.current.delete(key);
      place(key, null);
    },
    [place],
  );

  const writeItem = useCallback(
    async (entry: ItemEntry, day: string, keep: boolean): Promise<boolean> => {
      const { bundle, item } = entry;
      const groups = planListGroups(bundle, timeZone, 'agency');
      const order = flattenOrder(moveToEnd(planDayIds(groups), item.id, day));
      const traceId = generateTraceId();
      const result = await planItemMove(supabase, {
        p_item_id: item.id,
        p_target_date: day,
        p_item_ids: order,
        p_keep_reviews: keep,
        p_trace_id: traceId,
      });
      if (!result.ok) {
        logger.warn('plan tab: item move failed', {
          trace_id: traceId,
          item_id: item.id,
          error: result.error.message,
        });
        toast.show({ title: planWriteErrorCopy(result.error.message, MOVE_FAILED) });
        return false;
      }
      dispatchPlanChanged(window, bundle.plan.id);
      return true;
    },
    [timeZone, toast],
  );

  const writePost = useCallback(
    async (entry: Extract<CalendarEntry, { kind: 'post' }>, day: string): Promise<boolean> => {
      const traceId = generateTraceId();
      const result = await postUpdate(
        supabase,
        { postId: entry.post.id, targetDate: civilNoonInZoneIso(day, timeZone) },
        traceId,
      );
      if (!result.ok) {
        logger.warn('plan tab: post date move failed', {
          trace_id: traceId,
          post_id: entry.post.id,
          error: result.error.message,
        });
        toast.show({ title: planWriteErrorCopy(result.error.message, MOVE_FAILED) });
        return false;
      }
      return true;
    },
    [timeZone, toast],
  );

  const run = useCallback(
    (entry: CalendarEntry, day: string, keep: boolean): void => {
      const key = entry.key;
      busy.current.add(key);
      place(key, day);
      const write = (): Promise<boolean> =>
        entry.kind === 'item' ? writeItem(entry, day, keep) : writePost(entry, day);
      const reset = entry.kind === 'item' && !keep && hasTicks(entry.bundle, entry.item.id);
      const spec = dayMoveToast(
        dayHeaderOf(day),
        entry.kind === 'post' || entry.item.kind === 'post',
        reset,
      );
      const commit = async (): Promise<void> => {
        if (await write()) await settle(key);
        else revert(key);
      };
      if (spec.undo) {
        undoable.run({ label: spec.title, commit, revert: () => revert(key) });
        return;
      }
      // Ticks are reset: the creators cannot put an approver's tick back, so no Undo.
      void write().then(async (ok) => {
        if (!ok) {
          revert(key);
          return;
        }
        toast.show({ title: spec.title });
        await settle(key);
      });
    },
    [place, writeItem, writePost, settle, revert, undoable, toast],
  );

  const move = useCallback(
    (entry: CalendarEntry, day: string): void => {
      if (busy.current.has(entry.key) || day === entry.day) return;
      if (entry.kind === 'item' && moveAsksKeep(entry.bundle, entry.item, entry.day, day)) {
        const userId = approvedBy(entry.bundle, entry.item)?.userId ?? null;
        const ask = (name: string): void =>
          setKeepAsk({
            title: keepApprovalTitle(name),
            body: keepApprovalBody(dayHeaderOf(day)),
            entry,
            day,
          });
        if (userId === null) {
          ask(MEMBER_NAME);
          return;
        }
        // A failed name read keeps the question (the title reads "Member").
        void readProfiles(supabase, [userId]).then((res) =>
          ask(res.ok ? (res.data[0]?.displayName ?? MEMBER_NAME) : MEMBER_NAME),
        );
        return;
      }
      run(entry, day, false);
    },
    [run],
  );

  const answerKeep = useCallback(
    (keep: boolean): void => {
      const ask = keepAsk;
      setKeepAsk(null);
      if (ask !== null) run(ask.entry, ask.day, keep);
    },
    [keepAsk, run],
  );
  const cancelKeep = useCallback(() => setKeepAsk(null), []);

  return { overrides, move, keepAsk, answerKeep, cancelKeep };
}
