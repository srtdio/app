// The status ticker's own reads: the plans shared in this chat and the
// workspace's open briefs. Posts in review come from useOpenPosts and the marks
// from the thread's live marks, so neither is read again here.
//
// One round is three reads in parallel, each bounded with withReadTimeout:
// this channel's chat_messages that carry shared_plan_ids (one select, distinct
// ids in memory), the open briefs list (newest first, limit 100) and the
// head-only open briefs count. The plan ids then go through the thread's plan
// card cache (PlanCardsProvider, one batched read per 100 ids, never one per
// plan); outside a chat a local cache does the same. RLS decides what comes
// back, so a team plan never reaches a client. No realtime: a round refetches
// on PLAN_CHANGED_EVENT, POST_CHANGED_EVENT and a tab returning after more
// than a minute, single-flight (a trigger mid-round runs exactly one more).
// Plans shared live into the loaded thread are added from its messages.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import { usePlanCards, postChangedId } from '@/components/chat/PlanCardsProvider';
import { POST_CHANGED_EVENT, staleOnVisible } from '@/components/chat/post-card';
import { abortable, withReadTimeout, READ_TIMEOUT_MS } from '@/lib/chat-reads';
import {
  PLAN_CHANGED_EVENT,
  createPlanCardCache,
  planChangedId,
  readPlanBundles,
  type PlanBundle,
  type PlanCardCache,
} from '@/lib/chat/plans';
import { distinctPlanIds } from '@/lib/chat/status-bar';
import { supabase } from '@/lib/supabase';

/** Open briefs a round lists (newest first). */
export const OPEN_BRIEFS_LIMIT = 100;

/** Plan-carrying messages one round reads (newest first). */
export const PLAN_MESSAGES_LIMIT = 500;

/** One open brief row as the drawer lists it. */
export interface OpenBriefRow {
  id: string;
  number: number | null;
  title: string;
  created_at: string;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** The distinct plan ids shared in one channel (one select). Never throws. */
export async function readSharedPlanIds(
  client: Client,
  channelId: string,
  signal?: AbortSignal,
): Promise<Result<string[]>> {
  try {
    const res = await abortable(
      client
        .from('chat_messages')
        .select('shared_plan_ids')
        .eq('channel_id', channelId)
        .is('deleted_at', null)
        .not('shared_plan_ids', 'is', null)
        .order('created_at', { ascending: false })
        .limit(PLAN_MESSAGES_LIMIT),
      signal,
    );
    if (res.error) return fail(`readSharedPlanIds: ${res.error.message}`);
    return {
      ok: true,
      data: distinctPlanIds((res.data ?? []) as Array<{ shared_plan_ids: string[] | null }>),
    };
  } catch (error) {
    return fail(String(error));
  }
}

/** The workspace's open briefs, newest first, at most 100. Never throws. */
export async function listOpenBriefs(
  client: Client,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Result<OpenBriefRow[]>> {
  try {
    const res = await abortable(
      client
        .from('briefs')
        .select('id, number, title, created_at')
        .eq('workspace_id', workspaceId)
        .eq('status', 'open')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(OPEN_BRIEFS_LIMIT),
      signal,
    );
    if (res.error) return fail(`listOpenBriefs: ${res.error.message}`);
    return { ok: true, data: (res.data ?? []) as OpenBriefRow[] };
  } catch (error) {
    return fail(String(error));
  }
}

/** Head-only count on the {@link listOpenBriefs} filter. Never throws. */
export async function countOpenBriefs(
  client: Client,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Result<number>> {
  try {
    const res = await abortable(
      client
        .from('briefs')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'open')
        .is('deleted_at', null),
      signal,
    );
    if (res.error) return fail(`countOpenBriefs: ${res.error.message}`);
    return { ok: true, data: res.count ?? 0 };
  } catch (error) {
    return fail(String(error));
  }
}

/** One settled round: each read's result, null when that read failed. */
export interface StatusRound {
  planIds: string[] | null;
  briefs: OpenBriefRow[] | null;
  briefCount: number | null;
}

/** The injectable reads (tests pass fakes). */
export interface StatusReads {
  planIds: (client: Client, channelId: string, signal: AbortSignal) => Promise<Result<string[]>>;
  briefs: (
    client: Client,
    workspaceId: string,
    signal: AbortSignal,
  ) => Promise<Result<OpenBriefRow[]>>;
  briefCount: (client: Client, workspaceId: string, signal: AbortSignal) => Promise<Result<number>>;
}

const READS: StatusReads = {
  planIds: readSharedPlanIds,
  briefs: listOpenBriefs,
  briefCount: countOpenBriefs,
};

/** One round, every read in parallel and bounded at 5s. Never throws. */
export async function fetchStatusRound(
  client: Client,
  key: { workspaceId: string; channelId: string | null },
  reads: StatusReads = READS,
): Promise<StatusRound> {
  const channelId = key.channelId;
  const [planIds, briefs, briefCount] = await Promise.all([
    channelId !== null
      ? withReadTimeout((signal) => reads.planIds(client, channelId, signal))
      : Promise.resolve<Result<string[]>>({ ok: true, data: [] }),
    withReadTimeout((signal) => reads.briefs(client, key.workspaceId, signal)),
    withReadTimeout((signal) => reads.briefCount(client, key.workspaceId, signal)),
  ]);
  return {
    planIds: planIds.ok ? planIds.data : null,
    briefs: briefs.ok ? briefs.data : null,
    briefCount: briefCount.ok ? briefCount.data : null,
  };
}

/** What the ticker shows of a round; a failed read keeps what it showed before. */
export interface StatusRoundView {
  planIds: string[] | null;
  briefs: OpenBriefRow[] | null;
  briefCount: number | null;
}

/** Fold one round into what is shown: a failed read keeps its previous value. Pure. */
export function mergeStatusRound(prev: StatusRoundView | null, next: StatusRound): StatusRoundView {
  const briefs = next.briefs ?? prev?.briefs ?? null;
  const briefCount =
    next.briefCount ??
    (next.briefs !== null ? next.briefs.length : null) ??
    prev?.briefCount ??
    briefs?.length ??
    null;
  return {
    planIds: next.planIds ?? prev?.planIds ?? null,
    briefs,
    briefCount: briefs !== null ? briefCount : null,
  };
}

/**
 * Single-flight rounds for the latest key: a request while a round runs marks
 * it dirty and exactly one more round (for the latest key) follows. A round's
 * result is delivered only while its key is still the latest.
 */
export function createRoundRunner<K, D>(opts: {
  fetch: (key: K) => Promise<D>;
  onSettle: (key: K, data: D) => void;
  now: () => number;
}): { request: (key: K) => void; fetchedAt: () => number | null; dispose: () => void } {
  let latest: K | undefined;
  let inFlight = false;
  let dirty = false;
  let disposed = false;
  let startedAt: number | null = null;
  const run = (key: K): void => {
    inFlight = true;
    startedAt = opts.now();
    void opts
      .fetch(key)
      .then(
        (data) => {
          if (!disposed && latest === key) opts.onSettle(key, data);
        },
        () => undefined,
      )
      .finally(() => {
        inFlight = false;
        if (disposed || !dirty || latest === undefined) return;
        dirty = false;
        run(latest);
      });
  };
  return {
    request: (key) => {
      if (disposed) return;
      latest = key;
      if (inFlight) {
        dirty = true;
        return;
      }
      run(key);
    },
    fetchedAt: () => startedAt,
    dispose: () => {
      disposed = true;
    },
  };
}

/** The plans part of the ticker. */
export interface StatusPlans {
  /** The ids read and their bundles settled (ok, absent, failed or capped). */
  ready: boolean;
  /** A read failed: the plan item is omitted and the bar never says nothing is open. */
  failed: boolean;
  /** Readable plans shared here (open or not; the caller filters by date). */
  bundles: PlanBundle[];
}

/** The briefs part of the ticker. */
export interface StatusBriefs {
  ready: boolean;
  failed: boolean;
  rows: OpenBriefRow[];
  count: number;
}

export interface UseStatusCounts {
  plans: StatusPlans;
  briefs: StatusBriefs;
}

const NO_IDS: readonly string[] = [];
const NO_SUBSCRIBE = (): (() => void) => () => {};
const NO_VERSION = (): number => 0;

function keyOf(workspaceId: string, channelId: string | null): string {
  return `${workspaceId}\n${channelId ?? ''}`;
}

function parseKey(key: string): { workspaceId: string; channelId: string | null } {
  const at = key.indexOf('\n');
  const channelId = key.slice(at + 1);
  return { workspaceId: key.slice(0, at), channelId: channelId === '' ? null : channelId };
}

/**
 * The ticker's plans and briefs for the open chat. `livePlanIds` are the plan
 * ids on the loaded thread's messages (a live share shows without a round).
 */
export function useStatusCounts(params: {
  workspaceId: string | null;
  channelId: string | null;
  livePlanIds?: readonly string[];
  client?: Client;
  reads?: StatusReads;
  /** The plan bundle read behind a local cache (outside a chat; tests). */
  readBundles?: (ids: string[], signal: AbortSignal) => Promise<Result<Map<string, PlanBundle>>>;
}): UseStatusCounts {
  const client = params.client ?? supabase;
  const reads = params.reads ?? READS;
  const key = params.workspaceId !== null ? keyOf(params.workspaceId, params.channelId) : null;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [state, setState] = useState<{ key: string; view: StatusRoundView } | null>(null);
  const runnerRef = useRef<ReturnType<typeof createRoundRunner<string, StatusRound>> | null>(null);
  const readsRef = useRef(reads);
  readsRef.current = reads;

  useEffect(() => {
    const runner = createRoundRunner<string, StatusRound>({
      fetch: (k) => fetchStatusRound(client, parseKey(k), readsRef.current),
      onSettle: (k, data) =>
        setState((prev) => ({
          key: k,
          view: mergeStatusRound(prev !== null && prev.key === k ? prev.view : null, data),
        })),
      now: () => Date.now(),
    });
    runnerRef.current = runner;
    const refetch = (): void => {
      if (keyRef.current !== null) runner.request(keyRef.current);
    };
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      const at = runner.fetchedAt();
      if (at !== null && staleOnVisible(at, Date.now())) refetch();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(PLAN_CHANGED_EVENT, refetch);
    window.addEventListener(POST_CHANGED_EVENT, refetch);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(PLAN_CHANGED_EVENT, refetch);
      window.removeEventListener(POST_CHANGED_EVENT, refetch);
      runner.dispose();
      runnerRef.current = null;
    };
  }, [client]);

  useEffect(() => {
    if (key !== null) runnerRef.current?.request(key);
  }, [key, client]);

  // The plan bundles: the thread's card cache, else one of this hook's own.
  const planCards = usePlanCards();
  const readBundles = params.readBundles;
  const local = useMemo<PlanCardCache | null>(
    () =>
      planCards === null && params.workspaceId !== null
        ? createPlanCardCache(
            readBundles ?? ((ids, signal) => readPlanBundles(client, ids, signal)),
          )
        : null,
    [planCards, params.workspaceId, client, readBundles],
  );
  useEffect(() => {
    local?.resume();
    return () => local?.dispose();
  }, [local]);
  const cache = planCards?.cache ?? local;
  const version = cache?.version ?? NO_VERSION;
  useSyncExternalStore(cache?.subscribe ?? NO_SUBSCRIBE, version, version);

  const view = state !== null && state.key === key ? state.view : null;
  const roundIds = view?.planIds ?? NO_IDS;
  const live = params.livePlanIds ?? NO_IDS;
  const idKey = [...new Set([...roundIds, ...live])].sort().join(',');
  const ids = useMemo(() => (idKey === '' ? [] : idKey.split(',')), [idKey]);

  useEffect(() => {
    if (ids.length > 0) cache?.request(ids);
  }, [cache, ids]);

  // A local cache re-reads a changed plan itself (the provider does it in a chat).
  useEffect(() => {
    if (local === null) return;
    const onPlan = (event: Event): void => {
      const planId = planChangedId(event);
      if (planId !== null) local.refresh([planId]);
    };
    window.addEventListener(PLAN_CHANGED_EVENT, onPlan);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onPlan);
  }, [local]);

  // A post change re-reads the plans holding it that the provider does not track.
  const liveRef = useRef(live);
  liveRef.current = live;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useEffect(() => {
    if (cache === null) return;
    const onPost = (event: Event): void => {
      const postId = postChangedId(event);
      if (postId === null) return;
      const tracked = local !== null ? new Set<string>() : new Set(liveRef.current);
      const snap = cache.snapshot(idsRef.current);
      const holding = [...snap.bundles.values()]
        .filter((b) => !tracked.has(b.plan.id) && b.items.some((i) => i.post_id === postId))
        .map((b) => b.plan.id);
      if (holding.length > 0) cache.refresh(holding);
    };
    window.addEventListener(POST_CHANGED_EVENT, onPost);
    return () => window.removeEventListener(POST_CHANGED_EVENT, onPost);
  }, [cache, local]);

  // A bundle read still retrying after the read cap stops holding the first paint.
  const [cappedKey, setCappedKey] = useState<string | null>(null);
  const snap = cache !== null && ids.length > 0 ? cache.snapshot(ids) : null;
  const waiting = snap?.loading === true;
  useEffect(() => {
    if (!waiting) return;
    const at = idKey;
    const timer = setTimeout(() => setCappedKey(at), READ_TIMEOUT_MS + 500);
    return () => clearTimeout(timer);
  }, [waiting, idKey]);
  const capped = waiting && cappedKey === idKey;

  const roundReady = view !== null;
  const planIdsFailed = roundReady && view.planIds === null && live.length === 0;
  const plans: StatusPlans = {
    ready:
      key === null || (roundReady && (cache === null || ids.length === 0 || !waiting || capped)),
    failed: key !== null && (planIdsFailed || capped || (snap !== null && snap.failed.length > 0)),
    bundles: snap !== null ? [...snap.bundles.values()] : [],
  };
  const briefsFailed = roundReady && view.briefs === null;
  const briefs: StatusBriefs = {
    ready: key === null || roundReady,
    failed: key !== null && briefsFailed,
    rows: view?.briefs ?? [],
    count: view?.briefCount ?? 0,
  };
  return { plans, briefs };
}
