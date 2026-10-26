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

import { useCallback, useEffect, useRef, useState } from 'react';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { logger } from '@/lib/logger';
import type { PlanTabData } from '@/lib/plan-tab-read';
import {
  dropPlanTabReads,
  peekPlanTab,
  readSharedPlanTab,
  type PlanTabReadArgs,
} from '@/lib/plan-tab-shared';
import { getPrefetchContext } from '@/lib/prefetch-context';
import { supabase } from '@/lib/supabase';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';

type PlanTabLoad =
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
 * Whether a path is a post's page, where a post can change without a
 * post-changed event (the calendar opens posts there). Pure.
 */
export function leavingToPost(pathname: string): boolean {
  return pathname.startsWith('/posts/') || pathname.startsWith('/p/');
}

/**
 * The tab's read for `range` (null: every plan, the phone list). Off until
 * `enabled` (the workspace and the viewer's side are known). `reload` re-reads
 * in the background and resolves once the new data (or the failure) is in.
 */
export function usePlanTabData(input: {
  workspaceId: string | null;
  range: { start: string; end: string } | null;
  timeZone: string;
  onlyShared: boolean;
  enabled: boolean;
}): { load: PlanTabLoad; reload: () => Promise<void>; retry: () => void } {
  const { workspaceId, timeZone, onlyShared, enabled } = input;
  const start = input.range?.start ?? null;
  const end = input.range?.end ?? null;
  const active = enabled && workspaceId !== null;
  const [load, setLoad] = useState<PlanTabLoad>({ status: 'loading', data: null });
  const seq = useRef(0);

  const read = useCallback(
    async (background: boolean): Promise<void> => {
      if (!active || workspaceId === null) return;
      seq.current += 1;
      const mine = seq.current;
      const range = start !== null && end !== null ? { start, end } : null;
      const args: PlanTabReadArgs = { workspaceId, range, timeZone, onlyShared };
      const userId = sharedUserId(workspaceId);
      if (background) {
        // Something changed: no kept read may answer for it.
        dropPlanTabReads();
      } else {
        const kept = peekPlanTab(userId, args);
        if (kept !== undefined) {
          setLoad({ status: 'ready', data: kept });
          return;
        }
        setLoad({ status: 'loading', data: null });
      }
      const result = await readSharedPlanTab(supabase, userId, args);
      if (mine !== seq.current) return;
      if (result.ok) {
        setLoad({ status: 'ready', data: result.data });
        return;
      }
      logger.warn('plan tab: read failed', {
        workspace_id: workspaceId,
        error: result.error.message,
      });
      // A failed background re-read keeps what is shown.
      setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'failed', data: null }));
    },
    [active, workspaceId, start, end, timeZone, onlyShared],
  );

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
