// plan_bundle_read: one RPC for everything a plan surface paints (the plans,
// their items, draft rows, reviews, post rows, comment counts, tiles, the Also
// in titles, the loose posts of a range, the any-plan probe and the last send
// into a chat). Two modes: by id (p_plan_ids, at most PLAN_BUNDLE_CHUNK ids)
// and the Plan tab (no ids: PLAN_BUNDLE_PAGE plans per page, newest starts_on
// first, next_cursor non-null when more remain). The parser is pure and
// shared by the chat cards (readPlanBundles), the Plan screen (readPlanScreen)
// and the Plan tab (readPlanTab); the call builds its args against the
// generated proc signature with an explicit p_trace_id, never callRpc (that
// injects _trace_id, which this proc does not take). Never throws.

import type { Client, DomainErrorCode, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable } from '@/lib/chat-reads';
import type {
  ConceptThumb,
  PlanDraftRow,
  PlanItemKind,
  PlanItemRow,
  PlanPostRow,
  PlanReviewRow,
  PlanRow,
  PlanThumbs,
  ReviewSide,
  ReviewStatus,
} from '@/lib/chat/plans';
import type { LoosePost } from '@/lib/plan-tab';
import { getCurrentTraceId } from '@/lib/trace';

type Functions = Database['public']['Functions'];
type PlanBundleReadArgs = Functions['plan_bundle_read']['Args'];

/** Plan ids one by-id call reads at most (the proc slices p_plan_ids[1:200]). */
export const PLAN_BUNDLE_CHUNK = 200;

/** Plans per Plan tab page (the proc's c_page). */
export const PLAN_BUNDLE_PAGE = 12;

/** Where the next Plan tab page starts: the last plan of this one. */
export interface PlanBundleCursor {
  startsOn: string;
  id: string;
}

/** One plan_bundle_read answer, parsed. */
export interface PlanBundleRead {
  /** The workspace zone (workspaces.timezone). */
  timezone: string;
  /** Plans in starts_on, id order. */
  plans: PlanRow[];
  items: PlanItemRow[];
  draftRows: PlanDraftRow[];
  /** Tab mode: the next page's cursor; null when this is the last page (always null by id). */
  nextCursor: PlanBundleCursor | null;
  reviews: PlanReviewRow[];
  posts: PlanPostRow[];
  /** Visible comments per item id. */
  commentCounts: Record<string, number>;
  thumbs: PlanThumbs;
  /** One plan by id: other plans' titles per post id; empty otherwise. */
  alsoIn: Record<string, string[]>;
  /** Tab mode with a range: the posts dated in it (a day wider each side). */
  loosePosts: LoosePost[];
  anyPlan: boolean;
  /** One plan by id with a channel: when its card was last sent there; else null. */
  lastSentAt: string | null;
}

/** What one call asks for. */
export interface PlanBundleQuery {
  workspaceId: string;
  /** By id (at most PLAN_BUNDLE_CHUNK); absent is tab mode. */
  planIds?: readonly string[];
  /** Tab mode: the visible days (inclusive). */
  range?: { start: string; end: string } | null;
  /** Tab mode: shared plans only (approvers). */
  onlyShared?: boolean;
  /** One plan by id: the chat whose last send is read. */
  channelId?: string;
  /** Tab mode: the page after this cursor. */
  before?: PlanBundleCursor | null;
  /** The action's trace id (uuid v7); defaults to the current one. */
  traceId?: string;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rows(value: unknown): Obj[] {
  return Array.isArray(value) ? value.filter(isObj) : [];
}

function parsePlan(row: Obj): PlanRow | null {
  const id = str(row.id);
  const workspaceId = str(row.workspace_id);
  const startsOn = str(row.starts_on);
  const endsOn = str(row.ends_on);
  const audience = row.audience === 'client' || row.audience === 'team' ? row.audience : null;
  if (id === null || workspaceId === null || startsOn === null || endsOn === null) return null;
  if (audience === null) return null;
  const plan: PlanRow = {
    id,
    workspace_id: workspaceId,
    title: str(row.title) ?? '',
    starts_on: startsOn,
    ends_on: endsOn,
    audience,
    created_by: str(row.created_by),
  };
  const updatedAt = str(row.updated_at);
  if (updatedAt !== null) plan.updated_at = updatedAt;
  return plan;
}

function parseItem(row: Obj): PlanItemRow | null {
  const id = str(row.id);
  const planId = str(row.plan_id);
  const kind: PlanItemKind | null = row.kind === 'concept' || row.kind === 'post' ? row.kind : null;
  if (id === null || planId === null || kind === null) return null;
  const item: PlanItemRow = {
    id,
    plan_id: planId,
    kind,
    position: num(row.position) ?? 0,
    title: str(row.title),
    description: str(row.description),
    post_id: str(row.post_id),
    created_at: str(row.created_at) ?? '',
    target_date: str(row.target_date),
  };
  const updatedAt = str(row.updated_at);
  if (updatedAt !== null) item.updated_at = updatedAt;
  return item;
}

function parseDraftRow(row: Obj): PlanDraftRow | null {
  const planId = str(row.plan_id);
  const itemId = str(row.item_id);
  if (planId === null || itemId === null) return null;
  return {
    plan_id: planId,
    item_id: itemId,
    item_position: num(row.item_position) ?? 0,
    post_number: num(row.post_number) ?? 0,
    title: str(row.title) ?? '',
    target_date: str(row.target_date),
  };
}

function parseReview(row: Obj): PlanReviewRow | null {
  const itemId = str(row.item_id);
  const side: ReviewSide | null = row.side === 'team' || row.side === 'client' ? row.side : null;
  const status: ReviewStatus | null =
    row.status === 'waiting' || row.status === 'approved' || row.status === 'changes'
      ? row.status
      : null;
  if (itemId === null || side === null || status === null) return null;
  return {
    item_id: itemId,
    side,
    status,
    reviewed_by: str(row.reviewed_by),
    reviewed_at: str(row.reviewed_at),
  };
}

function parsePost(row: Obj): PlanPostRow | null {
  const id = str(row.id);
  const stage = str(row.stage);
  if (id === null || stage === null) return null;
  return {
    id,
    stage,
    title: str(row.title),
    format: str(row.format),
    target_date: str(row.target_date),
  };
}

function parseLoose(row: Obj): LoosePost | null {
  const id = str(row.id);
  const stage = str(row.stage);
  if (id === null || stage === null) return null;
  return { id, title: str(row.title) ?? '', stage, target_date: str(row.target_date) };
}

function parseCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(value)) return out;
  for (const [id, n] of Object.entries(value)) {
    const count = num(n);
    if (count !== null) out[id] = count;
  }
  return out;
}

function parseThumbs(value: unknown): PlanThumbs {
  const posts: Record<string, string> = {};
  const concepts: Record<string, ConceptThumb> = {};
  if (!isObj(value)) return { posts, concepts };
  if (isObj(value.posts)) {
    for (const [id, version] of Object.entries(value.posts)) {
      if (typeof version === 'string') posts[id] = version;
    }
  }
  if (isObj(value.concepts)) {
    for (const [id, thumb] of Object.entries(value.concepts)) {
      if (!isObj(thumb)) continue;
      if (thumb.kind === 'image' && typeof thumb.versionId === 'string') {
        concepts[id] = { kind: 'image', versionId: thumb.versionId };
      } else if (thumb.kind === 'file') {
        concepts[id] = { kind: 'file' };
      }
    }
  }
  return { posts, concepts };
}

function parseAlsoIn(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isObj(value)) return out;
  for (const [postId, titles] of Object.entries(value)) {
    if (!Array.isArray(titles)) continue;
    const list = titles.filter((t): t is string => typeof t === 'string');
    if (list.length > 0) out[postId] = list;
  }
  return out;
}

function parseCursor(value: unknown): PlanBundleCursor | null {
  if (!isObj(value)) return null;
  const startsOn = str(value.starts_on);
  const id = str(value.id);
  return startsOn !== null && id !== null ? { startsOn, id } : null;
}

function keep<T>(list: Obj[], parse: (row: Obj) => T | null): T[] {
  const out: T[] = [];
  for (const row of list) {
    const parsed = parse(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * Parse one plan_bundle_read answer. Anything but an object with a timezone
 * fails; a malformed row is dropped; an absent list or map reads as empty.
 * Pure.
 */
export function parsePlanBundle(raw: unknown): Result<PlanBundleRead> {
  if (!isObj(raw)) return planBundleFail('plan_bundle_read: not an object');
  const timezone = str(raw.timezone);
  if (timezone === null) return planBundleFail('plan_bundle_read: no timezone');
  return {
    ok: true,
    data: {
      timezone,
      plans: keep(rows(raw.plans), parsePlan),
      items: keep(rows(raw.items), parseItem),
      draftRows: keep(rows(raw.draft_rows), parseDraftRow),
      nextCursor: parseCursor(raw.next_cursor),
      reviews: keep(rows(raw.reviews), parseReview),
      posts: keep(rows(raw.posts), parsePost),
      commentCounts: parseCounts(raw.comment_counts),
      thumbs: parseThumbs(raw.thumbs),
      alsoIn: parseAlsoIn(raw.also_in),
      loosePosts: keep(rows(raw.loose_posts), parseLoose),
      anyPlan: raw.any_plan === true,
      lastSentAt: str(raw.last_sent_at),
    },
  };
}

function planBundleFail<T>(message: string, code: DomainErrorCode = 'unknown'): Result<T> {
  return { ok: false, error: { code, message } };
}

/**
 * The proc's args for a query: absent parts are left out (the proc's
 * defaults), the trace id is explicit. By id, at most PLAN_BUNDLE_CHUNK ids
 * are sent. Pure.
 */
export function planBundleArgs(query: PlanBundleQuery, traceId: string): PlanBundleReadArgs {
  const range = query.range ?? null;
  const before = query.before ?? null;
  return {
    p_trace_id: traceId,
    p_workspace_id: query.workspaceId,
    ...(query.planIds !== undefined
      ? { p_plan_ids: [...new Set(query.planIds)].slice(0, PLAN_BUNDLE_CHUNK) }
      : {}),
    ...(range !== null ? { p_range_start: range.start, p_range_end: range.end } : {}),
    ...(query.onlyShared === true ? { p_only_shared: true } : {}),
    ...(query.channelId !== undefined ? { p_channel_id: query.channelId } : {}),
    ...(before !== null ? { p_before_starts_on: before.startsOn, p_before_id: before.id } : {}),
  };
}

/** One plan_bundle_read call, parsed. A raised workspace_member_only keeps its code. Never throws. */
export async function readPlanBundleRpc(
  client: Client,
  query: PlanBundleQuery,
  signal?: AbortSignal,
): Promise<Result<PlanBundleRead>> {
  try {
    const args = planBundleArgs(query, query.traceId ?? getCurrentTraceId());
    const res = (await abortable(client.rpc('plan_bundle_read', args), signal)) as {
      data: unknown;
      error: { message: string } | null;
    };
    if (res.error !== null) {
      const message = res.error.message;
      return planBundleFail(
        `plan_bundle_read: ${message}`,
        message === 'workspace_member_only' ? 'workspace_member_only' : 'unknown',
      );
    }
    return parsePlanBundle(res.data);
  } catch (error) {
    return planBundleFail(`plan_bundle_read: ${String(error)}`);
  }
}
