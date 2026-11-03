// The Plan tab's read: ONE plan_bundle_read in tab mode (src/lib/chat/plan-bundle.ts)
// returns the workspace zone, a page of plans (PLAN_BUNDLE_PAGE, newest
// starts_on first) with their items, draft rows, reviews, post rows and tiles,
// the posts dated in the range (a day wider each side), and the any-plan probe
// (the zero state). Every read is ONE call for ONE page, and the next page's
// cursor comes back with it (Load more passes it as `before`). The phone asks
// for no range: a page of every plan, no posts. The laptop asks for a range
// (the month grid's whole weeks, or the week): a page of the plans that
// overlap it and its dated posts; more than a page of plans overlapping it
// shows the same Load more at the end of the calendar. Nothing loops.
// The client keeps the zone handling (post days in the bundle's zone), the
// loose-post filter (a post that is an item of a read plan is never loose, and
// a dated post is kept when its day in the zone is in the range), the order
// (starts_on, then id) and mergeDraftRows. The read's comment counts are kept
// (PlanTabData.commentCounts and each bundle's commentCounts): no extra read. Approvers (onlyShared) read shared
// plans only. Never throws.

import { withTraceHeader, type Client, type Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import {
  PLAN_BUNDLE_CHUNK,
  readPlanBundleRpc,
  type PlanBundleCursor,
  type PlanBundleRead,
} from '@/lib/chat/plan-bundle';
import { bundlesOfRead, type PlanBundle, type PlanRow, type PlanThumbs } from '@/lib/chat/plans';
import type { LoosePost } from '@/lib/plan-tab';
import { civilDayOf } from '@/lib/plan-week';
import { serverSearchQuery, withAbort } from '@/lib/search/server-search';
import { safeTimeZone } from '@/lib/time';
import { generateTraceId } from '@/lib/trace';

/** What the Plan tab shows. */
export interface PlanTabData {
  /** Plans read (overlapping the range, or the pages so far), in starts_on then id order. */
  bundles: PlanBundle[];
  /** Dated posts in the range that are in no read plan (laptop only). */
  posts: LoosePost[];
  /** Item and post tiles. */
  thumbs: PlanThumbs;
  /**
   * Visible comments per item id, from the same read (also on each bundle as
   * PlanBundle.commentCounts, which is how the calendar gets them). Absent in
   * data built before the counts were kept.
   */
  commentCounts?: Record<string, number>;
  /** Whether the workspace holds any plan the viewer can read (the zero state). */
  anyPlan: boolean;
  /** The workspace zone, from the bundle (post days and the loose-post filter use it). */
  timeZone: string;
  /** The next page's cursor (Load more); null when every plan (of the range) is in. */
  nextCursor: PlanBundleCursor | null;
}

export interface PlanTabReadInput {
  workspaceId: string;
  /** The visible days (inclusive); null reads every plan and no posts (the phone list). */
  range: { start: string; end: string } | null;
  /** Approvers: shared plans only. */
  onlyShared: boolean;
  /** The page after this cursor (Load more). */
  before?: PlanBundleCursor | null;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** Bundles in the tab's order: starts_on, then id. Pure. */
function byStart(a: PlanBundle, b: PlanBundle): number {
  return (
    a.plan.starts_on.localeCompare(b.plan.starts_on) ||
    (a.plan.id < b.plan.id ? -1 : a.plan.id > b.plan.id ? 1 : 0)
  );
}

/** The posts that are items of these plans. Pure. */
function plannedPostIds(bundles: readonly PlanBundle[]): Set<string> {
  return new Set(
    bundles.flatMap((b) => b.items.flatMap((i) => (i.post_id !== null ? [i.post_id] : []))),
  );
}

/** Dated posts whose day in the zone is in the range and that no read plan holds. Pure. */
function loosePosts(
  posts: readonly LoosePost[],
  bundles: readonly PlanBundle[],
  range: { start: string; end: string } | null,
  timeZone: string,
): LoosePost[] {
  if (range === null) return [];
  const planned = plannedPostIds(bundles);
  const seen = new Set<string>();
  return posts.filter((p) => {
    if (planned.has(p.id) || seen.has(p.id)) return false;
    seen.add(p.id);
    const day = civilDayOf(p.target_date, timeZone);
    return day !== null && day >= range.start && day <= range.end;
  });
}

/**
 * One tab-mode answer as the tab's data: bundles in the bundle's zone, in
 * starts_on then id order; the loose posts of `range`. Pure.
 */
export function planTabDataOf(
  read: PlanBundleRead,
  range: { start: string; end: string } | null,
): PlanTabData {
  const timeZone = safeTimeZone(read.timezone);
  const bundles = [...bundlesOfRead(read, timeZone).values()].sort(byStart);
  return {
    bundles,
    posts: loosePosts(read.loosePosts, bundles, range, timeZone),
    thumbs: read.thumbs,
    commentCounts: read.commentCounts,
    anyPlan: read.anyPlan || bundles.length > 0,
    timeZone,
    nextCursor: read.nextCursor,
  };
}

/**
 * Append a later page to what is shown: plans already shown are kept (no
 * duplicates by id), the order stays starts_on then id, tiles are merged, the
 * loose posts are re-filtered against every plan, and the cursor is the later
 * page's. Pure.
 */
export function mergePlanTabPages(
  shown: PlanTabData,
  next: PlanTabData,
  range: { start: string; end: string } | null = null,
): PlanTabData {
  const have = new Set(shown.bundles.map((b) => b.plan.id));
  const bundles = [...shown.bundles, ...next.bundles.filter((b) => !have.has(b.plan.id))].sort(
    byStart,
  );
  const timeZone = next.timeZone;
  return {
    bundles,
    posts: loosePosts([...shown.posts, ...next.posts], bundles, range, timeZone),
    thumbs: {
      posts: { ...shown.thumbs.posts, ...next.thumbs.posts },
      concepts: { ...shown.thumbs.concepts, ...next.thumbs.concepts },
    },
    commentCounts: { ...shown.commentCounts, ...next.commentCounts },
    anyPlan: shown.anyPlan || next.anyPlan,
    timeZone,
    nextCursor: next.nextCursor,
  };
}

/**
 * The Plan tab's read (see the header): one call, one page (the page after
 * `before`, when given), with the next page's cursor. Never throws.
 */
export async function readPlanTab(
  client: Client,
  input: PlanTabReadInput,
  signal?: AbortSignal,
): Promise<Result<PlanTabData>> {
  try {
    const read = await readPlanBundleRpc(
      client,
      {
        workspaceId: input.workspaceId,
        range: input.range,
        onlyShared: input.onlyShared,
        before: input.before ?? null,
      },
      signal,
    );
    if (!read.ok) return read;
    return { ok: true, data: planTabDataOf(read.data, input.range) };
  } catch (error) {
    return fail(String(error));
  }
}

// ---------------------------------------------------------------------------
// Search (2+ characters, src/lib/search/server-search.ts): ONE plan_search
// call finds the matching plans and items, then ONE plan_bundle_read by id
// (p_plan_ids, the distinct plans, at most PLAN_BUNDLE_CHUNK) reads them, so a
// search is two round trips whatever it matches. Both carry the search's one
// uuid_v7 trace id as p_trace_id. Never kept in the session.
// ---------------------------------------------------------------------------

type PlanSearchFn = Database['public']['Functions']['plan_search'];

/** plan_search's named args: the query normalized, the trace explicit. Pure. */
export function planSearchArgs(input: {
  workspaceId: string;
  query: string;
  traceId: string;
}): PlanSearchFn['Args'] {
  return {
    p_workspace_id: input.workspaceId,
    p_query: serverSearchQuery(input.query),
    p_trace_id: input.traceId,
  };
}

/** What a Plan search shows: the matched plans, and per plan the items that matched. */
export interface PlanSearchData {
  /** The plans read by id, in plan_search's order (sortPlanBundles orders them). */
  bundles: PlanBundle[];
  thumbs: PlanThumbs;
  /** Matched item ids per plan id (empty when only the plan itself matched). */
  matchedItems: Record<string, string[]>;
  timeZone: string;
}

/**
 * The distinct plan ids of the rows, first seen first, and each plan's
 * matched item ids (no repeats; a row with no item is a plan match). Pure.
 */
export function planSearchMatches(
  rows: readonly { plan_id: string | null; item_id: string | null }[],
): {
  planIds: string[];
  matchedItems: Record<string, string[]>;
} {
  const planIds: string[] = [];
  const matchedItems: Record<string, string[]> = {};
  for (const row of rows) {
    const planId = row.plan_id;
    if (planId === null || planId === '') continue;
    let items = matchedItems[planId];
    if (items === undefined) {
      items = [];
      matchedItems[planId] = items;
      planIds.push(planId);
    }
    const itemId = row.item_id;
    if (itemId !== null && itemId !== '' && !items.includes(itemId)) items.push(itemId);
  }
  return { planIds, matchedItems };
}

/**
 * The Plan tab's search: plan_search, then the matched plans in ONE
 * plan_bundle_read by id. No match: no second call. `signal` aborts both (a
 * newer query). Never throws.
 */
export async function searchPlanTab(
  client: Client,
  input: { workspaceId: string; query: string },
  signal?: AbortSignal,
): Promise<Result<PlanSearchData>> {
  if (serverSearchQuery(input.query) === '') {
    return fail('plan_search: query under 2 characters');
  }
  try {
    const traceId = generateTraceId();
    const args = planSearchArgs({ ...input, traceId });
    const res = await withAbort(withTraceHeader(client.rpc('plan_search', args), traceId), signal);
    if (res.error !== null) return fail(`plan_search: ${res.error.message}`);
    const { planIds, matchedItems } = planSearchMatches(res.data ?? []);
    if (planIds.length === 0) {
      return {
        ok: true,
        data: { bundles: [], thumbs: { posts: {}, concepts: {} }, matchedItems, timeZone: 'UTC' },
      };
    }
    const read = await readPlanBundleRpc(
      client,
      { workspaceId: input.workspaceId, planIds: planIds.slice(0, PLAN_BUNDLE_CHUNK), traceId },
      signal,
    );
    if (!read.ok) return read;
    const timeZone = safeTimeZone(read.data.timezone);
    const byId = bundlesOfRead(read.data, timeZone);
    const bundles = planIds.flatMap((id) => {
      const bundle = byId.get(id);
      return bundle !== undefined ? [bundle] : [];
    });
    return { ok: true, data: { bundles, thumbs: read.data.thumbs, matchedItems, timeZone } };
  } catch (error) {
    return fail(String(error));
  }
}

// ---------------------------------------------------------------------------
// Sort (the phone plan list and the search results; never the laptop calendar).
// ---------------------------------------------------------------------------

export type PlanTabSort = 'newest' | 'oldest' | 'name';

/**
 * Oldest first is the list as it always read (sections, each in date order);
 * Newest first and Name order one flat list.
 */
export const PLAN_SORT_DEFAULT: PlanTabSort = 'oldest';

export const PLAN_SORT_OPTIONS: { value: PlanTabSort; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name' },
];

/** A stored value the menu no longer lists reads as the default. Pure. */
export function sanitizePlanSort(value: string): PlanTabSort {
  return value === 'newest' || value === 'oldest' || value === 'name' ? value : PLAN_SORT_DEFAULT;
}

/**
 * Plans in the sort's order: by starts_on (then ends_on, then id) newest or
 * oldest first, or by title (case-insensitive, then starts_on). Pure.
 */
export function sortPlanBundles<
  T extends { plan: Pick<PlanRow, 'id' | 'title' | 'starts_on' | 'ends_on'> },
>(bundles: readonly T[], sort: PlanTabSort): T[] {
  const byDate = (a: T, b: T): number =>
    a.plan.starts_on.localeCompare(b.plan.starts_on) ||
    a.plan.ends_on.localeCompare(b.plan.ends_on) ||
    (a.plan.id < b.plan.id ? -1 : a.plan.id > b.plan.id ? 1 : 0);
  return [...bundles].sort((a, b) => {
    if (sort === 'name') {
      return (
        a.plan.title.localeCompare(b.plan.title, undefined, { sensitivity: 'base' }) || byDate(a, b)
      );
    }
    return sort === 'newest' ? byDate(b, a) : byDate(a, b);
  });
}
