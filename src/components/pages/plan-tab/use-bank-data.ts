// The Bank's data, shared by the phone list, the laptop side panel and the
// laptop table (one hook in PlanTabPage). A page of 12 ideas (starred first,
// then the rest, in the sort's order; keyset cursor; Load more appends). The
// first page of each filter is a session read (src/lib/session-read.ts): a
// return paints the kept page on its first frame (also seeded from the
// device), and the read behind it runs after paint, once per filter per
// session (the kept value stays fresh for the session; a plan change marks it
// stale). A refresh behind the arrival paint is applied only while the person
// has not touched, scrolled or typed (src/lib/kept-view.ts). Own writes
// update the kept value (primeRead), so a return shows them. The Bank has no
// search of its own (the top bar's CommandPalette is the one search). The hook
// never reads before the Plan tab's own paint: the read starts in an effect.
//
// Own writes made elsewhere (Move to bank from the Plan or item screen, Plan
// it, From bank, Delete, Archive, Show / Hide, Star) ride PLAN_CHANGED_EVENT
// with a BankChange: every kept Bank page patches in place with no read
// (applyBankChange), so the phone list, the side panel and the table show it
// on return. Anyone else's change arrives on the live topic bank:<workspace>
// (src/lib/plan-tab/bank-live.ts) while the Bank is open: one page read per
// burst, merged so rows already on screen keep their objects and never
// repaint (mergeLivePage).
//
// useBankActions: the writes (star, archive, show to client, delete, bulk,
// Plan it, buckets), each optimistic over the kept value; a deferred write
// sits behind the Undo strip (useUndoableAction) before it fires.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bankIdeaCreate,
  bankIdeaSet,
  planItemFromBank,
  planItemRemove,
  planItemToBank,
  type Client,
  type Result,
} from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import {
  bucketWriteError,
  createBucket,
  deleteBucket,
  listBuckets,
  renameBucket,
  type BucketOption,
} from '@/lib/buckets';
import { withReadTimeout } from '@/lib/chat-reads';
import {
  PLAN_CHANGED_EVENT,
  bankChangeOf,
  bankReadWhat,
  bankStaleBefore,
  bankThumbOf,
  dispatchPlanChanged,
  enrichBankIdeas,
  readBankPage,
  readOpenPlanRows,
  type BankChange,
  type BankIdea,
  type BankPage,
  type BankQuery,
  type PlanItemRow,
  type PlanRow,
} from '@/lib/chat/plans';
import { useUntouched } from '@/lib/kept-view';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import { planWeekLabel } from '@/lib/plan-week';
import { weekRangeOf } from '@/lib/plan-tab';
import { invalidateReads, peekKept, primeRead, readKey, sharedRead } from '@/lib/session-read';
import { supabase } from '@/lib/supabase';
import { subscribeBankLive } from '@/lib/plan-tab/bank-live';
import { generateTraceId } from '@/lib/trace';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { sortBankIdeas, type BankFilter } from './bank-parts';
import type { BucketWrites } from './BankFilterSheet';

/** A filter as the read asks for it. Pure. */
export function bankQueryOf(workspaceId: string, filter: BankFilter, now: Date): BankQuery {
  return {
    workspaceId,
    sort: filter.sort,
    bucketId: filter.bucketId,
    archived: filter.archived,
    staleBefore: filter.review && !filter.archived ? bankStaleBefore(now) : null,
  };
}

/** The session key of a filter's first page (the review keys by its flag, not the instant). Pure. */
export function bankKeyOf(userId: string, workspaceId: string, filter: BankFilter): string {
  return readKey(
    userId,
    workspaceId,
    bankReadWhat({
      sort: filter.sort,
      bucketId: filter.bucketId,
      archived: filter.archived,
      staleBefore: filter.review ? 'review' : null,
    }),
  );
}

/** Every Bank key of a workspace (a change marks them all stale). Pure. */
export function bankKeyPrefix(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, 'bank:');
}

/** Two pages as one: `next` appended, no duplicates by id, its cursor. Pure. */
export function mergeBankPages(shown: BankPage, next: BankPage): BankPage {
  const seen = new Set(shown.ideas.map((i) => i.id));
  return {
    ideas: [...shown.ideas, ...next.ideas.filter((i) => !seen.has(i.id))],
    nextCursor: next.nextCursor,
  };
}

/**
 * A kept page with an own write's bank change applied, for one filter:
 * `in` goes to the top of a live page it belongs on (not archived, the
 * picked bucket if any, never the Untouched review, which holds only old
 * ideas); `out` leaves; `flags` updates the idea, and an archive or restore
 * moves it off the page that no longer holds it. Never a duplicate. Pure.
 */
export function applyBankChange(
  ideas: readonly BankIdea[],
  change: BankChange,
  filter: Pick<BankFilter, 'bucketId' | 'archived' | 'review'>,
): BankIdea[] {
  switch (change.kind) {
    case 'in': {
      const rest = ideas.filter((i) => i.id !== change.idea.id);
      const fits =
        !filter.archived &&
        !filter.review &&
        change.idea.archived_at == null &&
        (filter.bucketId === null || (change.idea.bucket_ids ?? []).includes(filter.bucketId));
      return fits ? [change.idea, ...rest] : rest;
    }
    case 'out':
      return ideas.filter((i) => i.id !== change.itemId);
    case 'flags': {
      const out: BankIdea[] = [];
      for (const idea of ideas) {
        if (idea.id !== change.itemId) {
          out.push(idea);
          continue;
        }
        const next: BankIdea = { ...idea, ...change.flags };
        // An archive leaves the live page; a restore leaves the archived one.
        if ((next.archived_at != null) !== filter.archived) continue;
        out.push(next);
      }
      return out;
    }
  }
}

/** Every Bank page key this session showed, with the filter it holds (for kept patches). */
const keptBankFilters = new Map<string, BankFilter>();
let keptListenerOn = false;

/** Patch every kept Bank page for one own write. No read. */
function patchKeptBankPages(change: BankChange): void {
  for (const [key, filter] of keptBankFilters) {
    const kept = peekKept<Result<BankPage>>(key);
    if (kept?.ok !== true) continue;
    const ideas = applyBankChange(kept.data.ideas, change, filter);
    const page: BankPage = {
      ...kept.data,
      ideas: change.kind === 'in' ? ideas : sortBankIdeas(ideas, filter.sort),
    };
    primeRead<Result<BankPage>>(key, { ok: true, data: page }, Number.POSITIVE_INFINITY);
  }
}

/**
 * The one window listener that patches kept Bank pages on an own write, so a
 * return paints the change even when no Bank was mounted. Installed on the
 * first Bank mount, before the hook's own listener (so the hook reads the
 * patched page).
 */
function ensureKeptBankListener(): void {
  if (keptListenerOn || typeof window === 'undefined') return;
  keptListenerOn = true;
  window.addEventListener(PLAN_CHANGED_EVENT, (event) => {
    const change = bankChangeOf(event);
    if (change !== null) patchKeptBankPages(change);
  });
}

/** Test seam: forget the kept filters (the listener stays). */
export function resetKeptBankFilters(): void {
  keptBankFilters.clear();
}

/**
 * A live re-read merged over what is shown: the fresh first page in its
 * order, each unchanged idea keeping the object already on screen (so its
 * row never repaints), then the rows Load more had added beyond it. Pure.
 */
export function mergeLivePage(shown: BankPage, fresh: BankPage): BankPage {
  const before = new Map(shown.ideas.map((i) => [i.id, i]));
  const same = (a: BankIdea, b: BankIdea): boolean => JSON.stringify(a) === JSON.stringify(b);
  const head = fresh.ideas.map((idea) => {
    const old = before.get(idea.id);
    return old !== undefined && same(old, idea) ? old : idea;
  });
  const freshIds = new Set(fresh.ideas.map((i) => i.id));
  const tail =
    shown.ideas.length > fresh.ideas.length
      ? shown.ideas.slice(fresh.ideas.length).filter((i) => !freshIds.has(i.id))
      : [];
  return {
    ideas: [...head, ...tail],
    nextCursor: tail.length > 0 ? shown.nextCursor : fresh.nextCursor,
  };
}

/** One first-page read, bounded at 5s; kept for the session once ok. */
function readFirstPage(key: string, q: BankQuery): Promise<Result<BankPage>> {
  return sharedRead(
    key,
    () => withReadTimeout((signal) => readBankPage(supabase, q, null, signal)),
    { freshMs: Number.POSITIVE_INFINITY, isOk: (r) => r.ok },
  );
}

export type BankLoad =
  | { status: 'loading'; page: null }
  | { status: 'failed'; page: null }
  | { status: 'ready'; page: BankPage };

export interface BankData {
  load: BankLoad;
  /** The shown ideas in order, or null before any. */
  ideas: BankIdea[] | null;
  /** Load more while more remain; null otherwise. */
  more: { busy: boolean; onMore: () => void } | null;
  retry: () => void;
  /** An own write: edit the shown ideas (and the kept page, so a return shows it). */
  patch: (edit: (ideas: BankIdea[]) => BankIdea[]) => void;
  /** Mark every Bank read stale and read this filter again (behind what is shown). */
  reload: () => void;
}

/**
 * The Bank for one filter. Off until `enabled` (the workspace and the
 * viewer's side are known); never reads before the first paint.
 */
export function useBankData(input: {
  workspaceId: string | null;
  userId: string | null;
  enabled: boolean;
  filter: BankFilter;
  /**
   * The Bank is open and painted, on the agency side: subscribe to its live
   * topic. False closes the subscription (the chip, panel or table closed).
   */
  live?: boolean;
}): BankData {
  const { workspaceId, userId, enabled, filter } = input;
  ensureKeptBankListener();
  const key =
    enabled && workspaceId !== null && userId !== null
      ? bankKeyOf(userId, workspaceId, filter)
      : null;
  const [state, setState] = useState<{ key: string | null; load: BankLoad }>(() => {
    const kept = key !== null ? peekKept<Result<BankPage>>(key) : undefined;
    return {
      key,
      load:
        kept?.ok === true
          ? { status: 'ready', page: kept.data }
          : { status: 'loading', page: null },
    };
  });
  // A new filter paints its kept page (or loading) in the same render.
  let load = state.load;
  if (state.key !== key) {
    const kept = key !== null ? peekKept<Result<BankPage>>(key) : undefined;
    load =
      kept?.ok === true ? { status: 'ready', page: kept.data } : { status: 'loading', page: null };
    setState({ key, load });
  }
  const loadRef = useRef(load);
  loadRef.current = load;
  if (key !== null) keptBankFilters.set(key, filter);
  const untouched = useUntouched();
  const seq = useRef(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const read = useCallback(
    async (background: boolean): Promise<void> => {
      if (key === null || workspaceId === null) return;
      seq.current += 1;
      const mine = seq.current;
      const kept = peekKept<Result<BankPage>>(key);
      if (background) invalidateReads(key);
      mark('plan-bank:read:start');
      const result = await readFirstPage(
        key,
        bankQueryOf(workspaceId, filterRef.current, new Date()),
      );
      mark('plan-bank:read:end');
      if (mine !== seq.current) return;
      if (result.ok) {
        // The quiet refresh behind an arrival paint never moves what the person touched.
        if (!background && kept?.ok === true && !untouched()) return;
        setState({ key, load: { status: 'ready', page: result.data } });
        return;
      }
      logger.warn('plan bank: read failed', {
        workspace_id: workspaceId,
        error: result.error.message,
      });
      setState((prev) =>
        prev.key === key && prev.load.status === 'ready'
          ? prev
          : { key, load: { status: 'failed', page: null } },
      );
    },
    [key, workspaceId, untouched],
  );

  useEffect(() => {
    void read(false);
  }, [read]);

  const reload = useCallback(() => {
    if (userId !== null && workspaceId !== null)
      invalidateReads(bankKeyPrefix(userId, workspaceId));
    void read(true);
  }, [read, userId, workspaceId]);
  useWorkspaceDataChanged(reload);
  // An own write elsewhere: the kept page was patched (patchKeptBankPages);
  // show it with no read. Any other plan change re-reads behind what is shown.
  useEffect(() => {
    const onPlan = (event: Event): void => {
      const change = bankChangeOf(event);
      if (change === null) {
        reload();
        return;
      }
      if (key === null) return;
      const kept = peekKept<Result<BankPage>>(key);
      if (kept?.ok === true) setState({ key, load: { status: 'ready', page: kept.data } });
    };
    window.addEventListener(PLAN_CHANGED_EVENT, onPlan);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onPlan);
  }, [reload, key]);

  // Live: anyone's change re-reads this page once per burst and merges it in
  // place. Starts only once the Bank is open and painted (input.live).
  const live = input.live === true && enabled;
  useEffect(() => {
    if (!live || workspaceId === null || key === null) return;
    return subscribeBankLive(supabase, workspaceId, () => {
      seq.current += 1;
      const mine = seq.current;
      void withReadTimeout((signal) =>
        readBankPage(
          supabase,
          bankQueryOf(workspaceId, filterRef.current, new Date()),
          null,
          signal,
        ),
      ).then((fresh) => {
        if (mine !== seq.current || !fresh.ok) return;
        setState((prev) => {
          if (prev.key !== key || prev.load.status !== 'ready') return prev;
          const page = mergeLivePage(prev.load.page, fresh.data);
          primeRead<Result<BankPage>>(key, { ok: true, data: page }, Number.POSITIVE_INFINITY);
          return { key, load: { status: 'ready', page } };
        });
      });
    });
  }, [live, workspaceId, key]);

  const onMore = useCallback(() => {
    const shown = loadRef.current;
    if (key === null || workspaceId === null || shown.status !== 'ready' || moreBusy) return;
    const cursor = shown.page.nextCursor;
    if (cursor === null) return;
    const mine = seq.current;
    setMoreBusy(true);
    void withReadTimeout((signal) =>
      readBankPage(
        supabase,
        bankQueryOf(workspaceId, filterRef.current, new Date()),
        cursor,
        signal,
      ),
    ).then((next) => {
      setMoreBusy(false);
      if (mine !== seq.current || !next.ok) {
        if (!next.ok) logger.warn('plan bank: load more failed', { error: next.error.message });
        return;
      }
      const merged = mergeBankPages(shown.page, next.data);
      primeRead<Result<BankPage>>(key, { ok: true, data: merged }, Number.POSITIVE_INFINITY);
      setState({ key, load: { status: 'ready', page: merged } });
    });
  }, [key, workspaceId, moreBusy]);

  const patch = useCallback<BankData['patch']>((edit) => {
    setState((prev) => {
      if (prev.load.status !== 'ready' || prev.key === null) return prev;
      const page: BankPage = {
        ...prev.load.page,
        ideas: sortBankIdeas(edit(prev.load.page.ideas), filterRef.current.sort),
      };
      primeRead<Result<BankPage>>(prev.key, { ok: true, data: page }, Number.POSITIVE_INFINITY);
      return { key: prev.key, load: { status: 'ready', page } };
    });
  }, []);

  const retry = useCallback(() => void read(false), [read]);
  const ideas = load.status === 'ready' ? load.page.ideas : null;
  const more = useMemo(
    () =>
      load.status === 'ready' && load.page.nextCursor !== null ? { busy: moreBusy, onMore } : null,
    [load, moreBusy, onMore],
  );
  return {
    load,
    ideas,
    more,
    retry,
    patch,
    reload,
  };
}

// ---------------------------------------------------------------------------
// Plans for Plan it (one read on the tap)
// ---------------------------------------------------------------------------

/**
 * The open plans Plan it picks from (ending today or later): one plans read
 * on the Plan it tap, nothing held, nothing waited on. Never throws.
 */
export function readPlansForPlanIt(workspaceId: string, today: string): Promise<Result<PlanRow[]>> {
  return readOpenPlanRows(supabase, workspaceId, today);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** One idea's flags as bank_idea_set takes them (every flag sent; one changed). Pure. */
export function bankSetArgs(
  idea: Pick<BankIdea, 'id' | 'show_to_client' | 'archived_at' | 'starred_at'>,
  change: { show?: boolean; archived?: boolean; starred?: boolean },
  traceId: string,
): Parameters<typeof bankIdeaSet>[1] {
  return {
    p_item_id: idea.id,
    p_show_to_client: change.show ?? idea.show_to_client === true,
    p_archived: change.archived ?? idea.archived_at != null,
    p_starred: change.starred ?? idea.starred_at != null,
    p_trace_id: traceId,
  };
}

/** The idea with a flag change applied (what the server will hold). Pure. */
export function withFlags(
  idea: BankIdea,
  change: { show?: boolean; archived?: boolean; starred?: boolean },
  nowIso: string,
): BankIdea {
  return {
    ...idea,
    ...(change.show !== undefined ? { show_to_client: change.show } : {}),
    ...(change.archived !== undefined
      ? { archived_at: change.archived ? (idea.archived_at ?? nowIso) : null }
      : {}),
    ...(change.starred !== undefined
      ? { starred_at: change.starred ? (idea.starred_at ?? nowIso) : null }
      : {}),
  };
}

/** Set one idea's flags (bank_idea_set); throws on failure (the Undo path reverts). */
export async function setBankFlags(
  client: Client,
  idea: BankIdea,
  change: { show?: boolean; archived?: boolean; starred?: boolean },
): Promise<void> {
  const res = await bankIdeaSet(client, bankSetArgs(idea, change, generateTraceId()));
  if (!res.ok) throw new Error(res.error.message);
  const next = withFlags(idea, change, new Date().toISOString());
  dispatchPlanChanged(window, '', {
    kind: 'flags',
    itemId: idea.id,
    flags: {
      show_to_client: next.show_to_client === true,
      archived_at: next.archived_at ?? null,
      starred_at: next.starred_at ?? null,
    },
  });
}

/** Delete one idea (plan_item_remove); throws on failure. */
export async function removeBankIdea(client: Client, itemId: string): Promise<void> {
  const res = await planItemRemove(client, { p_item_id: itemId, p_trace_id: generateTraceId() });
  if (!res.ok) throw new Error(res.error.message);
  dispatchPlanChanged(window, '', { kind: 'out', itemId });
}

/** Put an idea into a plan on a day (plan_item_from_bank). Never throws. */
export async function placeBankIdea(
  client: Client,
  itemId: string,
  planId: string,
  day: string,
): Promise<Result<null>> {
  const res = await planItemFromBank(client, {
    p_item_id: itemId,
    p_plan_id: planId,
    p_target_date: day,
    p_trace_id: generateTraceId(),
  });
  if (!res.ok) return res;
  dispatchPlanChanged(window, planId, { kind: 'out', itemId });
  return { ok: true, data: null };
}

/**
 * Send a planned idea back to the bank (plan_item_to_bank; Plan it's Undo).
 * With the idea, every kept Bank page gets it back at once. Never throws.
 */
export async function unplanBankIdea(
  client: Client,
  itemId: string,
  idea?: BankIdea,
): Promise<Result<null>> {
  const res = await planItemToBank(client, { p_item_id: itemId, p_trace_id: generateTraceId() });
  if (!res.ok) return res;
  if (idea !== undefined) dispatchPlanChanged(window, '', { kind: 'in', idea });
  return { ok: true, data: null };
}

type PlanCreateArgs = Database['public']['Functions']['plan_create']['Args'];

/** A Draft plan for the week holding `day` (plan_create, audience team). Never throws. */
export async function makeWeekPlan(
  client: Client,
  workspaceId: string,
  day: string,
): Promise<Result<PlanRow>> {
  const week = weekRangeOf(day);
  const title = planWeekLabel(day);
  const args: PlanCreateArgs = {
    p_workspace_id: workspaceId,
    p_title: title,
    p_starts_on: week.startsOn,
    p_ends_on: week.endsOn,
    p_audience: 'team',
    p_trace_id: generateTraceId(),
  };
  try {
    const { data, error } = await client.rpc('plan_create', args);
    if (error !== null || typeof data !== 'string') {
      return { ok: false, error: { code: 'unknown', message: error?.message ?? 'plan_create' } };
    }
    return {
      ok: true,
      data: {
        id: data,
        workspace_id: workspaceId,
        title,
        starts_on: week.startsOn,
        ends_on: week.endsOn,
        audience: 'team',
        created_by: '',
        updated_at: new Date().toISOString(),
      } as PlanRow,
    };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

/** Add an idea (bank_idea_create) and read it back as a Bank row. Never throws. */
export async function addBankIdea(
  client: Client,
  input: {
    workspaceId: string;
    title: string;
    description: string;
    versionIds: readonly string[];
    bucketIds: readonly string[];
  },
): Promise<Result<BankIdea>> {
  const created = await bankIdeaCreate(client, {
    p_workspace_id: input.workspaceId,
    p_title: input.title.trim(),
    p_description: input.description.trim(),
    p_attachment_version_ids: [...input.versionIds],
    p_bucket_ids: [...input.bucketIds],
    p_trace_id: generateTraceId(),
  });
  if (!created.ok) return created;
  const now = new Date().toISOString();
  const row: PlanItemRow = {
    id: created.data,
    plan_id: null,
    kind: 'concept',
    position: 0,
    title: input.title.trim(),
    description: input.description.trim() === '' ? null : input.description.trim(),
    post_id: null,
    created_at: now,
    updated_at: now,
    target_date: null,
    linked_post_id: null,
    show_to_client: false,
    archived_at: null,
    starred_at: null,
    last_active_at: now,
    came_from_plan_title: null,
  } as PlanItemRow;
  const enriched = await enrichBankIdeas(client, [row]);
  const fallback: BankIdea = {
    ...row,
    bucket_ids: [...input.bucketIds],
    comment_count: 0,
    file_count: input.versionIds.length,
    thumb: bankThumbOf(input.versionIds.length > 0 ? { kind: 'file' } : undefined, row.description),
    format: null,
  };
  return { ok: true, data: enriched.ok ? (enriched.data[0] ?? fallback) : fallback };
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/**
 * The workspace's live buckets (listBuckets), kept for the session and read
 * after paint (an effect). `set` is an own write: the kept list follows.
 */
export function useBankBuckets(input: {
  workspaceId: string | null;
  userId: string | null;
  enabled: boolean;
}): { buckets: BucketOption[]; set: (next: BucketOption[]) => void } {
  const { workspaceId, userId, enabled } = input;
  const key =
    workspaceId !== null && userId !== null ? readKey(userId, workspaceId, 'bank:buckets') : null;
  const [state, setState] = useState<{ key: string | null; list: BucketOption[] }>(() => {
    const kept = key !== null ? peekKept<Result<BucketOption[]>>(key) : undefined;
    return { key, list: kept?.ok === true ? kept.data : [] };
  });
  useEffect(() => {
    if (!enabled || key === null || workspaceId === null) return;
    let live = true;
    void sharedRead(
      key,
      () =>
        listBuckets(supabase, workspaceId).catch(
          (error: unknown): Result<BucketOption[]> => ({
            ok: false,
            error: { code: 'unknown', message: String(error) },
          }),
        ),
      { isOk: (r) => r.ok },
    ).then((res) => {
      if (live && res.ok) setState({ key, list: res.data });
    });
    return () => {
      live = false;
    };
  }, [enabled, key, workspaceId]);
  const set = useCallback(
    (next: BucketOption[]) => {
      if (key !== null) primeRead<Result<BucketOption[]>>(key, { ok: true, data: next });
      setState({ key, list: next });
    },
    [key],
  );
  return { buckets: state.key === key ? state.list : [], set };
}

/** The bucket writes behind the Filter and Add sheets (src/lib/buckets.ts). */
export function bucketWritesFor(
  workspaceId: string,
  countIn: (id: string) => number,
): BucketWrites {
  return {
    create: async (name) => {
      const res = await createBucket(supabase, workspaceId, name, generateTraceId());
      return res.ok
        ? { ok: true, bucket: res.data }
        : { ok: false, message: bucketWriteError('add', res.error.message) };
    },
    rename: async (id, name) => {
      const res = await renameBucket(supabase, id, name, generateTraceId());
      return res.ok ? { ok: true } : { ok: false, message: res.error.message };
    },
    remove: async (id) => {
      const res = await deleteBucket(supabase, id, generateTraceId());
      if (!res.ok) throw new Error(res.error.message);
    },
    countIn,
  };
}
