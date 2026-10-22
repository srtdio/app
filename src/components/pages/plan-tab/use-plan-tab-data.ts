// The Plan tab's data: one readPlanTab per range (bounded at 5s), re-read in
// the background on the workspace-data-changed signal and on any plan write
// (PLAN_CHANGED_EVENT), keeping what is shown meanwhile. A new range clears to
// loading (the grid keeps its size); a failed background re-read keeps the
// data; a failed first read shows the failed state with Retry.

import { useCallback, useEffect, useRef, useState } from 'react';
import { READ_TIMEOUT_MS, withReadTimeout } from '@/lib/chat-reads';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { logger } from '@/lib/logger';
import { readPlanTab, type PlanTabData } from '@/lib/plan-tab-read';
import { supabase } from '@/lib/supabase';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';

export type PlanTabLoad =
  | { status: 'loading'; data: null }
  | { status: 'failed'; data: null }
  | { status: 'ready'; data: PlanTabData };

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
  const key =
    enabled && workspaceId !== null
      ? [workspaceId, start, end, timeZone, onlyShared].join('|')
      : null;
  const [load, setLoad] = useState<PlanTabLoad>({ status: 'loading', data: null });
  const seq = useRef(0);

  const read = useCallback(
    async (background: boolean): Promise<void> => {
      if (key === null || workspaceId === null) return;
      seq.current += 1;
      const mine = seq.current;
      if (!background) setLoad({ status: 'loading', data: null });
      const range = start !== null && end !== null ? { start, end } : null;
      const result = await withReadTimeout(
        (signal) => readPlanTab(supabase, { workspaceId, range, timeZone, onlyShared }, signal),
        READ_TIMEOUT_MS,
      );
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
    [key, workspaceId, start, end, timeZone, onlyShared],
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

  const retry = useCallback(() => void read(false), [read]);
  return { load, reload, retry };
}
