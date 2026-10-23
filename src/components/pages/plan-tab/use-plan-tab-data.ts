// The Plan tab's data: one readPlanTab per range (bounded at 5s), re-read in
// the background on the workspace-data-changed signal and on any plan write
// (PLAN_CHANGED_EVENT), keeping what is shown meanwhile. A range read before
// in this session paints at once from memory and is re-read in the background
// (coming back to the tab, or to a week or month already seen, is instant); a
// range never read clears to loading (the grid keeps its size). A failed
// background re-read keeps the data; a failed first read shows the failed
// state with Retry. The memory is per workspace and side, and is wiped on
// sign-out.

import { useCallback, useEffect, useRef, useState } from 'react';
import { READ_TIMEOUT_MS, withReadTimeout } from '@/lib/chat-reads';
import { PLAN_CHANGED_EVENT } from '@/lib/chat/plans';
import { logger } from '@/lib/logger';
import { readPlanTab, type PlanTabData } from '@/lib/plan-tab-read';
import { supabase } from '@/lib/supabase';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { SIGNOUT_EVENT } from '@/lib/events';

/** Ranges kept in memory: the newest win. */
export const PLAN_TAB_MEMORY_MAX = 12;
const memory = new Map<string, PlanTabData>();
let watchingSignOut = false;

/** The last data read for a key this session, or undefined. */
export function rememberedPlanTab(key: string): PlanTabData | undefined {
  return memory.get(key);
}

/** Keep a key's data, dropping the oldest past PLAN_TAB_MEMORY_MAX. */
export function rememberPlanTab(key: string, data: PlanTabData): void {
  memory.delete(key);
  memory.set(key, data);
  while (memory.size > PLAN_TAB_MEMORY_MAX) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  if (!watchingSignOut && typeof window !== 'undefined') {
    watchingSignOut = true;
    window.addEventListener(SIGNOUT_EVENT, () => memory.clear());
  }
}

/** Forget everything (sign-out; tests). */
export function forgetPlanTab(): void {
  memory.clear();
}

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
      if (!background) {
        const kept = rememberedPlanTab(key);
        setLoad(
          kept !== undefined ? { status: 'ready', data: kept } : { status: 'loading', data: null },
        );
      }
      const range = start !== null && end !== null ? { start, end } : null;
      const result = await withReadTimeout(
        (signal) => readPlanTab(supabase, { workspaceId, range, timeZone, onlyShared }, signal),
        READ_TIMEOUT_MS,
      );
      if (mine !== seq.current) return;
      if (result.ok) {
        rememberPlanTab(key, result.data);
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
