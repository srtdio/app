// Plans in chat: the reads behind the plan card, the Plan and Item screens, and
// the share sequence behind the New plan screen. The cards and the Plan screen
// read through plan_bundle_read (src/lib/chat/plan-bundle.ts): one call per
// 200 plan ids returns the plans, their items, draft rows, reviews, post rows,
// comment counts, tiles, Also in titles and the last send into a chat; RLS
// decides what comes back, so a plan the viewer cannot read is simply absent
// ("Plan not available"). Cards never read per message: the thread's plan card
// cache (createPlanCardCache) coalesces every plan id asked in the same tick
// into one batch. The other reads (the Plan tile's upcoming plans, the Item
// screen, a post's plans) are plain PostgREST selects by an id list (no
// embeds), chunked at 100 ids and bounded at 5s by the caller. A client never
// reads a draft post item from plan_items (RLS): its row comes from
// plan_draft_rows and is merged in as a post item at stage draft, name only.
// A post slot's day is its post's posts.target_date read in the workspace zone
// (a draft row's too); a concept's is plan_items.target_date. Framework-free:
// the create steps and the readers are injected, so the contract is
// unit-tested directly.

import type {
  Client,
  PlanConceptAddArgs,
  PlanConceptEditArgs,
  PlanCreateWithItemsArgs,
  Result,
} from '@srtdio/rpc';
import { planDraftRows } from '@srtdio/rpc';
import { abortable, READ_TIMEOUT_MS, withReadTimeout } from '@/lib/chat-reads';
import type { Precheck } from '@/lib/asset-upload';
import type { AttachmentUploader } from '@/lib/chat/attachments';
import { PLAN_BUNDLE_CHUNK, readPlanBundleRpc, type PlanBundleRead } from '@/lib/chat/plan-bundle';
import { openPlans } from '@/lib/chat/status-bar';
import { getPrefetchContext } from '@/lib/prefetch-context';
import { civilDayOf, civilDaysBetween, formatCivilDayHeader } from '@/lib/plan-week';

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
  /** Bumped by plan_update / plan_share_with_client (the Plan screen's Sent state). */
  updated_at?: string;
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
  /** Bumped by edits and moves (the Plan screen's Sent state); absent on a draft row. */
  updated_at?: string;
  /**
   * A concept's plan day ("YYYY-MM-DD"); null is No date. A post slot carries
   * no day of its own (its post's posts.target_date is the day); a draft row
   * carries the post's target_date as plan_draft_rows returns it (timestamptz,
   * read in the workspace zone).
   */
  target_date?: string | null;
  /**
   * A draft post item read from plan_draft_rows (the viewer cannot read the
   * item or its post): the title, number and date come from that row.
   */
  draft_row?: true;
  /** The post's number, on a draft row. */
  post_number?: number;
}

/** One row of plan_draft_rows: a draft post item the caller may see by name. */
export interface PlanDraftRow {
  plan_id: string;
  item_id: string;
  item_position: number;
  post_number: number;
  title: string;
  target_date: string | null;
}

export interface PlanReviewRow {
  item_id: string;
  side: ReviewSide;
  status: ReviewStatus;
  /** Who set this status (the Approved by line); absent in old fixtures. */
  reviewed_by?: string | null;
  /** When (timestamptz); absent in old fixtures. */
  reviewed_at?: string | null;
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
  /** The post's target_date (timestamptz, 12:00 workspace zone): the slot's day, read in the zone. */
  target_date?: string | null;
  /** The post's format (the Plan screen row's meta line); null when not read. */
  format?: string | null;
}

/** The plans columns every plan read selects. */
export const PLAN_COLUMNS =
  'id, workspace_id, title, starts_on, ends_on, audience, created_by, updated_at';
const ITEM_COLUMNS =
  'id, plan_id, kind, position, title, description, post_id, created_at, updated_at, target_date';
const REVIEW_COLUMNS = 'item_id, side, status, reviewed_by, reviewed_at';
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

/** What one PostgREST select resolves to (typed loosely: no embeds). */
export type SelectResult = { data: unknown; error: { message: string } | null };

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
export interface PlanQuery extends PromiseLike<SelectResult> {
  in: (column: string, values: readonly string[]) => PlanQuery;
  is: (column: string, value: null) => PlanQuery;
  eq: (column: string, value: string) => PlanQuery;
  contains: (column: string, value: readonly string[]) => PlanQuery;
  gte: (column: string, value: string) => PlanQuery;
  lte: (column: string, value: string) => PlanQuery;
  order: (column: string, opts?: { ascending?: boolean }) => PlanQuery;
  limit: (count: number) => PlanQuery;
  range: (from: number, to: number) => PlanQuery;
}
/** A table's select entry point, as these reads type it. */
export interface PlanTable {
  select: (columns: string) => PlanQuery;
}

/**
 * An item's plan day ("YYYY-MM-DD") in the workspace zone; null is No date.
 * A concept: plan_items.target_date (a calendar date). A post slot: its
 * post's posts.target_date (timestamptz) read in the zone. A draft row (no
 * post id): the post's target_date plan_draft_rows returns, read in the zone
 * (never sliced). plan_items.target_date never places a post. Pure.
 */
export function planItemDayInZone(
  item: PlanItemRow,
  postInfo: Readonly<Record<string, PlanPostInfo>>,
  timeZone: string,
): string | null {
  if (item.kind === 'concept') return civilDayOf(item.target_date ?? null, timeZone);
  if (item.post_id !== null) return civilDayOf(postInfo[item.post_id]?.target_date, timeZone);
  return item.draft_row === true ? civilDayOf(item.target_date ?? null, timeZone) : null;
}

/** planItemDayInZone, the zone defaulting to UTC (callers without a workspace zone). Pure. */
export function planItemDay(
  item: PlanItemRow,
  postInfo: Readonly<Record<string, PlanPostInfo>> = {},
  timeZone = 'UTC',
): string | null {
  return planItemDayInZone(item, postInfo, timeZone);
}

/**
 * The plan's order everywhere items are listed or numbered: dated items by day
 * (in the workspace zone) ascending, undated last, ties by position then
 * creation. Pure.
 */
export function sortPlanItemsByDate(
  items: readonly PlanItemRow[],
  postInfo: Readonly<Record<string, PlanPostInfo>>,
  timeZone = 'UTC',
): PlanItemRow[] {
  const days = new Map(items.map((i) => [i.id, planItemDayInZone(i, postInfo, timeZone)]));
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
 * The bundles of one plan_bundle_read answer: the draft rows merged in as
 * post items, everything grouped by plan, items ordered in `timeZone` (the
 * bundle's own workspace zone when absent). Pure.
 */
export function bundlesOfRead(read: PlanBundleRead, timeZone?: string): Map<string, PlanBundle> {
  return assembleBundles(
    read.plans,
    mergeDraftRows(read.items, read.draftRows),
    read.reviews,
    read.posts,
    timeZone ?? read.timezone,
  );
}

/**
 * Read plans by id with their items, reviews, draft rows and post stages:
 * one plan_bundle_read per PLAN_BUNDLE_CHUNK ids (all chunks at once). A plan
 * absent under RLS (or of another workspace) is absent from the map. The
 * workspace is `workspaceId`, else the shell's (getPrefetchContext); without
 * either the read fails. Items are ordered in `timeZone`, else the bundle's
 * workspace zone. Never throws.
 */
export async function readPlanBundles(
  client: Client,
  planIds: readonly string[],
  signal?: AbortSignal,
  /** The zone the items are ordered in (post days are read in it); the workspace's when absent. */
  timeZone?: string,
  /** The plans' workspace; the shell's active workspace when absent. */
  workspaceId?: string,
): Promise<Result<Map<string, PlanBundle>>> {
  try {
    const ids = [...new Set(planIds)];
    if (ids.length === 0) return { ok: true, data: new Map() };
    const workspace = workspaceId ?? getPrefetchContext()?.workspaceId;
    if (workspace === undefined) return fail('plan_bundle_read: no workspace');
    const reads = await Promise.all(
      bundleChunks(ids).map((chunk) =>
        readPlanBundleRpc(client, { workspaceId: workspace, planIds: chunk }, signal),
      ),
    );
    const out = new Map<string, PlanBundle>();
    for (const read of reads) {
      if (!read.ok) return read;
      for (const [id, bundle] of bundlesOfRead(read.data, timeZone)) out.set(id, bundle);
    }
    return { ok: true, data: out };
  } catch (error) {
    return fail(String(error));
  }
}

/** Split ids into by-id plan_bundle_read calls of at most PLAN_BUNDLE_CHUNK. Pure. */
export function bundleChunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += PLAN_BUNDLE_CHUNK) {
    out.push(ids.slice(i, i + PLAN_BUNDLE_CHUNK));
  }
  return out;
}

/**
 * The bundles of plans already read: their draft rows, and their items then
 * (as soon as the items are in) the reviews and post stages. Items are
 * ordered in `timeZone` (UTC by default). Never throws.
 */
export async function readBundlesOf(
  client: Client,
  plans: readonly PlanRow[],
  signal: AbortSignal | undefined,
  timeZone = 'UTC',
): Promise<Result<Map<string, PlanBundle>>> {
  const read = await readBundlesAlongside(client, plans, signal, timeZone, () =>
    Promise.resolve(null),
  );
  return read.ok ? { ok: true, data: read.data.bundles } : read;
}

/**
 * readBundlesOf, plus one more read that needs only the plans' items (the
 * Plan tab's tiles): it starts the moment the items are in and runs alongside
 * the reviews and post stages, so it costs no extra round trip of waiting.
 * Never throws.
 */
export async function readBundlesAlongside<T>(
  client: Client,
  plans: readonly PlanRow[],
  signal: AbortSignal | undefined,
  timeZone: string,
  alongside: (items: readonly PlanItemRow[]) => Promise<T>,
): Promise<Result<{ bundles: Map<string, PlanBundle>; alongside: T }>> {
  if (plans.length === 0) {
    return { ok: true, data: { bundles: new Map(), alongside: await alongside([]) } };
  }
  const ids = plans.map((p) => p.id);
  const [drafts, items] = await Promise.all([
    readDraftRows(client, ids),
    readItemsWithReviews(client, ids, signal, alongside),
  ]);
  if (!drafts.ok) return drafts;
  if (!items.ok) return items;
  return {
    ok: true,
    data: {
      bundles: assembleBundles(
        plans,
        mergeDraftRows(items.data.items, drafts.data),
        items.data.reviews,
        items.data.stages,
        timeZone,
      ),
      alongside: items.data.alongside,
    },
  };
}

/** The plans' items, then their reviews and post stages together. Never throws. */
async function readItemsWithReviews<T>(
  client: Client,
  planIds: readonly string[],
  signal: AbortSignal | undefined,
  alongside: (items: readonly PlanItemRow[]) => Promise<T>,
): Promise<
  Result<{
    items: PlanItemRow[];
    reviews: PlanReviewRow[];
    stages: PlanPostRow[];
    alongside: T;
  }>
> {
  const items = await selectIn<PlanItemRow>(
    client,
    'plan_items',
    ITEM_COLUMNS,
    'plan_id',
    planIds,
    signal,
  );
  if (!items.ok) return items;
  const postIds = items.data.flatMap((i) => (i.post_id !== null ? [i.post_id] : []));
  const [reviews, stages, side] = await Promise.all([
    selectIn<PlanReviewRow>(
      client,
      'plan_item_reviews',
      REVIEW_COLUMNS,
      'item_id',
      items.data.map((i) => i.id),
      signal,
    ),
    selectIn<PlanPostRow>(
      client,
      'posts',
      'id, stage, title, format, target_date',
      'id',
      postIds,
      signal,
    ),
    alongside(items.data),
  ]);
  if (!reviews.ok) return reviews;
  if (!stages.ok) return stages;
  return {
    ok: true,
    data: { items: items.data, reviews: reviews.data, stages: stages.data, alongside: side },
  };
}

/** plan_draft_rows over the plan ids: one call per chunk of 100. Never throws. */
async function readDraftRows(
  client: Client,
  planIds: readonly string[],
): Promise<Result<PlanDraftRow[]>> {
  const unique = [...new Set(planIds)];
  if (unique.length === 0) return { ok: true, data: [] };
  const results = await Promise.all(
    planChunks(unique).map((chunk) => planDraftRows(client, { p_plan_ids: chunk })),
  );
  const rows: PlanDraftRow[] = [];
  for (const res of results) {
    if (!res.ok) return fail(`plan_draft_rows: ${res.error.message}`);
    rows.push(...((res.data ?? []) as PlanDraftRow[]));
  }
  return { ok: true, data: rows };
}

/**
 * The items plus every draft row whose item is not already among them (the
 * agency reads those items itself), as a post item at stage draft: name,
 * number and the post's target_date (as returned, read in the zone) from the
 * row, no post id. Pure.
 */
export function mergeDraftRows(
  items: readonly PlanItemRow[],
  drafts: readonly PlanDraftRow[],
): PlanItemRow[] {
  const have = new Set(items.map((i) => i.id));
  const out = [...items];
  for (const row of drafts) {
    if (have.has(row.item_id)) continue;
    have.add(row.item_id);
    out.push({
      id: row.item_id,
      plan_id: row.plan_id,
      kind: 'post',
      position: row.item_position,
      title: row.title,
      description: null,
      post_id: null,
      created_at: '',
      // plan_draft_rows returns the post's target_date (part 2b): a
      // timestamptz read in the workspace zone, never sliced.
      target_date: row.target_date,
      draft_row: true,
      post_number: row.post_number,
    });
  }
  return out;
}

/** Plans the Plan tile lists: this many at most. */
export const UPCOMING_PLANS_LIMIT = 100;

/**
 * The workspace's upcoming plans (not deleted, ending on `today` or later in
 * the workspace zone), ending soonest first, at most 100: one plans select,
 * then their bundles through the batched reads. Never throws.
 */
export async function readUpcomingPlans(
  client: Client,
  workspaceId: string,
  today: string,
  signal?: AbortSignal,
): Promise<Result<PlanBundle[]>> {
  try {
    const query = (client.from('plans') as unknown as PlanTable)
      .select(PLAN_COLUMNS)
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .gte('ends_on', today)
      .order('ends_on', { ascending: true })
      .limit(UPCOMING_PLANS_LIMIT);
    const res = (await abortable(query, signal)) as SelectResult;
    if (res.error !== null) return fail(`plans: ${res.error.message}`);
    const plans = (res.data ?? []) as PlanRow[];
    const bundles = await readBundlesOf(client, plans, signal);
    if (!bundles.ok) return bundles;
    return { ok: true, data: openPlans(bundles.data.values(), today) };
  } catch (error) {
    return fail(String(error));
  }
}

/** The post columns a plan reads (stage feeds progress; title and format the rows). */
export interface PlanPostRow {
  id: string;
  stage: string;
  title?: string | null;
  format?: string | null;
  /** posts.target_date (timestamptz): the slot's day in the workspace zone. */
  target_date?: string | null;
}

/** Group the four reads into bundles by plan id. Pure. */
export function assembleBundles(
  plans: readonly PlanRow[],
  items: readonly PlanItemRow[],
  reviews: readonly PlanReviewRow[],
  stages: ReadonlyArray<PlanPostRow>,
  timeZone = 'UTC',
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
        postInfo[item.post_id] = {
          title: post.title ?? '',
          format: post.format ?? null,
          target_date: post.target_date ?? null,
        };
      }
    }
    out.set(plan.id, {
      plan,
      // Sorted here, once, so the first paint is already in date order.
      items: sortPlanItemsByDate(own, postInfo, timeZone),
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
  /**
   * A reopen: re-read every settled plan (shown or absent) in the background;
   * the cards stay as they are and change only when the data did.
   */
  revalidate: () => void;
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

/** Whether two read values (plain JSON data: rows, lists, records) are equal. Pure. */
export function sameReadValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every(
    (k) => Object.prototype.hasOwnProperty.call(rb, k) && sameReadValue(ra[k], rb[k]),
  );
}

/**
 * The batched plan reads for one thread. Asks in one tick coalesce into one
 * readPlanBundles per 100 ids, each chunk bounded at `timeoutMs`. A failed read
 * keeps the skeleton and is re-read on the next trigger or on its own after
 * `retryDelayMs`, up to PLAN_READ_TRIES; a refresh asked while a read is in
 * flight runs once more after it; a failed refresh keeps what is shown. A
 * settled card never goes back to loading on a background re-read, and a
 * re-read that returns the same data keeps the entry (same bundle object) and
 * notifies nobody, so a painted card only changes when its data did.
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
        let changed = false;
        if (result.ok) {
          for (const id of chunk) {
            const bundle = result.data.get(id);
            const prev = entries.get(id);
            if (bundle === undefined) {
              if (prev?.state === 'absent') continue;
              entries.set(id, { state: 'absent' });
            } else {
              if (prev?.state === 'ok' && sameReadValue(prev.bundle, bundle)) continue;
              entries.set(id, { state: 'ok', bundle });
            }
            changed = true;
          }
        } else {
          for (const id of chunk) {
            const prev = entries.get(id);
            // A failed refresh keeps the card it already shows.
            if (prev?.state === 'ok' || prev?.state === 'absent') continue;
            const tries =
              (prev?.state === 'pending' || prev?.state === 'failed' ? prev.tries : 0) + 1;
            entries.set(id, { state: 'failed', tries });
            changed = true;
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
        if (changed) emit();
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
      let changed = false;
      for (const id of ids) {
        const e = entries.get(id);
        if (e?.state === 'failed') {
          entries.set(id, { state: 'pending', tries: 0 });
          changed = true;
        }
      }
      if (changed) emit();
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
    revalidate() {
      const settled = [...entries.entries()]
        .filter(([, e]) => e.state === 'ok' || e.state === 'absent')
        .map(([id]) => id);
      for (const id of settled) {
        if (inFlight.has(id)) refreshAfter.add(id);
      }
      enqueue(settled.filter((id) => !inFlight.has(id)));
    },
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

/** One concept the New plan screen holds until Create plan. */
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
  /** The chat a share step sends into; absent when the sequence only creates. */
  channelId?: string;
  title: string;
  startsOn: string;
  endsOn: string;
  audience: PlanAudience;
  concepts: DraftConcept[];
  postIds: string[];
}

/**
 * How far a create got. A retry resumes from here: plan_create runs once,
 * each concept is added once (in order), the posts once, and an optional share
 * reuses the same message id (chat_plan_share is idempotent on it).
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

/**
 * The write steps the sequence runs (the app binds the @srtdio/rpc wrappers).
 * Without `share` it only creates (Create plan never sends a card).
 */
export interface PlanShareDeps {
  create: (draft: PlanDraft, traceId: string) => Promise<Result<string>>;
  conceptAdd: (planId: string, concept: DraftConcept, traceId: string) => Promise<Result<string>>;
  postsAdd: (planId: string, postIds: string[], traceId: string) => Promise<Result<number>>;
  share?: (
    planId: string,
    channelId: string,
    messageId: string,
    traceId: string,
  ) => Promise<Result<unknown>>;
}

/** Shown inline when a share step fails. */
export const PLAN_SHARE_FAILED = "Couldn't share. Try again.";
/** Shown inline when Create plan fails (a retry resumes). */
export const PLAN_CREATE_FAILED = "Couldn't create. Try again.";
/** Shown when a Draft plan meets a chat with a client (the server refused it). */
export const TEAM_PLAN_CLIENT_CHAT = 'Open the plan for approvers first.';

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

/** Whether a share was refused because the plan is a Draft and the chat has a client. Pure. */
export function refusedForClient(message: string): boolean {
  return message.includes('plan_not_shared_with_client');
}

/** The inline copy for a failed step's raw error. Pure. */
export function shareFailureCopy(message: string): string {
  return refusedForClient(message) ? TEAM_PLAN_CLIENT_CHAT : PLAN_SHARE_FAILED;
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
    if (!progress.shared && deps.share !== undefined && draft.channelId !== undefined) {
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
  /** Each post's first image (asset version id), for the row thumbnails. */
  thumbs: Record<string, string>;
  /** Each concept's tile: its first image, or a file tile when it holds only documents. */
  conceptThumbs?: Record<string, ConceptThumb>;
  /** Approvers' display names by user id (the Approved by lines; one batched read). */
  names?: Record<string, string>;
  /** Other live plans (titles) each post sits in, by post id (the Also in pill). */
  alsoIn?: Record<string, string[]>;
  /**
   * Opened from a chat: when the plan's card was last sent there (the latest
   * non-deleted chat_messages row whose shared_plan_ids holds it); null when
   * never, or when that read failed.
   */
  lastSentAt?: string | null;
  /** The latest of plans.updated_at and its items' updated_at; null when unknown. */
  lastChangedAt?: string | null;
}

/** A concept row's tile: its first image file, or "has files, none an image". */
export type ConceptThumb = { kind: 'image'; versionId: string } | { kind: 'file' };

/** One asset_attachments row as the thumbs read selects it. */
export interface ThumbRow {
  entity_id: string;
  entity_type: string;
  asset_version_id: string;
  asset_versions: { mime_type: string | null } | Array<{ mime_type: string | null }> | null;
}

/** What the plan's rows need from asset_attachments: post images and concept tiles. */
export interface PlanThumbs {
  posts: Record<string, string>;
  concepts: Record<string, ConceptThumb>;
}

/** The thumbs of a list of attachment rows (lowest position first per entity). Pure. */
export function thumbsOfRows(rows: readonly ThumbRow[]): PlanThumbs {
  const posts: Record<string, string> = {};
  const concepts: Record<string, ConceptThumb> = {};
  for (const row of rows) {
    const version = Array.isArray(row.asset_versions) ? row.asset_versions[0] : row.asset_versions;
    const image = version?.mime_type?.startsWith('image/') === true;
    if (row.entity_type === 'post') {
      if (posts[row.entity_id] === undefined && image) posts[row.entity_id] = row.asset_version_id;
      continue;
    }
    if (row.entity_type !== 'plan_item') continue;
    const have = concepts[row.entity_id];
    if (have?.kind === 'image') continue;
    concepts[row.entity_id] = image
      ? { kind: 'image', versionId: row.asset_version_id }
      : { kind: 'file' };
  }
  return { posts, concepts };
}

/**
 * The rows' tiles in ONE asset_attachments read (per chunk of 100 ids, the
 * version mime embedded; never a read per row): each post's first image (the
 * live image attachment with the lowest position, then the earliest attached)
 * and each concept's first image, or a file tile when its files are all
 * documents. Entities with no file are absent. Never throws.
 */
export async function readPlanThumbs(
  client: Client,
  postIds: readonly string[],
  conceptIds: readonly string[],
  signal?: AbortSignal,
): Promise<Result<PlanThumbs>> {
  try {
    const rows = await selectIn<ThumbRow>(
      client,
      'asset_attachments',
      'entity_id, entity_type, asset_version_id, asset_versions!inner(mime_type)',
      'entity_id',
      [...postIds, ...conceptIds],
      signal,
      (q) =>
        q
          .in('entity_type', ['post', 'plan_item'])
          .is('deleted_at', null)
          .order('entity_id', { ascending: true })
          .order('position', { ascending: true })
          .order('attached_at', { ascending: true }),
    );
    if (!rows.ok) return rows;
    return { ok: true, data: thumbsOfRows(rows.data) };
  } catch (error) {
    return fail(String(error));
  }
}

/** Each post's first image (asset version id). Posts with no image are absent. Never throws. */
export async function readPostThumbs(
  client: Client,
  postIds: readonly string[],
  signal?: AbortSignal,
): Promise<Result<Record<string, string>>> {
  const thumbs = await readPlanThumbs(client, postIds, [], signal);
  return thumbs.ok ? { ok: true, data: thumbs.data.posts } : thumbs;
}

interface AlsoInRow {
  post_id: string | null;
  plan_id: string;
  plans: { title: string } | Array<{ title: string }> | null;
}

/** Group Also in rows by post: other plans' titles, each plan once, in read order. Pure. */
export function alsoInByPost(
  planId: string,
  rows: ReadonlyArray<AlsoInRow>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.post_id === null || row.plan_id === planId) continue;
    const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans;
    const key = `${row.post_id}:${row.plan_id}`;
    if (plan === undefined || plan === null || seen.has(key)) continue;
    seen.add(key);
    (out[row.post_id] ??= []).push(plan.title);
  }
  return out;
}

/** Options for the Plan screen read. */
export interface PlanScreenReadOptions {
  /** The workspace zone (post days, the list order). */
  timeZone?: string;
  /** One batched name read (readProfiles) for the approvers. */
  readNames?: (userIds: string[], signal?: AbortSignal) => Promise<Result<NameRow[]>>;
  /** The approver ids to name (approverIds of the bundle). */
  approvers?: (bundle: PlanBundle) => string[];
  /** Opened from a chat: its channel id (the bundle read carries the plan's last send there). */
  sentInChannelId?: string | undefined;
  /** The plan's workspace; the shell's active workspace when absent. */
  workspaceId?: string | undefined;
}

/** The latest of the plan's and its items' updated_at; null when none is known. Pure. */
export function planLastChangedAt(bundle: PlanBundle): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  const stamps = [bundle.plan.updated_at, ...bundle.items.map((i) => i.updated_at)];
  for (const stamp of stamps) {
    if (stamp === undefined) continue;
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    best = stamp;
    bestMs = ms;
  }
  return best;
}

/**
 * Read the Plan screen: ONE plan_bundle_read by id (the plan, its items,
 * reviews, posts, comment counts, tiles, the Also in titles and, opened from
 * a chat, the plan's last send there), then the approvers' names (from the
 * members already read; only the missing ones are a request). The workspace
 * is opts.workspaceId, else the shell's; without either the read fails.
 * Never throws.
 */
export async function readPlanScreen(
  client: Client,
  planId: string,
  signal?: AbortSignal,
  opts: PlanScreenReadOptions = {},
): Promise<Result<PlanScreenData>> {
  try {
    const workspaceId = opts.workspaceId ?? getPrefetchContext()?.workspaceId;
    if (workspaceId === undefined) return fail('plan_bundle_read: no workspace');
    const channelId = opts.sentInChannelId;
    const read = await readPlanBundleRpc(
      client,
      {
        workspaceId,
        planIds: [planId],
        ...(channelId !== undefined ? { channelId } : {}),
      },
      signal,
    );
    if (!read.ok) return read;
    return await planScreenOfRead(read.data, planId, signal, opts);
  } catch (error) {
    return fail(String(error));
  }
}

/**
 * The Plan screen's data from its bundle read, plus the approvers' names (a
 * failed name read keeps the screen: the lines read "Member"). Never throws.
 */
export async function planScreenOfRead(
  read: PlanBundleRead,
  planId: string,
  signal: AbortSignal | undefined,
  opts: PlanScreenReadOptions = {},
): Promise<Result<PlanScreenData>> {
  const bundle = bundlesOfRead(read, opts.timeZone).get(planId) ?? null;
  if (bundle === null) return { ok: true, data: { bundle, commentCounts: {}, thumbs: {} } };
  const approvers = opts.approvers?.(bundle) ?? [];
  const readNames = opts.readNames;
  const names: Result<NameRow[]> =
    approvers.length > 0 && readNames !== undefined
      ? await readNames(approvers, signal)
      : { ok: true, data: [] };
  const nameMap: Record<string, string> = {};
  if (names.ok) for (const row of names.data) nameMap[row.userId] = row.displayName;
  const own = new Set(bundle.items.map((i) => i.id));
  const counts: Record<string, number> = {};
  for (const [id, n] of Object.entries(read.commentCounts)) if (own.has(id)) counts[id] = n;
  return {
    ok: true,
    data: {
      bundle,
      commentCounts: counts,
      thumbs: read.thumbs.posts,
      conceptThumbs: read.thumbs.concepts,
      names: nameMap,
      alsoIn: read.alsoIn,
      lastSentAt: read.lastSentAt,
      lastChangedAt: planLastChangedAt(bundle),
    },
  };
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

// ---------------------------------------------------------------------------
// The concept sheet: its files read (edit) and its fresh uploads
// ---------------------------------------------------------------------------

/**
 * A concept's files for the Edit concept sheet, capped at 5s: a slow read
 * resolves to a failure at the cap (the sheet then sends files as null).
 * `cancel` (the sheet closed, a Retry) aborts the request. Never throws.
 */
export function readConceptFiles(
  client: Client,
  itemId: string,
  cancel: AbortSignal,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<Result<string[]>> {
  return withReadTimeout((signal) => {
    const linked = new AbortController();
    const abort = (): void => linked.abort();
    if (cancel.aborted) linked.abort();
    signal.addEventListener('abort', abort, { once: true });
    cancel.addEventListener('abort', abort, { once: true });
    return readItemFiles(client, itemId, linked.signal).finally(() => {
      signal.removeEventListener('abort', abort);
      cancel.removeEventListener('abort', abort);
    });
  }, timeoutMs);
}

/** The Edit concept sheet's files section while the files are not known. */
export type ConceptFilesReadState = 'loading' | 'failed';

/** One files read per start or retry; the previous one is aborted. */
export interface ConceptFilesRead {
  start: () => void;
  stop: () => void;
}

/**
 * The files read behind the Edit concept sheet. start() (also Retry) aborts
 * any read in flight, reports 'loading' and runs `load`; a success goes to
 * onLoaded, anything else reports 'failed'. stop() aborts, after which nothing
 * is reported. Framework-free.
 */
export function createConceptFilesRead(deps: {
  load: (cancel: AbortSignal) => Promise<Result<string[]>>;
  onState: (state: ConceptFilesReadState) => void;
  onLoaded: (files: string[]) => void;
}): ConceptFilesRead {
  let current: AbortController | null = null;
  const stop = (): void => {
    current?.abort();
    current = null;
  };
  const start = (): void => {
    stop();
    const cancel = new AbortController();
    current = cancel;
    deps.onState('loading');
    void deps
      .load(cancel.signal)
      .catch((error: unknown) => fail<string[]>(String(error)))
      .then((result) => {
        if (cancel.signal.aborted) return;
        current = null;
        if (result.ok) deps.onLoaded(result.data);
        else deps.onState('failed');
      });
  };
  return { start, stop };
}

/** The toast when Save meets a failed upload. */
export const CONCEPT_UPLOAD_FAILED = "Couldn't upload. Try again.";

/** A fresh upload in the concept sheet, until it lands in the file list. */
export interface ConceptUpload {
  id: string;
  file: File;
  /** An object URL for an image's chip; null otherwise. */
  previewUrl: string | null;
  status: { state: 'uploading' } | { state: 'error'; message: string };
}

/**
 * Whether Save may go: 'wait' while any upload is in flight, 'refuse' while
 * any failed upload is neither retried nor removed, else 'go'. Pure.
 */
export function conceptSaveGate(uploads: readonly ConceptUpload[]): 'go' | 'wait' | 'refuse' {
  if (uploads.some((u) => u.status.state === 'uploading')) return 'wait';
  if (uploads.some((u) => u.status.state === 'error')) return 'refuse';
  return 'go';
}

/** The concept sheet's uploads. */
export interface ConceptUploads {
  /** Start one upload per file, all at once. */
  add: (files: readonly File[]) => void;
  /** Upload a failed file again. */
  retry: (id: string) => void;
  /** Drop one file (aborting it when in flight). */
  remove: (id: string) => void;
  /** Abort every upload and drop the list (the sheet closed). */
  abortAll: () => void;
}

let conceptUploadSeq = 0;

/**
 * Fresh uploads for a concept, through the comments' upload path (`upload`,
 * library origin) after the same precheck. Every file starts at once; a
 * finished one leaves the list and goes to onUploaded (the sheet's file list);
 * a failed one stays with its message until retried or removed. A dropped or
 * aborted upload reports nothing. Framework-free.
 */
export function createConceptUploads(deps: {
  upload: AttachmentUploader;
  precheck: (file: File) => Precheck;
  onChange: (uploads: readonly ConceptUpload[]) => void;
  onUploaded: (versionId: string, name: string) => void;
  preview?: (file: File) => string | null;
  revoke?: (url: string) => void;
}): ConceptUploads {
  let list: ConceptUpload[] = [];
  const inFlight = new Map<string, AbortController>();
  const publish = (next: ConceptUpload[]): void => {
    list = next;
    deps.onChange(list);
  };
  const setStatus = (id: string, status: ConceptUpload['status']): void =>
    publish(list.map((u) => (u.id === id ? { ...u, status } : u)));
  const release = (upload: ConceptUpload): void => {
    if (upload.previewUrl !== null) deps.revoke?.(upload.previewUrl);
  };

  const run = (upload: ConceptUpload): void => {
    const check = deps.precheck(upload.file);
    if (!check.ok) {
      setStatus(upload.id, { state: 'error', message: check.message });
      return;
    }
    const controller = new AbortController();
    inFlight.set(upload.id, controller);
    setStatus(upload.id, { state: 'uploading' });
    void deps
      .upload(upload.file, undefined, controller.signal)
      .catch(() => ({ ok: false as const, message: CONCEPT_UPLOAD_FAILED }))
      .then((outcome) => {
        if (inFlight.get(upload.id) !== controller || controller.signal.aborted) return;
        inFlight.delete(upload.id);
        if (!outcome.ok) {
          setStatus(upload.id, { state: 'error', message: outcome.message });
          return;
        }
        const done = list.find((u) => u.id === upload.id);
        if (done !== undefined) release(done);
        publish(list.filter((u) => u.id !== upload.id));
        deps.onUploaded(outcome.versionId, upload.file.name);
      });
  };

  return {
    add: (files) => {
      const added = files.map(
        (file): ConceptUpload => ({
          id: `concept-upload-${(conceptUploadSeq += 1)}`,
          file,
          previewUrl: deps.preview?.(file) ?? null,
          status: { state: 'uploading' },
        }),
      );
      if (added.length === 0) return;
      publish([...list, ...added]);
      for (const upload of added) run(upload);
    },
    retry: (id) => {
      const upload = list.find((u) => u.id === id);
      if (upload === undefined || upload.status.state !== 'error') return;
      run(upload);
    },
    remove: (id) => {
      inFlight.get(id)?.abort();
      inFlight.delete(id);
      const upload = list.find((u) => u.id === id);
      if (upload === undefined) return;
      release(upload);
      publish(list.filter((u) => u.id !== id));
    },
    abortAll: () => {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
      if (list.length === 0) return;
      for (const upload of list) release(upload);
      publish([]);
    },
  };
}

// ---------------------------------------------------------------------------
// A post's live plans (the delete confirm)
// ---------------------------------------------------------------------------

/** One live plan a post sits in. */
export interface PostPlanRef {
  planId: string;
  title: string;
}

interface PostPlanRow {
  plan_id: string;
  plans: { title: string } | Array<{ title: string }> | null;
}

/**
 * The live plans holding a post: ONE select of its live plan_items joined to
 * their live plans (title), capped at 5s. A plan listed twice counts once.
 * Never throws; a failure or the cap is a failed Result.
 */
export function readPostPlans(
  client: Client,
  postId: string,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<Result<PostPlanRef[]>> {
  return withReadTimeout(async (signal) => {
    try {
      const query = (client.from('plan_items') as unknown as PlanTable)
        .select('plan_id, plans!inner(title)')
        .eq('post_id', postId)
        .is('deleted_at', null)
        .is('plans.deleted_at', null);
      const res = (await abortable(query, signal)) as SelectResult;
      if (res.error !== null) return fail(`plan_items: ${res.error.message}`);
      const seen = new Set<string>();
      const out: PostPlanRef[] = [];
      for (const row of (res.data ?? []) as PostPlanRow[]) {
        const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans;
        if (plan === undefined || plan === null || seen.has(row.plan_id)) continue;
        seen.add(row.plan_id);
        out.push({ planId: row.plan_id, title: plan.title });
      }
      return { ok: true, data: out };
    } catch (error) {
      return fail(String(error));
    }
  }, timeoutMs);
}

/**
 * The delete confirm's plan line: none for no plan, "It's in <title> and will
 * leave that plan." for one, "It's in <title> and N other plans and will leave
 * them." for more. Pure.
 */
export function postPlansLine(plans: readonly PostPlanRef[]): string | null {
  const first = plans[0];
  if (first === undefined) return null;
  if (plans.length === 1) return `It's in ${first.title} and will leave that plan.`;
  const others = plans.length - 1;
  return `It's in ${first.title} and ${others} other ${others === 1 ? 'plan' : 'plans'} and will leave them.`;
}

// ---------------------------------------------------------------------------
// A slot write (the Plan screen's checkbox)
// ---------------------------------------------------------------------------

/**
 * One optimistic slot write: `apply` the new status at once, run the write,
 * and on failure `apply` the previous status back. Returns the write's
 * Result. Never throws (a thrown write is a failure, reverted).
 */
export async function runSlotWrite(input: {
  status: ReviewStatus;
  previous: ReviewStatus;
  apply: (status: ReviewStatus) => void;
  write: (status: ReviewStatus) => Promise<Result<unknown>>;
}): Promise<Result<unknown>> {
  input.apply(input.status);
  let result: Result<unknown>;
  try {
    result = await input.write(input.status);
  } catch (error) {
    result = fail(String(error));
  }
  if (!result.ok) input.apply(input.previous);
  return result;
}

// ---------------------------------------------------------------------------
// New plan: a day for every item, one-step create
// ---------------------------------------------------------------------------

/**
 * An item's day on the New plan screen: a civil day inside the plan, 'none'
 * (No date), or null (it needs a day: Create will not run).
 */
export type ComposeDay = string | 'none' | null;

/** The plan's dates. */
export interface ComposeRange {
  startsOn: string;
  endsOn: string;
}

export interface ComposeConcept {
  kind: 'concept';
  key: string;
  title: string;
  description: string;
  files: Array<{ versionId: string; name: string }>;
  day: ComposeDay;
}

export interface ComposePost {
  kind: 'post' | 'draft';
  /** The post id. */
  key: string;
  title: string;
  stage: string;
  /** The post's Pipeline day in the workspace zone; null when undated. */
  orig: string | null;
  day: ComposeDay;
  /** The day was picked by hand (a range change never refills it). */
  chosen: boolean;
}

export type ComposeItem = ComposeConcept | ComposePost;

/** Max concepts and max posts plan_create_with_items takes. */
export const COMPOSE_MAX_CONCEPTS = 50;
export const COMPOSE_MAX_POSTS = 50;

/** Longest plan the New plan screen allows: 5 weeks (end - start <= 34). */
export const COMPOSE_MAX_SPAN_DAYS = 34;

/** Whether a civil day is inside the plan (inclusive). Pure. */
export function inComposeRange(day: string | null, range: ComposeRange): boolean {
  return day !== null && day >= range.startsOn && day <= range.endsOn;
}

/**
 * A picked post's row: its Pipeline date (civil day in the zone) prefills the
 * day when inside the plan; undated is No date; dated outside needs a day. Pure.
 */
export function composePostItem(
  post: { id: string; title: string; stage: string; target_date?: string | null | undefined },
  kind: 'post' | 'draft',
  range: ComposeRange,
  timeZone: string,
): ComposePost {
  const orig = civilDayOf(post.target_date ?? null, timeZone);
  // A row without the column is never read as undated (No date would clear it).
  const known = post.target_date !== undefined;
  const day: ComposeDay = !known
    ? null
    : orig === null
      ? 'none'
      : inComposeRange(orig, range)
        ? orig
        : null;
  return { kind, key: post.id, title: post.title, stage: post.stage, orig, day, chosen: false };
}

/**
 * After the plan dates change: a day now outside goes back to needing one; a
 * post whose day was not picked by hand and whose Pipeline date is now inside
 * gets it. Pure.
 */
export function recheckComposeItems(
  items: readonly ComposeItem[],
  range: ComposeRange,
): ComposeItem[] {
  return items.map((item) => {
    let day = item.day;
    if (day !== null && day !== 'none' && !inComposeRange(day, range)) day = null;
    if (item.kind !== 'concept' && !item.chosen && inComposeRange(item.orig, range)) {
      day = item.orig;
    }
    return day === item.day ? item : { ...item, day };
  });
}

/** The items that still need a day, in screen order. Pure. */
export function composeNeedsDay(items: readonly ComposeItem[]): ComposeItem[] {
  return items.filter((i) => i.day === null);
}

/** Posts whose Pipeline date moves to a different day. Pure. */
export function composeMoves(items: readonly ComposeItem[]): number {
  return items.filter(
    (i) => i.kind !== 'concept' && i.day !== null && i.day !== 'none' && i.day !== i.orig,
  ).length;
}

/** Posts whose Pipeline date changes at all (a move, or a date cleared). Pure. */
export function composePipelineUpdates(items: readonly ComposeItem[]): number {
  return items.filter(
    (i) =>
      i.kind !== 'concept' &&
      i.day !== null &&
      (i.day === 'none' ? i.orig !== null : i.day !== i.orig),
  ).length;
}

/** The line under Create: what still needs a day, how many dates move, or Ready. Pure. */
export function composeSummary(items: readonly ComposeItem[]): string {
  const need = composeNeedsDay(items).length;
  if (need > 0) return `${need} ${need === 1 ? 'item needs' : 'items need'} a day`;
  const moves = composeMoves(items);
  if (moves > 0) return `${moves} due ${moves === 1 ? 'date' : 'dates'} will move to match`;
  return 'Ready';
}

/** The note under a row; warn is the orange "outside this plan" line. Pure. */
export function composeItemNote(item: ComposeItem): { text: string; warn: boolean } | null {
  if (item.kind === 'concept') return null;
  const fmt = formatCivilDayHeader;
  if (item.day === null) {
    return item.orig !== null
      ? { text: `Dated ${fmt(item.orig)}, outside this plan. Pick a day.`, warn: true }
      : null;
  }
  if (item.day === 'none') {
    return item.orig !== null
      ? { text: `Due date ${fmt(item.orig)} will be cleared.`, warn: false }
      : null;
  }
  if (item.day === item.orig) return null;
  return {
    text:
      item.orig !== null
        ? `Due date moves from ${fmt(item.orig)} to ${fmt(item.day)}.`
        : `Due date moves to ${fmt(item.day)}.`,
    warn: false,
  };
}

/** Create's refusal while items need a day: the heading and one line per item. Pure. */
export function composeNeedsDayError(
  items: readonly ComposeItem[],
): { heading: string; lines: string[] } | null {
  const need = composeNeedsDay(items);
  if (need.length === 0) return null;
  return {
    heading: `${need.length} ${need.length === 1 ? 'item needs' : 'items need'} a day before the plan can be created.`,
    lines: need.map((i) =>
      i.kind !== 'concept' && i.orig !== null
        ? `${i.title} is dated ${formatCivilDayHeader(i.orig)}, outside this plan`
        : i.title,
    ),
  };
}

/** Create's refusal when the plan has nothing in it. */
export const COMPOSE_EMPTY = 'Add at least one item to create a plan.';

/** Create's refusal past the proc's limits. */
export const COMPOSE_TOO_MANY = 'A plan can hold up to 50 concepts and 50 posts.';

/**
 * plan_create_with_items' args: concepts in screen order, posts once each
 * (first wins), a post's day or null (No date: clears its Pipeline date).
 * Call only when nothing needs a day. Pure.
 */
export function composeCreateArgs(input: {
  workspaceId: string;
  title: string;
  range: ComposeRange;
  items: readonly ComposeItem[];
  traceId: string;
}): PlanCreateWithItemsArgs {
  const dayOf = (day: ComposeDay): string | null => (day === null || day === 'none' ? null : day);
  const seen = new Set<string>();
  const posts: PlanCreateWithItemsArgs['p_posts'] = [];
  const concepts: PlanCreateWithItemsArgs['p_concepts'] = [];
  for (const item of input.items) {
    if (item.kind === 'concept') {
      concepts.push({
        title: item.title.trim(),
        description: item.description.trim(),
        attachment_version_ids: item.files.map((f) => f.versionId),
        target_date: dayOf(item.day),
      });
    } else if (!seen.has(item.key)) {
      seen.add(item.key);
      posts.push({ post_id: item.key, target_date: dayOf(item.day) });
    }
  }
  return {
    p_workspace_id: input.workspaceId,
    p_title: input.title.trim(),
    p_starts_on: input.range.startsOn,
    p_ends_on: input.range.endsOn,
    p_concepts: concepts,
    p_posts: posts,
    p_trace_id: input.traceId,
  };
}

/** The toast after Create: "Plan created with 4 items. 2 due dates updated." Pure. */
export function composeCreatedToast(items: number, updated: number): string {
  const head = `Plan created with ${items} ${items === 1 ? 'item' : 'items'}`;
  return updated > 0
    ? `${head}. ${updated} due ${updated === 1 ? 'date' : 'dates'} updated.`
    : `${head}.`;
}

/** The plan-dates sheet's check: end on or after start, at most 5 weeks. Pure. */
export function composeRangeProblem(range: ComposeRange): string | null {
  if (range.startsOn === '' || range.endsOn === '') {
    return 'The end date must be on or after the start date.';
  }
  const span = civilDaysBetween(range.startsOn, range.endsOn).length - 1;
  if (span < 0 || range.endsOn < range.startsOn) {
    return 'The end date must be on or after the start date.';
  }
  if (span > COMPOSE_MAX_SPAN_DAYS) return 'A plan can cover up to 5 weeks. Shorten the dates.';
  return null;
}

/** Words in a concept description (whitespace-separated). Pure. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The soft word guide for a concept description. */
export const CONCEPT_WORD_AIM = 50;

/** The counter under the description: "12 / 50 words", or past 50 the aim line. Pure. */
export function wordCounterLabel(text: string): { label: string; over: boolean } {
  const n = wordCount(text);
  return n > CONCEPT_WORD_AIM
    ? { label: `${n} words · aim for ${CONCEPT_WORD_AIM} so approvers read it all`, over: true }
    : { label: `${n} / ${CONCEPT_WORD_AIM} words`, over: false };
}

/**
 * Existing plan, header "+" then Pick a post: posts dated inside the plan or
 * undated go in now (no day sent); posts dated outside wait for a day. Pure.
 */
export function splitPickedByRange<
  T extends { id: string; target_date?: string | null | undefined },
>(posts: readonly T[], range: ComposeRange, timeZone: string): { now: string[]; outside: T[] } {
  const now: string[] = [];
  const outside: T[] = [];
  for (const post of posts) {
    const day = civilDayOf(post.target_date ?? null, timeZone);
    if (day === null || inComposeRange(day, range)) now.push(post.id);
    else outside.push(post);
  }
  return { now, outside };
}

/** The picked days of the outside posts grouped into one add per day (first-seen order). Pure. */
export function groupPostsByDay(
  choices: ReadonlyArray<{ postId: string; day: string }>,
): Array<{ day: string; postIds: string[] }> {
  const byDay = new Map<string, string[]>();
  for (const c of choices) {
    const list = byDay.get(c.day);
    if (list === undefined) byDay.set(c.day, [c.postId]);
    else if (!list.includes(c.postId)) list.push(c.postId);
  }
  return [...byDay].map(([day, postIds]) => ({ day, postIds }));
}

/** The note when a post dated outside the plan was skipped. Pure. */
export function skippedOutsideNote(title: string): string {
  return `${title} was not added: its date is outside this plan.`;
}
