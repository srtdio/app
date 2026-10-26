// The Plan tab's read: ONE plan_bundle_read in tab mode (src/lib/chat/plan-bundle.ts)
// returns the workspace zone, a page of plans (PLAN_BUNDLE_PAGE, newest
// starts_on first) with their items, draft rows, reviews, post rows and tiles,
// the posts dated in the range (a day wider each side), and the any-plan probe
// (the zero state). The phone asks for no range: one page of every plan, no
// posts, and the next page's cursor (Load more). Desktop asks for a range (the
// month grid's whole weeks, or the week) and reads every page of it (one call
// unless more than a page of plans overlaps it), since a grid cannot page.
// The client keeps the zone handling (post days in the bundle's zone), the
// loose-post filter (a post that is an item of a read plan is never loose, and
// a dated post is kept when its day in the zone is in the range), the order
// (starts_on, then id) and mergeDraftRows. Approvers (onlyShared) read shared
// plans only. Never throws.

import type { Client, Result } from '@srtdio/rpc';
import {
  readPlanBundleRpc,
  type PlanBundleCursor,
  type PlanBundleRead,
} from '@/lib/chat/plan-bundle';
import { bundlesOfRead, type PlanBundle, type PlanThumbs } from '@/lib/chat/plans';
import type { LoosePost } from '@/lib/plan-tab';
import { civilDayOf } from '@/lib/plan-week';
import { safeTimeZone } from '@/lib/time';

/** Range pages one desktop read follows at most (12 plans each). */
export const PLAN_TAB_RANGE_PAGES = 20;

/** What the Plan tab shows. */
export interface PlanTabData {
  /** Plans read (overlapping the range, or the pages so far), in starts_on then id order. */
  bundles: PlanBundle[];
  /** Dated posts in the range that are in no read plan (desktop only). */
  posts: LoosePost[];
  /** Item and post tiles. */
  thumbs: PlanThumbs;
  /** Whether the workspace holds any plan the viewer can read (the zero state). */
  anyPlan: boolean;
  /** The workspace zone, from the bundle (post days and the loose-post filter use it). */
  timeZone: string;
  /** The phone list's next page (Load more); null when every plan is in, always null for a range. */
  nextCursor: PlanBundleCursor | null;
}

export interface PlanTabReadInput {
  workspaceId: string;
  /** The visible days (inclusive); null reads every plan, a page at a time, and no posts (the phone list). */
  range: { start: string; end: string } | null;
  /** Approvers: shared plans only. */
  onlyShared: boolean;
  /** The phone list: the page after this cursor (Load more). */
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
    anyPlan: shown.anyPlan || next.anyPlan,
    timeZone,
    nextCursor: next.nextCursor,
  };
}

/**
 * The Plan tab's read (see the header). The phone list: one call (the page
 * after `before`, when given). A range: one call per page until the cursor
 * runs out (at most PLAN_TAB_RANGE_PAGES). Never throws.
 */
export async function readPlanTab(
  client: Client,
  input: PlanTabReadInput,
  signal?: AbortSignal,
): Promise<Result<PlanTabData>> {
  try {
    const range = input.range;
    let before = input.before ?? null;
    let data: PlanTabData | null = null;
    for (let page = 0; page < PLAN_TAB_RANGE_PAGES; page += 1) {
      const read = await readPlanBundleRpc(
        client,
        {
          workspaceId: input.workspaceId,
          range,
          onlyShared: input.onlyShared,
          before,
        },
        signal,
      );
      if (!read.ok) return read;
      const next = planTabDataOf(read.data, range);
      data = data === null ? next : mergePlanTabPages(data, next, range);
      // The phone list pages on Load more; a range reads on while more overlap it.
      if (range === null || next.nextCursor === null) break;
      before = next.nextCursor;
    }
    if (data === null) return fail('plan_bundle_read: no page');
    return { ok: true, data: range !== null ? { ...data, nextCursor: null } : data };
  } catch (error) {
    return fail(String(error));
  }
}
