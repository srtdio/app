// Pure rules behind the Plan tab (/plan): the plan colour cycle, the month and
// week grids (Monday first, civil days in the workspace zone), the range
// labels, the calendar entries per day (plan items in their plan's colour,
// dated posts in no visible plan in neutral), the month cell cap, the
// empty-day menu's plans, the week card's Plan pill and Post line, the phone
// list's sections and card meta, the zero state copy, and the gates that keep
// drafts, Create, drag and the empty-day menu from approvers. No React, no
// reads, so every rule is unit-tested directly.

import { mark } from '@/lib/perf-marks';
import type { PlanBundle, PlanItemRow, PlanRow } from '@/lib/chat/plans';
import { planItemDayInZone } from '@/lib/chat/plans';
import { planProgress, reviewStatus, shownReviewSide } from '@/components/chat/plan-card';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { addCivilDays } from '@/lib/list-sort';
import { civilMondayOf, formatCivilDayHeader, PLAN_WEEK_DAYS } from '@/lib/plan-week';
import type { PrefetchContext } from '@/lib/prefetch-context';

// ---------------------------------------------------------------------------
// Copy (the approved lines only)
// ---------------------------------------------------------------------------

export const MONTH_LABEL = 'Month';
export const WEEK_LABEL = 'Week';
export const NEW_PLAN_LABEL = 'New plan';
export const NEW_PLAN_ROW_LABEL = '+ New plan';
export const TODAY_LABEL = 'Today';
export const ALL_LABEL = 'All';
export const PLAN_ITEM_LEGEND = "Plan item, in its plan's colour";
export const LOOSE_POST_LEGEND = 'Post not in a plan';
const NO_POST_YET = 'No post yet';

/** A stage as a status line says it: "In review", else the capitalised stage. Pure. */
export function stageStatusWord(stage: string): string {
  if (stage === 'review') return 'In review';
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

// ---------------------------------------------------------------------------
// Colours: colour = which plan
// ---------------------------------------------------------------------------

/** A plan's colour token. */
export type PlanTone = 'accent' | 'good' | 'warn' | 'parked';

/** The fixed cycle plans take, ordered by start date. */
const PLAN_TONE_CYCLE: readonly PlanTone[] = ['accent', 'good', 'warn', 'parked'];

/**
 * Each tone's classes: the item's soft background and the dot. stage-parked
 * has no soft token, so its soft is the codebase's color-mix over the token.
 */
export const PLAN_TONE_CLASSES: Readonly<Record<PlanTone, { soft: string; dot: string }>> = {
  accent: { soft: 'bg-accent-soft', dot: 'bg-accent' },
  good: { soft: 'bg-good-soft', dot: 'bg-good' },
  warn: { soft: 'bg-warn-soft', dot: 'bg-warn' },
  parked: {
    soft: 'bg-[color-mix(in_srgb,var(--stage-parked)_14%,transparent)]',
    dot: 'bg-stage-parked',
  },
};

/** A dated post in no visible plan: neutral background, square neutral dot. */
export const LOOSE_POST_CLASSES = { soft: 'bg-panel-2', dot: 'bg-fg-3' } as const;

/** Plans in colour order: start date ascending, ties by id. Pure. */
export function plansInToneOrder<T extends Pick<PlanRow, 'id' | 'starts_on'>>(
  plans: readonly T[],
): T[] {
  return [...plans].sort(
    (a, b) => a.starts_on.localeCompare(b.starts_on) || a.id.localeCompare(b.id),
  );
}

/** Each plan's tone: the cycle in start-date order (accent, good, warn, parked, repeat). Pure. */
export function planTones(
  plans: readonly Pick<PlanRow, 'id' | 'starts_on'>[],
): Map<string, PlanTone> {
  const out = new Map<string, PlanTone>();
  plansInToneOrder(plans).forEach((plan, i) => {
    out.set(plan.id, PLAN_TONE_CYCLE[i % PLAN_TONE_CYCLE.length] as PlanTone);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Views, grids and labels
// ---------------------------------------------------------------------------

export type PlanTabView = 'month' | 'week';

/** One cell of the month grid. */
interface MonthCell {
  day: string;
  /** Inside the shown month (out-of-month days are dimmed). */
  inMonth: boolean;
}

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

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The first day of the month holding `day` ("2026-10-01"). Pure. */
function monthStartOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** The last day of the month holding `day`. Pure. */
function monthEndOf(day: string): string {
  const [y, m] = day.split('-').map(Number);
  const next =
    m === 12 ? `${(y ?? 1970) + 1}-01-01` : `${y}-${String((m ?? 1) + 1).padStart(2, '0')}-01`;
  return addCivilDays(next, -1);
}

/**
 * The month grid: whole Monday-first weeks from the week holding the 1st to
 * the week holding the last day, each day marked in or out of the month. Pure.
 */
export function monthGrid(anchor: string): MonthCell[][] {
  const first = monthStartOf(anchor);
  const last = monthEndOf(anchor);
  const month = first.slice(0, 7);
  const weeks: MonthCell[][] = [];
  for (let monday = civilMondayOf(first); monday <= last; monday = addCivilDays(monday, 7)) {
    weeks.push(weekDays(monday).map((day) => ({ day, inMonth: day.slice(0, 7) === month })));
  }
  return weeks;
}

/** The seven days (Mon to Sun) of the week holding `anchor`. Pure. */
export function weekDays(anchor: string): string[] {
  const monday = civilMondayOf(anchor);
  return Array.from({ length: PLAN_WEEK_DAYS }, (_unused, i) => addCivilDays(monday, i));
}

/** The Mon to Sun week holding `day`, as a plan range. Pure. */
export function weekRangeOf(day: string): { startsOn: string; endsOn: string } {
  const monday = civilMondayOf(day);
  return { startsOn: monday, endsOn: addCivilDays(monday, PLAN_WEEK_DAYS - 1) };
}

/** The first and last day a view shows (the month view's whole weeks). Pure. */
export function visibleRange(view: PlanTabView, anchor: string): { start: string; end: string } {
  if (view === 'week') {
    const { startsOn, endsOn } = weekRangeOf(anchor);
    return { start: startsOn, end: endsOn };
  }
  const weeks = monthGrid(anchor);
  return {
    start: weeks[0]?.[0]?.day ?? anchor,
    end: weeks[weeks.length - 1]?.[PLAN_WEEK_DAYS - 1]?.day ?? anchor,
  };
}

/** Prev / next: a month view moves a month (to its 1st), a week view a week. Pure. */
export function shiftAnchor(view: PlanTabView, anchor: string, dir: 1 | -1): string {
  if (view === 'week') return addCivilDays(civilMondayOf(anchor), dir * PLAN_WEEK_DAYS);
  const first = monthStartOf(anchor);
  return dir === 1 ? addCivilDays(monthEndOf(first), 1) : monthStartOf(addCivilDays(first, -1));
}

/** "October 2026". Pure. */
export function monthLabel(anchor: string): string {
  const [y, m] = anchor.split('-');
  return `${MONTH_NAMES[Number(m) - 1] ?? ''} ${Number(y)}`;
}

function dayMonth(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(d)} ${MONTH_SHORT[Number(m) - 1] ?? ''}`;
}

/**
 * The week's range with a spaced hyphen: "19 - 25 Oct 2026" in one month,
 * "28 Sep - 4 Oct 2026" across two, "29 Dec 2025 - 4 Jan 2026" across years. Pure.
 */
export function weekRangeLabel(anchor: string): string {
  const { startsOn, endsOn } = weekRangeOf(anchor);
  const endYear = Number(endsOn.slice(0, 4));
  if (startsOn.slice(0, 4) !== endsOn.slice(0, 4)) {
    return `${dayMonth(startsOn)} ${Number(startsOn.slice(0, 4))} - ${dayMonth(endsOn)} ${endYear}`;
  }
  if (startsOn.slice(0, 7) !== endsOn.slice(0, 7)) {
    return `${dayMonth(startsOn)} - ${dayMonth(endsOn)} ${endYear}`;
  }
  return `${Number(startsOn.slice(8, 10))} - ${dayMonth(endsOn)} ${endYear}`;
}

/** The toolbar's label for a view. Pure. */
export function rangeLabel(view: PlanTabView, anchor: string): string {
  return view === 'month' ? monthLabel(anchor) : weekRangeLabel(anchor);
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
    const bundle = byId.get(plan.id);
    if (bundle === undefined) continue;
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

/** Items a month cell shows before "+N more". */
const MONTH_CELL_CAP = 3;

/** A month cell's entries: the first `cap`, and how many more. Pure. */
export function capEntries<T>(
  entries: readonly T[],
  cap: number = MONTH_CELL_CAP,
): { shown: T[]; more: number } {
  return { shown: entries.slice(0, cap), more: Math.max(0, entries.length - cap) };
}

// A laptop month cell's measured lines: 22px item lines 2px apart under a 28px
// number row in 12px of padding; "+N more" takes one line (and its gap) when
// not all fit.
const MONTH_LINE_PX = 22;
const MONTH_LINE_GAP_PX = 2;
const MONTH_CELL_PAD_PX = 12;
const MONTH_NUMBER_ROW_PX = 28;
const MONTH_MORE_PX = MONTH_LINE_PX + MONTH_LINE_GAP_PX;

/**
 * How many entries a month cell of `rowHeight` px shows: all `count` when they
 * fit, else as many as fit above the "+N more" line (never below 0). Pure.
 */
export function monthCellCap(input: { rowHeight: number; count: number }): number {
  const step = MONTH_LINE_PX + MONTH_LINE_GAP_PX;
  const avail = input.rowHeight - MONTH_CELL_PAD_PX - MONTH_NUMBER_ROW_PX;
  if (input.count * step <= avail) return input.count;
  return Math.max(0, Math.floor((avail - MONTH_MORE_PX) / step));
}

/** "+2 more". Pure. */
export function moreLabel(count: number): string {
  return `+${count} more`;
}

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

/** Creators (the agency side) create plans. Approvers and an unknown side never do. Pure. */
export function canCreatePlans(side: ViewerSide): boolean {
  return side === 'agency';
}

/** Only creators drag entries to another day (the move procs refuse anyone else). Pure. */
export function canDragEntries(side: ViewerSide): boolean {
  return side === 'agency';
}

/** Only creators get the empty-day menu. Pure. */
export function canOpenDayMenu(side: ViewerSide): boolean {
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
// The empty-day menu and drag
// ---------------------------------------------------------------------------

/** "Add on Thu 22 Oct to". Pure. */
export function addOnLabel(day: string): string {
  return `Add on ${formatCivilDayHeader(day)} to`;
}

/** Whether a plan's dates (inclusive) hold `day`. Pure. */
function planCovers(plan: Pick<PlanRow, 'starts_on' | 'ends_on'>, day: string): boolean {
  return day >= plan.starts_on && day <= plan.ends_on;
}

/** The plans whose dates hold `day`, in colour order. Pure. */
export function plansCovering<T extends { plan: Pick<PlanRow, 'id' | 'starts_on' | 'ends_on'> }>(
  bundles: readonly T[],
  day: string,
): T[] {
  return [...bundles]
    .filter((b) => planCovers(b.plan, day))
    .sort(
      (a, b) =>
        a.plan.starts_on.localeCompare(b.plan.starts_on) || a.plan.id.localeCompare(b.plan.id),
    );
}

/**
 * Whether an entry may drop on `day`: another day, and for a plan item a day
 * inside its plan (the move proc refuses any other). Pure.
 */
export function canDropOn(entry: CalendarEntry, day: string): boolean {
  if (day === entry.day) return false;
  return entry.kind === 'post' || planCovers(entry.bundle.plan, day);
}

// ---------------------------------------------------------------------------
// The week card
// ---------------------------------------------------------------------------

/** The Plan pill's copy. */
const PLAN_OK_PILL = 'Plan OK';
const PLAN_NOT_OK_PILL = 'Plan Not OK';
const PLAN_UNDECIDED_PILL = 'Plan: not decided';

/**
 * The card's Plan pill: the item's review on the side the plan shows (the
 * client side on a shared plan, the team side on a Draft, as the Plan screen
 * reads it): solid good "Plan OK", solid bad "Plan Not OK", else neutral. Pure.
 */
export function planPill(
  bundle: PlanBundle,
  item: PlanItemRow,
): { label: string; tone: 'good' | 'bad' | 'neutral' } {
  const status = reviewStatus(bundle, item.id, shownReviewSide(bundle.plan.audience));
  if (status === 'approved') return { label: PLAN_OK_PILL, tone: 'good' };
  if (status === 'changes') return { label: PLAN_NOT_OK_PILL, tone: 'bad' };
  return { label: PLAN_UNDECIDED_PILL, tone: 'neutral' };
}

/**
 * The card's post line: "Post: <stage status word>" ("Post: In review",
 * "Post: Draft") for a post item (a draft row reads "Draft"), "No post yet"
 * for a concept or an unreadable post. Pure.
 */
export function postStageLine(bundle: Pick<PlanBundle, 'postStages'>, item: PlanItemRow): string {
  if (item.kind !== 'post') return NO_POST_YET;
  if (item.draft_row === true) return 'Post: Draft';
  const stage = item.post_id !== null ? bundle.postStages[item.post_id] : undefined;
  return stage !== undefined ? `Post: ${stageStatusWord(stage)}` : NO_POST_YET;
}

// ---------------------------------------------------------------------------
// The phone list
// ---------------------------------------------------------------------------

type PlanSectionKey = 'this' | 'next' | 'later' | 'earlier';

const PLAN_SECTION_LABELS: Readonly<Record<PlanSectionKey, string>> = {
  this: 'This week',
  next: 'Next week',
  later: 'Later',
  earlier: 'Earlier',
};

const SECTION_ORDER: readonly PlanSectionKey[] = ['this', 'next', 'later', 'earlier'];

/**
 * A plan's section from `today` (Mon to Sun weeks, workspace zone): overlapping
 * this week, else overlapping next week, else starting after next week
 * (Later), else Earlier. Pure.
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
 * The phone list's sections in order (This week, Next week, Later, Earlier),
 * empty ones left out; within one, start date ascending (Earlier: the most
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
 * The phone card's progress: a shared plan "N of M OK" (approvers' OKs) with
 * its bar; a Draft "N items · only your team sees this" ("1 item" for one),
 * no bar. Pure.
 */
export function planCardMeta(
  bundle: PlanBundle,
):
  | { kind: 'shared'; label: string; ok: number; total: number; percent: number }
  | { kind: 'draft'; label: string } {
  const total = bundle.items.length;
  if (isDraftPlan(bundle.plan)) {
    return {
      kind: 'draft',
      label: `${total} ${total === 1 ? 'item' : 'items'} · only your team sees this`,
    };
  }
  const ok = planProgress(bundle).approved;
  return {
    kind: 'shared',
    label: `${ok} of ${total} OK`,
    ok,
    total,
    percent: total > 0 ? Math.round((ok / total) * 100) : 0,
  };
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
    const [shared, { supabase }, { isLaptopNow }] = await Promise.all([
      import('@/lib/plan-tab-shared'),
      import('@/lib/supabase'),
      import('@/lib/use-is-laptop'),
    ]);
    await shared.startPlanTabRead(supabase, ctx, isLaptopNow());
  } catch {
    // The tab's own read retries.
  }
}
