// Plans in chat: the reads behind the plan card, the Plan and Item screens, and
// the share sequence behind the New plan screen. Every read is a plain
// PostgREST select by an id list (no embeds), chunked at 100 ids and bounded at
// 5s by the caller; RLS decides what comes back, so a plan the viewer cannot
// read is simply absent ("Plan not available"). Cards never read per message:
// the thread's plan card cache (createPlanCardCache) coalesces every plan id
// asked in the same tick into one batch (plans, then their items, then the
// items' reviews, then the post items' stages). Framework-free: the share
// steps and the readers are injected, so the contract is unit-tested directly.

import type { Client, PlanConceptAddArgs, PlanConceptEditArgs, Result } from '@srtdio/rpc';
import { abortable, withReadTimeout } from '@/lib/chat-reads';

/** Ids per IN read (the PostgREST URL stays short). */
export const PLAN_READ_CHUNK = 100;

/** Failed reads of one plan before its card shows "Couldn't load" (tap to retry). */
export const PLAN_READ_TRIES = 3;

/** A failed plan read is retried on its own this long after it failed. */
export const PLAN_RETRY_DELAY_MS = 5_000;

/** The window event a plan write dispatches; open cards and screens re-read the plan. */
export const PLAN_CHANGED_EVENT = 'sorted:plan-changed';

/** The detail a PLAN_CHANGED_EVENT carries. */
export interface PlanChangedDetail {
  planId: string;
}

/** Tell every open card and screen that this plan changed. */
export function dispatchPlanChanged(target: Pick<Window, 'dispatchEvent'>, planId: string): void {
  target.dispatchEvent(
    new CustomEvent<PlanChangedDetail>(PLAN_CHANGED_EVENT, { detail: { planId } }),
  );
}

/** The plan id a PLAN_CHANGED_EVENT names, or null. Pure. */
export function planChangedId(event: Event): string | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const planId = (detail as Record<string, unknown>).planId;
  return typeof planId === 'string' && planId !== '' ? planId : null;
}

export type PlanAudience = 'team' | 'client';
export type PlanItemKind = 'concept' | 'post';
export type ReviewSide = 'team' | 'client';
export type ReviewStatus = 'waiting' | 'approved' | 'changes';
export type CommentVisibility = 'everyone' | 'team';

export interface PlanRow {
  id: string;
  workspace_id: string;
  title: string;
  starts_on: string;
  ends_on: string;
  audience: PlanAudience;
  created_by: string | null;
}

export interface PlanItemRow {
  id: string;
  plan_id: string;
  kind: PlanItemKind;
  position: number;
  title: string | null;
  description: string | null;
  post_id: string | null;
  created_at: string;
  /** A concept's own date ("YYYY-MM-DD"); always null on a post (its post holds the date). */
  target_date?: string | null;
}

export interface PlanReviewRow {
  item_id: string;
  side: ReviewSide;
  status: ReviewStatus;
}

export interface PlanCommentRow {
  id: string;
  item_id: string;
  author_user_id: string | null;
  body: string;
  visibility: CommentVisibility;
  created_at: string;
}

/** One plan with everything its card and screen show. */
export interface PlanBundle {
  plan: PlanRow;
  /** Live items the viewer can read, in date order (sortPlanItemsByDate). */
  items: PlanItemRow[];
  /** Reviews the viewer can read (team reviews only on the agency side). */
  reviews: PlanReviewRow[];
  /** Post stage by post id, for the post items. */
  postStages: Record<string, string>;
  /** Post title and target date by post id, for the post rows. */
  postInfo: Record<string, PlanPostInfo>;
}

export interface PlanPostInfo {
  title: string;
  target_date: string | null;
}

const PLAN_COLUMNS = 'id, workspace_id, title, starts_on, ends_on, audience, created_by';
const ITEM_COLUMNS =
  'id, plan_id, kind, position, title, description, post_id, created_at, target_date';
const REVIEW_COLUMNS = 'item_id, side, status';
const COMMENT_COLUMNS = 'id, item_id, author_user_id, body, visibility, created_at';

/** Split ids into IN lists of at most PLAN_READ_CHUNK. Pure. */
export function planChunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += PLAN_READ_CHUNK) {
    out.push(ids.slice(i, i + PLAN_READ_CHUNK));
  }
  return out;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

type SelectResult = { data: unknown; error: { message: string } | null };

/**
 * One table read by an id list, chunked: every chunk is one select; any chunk
 * that errors fails the whole read. Rows come back in chunk order.
 */
async function selectIn<T>(
  client: Client,
  table:
    | 'plans'
    | 'plan_items'
    | 'plan_item_reviews'
    | 'plan_item_comments'
    | 'posts'
    | 'asset_attachments',
  columns: string,
  column: string,
  ids: readonly string[],
  signal: AbortSignal | undefined,
  extra?: (query: PlanQuery) => PlanQuery,
): Promise<Result<T[]>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, data: [] };
  const results = await Promise.all(
    planChunks(unique).map((chunk) => {
      const base = (client.from(table) as unknown as PlanTable).select(columns).in(column, chunk);
      const query = extra !== undefined ? extra(base) : base;
      return abortable(query, signal) as unknown as Promise<SelectResult>;
    }),
  );
  const rows: T[] = [];
  for (const res of results) {
    if (res.error !== null) return fail(`${table}: ${res.error.message}`);
    rows.push(...((res.data ?? []) as T[]));
  }
  return { ok: true, data: rows };
}

/** The slice of a PostgREST builder these reads use (typed loosely: no embeds). */
interface PlanQuery extends PromiseLike<SelectResult> {
  in: (column: string, values: readonly string[]) => PlanQuery;
  is: (column: string, value: null) => PlanQuery;
  eq: (column: string, value: string) => PlanQuery;
  order: (column: string, opts?: { ascending?: boolean }) => PlanQuery;
}
interface PlanTable {
  select: (columns: string) => PlanQuery;
}

/**
 * An item's day ("YYYY-MM-DD"): a concept's own target_date, a post's
 * target_date; null when undated or the post is not readable. Pure.
 */
export function planItemDay(
  item: PlanItemRow,
  postInfo: Readonly<Record<string, PlanPostInfo>>,
): string | null {
  const raw =
    item.kind === 'concept'
      ? (item.target_date ?? null)
      : item.post_id !== null
        ? (postInfo[item.post_id]?.target_date ?? null)
        : null;
  return raw === null || raw === '' ? null : raw.slice(0, 10);
}

/**
 * The plan's order everywhere items are listed or numbered: dated items by day
 * ascending, undated last, ties by position then creation. Pure.
 */
export function sortPlanItemsByDate(
  items: readonly PlanItemRow[],
  postInfo: Readonly<Record<string, PlanPostInfo>>,
): PlanItemRow[] {
  const days = new Map(items.map((i) => [i.id, planItemDay(i, postInfo)]));
  return [...items].sort((a, b) => {
    const da = days.get(a.id) ?? null;
    const db = days.get(b.id) ?? null;
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : 1;
    }
    return a.position - b.position || a.created_at.localeCompare(b.created_at);
  });
}

/**
 * Read plans by id with their items, reviews and post stages: four selects in
 * sequence (each chunked at 100), never an embed. A plan absent under RLS is
 * absent from the map. Never throws.
 */
export async function readPlanBundles(
  client: Client,
  planIds: readonly string[],
  signal?: AbortSignal,
): Promise<Result<Map<string, PlanBundle>>> {
  const out = new Map<string, PlanBundle>();
  try {
    const plans = await selectIn<PlanRow>(client, 'plans', PLAN_COLUMNS, 'id', planIds, signal);
    if (!plans.ok) return plans;
    if (plans.data.length === 0) return { ok: true, data: out };
    const items = await selectIn<PlanItemRow>(
      client,
      'plan_items',
      ITEM_COLUMNS,
      'plan_id',
      plans.data.map((p) => p.id),
      signal,
    );
    if (!items.ok) return items;
    const reviews = await selectIn<PlanReviewRow>(
      client,
      'plan_item_reviews',
      REVIEW_COLUMNS,
      'item_id',
      items.data.map((i) => i.id),
      signal,
    );
    if (!reviews.ok) return reviews;
    const postIds = items.data.flatMap((i) => (i.post_id !== null ? [i.post_id] : []));
    const stages = await selectIn<PlanPostRow>(
      client,
      'posts',
      'id, stage, title, target_date',
      'id',
      postIds,
      signal,
    );
    if (!stages.ok) return stages;
    return { ok: true, data: assembleBundles(plans.data, items.data, reviews.data, stages.data) };
  } catch (error) {
    return fail(String(error));
  }
}

/** The post columns a plan reads (stage feeds progress; title and date the rows). */
export interface PlanPostRow {
  id: string;
  stage: string;
  title?: string | null;
  target_date?: string | null;
}

/** Group the four reads into bundles by plan id. Pure. */
export function assembleBundles(
  plans: readonly PlanRow[],
  items: readonly PlanItemRow[],
  reviews: readonly PlanReviewRow[],
  stages: ReadonlyArray<PlanPostRow>,
): Map<string, PlanBundle> {
  const byId = new Map<string, PlanPostRow>();
  for (const s of stages) byId.set(s.id, s);
  const out = new Map<string, PlanBundle>();
  for (const plan of plans) {
    const own = items.filter((i) => i.plan_id === plan.id);
    const ids = new Set(own.map((i) => i.id));
    const postStages: Record<string, string> = {};
    const postInfo: Record<string, PlanPostInfo> = {};
    for (const item of own) {
      const post = item.post_id !== null ? byId.get(item.post_id) : undefined;
      if (item.post_id !== null && post !== undefined) {
        postStages[item.post_id] = post.stage;
        postInfo[item.post_id] = { title: post.title ?? '', target_date: post.target_date ?? null };
      }
    }
    out.set(plan.id, {
      plan,
      // Sorted here, once, so the first paint is already in date order.
      items: sortPlanItemsByDate(own, postInfo),
      reviews: reviews.filter((r) => ids.has(r.item_id)),
      postStages,
      postInfo,
    });
  }
  return out;
}

/** Visible comments per item id (one select over every item id). Never throws. */
export async function readCommentCounts(
  client: Client,
  itemIds: readonly string[],
  signal?: AbortSignal,
): Promise<Result<Record<string, number>>> {
  try {
    const rows = await selectIn<{ item_id: string }>(
      client,
      'plan_item_comments',
      'item_id',
      'item_id',
      itemIds,
      signal,
      (q) => q.is('deleted_at', null),
    );
    if (!rows.ok) return rows;
    const counts: Record<string, number> = {};
    for (const row of rows.data) counts[row.item_id] = (counts[row.item_id] ?? 0) + 1;
    return { ok: true, data: counts };
  } catch (error) {
    return fail(String(error));
  }
}

/** One item's visible comments, oldest first (newest last). Never throws. */
export async function readItemComments(
  client: Client,
  itemId: string,
  signal?: AbortSignal,
): Promise<Result<PlanCommentRow[]>> {
  try {
    const rows = await selectIn<PlanCommentRow>(
      client,
      'plan_item_comments',
      COMMENT_COLUMNS,
      'item_id',
      [itemId],
      signal,
      (q) => q.is('deleted_at', null).order('created_at', { ascending: true }),
    );
    if (!rows.ok) return rows;
    return { ok: true, data: sortComments(rows.data) };
  } catch (error) {
    return fail(String(error));
  }
}

/** Comments oldest first, newest last (ties by id). Pure. */
export function sortComments(rows: readonly PlanCommentRow[]): PlanCommentRow[] {
  return [...rows].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

/** One concept's library files (asset version ids, in position order). Never throws. */
export async function readItemFiles(
  client: Client,
  itemId: string,
  signal?: AbortSignal,
): Promise<Result<string[]>> {
  try {
    const rows = await selectIn<{ asset_version_id: string; position: number }>(
      client,
      // A concept's files: entity_type plan_item, entity_id = the item id.
      'asset_attachments',
      'asset_version_id, position',
      'entity_id',
      [itemId],
      signal,
      (q) =>
        q
          .eq('entity_type', 'plan_item')
          .is('deleted_at', null)
          .order('position', { ascending: true }),
    );
    if (!rows.ok) return rows;
    return {
      ok: true,
      data: [...rows.data].sort((a, b) => a.position - b.position).map((r) => r.asset_version_id),
    };
  } catch (error) {
    return fail(String(error));
  }
}

/** Plan titles by id (the marks sheet's bodyless rows). Never throws. */
export async function readPlanTitles(
  client: Client,
  planIds: readonly string[],
  signal?: AbortSignal,
): Promise<Result<Array<{ id: string; title: string }>>> {
  try {
    return await selectIn<{ id: string; title: string }>(
      client,
      'plans',
      'id, title',
      'id',
      planIds,
      signal,
    );
  } catch (error) {
    return fail(String(error));
  }
}

// ---------------------------------------------------------------------------
// The thread's plan card cache
// ---------------------------------------------------------------------------

/** What the cards with these plan ids show right now. */
export interface PlanCardsSnapshot {
  /** Some id has not settled yet (first read, or failed and still retrying): skeleton. */
  loading: boolean;
  /** Readable plans by id (absent = not available under RLS). */
  bundles: Map<string, PlanBundle>;
  /** Ids whose reads failed PLAN_READ_TRIES times: "Couldn't load", tap to retry. */
  failed: string[];
}

export interface PlanCardCache {
  /** Ask for these ids; only ids never tried and not in flight are read. */
  request: (ids: readonly string[]) => void;
  /** Re-read these plans (a plan changed); the cards stay as they are meanwhile. */
  refresh: (ids: readonly string[]) => void;
  /** A retry trigger: re-read failed ids with tries left (all, when `ids` is absent). */
  retryFailed: (ids?: readonly string[]) => void;
  /** The "Couldn't load" tap: a fresh set of tries, starting now. */
  retry: (ids: readonly string[]) => void;
  snapshot: (ids: readonly string[]) => PlanCardsSnapshot;
  /** Whether any of these ids is known to the cache (read or asked). */
  knows: (id: string) => boolean;
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  dispose: () => void;
  resume: () => void;
}

export interface PlanCardCacheOptions {
  schedule?: (flush: () => void) => void;
  timeoutMs?: number;
  retryDelayMs?: number;
}

type Entry =
  | { state: 'pending'; tries: number }
  | { state: 'ok'; bundle: PlanBundle }
  | { state: 'absent' }
  | { state: 'failed'; tries: number };

/**
 * The batched plan reads for one thread. Asks in one tick coalesce into one
 * readPlanBundles per 100 ids, each chunk bounded at `timeoutMs`. A failed read
 * keeps the skeleton and is re-read on the next trigger or on its own after
 * `retryDelayMs`, up to PLAN_READ_TRIES; a refresh asked while a read is in
 * flight runs once more after it; a failed refresh keeps what is shown.
 */
export function createPlanCardCache(
  read: (ids: string[], signal: AbortSignal) => Promise<Result<Map<string, PlanBundle>>>,
  opts: PlanCardCacheOptions = {},
): PlanCardCache {
  const schedule = opts.schedule ?? ((flush: () => void) => queueMicrotask(flush));
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const retryDelayMs = opts.retryDelayMs ?? PLAN_RETRY_DELAY_MS;
  const entries = new Map<string, Entry>();
  const inFlight = new Set<string>();
  const queued = new Set<string>();
  const refreshAfter = new Set<string>();
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let flushScheduled = false;
  let disposed = false;
  let generation = 0;
  let ver = 0;

  const emit = (): void => {
    ver += 1;
    for (const l of [...listeners]) l();
  };

  const enqueue = (ids: readonly string[]): void => {
    for (const id of ids) queued.add(id);
    if (flushScheduled || queued.size === 0) return;
    flushScheduled = true;
    schedule(flush);
  };

  function flush(): void {
    flushScheduled = false;
    if (disposed) return;
    const ids = [...queued].filter((id) => !inFlight.has(id));
    queued.clear();
    if (ids.length === 0) return;
    const gen = generation;
    for (const chunk of planChunks(ids)) {
      for (const id of chunk) inFlight.add(id);
      void withReadTimeout((signal) => read(chunk, signal), timeoutMs).then((result) => {
        if (disposed || gen !== generation) return;
        for (const id of chunk) inFlight.delete(id);
        if (result.ok) {
          for (const id of chunk) {
            const bundle = result.data.get(id);
            entries.set(id, bundle !== undefined ? { state: 'ok', bundle } : { state: 'absent' });
          }
        } else {
          for (const id of chunk) {
            const prev = entries.get(id);
            // A failed refresh keeps the card it already shows.
            if (prev?.state === 'ok' || prev?.state === 'absent') continue;
            const tries =
              (prev?.state === 'pending' || prev?.state === 'failed' ? prev.tries : 0) + 1;
            entries.set(id, { state: 'failed', tries });
          }
          const again = chunk.filter((id) => {
            const e = entries.get(id);
            return e?.state === 'failed' && e.tries < PLAN_READ_TRIES;
          });
          if (again.length > 0) {
            const timer = setTimeout(() => {
              timers.delete(timer);
              retryFailed(again);
            }, retryDelayMs);
            timers.add(timer);
          }
        }
        const rerun = chunk.filter((id) => refreshAfter.delete(id));
        if (rerun.length > 0) enqueue(rerun);
        emit();
      });
    }
  }

  function retryFailed(ids?: readonly string[]): void {
    const pool = ids ?? [...entries.keys()];
    const due = pool.filter((id) => {
      const e = entries.get(id);
      return e?.state === 'failed' && e.tries < PLAN_READ_TRIES && !inFlight.has(id);
    });
    enqueue(due);
  }

  return {
    request(ids) {
      const fresh = ids.filter((id) => !entries.has(id));
      for (const id of fresh) entries.set(id, { state: 'pending', tries: 0 });
      enqueue(fresh);
    },
    refresh(ids) {
      const known = ids.filter((id) => entries.has(id));
      for (const id of known) {
        if (inFlight.has(id)) refreshAfter.add(id);
      }
      enqueue(known.filter((id) => !inFlight.has(id)));
    },
    retryFailed,
    retry(ids) {
      for (const id of ids) {
        const e = entries.get(id);
        if (e?.state === 'failed') entries.set(id, { state: 'pending', tries: 0 });
      }
      emit();
      enqueue(ids.filter((id) => entries.get(id)?.state === 'pending'));
    },
    snapshot(ids) {
      const bundles = new Map<string, PlanBundle>();
      const failed: string[] = [];
      let loading = false;
      for (const id of ids) {
        const e = entries.get(id);
        if (e === undefined || e.state === 'pending') loading = true;
        else if (e.state === 'ok') bundles.set(id, e.bundle);
        else if (e.state === 'failed') {
          if (e.tries >= PLAN_READ_TRIES) failed.push(id);
          else loading = true;
        }
      }
      return { loading, bundles, failed };
    },
    knows: (id) => entries.has(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => ver,
    dispose() {
      disposed = true;
      generation += 1;
      inFlight.clear();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      listeners.clear();
    },
    resume() {
      if (!disposed) return;
      disposed = false;
      // Ids whose reads were dropped by the dispose are read again.
      const pending = [...entries.entries()]
        .filter(([, e]) => e.state === 'pending')
        .map(([id]) => id);
      enqueue(pending);
    },
  };
}

// ---------------------------------------------------------------------------
// The New plan screen's share sequence
// ---------------------------------------------------------------------------

/** One concept the New plan screen holds until Share. */
export interface DraftConcept {
  /** Local key (list identity only). */
  key: string;
  title: string;
  description: string;
  /** Library asset version ids, up to 20. */
  versionIds: string[];
  /** Optional date ("YYYY-MM-DD"), null when none. */
  targetDate: string | null;
}

export interface PlanDraft {
  workspaceId: string;
  channelId: string;
  title: string;
  startsOn: string;
  endsOn: string;
  audience: PlanAudience;
  concepts: DraftConcept[];
  postIds: string[];
}

/**
 * How far a share got. A retry resumes from here: plan_create runs once,
 * each concept is added once (in order), the posts once, and the share reuses
 * the same message id (chat_plan_share is idempotent on it).
 */
export interface ShareProgress {
  planId: string | null;
  conceptsDone: number;
  postsDone: boolean;
  /** The chat message id, minted once per New plan screen. */
  messageId: string;
  shared: boolean;
}

/**
 * A share's epoch: bumped on every open and close of the New plan screen. A
 * share captures the epoch it started in and drops its result when it is no
 * longer current (a reopened form never takes an old share's progress).
 */
export interface ShareEpoch {
  next: () => number;
  current: () => number;
  isCurrent: (token: number) => boolean;
}

export function createShareEpoch(): ShareEpoch {
  let value = 0;
  return {
    next: () => {
      value += 1;
      return value;
    },
    current: () => value,
    isCurrent: (token) => token === value,
  };
}

export function initialShareProgress(messageId: string): ShareProgress {
  return { planId: null, conceptsDone: 0, postsDone: false, messageId, shared: false };
}

export type ShareStep = 'create' | 'concepts' | 'posts' | 'share';

/** The write steps the share runs (the app binds the @srtdio/rpc wrappers). */
export interface PlanShareDeps {
  create: (draft: PlanDraft, traceId: string) => Promise<Result<string>>;
  conceptAdd: (planId: string, concept: DraftConcept, traceId: string) => Promise<Result<string>>;
  postsAdd: (planId: string, postIds: string[], traceId: string) => Promise<Result<number>>;
  share: (
    planId: string,
    channelId: string,
    messageId: string,
    traceId: string,
  ) => Promise<Result<unknown>>;
}

/** Shown inline when a share step fails. */
export const PLAN_SHARE_FAILED = "Couldn't share. Try again.";
/** Shown when a team only plan meets a chat with a client. */
export const TEAM_PLAN_CLIENT_CHAT = "Team only plans can't be shared in chats with clients.";

export type PlanShareResult =
  | { ok: true; progress: ShareProgress }
  | {
      ok: false;
      progress: ShareProgress;
      step: ShareStep;
      /** The inline copy (never the raw proc text). */
      copy: string;
      /** The raw error, for the log. */
      message: string;
    };

/** The inline copy for a failed step's raw error. Pure. */
export function shareFailureCopy(message: string): string {
  return message.includes('plan_not_shared_with_client')
    ? TEAM_PLAN_CLIENT_CHAT
    : PLAN_SHARE_FAILED;
}

/**
 * Run the share from wherever `progress` stopped, one trace id for every step.
 * Steps run in sequence; the first failure stops it with the progress so far,
 * so a retry never repeats plan_create or a concept already added. Never throws.
 */
export async function runPlanShare(
  deps: PlanShareDeps,
  draft: PlanDraft,
  start: ShareProgress,
  traceId: string,
): Promise<PlanShareResult> {
  let progress = { ...start };
  let step: ShareStep = 'create';
  const failed = (step: ShareStep, message: string): PlanShareResult => ({
    ok: false,
    progress,
    step,
    copy: shareFailureCopy(message),
    message,
  });
  try {
    if (progress.planId === null) {
      const created = await deps.create(draft, traceId);
      if (!created.ok) return failed('create', created.error.message);
      progress = { ...progress, planId: created.data };
    }
    const planId = progress.planId as string;
    step = 'concepts';
    while (progress.conceptsDone < draft.concepts.length) {
      const concept = draft.concepts[progress.conceptsDone] as DraftConcept;
      const added = await deps.conceptAdd(planId, concept, traceId);
      if (!added.ok) return failed('concepts', added.error.message);
      progress = { ...progress, conceptsDone: progress.conceptsDone + 1 };
    }
    step = 'posts';
    if (!progress.postsDone) {
      if (draft.postIds.length > 0) {
        const added = await deps.postsAdd(planId, draft.postIds, traceId);
        if (!added.ok) return failed('posts', added.error.message);
      }
      progress = { ...progress, postsDone: true };
    }
    step = 'share';
    if (!progress.shared) {
      const shared = await deps.share(planId, draft.channelId, progress.messageId, traceId);
      if (!shared.ok) return failed('share', shared.error.message);
      progress = { ...progress, shared: true };
    }
    return { ok: true, progress };
  } catch (error) {
    return failed(step, String(error));
  }
}

/** plan_concept_add's args for a draft concept: no date leaves the column null. Pure. */
export function conceptAddArgs(
  planId: string,
  concept: DraftConcept,
  traceId: string,
): PlanConceptAddArgs {
  return {
    p_plan_id: planId,
    p_title: concept.title,
    p_description: concept.description,
    p_attachment_version_ids: concept.versionIds,
    p_trace_id: traceId,
    ...(concept.targetDate !== null ? { p_target_date: concept.targetDate } : {}),
  };
}

/** Whether two file lists hold the same ids in the same order. Pure. */
function sameFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** One concept edit: the fields as they will be saved. */
export interface ConceptEdit {
  title: string;
  description: string;
  /** "YYYY-MM-DD", or null / '' for no date. */
  targetDate: string | null;
  /** The concept's files as read (null when not read). */
  currentFiles: readonly string[] | null;
  /** The files as picked in the edit (null when the edit does not touch files). */
  pickedFiles: readonly string[] | null;
}

/**
 * plan_concept_edit's args. The date is always sent (null clears it). Files go
 * as null ("keep files") unless the picked list differs from the current one
 * (added, removed or reordered): an array makes the proc soft-delete and
 * re-attach every link. Pure.
 */
export function conceptEditArgs(
  itemId: string,
  edit: ConceptEdit,
  traceId: string,
): PlanConceptEditArgs {
  const picked = edit.pickedFiles;
  const changed =
    picked !== null && (edit.currentFiles === null || !sameFiles(edit.currentFiles, picked));
  return {
    p_item_id: itemId,
    p_title: edit.title,
    p_description: edit.description,
    p_attachment_version_ids: changed ? [...picked] : null,
    p_target_date: edit.targetDate === '' ? null : edit.targetDate,
    p_trace_id: traceId,
  };
}

/**
 * Whether an edit leaves the concept as it is: same title, description and
 * date, and files that would go as null (untouched or picked the same). Such a
 * save sends nothing, so no review resets. Pure.
 */
export function conceptEditUnchanged(
  item: Pick<PlanItemRow, 'title' | 'description' | 'target_date'>,
  edit: ConceptEdit,
): boolean {
  return (
    edit.title === (item.title ?? '') &&
    edit.description === (item.description ?? '') &&
    (edit.targetDate ?? '') === (item.target_date?.slice(0, 10) ?? '') &&
    conceptEditArgs('', edit, '').p_attachment_version_ids === null
  );
}

// ---------------------------------------------------------------------------
// Screen reads: one select per table per screen open
// ---------------------------------------------------------------------------

/** The Plan screen: the plan's bundle (null when not readable) and visible comment counts. */
export interface PlanScreenData {
  bundle: PlanBundle | null;
  commentCounts: Record<string, number>;
}

/** Read the Plan screen (plans, items, reviews, posts, then comment counts). Never throws. */
export async function readPlanScreen(
  client: Client,
  planId: string,
  signal?: AbortSignal,
): Promise<Result<PlanScreenData>> {
  const bundles = await readPlanBundles(client, [planId], signal);
  if (!bundles.ok) return bundles;
  const bundle = bundles.data.get(planId) ?? null;
  if (bundle === null) return { ok: true, data: { bundle, commentCounts: {} } };
  const counts = await readCommentCounts(
    client,
    bundle.items.map((i) => i.id),
    signal,
  );
  if (!counts.ok) return counts;
  return { ok: true, data: { bundle, commentCounts: counts.data } };
}

/** The Item screen: comments (oldest first), a concept's files, and author names. */
export interface ItemScreenData {
  comments: PlanCommentRow[];
  /** Library asset version ids (concepts only; empty for a post item). */
  files: string[];
  /** Author display names by user id. */
  names: Record<string, string>;
}

/** Read the Item screen. Never throws. */
export async function readItemScreen(
  client: Client,
  item: Pick<PlanItemRow, 'id' | 'kind'>,
  readNames: (userIds: string[], signal?: AbortSignal) => Promise<Result<NameRow[]>>,
  signal?: AbortSignal,
): Promise<Result<ItemScreenData>> {
  const [comments, files] = await Promise.all([
    readItemComments(client, item.id, signal),
    item.kind === 'concept'
      ? readItemFiles(client, item.id, signal)
      : Promise.resolve<Result<string[]>>({ ok: true, data: [] }),
  ]);
  if (!comments.ok) return comments;
  if (!files.ok) return files;
  const authors = [
    ...new Set(comments.data.flatMap((c) => (c.author_user_id !== null ? [c.author_user_id] : []))),
  ];
  const names: Record<string, string> = {};
  if (authors.length > 0) {
    const read = await readNames(authors, signal);
    // A failed name read keeps the comments (rows read "Member").
    if (read.ok) for (const row of read.data) names[row.userId] = row.displayName;
  }
  return { ok: true, data: { comments: comments.data, files: files.data, names } };
}

/** One author's name row (readProfiles). */
export interface NameRow {
  userId: string;
  displayName: string;
}
