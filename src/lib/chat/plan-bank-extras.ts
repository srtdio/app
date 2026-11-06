// Bank meets Plan, the after-paint parts of a plan surface: the rows' bucket
// names (the Plan screen's format line) and the moved-to-bank traces (the
// Plan screen and the laptop month). Both start in an effect, after the
// surface has painted from its bundle read, never before; one read per table
// (plans.ts readRowBuckets, readBankTraces), at most once per plan set per
// session (kept in a module map, so a return paints them on its first frame),
// read again only when the plan changes (PLAN_CHANGED_EVENT for that plan).
// Move to bank (moveToBankAction): the row leaves at once, the RPC fires only
// when the Undo strip ends, never after Undo.

import { useEffect, useMemo, useState } from 'react';
import { planItemToBank, type Client, type Result } from '@srtdio/rpc';
import { withReadTimeout } from '@/lib/chat-reads';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import { generateTraceId } from '@/lib/trace';
import { MOVED_TO_BANK_LABEL, moveToBankError } from '@/lib/chat/bank-plan-copy';
import type { UndoableAction } from '@/lib/use-undoable-action';
import {
  PLAN_CHANGED_EVENT,
  planChangedId,
  readBankTraces,
  readRowBuckets,
  type BankTrace,
  type PlanBundle,
  type PlanRow,
  type RowBuckets,
} from '@/lib/chat/plans';

const EMPTY_BUCKETS: RowBuckets = { items: {}, posts: {} };
const keptBuckets = new Map<string, RowBuckets>();
const keptTraces = new Map<string, Map<string, BankTrace[]>>();

/** Forget what the session holds (tests). */
export function resetPlanBankExtras(): void {
  keptBuckets.clear();
  keptTraces.clear();
}

/** The ids the bucket read asks for: concepts by item id, post rows by post id. Pure. */
export function bucketReadIds(bundle: Pick<PlanBundle, 'items'>): {
  conceptIds: string[];
  postIds: string[];
} {
  const conceptIds: string[] = [];
  const postIds: string[] = [];
  for (const item of bundle.items) {
    if (item.kind === 'concept') conceptIds.push(item.id);
    else if (item.post_id !== null && item.draft_row !== true) postIds.push(item.post_id);
  }
  return { conceptIds, postIds };
}

/** Re-render once when any of these plans changes (a write here or live). */
function usePlanChangeTick(planIds: readonly string[], enabled: boolean): number {
  const [tick, setTick] = useState(0);
  const key = planIds.join(',');
  useEffect(() => {
    if (!enabled) return;
    const ids = new Set(key.split(','));
    const on = (event: Event): void => {
      const id = planChangedId(event);
      if (id !== null && ids.has(id)) setTick((t) => t + 1);
    };
    window.addEventListener(PLAN_CHANGED_EVENT, on);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, on);
  }, [key, enabled]);
  return tick;
}

/**
 * The Plan screen rows' bucket names, read after the bundle paints (one
 * plan_item_buckets select and one posts select). Kept per plan for the
 * session; empty until the first read lands.
 */
export function usePlanRowBuckets(input: {
  client: Client;
  enabled: boolean;
  bundle: PlanBundle | null;
}): RowBuckets {
  const { client, enabled, bundle } = input;
  const planId = bundle?.plan.id ?? null;
  const ids = useMemo(
    () => (bundle !== null ? bucketReadIds(bundle) : { conceptIds: [], postIds: [] }),
    [bundle],
  );
  const idsKey = `${ids.conceptIds.join(',')}|${ids.postIds.join(',')}`;
  const tick = usePlanChangeTick(planId !== null ? [planId] : [], enabled);
  const [held, setHeld] = useState<{ planId: string | null; value: RowBuckets }>(() => ({
    planId,
    value: (planId !== null ? keptBuckets.get(planId) : undefined) ?? EMPTY_BUCKETS,
  }));
  useEffect(() => {
    if (!enabled || planId === null) return;
    if (ids.conceptIds.length === 0 && ids.postIds.length === 0) return;
    let cancelled = false;
    mark('plan:buckets:start');
    void withReadTimeout((signal) =>
      readRowBuckets(client, ids.conceptIds, ids.postIds, signal),
    ).then((res) => {
      mark('plan:buckets:end');
      if (cancelled) return;
      if (!res.ok) {
        logger.warn('plan: row buckets read failed', { plan_id: planId, error: res.error.message });
        return;
      }
      keptBuckets.set(planId, res.data);
      setHeld({ planId, value: res.data });
    });
    return () => {
      cancelled = true;
    };
    // idsKey stands for ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, planId, idsKey, tick]);
  if (held.planId !== planId) {
    return (planId !== null ? keptBuckets.get(planId) : undefined) ?? EMPTY_BUCKETS;
  }
  return held.value;
}

/**
 * The moved-to-bank traces of these plans (agency only: `enabled` false reads
 * nothing): one audit_log select and one plan_items select, after the
 * surface paints. Kept per plan set for the session.
 */
export function useBankTraces(input: {
  client: Client;
  enabled: boolean;
  workspaceId: string | null;
  plans: ReadonlyArray<Pick<PlanRow, 'id' | 'starts_on' | 'ends_on'>>;
  timeZone: string;
}): Map<string, BankTrace[]> {
  const { client, enabled, workspaceId, plans, timeZone } = input;
  const planIds = useMemo(() => [...new Set(plans.map((p) => p.id))].sort(), [plans]);
  const key = `${workspaceId ?? ''}:${timeZone}:${plans
    .map((p) => `${p.id}@${p.starts_on}..${p.ends_on}`)
    .sort()
    .join(',')}`;
  const tick = usePlanChangeTick(planIds, enabled);
  const [held, setHeld] = useState<{ key: string; value: Map<string, BankTrace[]> }>(() => ({
    key,
    value: keptTraces.get(key) ?? new Map(),
  }));
  const plansRef = useMemo(() => plans, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled || workspaceId === null || plansRef.length === 0) return;
    let cancelled = false;
    mark('plan:traces:start');
    void withReadTimeout((signal) =>
      readBankTraces(client, workspaceId, plansRef, timeZone, signal),
    ).then((res) => {
      mark('plan:traces:end');
      if (cancelled) return;
      if (!res.ok) {
        logger.warn('plan: bank traces read failed', {
          workspace_id: workspaceId,
          error: res.error.message,
        });
        return;
      }
      keptTraces.set(key, res.data);
      setHeld({ key, value: res.data });
    });
    return () => {
      cancelled = true;
    };
  }, [client, enabled, workspaceId, plansRef, timeZone, key, tick]);
  if (!enabled) return EMPTY_TRACES;
  if (held.key !== key) return keptTraces.get(key) ?? EMPTY_TRACES;
  return held.value;
}

const EMPTY_TRACES: Map<string, BankTrace[]> = new Map();

/** What Move to bank needs from its surface. */
export interface MoveToBankDeps {
  client: Client;
  itemId: string;
  /** The row has left the list (the caller ran itemOut and hid it). */
  hide: () => void;
  /** Undo, or a failed write: the row comes back. */
  show: () => void;
  /** After the write: the surfaces re-read (dispatchPlanChanged). */
  onMoved: () => void;
  /** A failed write's copy (moveToBankError), in the bad tone. */
  onError: (copy: string) => void;
}

/**
 * Move to bank as an Undo strip action: the row leaves at once (hide runs
 * now); plan_item_to_bank fires only when the strip ends (commit), never
 * after Undo (revert shows the row again). A refused write (post_approved:
 * "Couldn't move to bank. Approved posts are locked.") brings the row back.
 */
export function moveToBankAction(deps: MoveToBankDeps): UndoableAction {
  deps.hide();
  return {
    label: MOVED_TO_BANK_LABEL,
    revert: deps.show,
    commit: async () => {
      const traceId = generateTraceId();
      const res: Result<unknown> = await planItemToBank(deps.client, {
        p_item_id: deps.itemId,
        p_trace_id: traceId,
      });
      if (!res.ok) {
        logger.warn('plan: move to bank failed', {
          trace_id: traceId,
          item_id: deps.itemId,
          error: res.error.message,
        });
        deps.show();
        deps.onError(moveToBankError(res.error.message));
        return;
      }
      deps.onMoved();
    },
  };
}
