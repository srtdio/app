// The Plan tab's one batched read. Desktop asks for a range (the month grid's
// whole weeks, or the week): the plans overlapping it, a one-row probe for any
// plan at all (the zero state), and the posts dated in it, all at once; then
// the plans' bundles through the batched plan reads (draft rows, items, then
// reviews and post stages, each a select by id list, chunked at 100), with
// every item's and loose post's tile read alongside the reviews (it needs only
// the items), so the tab waits three round trips, not four. The phone
// asks for no range: every plan, no posts. Plans and posts are list reads,
// paged at 1000 rows (range 0 to 999, then the next page while one is full),
// so the request count is fixed for any number of rows under a page. A post
// that is an item of a read plan is never a loose post. Approvers (onlyShared)
// read shared plans only (RLS returns no Draft to them anyway). Never throws.

import type { Client, Result } from '@srtdio/rpc';
import { abortable } from '@/lib/chat-reads';
import {
  PLAN_COLUMNS,
  readBundlesAlongside,
  readPlanThumbs,
  type PlanBundle,
  type PlanItemRow,
  type PlanQuery,
  type PlanRow,
  type PlanTable,
  type PlanThumbs,
  type SelectResult,
} from '@/lib/chat/plans';
import type { LoosePost } from '@/lib/plan-tab';
import { addCivilDays } from '@/lib/list-sort';
import { civilDayOf } from '@/lib/plan-week';

/** Rows per page of a list read (PostgREST's max rows). */
export const PLAN_TAB_PAGE = 1000;

/** What the Plan tab shows. */
export interface PlanTabData {
  /** Plans read (overlapping the range, or all), with their items, reviews and posts. */
  bundles: PlanBundle[];
  /** Dated posts in the range that are in no read plan (desktop only). */
  posts: LoosePost[];
  /** Item and post tiles (a failed tile read leaves these empty). */
  thumbs: PlanThumbs;
  /** Whether the workspace holds any plan the viewer can read (the zero state). */
  anyPlan: boolean;
}

export interface PlanTabReadInput {
  workspaceId: string;
  /** The visible days (inclusive); null reads every plan and no posts (the phone list). */
  range: { start: string; end: string } | null;
  timeZone: string;
  /** Approvers: shared plans only. */
  onlyShared: boolean;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** Every page of a list read: pages of PLAN_TAB_PAGE rows until one comes back short. */
async function readAllPages<T>(
  build: () => PlanQuery,
  label: string,
  signal: AbortSignal | undefined,
): Promise<Result<T[]>> {
  const rows: T[] = [];
  for (let from = 0; ; from += PLAN_TAB_PAGE) {
    const res = (await abortable(
      build().range(from, from + PLAN_TAB_PAGE - 1),
      signal,
    )) as SelectResult;
    if (res.error !== null) return fail(`${label}: ${res.error.message}`);
    const page = (res.data ?? []) as T[];
    rows.push(...page);
    if (page.length < PLAN_TAB_PAGE) return { ok: true, data: rows };
  }
}

function plansQuery(client: Client, input: PlanTabReadInput): PlanQuery {
  let query = (client.from('plans') as unknown as PlanTable)
    .select(PLAN_COLUMNS)
    .eq('workspace_id', input.workspaceId)
    .is('deleted_at', null);
  if (input.onlyShared) query = query.eq('audience', 'client');
  if (input.range !== null) {
    query = query.lte('starts_on', input.range.end).gte('ends_on', input.range.start);
  }
  return query.order('starts_on', { ascending: true }).order('id', { ascending: true });
}

/** Whether any plan exists for the viewer: one row at most. */
async function readAnyPlan(
  client: Client,
  input: PlanTabReadInput,
  signal: AbortSignal | undefined,
): Promise<Result<boolean>> {
  let query = (client.from('plans') as unknown as PlanTable)
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .is('deleted_at', null);
  if (input.onlyShared) query = query.eq('audience', 'client');
  const res = (await abortable(query.limit(1), signal)) as SelectResult;
  if (res.error !== null) return fail(`plans: ${res.error.message}`);
  return { ok: true, data: ((res.data ?? []) as unknown[]).length > 0 };
}

/**
 * The posts dated in the range, read a day wider on each side (any zone's
 * noon lands inside) and kept when their day in the workspace zone is in it.
 */
async function readDatedPosts(
  client: Client,
  input: PlanTabReadInput & { range: { start: string; end: string } },
  signal: AbortSignal | undefined,
): Promise<Result<LoosePost[]>> {
  const { start, end } = input.range;
  const rows = await readAllPages<LoosePost>(
    () =>
      (client.from('posts') as unknown as PlanTable)
        .select('id, title, stage, target_date')
        .eq('workspace_id', input.workspaceId)
        .is('deleted_at', null)
        .gte('target_date', `${addCivilDays(start, -1)}T00:00:00Z`)
        .lte('target_date', `${addCivilDays(end, 1)}T23:59:59Z`)
        .order('target_date', { ascending: true })
        .order('id', { ascending: true }),
    'posts',
    signal,
  );
  if (!rows.ok) return rows;
  return {
    ok: true,
    data: rows.data.filter((p) => {
      const day = civilDayOf(p.target_date, input.timeZone);
      return day !== null && day >= start && day <= end;
    }),
  };
}

/** The posts that are items of the read plans. Pure. */
export function plannedPostIds(bundles: readonly PlanBundle[]): Set<string> {
  return new Set(
    bundles.flatMap((b) => b.items.flatMap((i) => (i.post_id !== null ? [i.post_id] : []))),
  );
}

/**
 * The Plan tab's read (see the header): plans, the any-plan probe and the
 * dated posts together; then the items; then reviews, stages and tiles
 * together. Never throws.
 */
export async function readPlanTab(
  client: Client,
  input: PlanTabReadInput,
  signal?: AbortSignal,
): Promise<Result<PlanTabData>> {
  try {
    const range = input.range;
    const [plans, any, dated] = await Promise.all([
      readAllPages<PlanRow>(() => plansQuery(client, input), 'plans', signal),
      range !== null
        ? readAnyPlan(client, input, signal)
        : Promise.resolve<Result<boolean> | null>(null),
      range !== null
        ? readDatedPosts(client, { ...input, range }, signal)
        : Promise.resolve<Result<LoosePost[]>>({ ok: true, data: [] }),
    ]);
    if (!plans.ok) return plans;
    if (any !== null && !any.ok) return any;
    if (!dated.ok) return dated;
    // The tiles need only the items (and the loose posts, already in), so they
    // load alongside the reviews and post stages: one round trip less.
    const looseOf = (items: readonly PlanItemRow[]): LoosePost[] => {
      const planned = new Set(items.flatMap((i) => (i.post_id !== null ? [i.post_id] : [])));
      return dated.data.filter((p) => !planned.has(p.id));
    };
    const read = await readBundlesAlongside(client, plans.data, signal, input.timeZone, (items) =>
      readPlanThumbs(
        client,
        [
          ...items.flatMap((i) => (i.post_id !== null ? [i.post_id] : [])),
          ...looseOf(items).map((p) => p.id),
        ],
        items.flatMap((i) => (i.kind === 'concept' ? [i.id] : [])),
        signal,
      ),
    );
    if (!read.ok) return read;
    const bundles = plans.data.flatMap((p) => {
      const b = read.data.bundles.get(p.id);
      return b !== undefined ? [b] : [];
    });
    const planned = plannedPostIds(bundles);
    const posts = dated.data.filter((p) => !planned.has(p.id));
    const thumbs = read.data.alongside;
    return {
      ok: true,
      data: {
        bundles,
        posts,
        // A failed tile read keeps the tab (tiles show their fallbacks).
        thumbs: thumbs.ok ? thumbs.data : { posts: {}, concepts: {} },
        anyPlan: any !== null ? any.data || bundles.length > 0 : bundles.length > 0,
      },
    };
  } catch (error) {
    return fail(String(error));
  }
}
