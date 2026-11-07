// Pure rules behind the Plan tab (/plan): the week ranges (Monday first, civil
// days in the workspace zone), the calendar entries per day (still read by the
// Plan screens' tests), the post stage line, the list's chips, sections and
// card lines, the zero state copy, and the gates that keep drafts and Create
// from approvers. The laptop Month | Week calendar is retired (7 Nov 2026):
// both widths show the chips over the ListCard grid. No React, no reads, so
// every rule is unit-tested directly.

import { mark } from '@/lib/perf-marks';
import type { PlanBundle, PlanItemRow, PlanRow } from '@/lib/chat/plans';
import { planItemDayInZone } from '@/lib/chat/plans';
import {
  PLAN_DRAFT_LABEL,
  linkedPost,
  planProgress,
  withoutPairedPosts,
} from '@/components/chat/plan-card';
import type { LinkBundle } from '@/components/chat/plan-card';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { addCivilDays } from '@/lib/list-sort';
import { civilMondayOf, PLAN_WEEK_DAYS } from '@/lib/plan-week';
import { formatDayRange } from '@/lib/time';
import type { PrefetchContext } from '@/lib/prefetch-context';

// ---------------------------------------------------------------------------
// Copy (the approved lines only)
// ---------------------------------------------------------------------------

export const NEW_PLAN_LABEL = 'New plan';
export const TODAY_LABEL = 'Today';
const NO_POST_YET = 'No post yet';

/** A stage as a status line says it: the capitalised stage ("Review", never "In review"). Pure. */
export function stageStatusWord(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

// ---------------------------------------------------------------------------
// Colours: colour = which plan
// ---------------------------------------------------------------------------

/** A plan's colour token. */
export type PlanTone = 'accent' | 'good' | 'warn' | 'parked';

/** Plans in colour order: start date ascending, ties by id. Pure. */
export function plansInToneOrder<T extends Pick<PlanRow, 'id' | 'starts_on'>>(
  plans: readonly T[],
): T[] {
  return [...plans].sort(
    (a, b) => a.starts_on.localeCompare(b.starts_on) || a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Weeks and labels
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The Mon to Sun week holding `day`, as a plan range. Pure. */
export function weekRangeOf(day: string): { startsOn: string; endsOn: string } {
  const monday = civilMondayOf(day);
  return { startsOn: monday, endsOn: addCivilDays(monday, PLAN_WEEK_DAYS - 1) };
}

/** "October 2026". Pure. */
export function monthLabel(anchor: string): string {
  const [y, m] = anchor.split('-');
  return `${MONTH_NAMES[Number(m) - 1] ?? ''} ${Number(y)}`;
}

// ---------------------------------------------------------------------------
// Calendar entries
// ---------------------------------------------------------------------------

/** A dated post that is in no visible plan. */
export interface LoosePost {
  id: string;
  title: string;
  stage: string;
  /** posts.target_date (timestamptz), read in the workspace zone. */
  target_date: string | null;
}

/** One thing on a calendar day. */
export type CalendarEntry =
  | {
      kind: 'item';
      /** Unique per entry ("item:<id>"). */
      key: string;
      day: string;
      title: string;
      tone: PlanTone;
      bundle: PlanBundle;
      item: PlanItemRow;
    }
  | { kind: 'post'; key: string; day: string; title: string; post: LoosePost };

/**
 * Every entry by day: with no filter (All) every dated plan item and every
 * loose post; with a plan id, only that plan's dated items. Plans come in
 * colour order, items in their plan's order, loose posts after them in read
 * order. `overrides` moves an entry (by key) to another day (an optimistic
 * move). `titleOf` names a plan item. Pure.
 */
export function calendarEntries(input: {
  bundles: readonly PlanBundle[];
  posts: readonly LoosePost[];
  tones: ReadonlyMap<string, PlanTone>;
  timeZone: string;
  filter: string | null;
  titleOf: (bundle: PlanBundle, item: PlanItemRow) => string;
  dayOfPost: (post: LoosePost) => string | null;
  overrides?: Readonly<Record<string, string>>;
}): Map<string, CalendarEntry[]> {
  const out = new Map<string, CalendarEntry[]>();
  const put = (entry: CalendarEntry): void => {
    const list = out.get(entry.day);
    if (list === undefined) out.set(entry.day, [entry]);
    else list.push(entry);
  };
  const moved = input.overrides ?? {};
  const plans = plansInToneOrder(input.bundles.map((b) => b.plan));
  const byId = new Map(input.bundles.map((b) => [b.plan.id, b]));
  for (const plan of plans) {
    if (input.filter !== null && plan.id !== input.filter) continue;
    const full = byId.get(plan.id);
    if (full === undefined) continue;
    // One chip per pair: the concept's (its post line reads the linked post).
    const bundle = withoutPairedPosts(full);
    for (const item of bundle.items) {
      const key = `item:${item.id}`;
      const day = moved[key] ?? planItemDayInZone(item, bundle.postInfo, input.timeZone);
      if (day === null) continue;
      put({
        kind: 'item',
        key,
        day,
        title: input.titleOf(bundle, item),
        tone: input.tones.get(plan.id) ?? 'accent',
        bundle,
        item,
      });
    }
  }
  if (input.filter === null) {
    for (const post of input.posts) {
      const key = `post:${post.id}`;
      const day = moved[key] ?? input.dayOfPost(post);
      if (day === null) continue;
      put({ kind: 'post', key, day, title: post.title, post });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

/** Creators (the agency side) create plans. Approvers and an unknown side never do. Pure. */
export function canCreatePlans(side: ViewerSide): boolean {
  return side === 'agency';
}

/** The plans a viewer may see: every plan for creators, shared plans only for anyone else. Pure. */
export function visibleBundles<T extends { plan: Pick<PlanRow, 'audience'> }>(
  bundles: readonly T[],
  side: ViewerSide,
): T[] {
  return side === 'agency' ? [...bundles] : bundles.filter((b) => b.plan.audience === 'client');
}

/** Whether a plan is a Draft (only the team sees it). Pure. */
export function isDraftPlan(plan: Pick<PlanRow, 'audience'>): boolean {
  return plan.audience === 'team';
}

// ---------------------------------------------------------------------------
// The post line
// ---------------------------------------------------------------------------

/**
 * The card's post line: "Post: <stage status word>" ("Post: Review",
 * "Post: Draft") for a post item (a draft row reads "Draft"), "No post yet"
 * for a concept or an unreadable post. Pure.
 */
export function postStageLine(bundle: LinkBundle, item: PlanItemRow): string {
  // A concept with a linked post reads that post's stage (agency side: the
  // calendar only shows what the viewer's read returned).
  const link = linkedPost(bundle, item, 'agency');
  if (link.kind === 'linked') return `Post: ${stageStatusWord(link.stage)}`;
  if (item.kind !== 'post') return NO_POST_YET;
  if (item.draft_row === true) return 'Post: Draft';
  const stage = item.post_id !== null ? bundle.postStages[item.post_id] : undefined;
  return stage !== undefined ? `Post: ${stageStatusWord(stage)}` : NO_POST_YET;
}

// ---------------------------------------------------------------------------
// The list (phone and laptop)
// ---------------------------------------------------------------------------

export type PlanSectionKey = 'this' | 'next' | 'later' | 'earlier';

export const PLAN_SECTION_LABELS: Readonly<Record<PlanSectionKey, string>> = {
  this: 'This week',
  next: 'Next week',
  later: 'Later',
  earlier: 'Past',
};

export const SECTION_ORDER: readonly PlanSectionKey[] = ['this', 'next', 'later', 'earlier'];

/**
 * The Plan tab's chip row, phone and laptop (the same line as Pipeline's stage
 * chips): Bank (the idea bank), Upcoming, Past (decision D, 7 Nov 2026). One
 * pick; Upcoming by default. Upcoming holds This week, Next week and Later
 * (each under its heading, in date order); Past holds the rest. A client sees
 * Bank only when their bank read holds an idea.
 */
export type PlanWeekChip = 'bank' | 'upcoming' | 'past';
export const PLAN_WEEK_CHIPS: readonly PlanWeekChip[] = ['bank', 'upcoming', 'past'];
/** The idea bank's chip id and label. */
export const PLAN_BANK_CHIP = 'bank' satisfies PlanWeekChip;
export const PLAN_BANK_CHIP_LABEL = 'Bank';
export const PLAN_WEEK_CHIP_DEFAULT: PlanWeekChip = 'upcoming';
/** The chip's URL param (?week=), so Back lands on the same chip. */
export const PLAN_WEEK_PARAM = 'week';
/** The chips a viewer sees: Bank only for a creator or a client whose bank holds an idea. Pure. */
export function visiblePlanChips(showBank: boolean): PlanWeekChip[] {
  return PLAN_WEEK_CHIPS.filter((c) => c !== PLAN_BANK_CHIP || showBank);
}

const PLAN_WEEK_CHIP_LABELS: Readonly<Record<PlanWeekChip, string>> = {
  bank: PLAN_BANK_CHIP_LABEL,
  upcoming: 'Upcoming',
  past: 'Past',
};

/** A chip's label. Pure. */
export function planWeekChipLabel(chip: PlanWeekChip): string {
  return PLAN_WEEK_CHIP_LABELS[chip];
}

/**
 * A URL or kept value as a chip, or null when it names none. The retired
 * chips still land: this, next, later and all on Upcoming, earlier on Past.
 * Pure.
 */
export function parsePlanWeekChip(value: string | null): PlanWeekChip | null {
  switch (value) {
    case 'bank':
      return 'bank';
    case 'upcoming':
    case 'this':
    case 'next':
    case 'later':
    case 'all':
      return 'upcoming';
    case 'past':
    case 'earlier':
      return 'past';
    default:
      return null;
  }
}

/** Whether a list section belongs under a chip: Upcoming holds This week, Next week and Later; Past the rest. Pure. */
export function planChipHolds(chip: PlanWeekChip, section: PlanSectionKey): boolean {
  if (chip === 'upcoming') return section !== 'earlier';
  if (chip === 'past') return section === 'earlier';
  return false;
}

/** The zero line under a picked chip with no plans in it (as Pipeline's "Posts show up here."). */
export const PLAN_WEEK_CHIP_ZERO = 'Plans show up here.';

/**
 * A plan's section from `today` (Mon to Sun weeks, workspace zone): overlapping
 * this week, else overlapping next week, else starting after next week
 * (Later), else Past. Pure.
 */
export function planSectionOf(
  plan: Pick<PlanRow, 'starts_on' | 'ends_on'>,
  today: string,
): PlanSectionKey {
  const thisWeek = weekRangeOf(today);
  const nextWeek = weekRangeOf(addCivilDays(thisWeek.startsOn, PLAN_WEEK_DAYS));
  const overlaps = (w: { startsOn: string; endsOn: string }): boolean =>
    plan.starts_on <= w.endsOn && plan.ends_on >= w.startsOn;
  if (overlaps(thisWeek)) return 'this';
  if (overlaps(nextWeek)) return 'next';
  if (plan.starts_on > nextWeek.endsOn) return 'later';
  return 'earlier';
}

/**
 * The list's sections in order (This week, Next week, Later, Past),
 * empty ones left out; within one, start date ascending (Past: the most
 * recent first). Ties by id. Pure.
 */
export function planSections<T extends { plan: Pick<PlanRow, 'id' | 'starts_on' | 'ends_on'> }>(
  bundles: readonly T[],
  today: string,
): Array<{ key: PlanSectionKey; label: string; bundles: T[] }> {
  const groups = new Map<PlanSectionKey, T[]>();
  for (const b of bundles) {
    const key = planSectionOf(b.plan, today);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [b]);
    else list.push(b);
  }
  return SECTION_ORDER.flatMap((key) => {
    const list = groups.get(key);
    if (list === undefined) return [];
    const sorted = [...list].sort((a, b) => {
      const byStart = a.plan.starts_on.localeCompare(b.plan.starts_on);
      const byEnd = a.plan.ends_on.localeCompare(b.plan.ends_on);
      return key === 'earlier'
        ? -byEnd || -byStart || a.plan.id.localeCompare(b.plan.id)
        : byStart || a.plan.id.localeCompare(b.plan.id);
    });
    return [{ key, label: PLAN_SECTION_LABELS[key], bundles: sorted }];
  });
}

/**
 * A plan card's words (ui/ListCard, both widths): `count` closes line 2 after
 * the date range, "3 posts" ("1 post"; a pair counts once, its concept), and a
 * Draft adds "only your team sees this"; `tag` is line 3's one grey tag, a
 * shared plan's "N of M OK" (approvers' OKs) or "Draft". Pure.
 */
export function planCardMeta(
  bundle: PlanBundle,
):
  | { kind: 'shared'; tag: string; count: string; ok: number; total: number; percent: number }
  | { kind: 'draft'; tag: string; count: string; total: number } {
  // A pair counts once (its concept).
  const total = withoutPairedPosts(bundle).items.length;
  const posts = `${total} ${total === 1 ? 'post' : 'posts'}`;
  if (isDraftPlan(bundle.plan)) {
    return {
      kind: 'draft',
      tag: PLAN_DRAFT_LABEL,
      count: `${posts} · only your team sees this`,
      total,
    };
  }
  const ok = planProgress(bundle).approved;
  return {
    kind: 'shared',
    tag: `${ok} of ${total} OK`,
    count: posts,
    ok,
    total,
    percent: total > 0 ? Math.round((ok / total) * 100) : 0,
  };
}

/**
 * A plan card's line 2: its dates (lib/time formatDayRange, "2–8 Nov") then
 * the count, joined on one line that wraps to the card's two
 * ("2–8 Nov · 3 posts · only your team sees this"). Pure.
 */
export function planCardPreview(
  bundle: PlanBundle,
  timeZone: string | null | undefined,
  now: Date,
): string {
  const range = formatDayRange(bundle.plan.starts_on, bundle.plan.ends_on, timeZone, now);
  return `${range} · ${planCardMeta(bundle).count}`;
}

// ---------------------------------------------------------------------------
// Zero state
// ---------------------------------------------------------------------------

/**
 * The zero state: a creator "No plans yet" with Create plan, an approver "No
 * plans shared yet" with no button. Line 2 shows only until the person has
 * finished onboarding. Pure.
 */
export function zeroStateCopy(
  side: ViewerSide,
  onboarded: boolean,
): { title: string; line2: string | null; create: boolean } {
  const creator = canCreatePlans(side);
  const line2 = creator
    ? 'Plan the content together, week by week'
    : "Plans show up here once they're shared with you";
  return {
    title: creator ? 'No plans yet' : 'No plans shared yet',
    line2: onboarded ? null : line2,
    create: creator,
  };
}

/**
 * Whether the person has finished onboarding: the guide is off (done, or not
 * running) on the client. No guide state at all (no provider) reads as done.
 * Pure.
 */
export function onboardingFinished(guide: 'off' | 'intro' | 'step' | 'closing' | null): boolean {
  return guide === null || guide === 'off';
}

// ---------------------------------------------------------------------------
// Nav press
// ---------------------------------------------------------------------------

/**
 * Nav-press starter (src/lib/route-data.ts): the read the tab's first render
 * asks for (src/lib/plan-tab-shared.ts), so it runs while the chunk loads and
 * the tap lands, and the mount joins it. The read modules load lazily, so
 * this module stays free of reads for its pure importers. Paints nothing;
 * never throws.
 */
export async function prefetchPlanTabData(ctx: PrefetchContext): Promise<void> {
  try {
    mark('plan-tab:prefetch');
    const [shared, { supabase }] = await Promise.all([
      import('@/lib/plan-tab-shared'),
      import('@/lib/supabase'),
    ]);
    await shared.startPlanTabRead(supabase, ctx);
  } catch {
    // The tab's own read retries.
  }
}
