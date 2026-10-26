// The Plan tab's data: one readPlanTab per range (bounded at 5s), shared
// within this tab session (src/lib/plan-tab-shared.ts): a nav press starts the
// first range's read and the mount joins it. A range read this session paints
// at once (coming back to the tab, or to a week or month already seen) and
// refreshes quietly behind it (no request while it is fresh); only a range
// never read clears to loading (the grid keeps its size). The refresh behind
// the tab's arrival paint is applied only while the person has not touched,
// scrolled or typed since arriving (src/lib/kept-view.ts); a later one is held
// (the session keeps it for the next visit). The workspace-data-changed signal
// and any plan write (PLAN_CHANGED_EVENT) mark the kept reads stale and re-read
// in the background, keeping what is shown until the new data lands. A failed
// background re-read keeps the data; a failed first read shows the failed
// state with Retry.
//
// Every read is one page of plans (12, src/lib/plan-tab-read.ts), on the
// phone (no range) and on the laptop (the range) alike. While the shown data
// has a next cursor, the hook hands PlanTabPage `loadMore` and `moreBusy`, and
// the page draws Load more at the end of the list or the calendar: a tap reads
// the next page (one request) and appends it (no duplicates by id). Nothing
// reads a further page on its own. A background re-read (a change) reads the
// pages the viewer loaded, one request each, one after another, so a change
// never shortens what is shown and never reads past it; a new range, a Retry
// or a first read starts again at one page. A failed Load more keeps what is
// shown and the control (tap again).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import { READ_TIMEOUT_MS, withReadTimeout } from '@/lib/chat-reads';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { useUntouched } from '@/lib/kept-view';
import { logger } from '@/lib/logger';
import { mergePlanTabPages, readPlanTab, type PlanTabData } from '@/lib/plan-tab-read';
import {
  invalidatePlanTabReads,
  peekPlanTab,
  readSharedPlanTab,
  type PlanTabReadArgs,
} from '@/lib/plan-tab-shared';
import { getPrefetchContext } from '@/lib/prefetch-context';
import { supabase } from '@/lib/supabase';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';

export type PlanTabLoad =
  | { status: 'loading'; data: null }
  | { status: 'failed'; data: null }
  | { status: 'ready'; data: PlanTabData };

/**
 * Who the shared reads are keyed to: the user the shell's nav press started
 * them for (src/lib/route-data.ts), when it is this workspace. Null: the tab
 * reads on its own and shares nothing.
 */
function sharedUserId(workspaceId: string): string | null {
  const ctx = getPrefetchContext();
  return ctx !== null && ctx.workspaceId === workspaceId ? ctx.userId : null;
}

/**
 * The page after `shown` (its cursor; in its range on the laptop), bounded at
 * 5s, appended to it. Null when there is no next page. Never throws.
 */
export async function readNextPlanTabPage(
  client: Client,
  args: PlanTabReadArgs,
  shown: PlanTabData,
): Promise<Result<PlanTabData> | null> {
  const before = shown.nextCursor;
  if (before === null) return null;
  const next = await withReadTimeout(
    (signal) => readPlanTab(client, { ...args, before }, signal),
    READ_TIMEOUT_MS,
  );
  return next.ok ? { ok: true, data: mergePlanTabPages(shown, next.data, args.range) } : next;
}

/**
 * Whether a path is a post's page, where a post can change without a
 * post-changed event (the calendar opens posts there). Pure.
 */
export function leavingToPost(pathname: string): boolean {
  return pathname.startsWith('/posts/') || pathname.startsWith('/p/');
}

/** The tab's data and its controls. */
export interface PlanTabDataState {
  load: PlanTabLoad;
  /** Re-read in the background; resolves once the new data (or the failure) is in. */
  reload: () => Promise<void>;
  /** Read again from one page (the failed state's Retry). */
  retry: () => void;
  /** Read the next page and append it (Load more); a no-op without a next cursor or while one is in flight. */
  loadMore: () => void;
  /** Whether a Load more page is in flight ('Loading'). */
  moreBusy: boolean;
}

/**
 * The tab's read for `range` (null: every plan, the phone list), a page at a
 * time. Off until `enabled` (the workspace and the viewer's side are known).
 * The workspace zone is not an input: the bundle carries it
 * (PlanTabData.timeZone).
 */
export function usePlanTabData(input: {
  workspaceId: string | null;
  range: { start: string; end: string } | null;
  onlyShared: boolean;
  enabled: boolean;
}): PlanTabDataState {
  const { workspaceId, onlyShared, enabled } = input;
  const start = input.range?.start ?? null;
  const end = input.range?.end ?? null;
  const active = enabled && workspaceId !== null;
  // A return paints the kept read on its first frame, before the read effect runs.
  const [load, setLoad] = useState<PlanTabLoad>(() => {
    const kept =
      active && workspaceId !== null
        ? peekPlanTab(sharedUserId(workspaceId), {
            workspaceId,
            range: start !== null && end !== null ? { start, end } : null,
            onlyShared,
          })
        : undefined;
    return kept !== undefined ? { status: 'ready', data: kept } : { status: 'loading', data: null };
  });
  const [moreBusy, setMoreBusy] = useState(false);
  const seq = useRef(0);
  // Pages shown (1 until a Load more lands; back to 1 on a first read).
  const pages = useRef(1);
  const loadRef = useRef(load);
  loadRef.current = load;
  const moreInFlight = useRef(false);
  // What this mount first read (the arrival); a range read after it is an ask.
  const arrivalArgs = useRef<PlanTabReadArgs | null>(null);
  const untouched = useUntouched();

  const args = useMemo<PlanTabReadArgs | null>(
    () =>
      active && workspaceId !== null
        ? {
            workspaceId,
            range: start !== null && end !== null ? { start, end } : null,
            onlyShared,
          }
        : null,
    [active, workspaceId, start, end, onlyShared],
  );

  const read = useCallback(
    async (background: boolean): Promise<void> => {
      if (args === null) return;
      seq.current += 1;
      const mine = seq.current;
      const userId = sharedUserId(args.workspaceId);
      arrivalArgs.current ??= args;
      const arrival = !background && args === arrivalArgs.current;
      // The kept range painted on this read; its refresh is quiet.
      const kept = background ? undefined : peekPlanTab(userId, args);
      if (background) {
        // Something changed: no fresh read may answer for it.
        invalidatePlanTabReads();
      } else {
        pages.current = 1;
        setLoad(
          kept !== undefined ? { status: 'ready', data: kept } : { status: 'loading', data: null },
        );
      }
      let result = await readSharedPlanTab(supabase, userId, args);
      // A background re-read reads the pages the viewer loaded, one request
      // each (bounded by their Load more taps), never further.
      for (let page = 1; result.ok && page < pages.current; page += 1) {
        if (mine !== seq.current) return;
        const next = await readNextPlanTabPage(supabase, args, result.data);
        if (next === null) break;
        result = next;
      }
      if (mine !== seq.current) return;
      if (result.ok) {
        // A quiet refresh behind the arrival paint never moves what the person touched.
        if (arrival && kept !== undefined && !untouched()) return;
        setLoad({ status: 'ready', data: result.data });
        return;
      }
      logger.warn('plan tab: read failed', {
        workspace_id: args.workspaceId,
        error: result.error.message,
      });
      // A failed background re-read keeps what is shown.
      setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'failed', data: null }));
    },
    [args, untouched],
  );

  const more = useCallback(async (): Promise<void> => {
    const shown = loadRef.current;
    if (args === null || shown.status !== 'ready' || moreInFlight.current) return;
    const mine = seq.current;
    moreInFlight.current = true;
    setMoreBusy(true);
    const next = await readNextPlanTabPage(supabase, args, shown.data);
    moreInFlight.current = false;
    setMoreBusy(false);
    // A newer read replaced what was shown: this page belongs to nothing.
    if (next === null || mine !== seq.current) return;
    if (!next.ok) {
      logger.warn('plan tab: load more failed', {
        workspace_id: args.workspaceId,
        error: next.error.message,
      });
      return;
    }
    pages.current += 1;
    setLoad({ status: 'ready', data: next.data });
  }, [args]);

  const loadMore = useCallback(() => void more(), [more]);

  useEffect(() => {
    void read(false);
  }, [read]);

  const reload = useCallback(() => read(true), [read]);
  useWorkspaceDataChanged(() => void reload());
  useEffect(() => {
    const onPlan = (): void => void reload();
    window.addEventListener(PLAN_CHANGED_EVENT, onPlan);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onPlan);
  }, [reload]);
  // Opening a post from the calendar leaves for a page that can change it
  // without a post-changed event: the kept reads are marked stale, so Back
  // paints them and reads the server again behind them.
  useEffect(
    () => () => {
      if (leavingToPost(window.location.pathname)) invalidatePlanTabReads();
    },
    [],
  );

  const retry = useCallback(() => void read(false), [read]);
  return { load, reload, retry, loadMore, moreBusy };
}
