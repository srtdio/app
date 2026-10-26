// The Plan tab's data: one readPlanTab per range (bounded at 5s), shared
// within this tab session (src/lib/plan-tab-shared.ts): a nav press starts the
// first range's read and the mount joins it. A range read inside the freshness
// window paints at once with no request (coming back to the tab, or to a week
// or month just seen); past the window it is absent, so the tab clears to
// loading (the grid keeps its size) and reads. Older data is never painted.
// The workspace-data-changed signal and any plan write (PLAN_CHANGED_EVENT)
// drop the kept reads and re-read in the background, keeping what is shown
// until the new data lands. A failed background re-read keeps the data; a
// failed first read shows the failed state with Retry.
//
// The phone list (no range) reads a page of plans at a time: while the read
// returns a next cursor, the list's Load more (plan-tab-more.ts) fetches the
// next page with it and appends it (no duplicates by id). A background re-read
// reads as many pages as are shown, so a change never shortens the list. A
// failed Load more keeps the list and the control (tap again).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import { READ_TIMEOUT_MS, withReadTimeout } from '@/lib/chat-reads';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { logger } from '@/lib/logger';
import { mergePlanTabPages, readPlanTab, type PlanTabData } from '@/lib/plan-tab-read';
import {
  dropPlanTabReads,
  peekPlanTab,
  readSharedPlanTab,
  type PlanTabReadArgs,
} from '@/lib/plan-tab-shared';
import { getPrefetchContext } from '@/lib/prefetch-context';
import { supabase } from '@/lib/supabase';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { setPlanTabMore } from './plan-tab-more';

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
 * The phone list's page after `shown` (its cursor), bounded at 5s, appended
 * to it. Null when there is no next page. Never throws.
 */
export async function readNextPlanTabPage(
  client: Client,
  args: PlanTabReadArgs,
  shown: PlanTabData,
): Promise<Result<PlanTabData> | null> {
  const before = shown.nextCursor;
  if (args.range !== null || before === null) return null;
  const next = await withReadTimeout(
    (signal) => readPlanTab(client, { ...args, before }, signal),
    READ_TIMEOUT_MS,
  );
  return next.ok ? { ok: true, data: mergePlanTabPages(shown, next.data) } : next;
}

/**
 * Whether a path is a post's page, where a post can change without a
 * post-changed event (the calendar opens posts there). Pure.
 */
export function leavingToPost(pathname: string): boolean {
  return pathname.startsWith('/posts/') || pathname.startsWith('/p/');
}

/**
 * The tab's read for `range` (null: every plan, the phone list, a page at a
 * time). Off until `enabled` (the workspace and the viewer's side are known).
 * `reload` re-reads in the background and resolves once the new data (or the
 * failure) is in. `timeZone` is not part of the read: the bundle carries the
 * workspace's zone (PlanTabData.timeZone).
 */
export function usePlanTabData(input: {
  workspaceId: string | null;
  range: { start: string; end: string } | null;
  timeZone?: string;
  onlyShared: boolean;
  enabled: boolean;
}): { load: PlanTabLoad; reload: () => Promise<void>; retry: () => void } {
  const { workspaceId, onlyShared, enabled } = input;
  const start = input.range?.start ?? null;
  const end = input.range?.end ?? null;
  const active = enabled && workspaceId !== null;
  const [load, setLoad] = useState<PlanTabLoad>({ status: 'loading', data: null });
  const [moreBusy, setMoreBusy] = useState(false);
  const seq = useRef(0);
  // Pages the phone list shows (1 until a Load more lands).
  const pages = useRef(1);
  const loadRef = useRef(load);
  loadRef.current = load;
  const moreInFlight = useRef(false);

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
      if (background) {
        // Something changed: no kept read may answer for it.
        dropPlanTabReads();
      } else {
        pages.current = 1;
        const kept = peekPlanTab(userId, args);
        if (kept !== undefined) {
          setLoad({ status: 'ready', data: kept });
          return;
        }
        setLoad({ status: 'loading', data: null });
      }
      let result = await readSharedPlanTab(supabase, userId, args);
      // A background re-read reads as many pages as are shown.
      for (let page = 1; result.ok && page < pages.current; page += 1) {
        if (mine !== seq.current) return;
        const next = await readNextPlanTabPage(supabase, args, result.data);
        if (next === null) break;
        result = next;
      }
      if (mine !== seq.current) return;
      if (result.ok) {
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
    [args],
  );

  const loadMore = useCallback(async (): Promise<void> => {
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

  const canMore =
    args !== null &&
    args.range === null &&
    load.status === 'ready' &&
    load.data.nextCursor !== null;
  useEffect(() => {
    setPlanTabMore(canMore ? { busy: moreBusy, onMore: () => void loadMore() } : null);
  }, [canMore, moreBusy, loadMore]);
  useEffect(() => () => setPlanTabMore(null), []);

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
  // without a post-changed event: the kept reads go with it, so Back reads
  // the server again rather than paint them.
  useEffect(
    () => () => {
      if (leavingToPost(window.location.pathname)) dropPlanTabReads();
    },
    [],
  );

  const retry = useCallback(() => void read(false), [read]);
  return { load, reload, retry };
}
