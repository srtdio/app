// The chat status ticker's pure pieces: which items the bar shows and how each
// reads (fixed order, zero items omitted, 99+ cap, plural words, side wording,
// plan colour), the current shared plans filter and order (audience 'client',
// starts_on <= today <= ends_on in the workspace zone, ending soonest first),
// one bar item per plan for at most two plans then "+K", compact mode's plan
// title word drop, the empty and failed-read rules, the first-paint gate and
// the drawer's per-section rows. No React and no reads, so every rule is
// unit-tested directly.

import { NOTHING_OPEN, type MarkCounts, type ChatMark, type MarkType } from '@/lib/chat/marks';
import type { PlanBundle } from '@/lib/chat/plans';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { formatDate } from '@/lib/time';

/** The bar's items and the drawer's sections, in their one fixed order. */
export type StatusKey = 'plan' | 'posts' | 'briefs' | 'commitments' | 'decisions' | 'pending';

export const STATUS_ORDER: readonly StatusKey[] = [
  'plan',
  'posts',
  'briefs',
  'commitments',
  'decisions',
  'pending',
];

/** The bar's line when every read succeeded and nothing is open. */
export const NOTHING_OPEN_LINE = NOTHING_OPEN;

/** Rows a drawer section lists before its "See all N" row. */
export const SECTION_ROWS = 5;

/** The cap a bar count shows above (the drawer keeps the real number). */
const BAR_CAP = 99;

/** A count as the bar shows it: "99+" over the cap. Pure. */
export function capCount(n: number): string {
  return n > BAR_CAP ? `${BAR_CAP}+` : String(Math.max(0, n));
}

/** What the bar reads of one current shared plan. */
export interface PlanSummary {
  id: string;
  title: string;
  /** Items the client approved. */
  approved: number;
  /** Every item. */
  total: number;
  /** Items the client asked changes on. */
  changes: number;
}

/** Plan items the bar shows before its "+K" (the rest are in the drawer). */
export const BAR_PLANS = 2;

/**
 * One settled round of every read the bar counts. `null` is a read that
 * failed (its item is omitted and the bar never says nothing is open).
 */
export interface StatusInput {
  /** The current shared plans, ending soonest first ([] when none). */
  plans: readonly PlanSummary[] | null;
  /** Posts in review (the head-only count). */
  posts: number | null;
  /** Open briefs (the head-only count). */
  briefs: number | null;
  /** Open marks of this channel. */
  marks: MarkCounts | null;
  side: ViewerSide;
}

export type StatusTone = 'default' | 'warn' | 'good';

/** One bar item. */
export interface StatusItem {
  key: StatusKey;
  /** Unique on the bar: the key, or "plan:{id}" for a plan item. */
  id: string;
  /** Kept in compact mode: "Plan" for a lone plan, else the plan's title. */
  lead: string | null;
  /** Compact mode may drop the lead's trailing words (a plan title). */
  trim: boolean;
  /** The number as shown ("3", "99+", "2/5"). */
  number: string;
  /** Dropped in compact mode: "in review", "briefs". */
  word: string | null;
  /** The last plan item's "+K" (current shared plans past it); 0 for none. Hidden in compact mode. */
  more: number;
  tone: StatusTone;
  /** The real count (the plan's open items for its section). */
  count: number;
  /** The screen reader name. */
  aria: string;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The posts word per side: agency and unknown read "in review", a client "waiting". Pure. */
export function postsWord(side: ViewerSide): string {
  return side === 'client' ? 'waiting' : 'in review';
}

/** The plan number's colour: warn when any change is asked, good when all approved. Pure. */
export function planTone(plan: Pick<PlanSummary, 'approved' | 'total' | 'changes'>): StatusTone {
  if (plan.changes > 0) return 'warn';
  if (plan.total > 0 && plan.approved === plan.total) return 'good';
  return 'default';
}

function countItem(
  key: Exclude<StatusKey, 'plan'>,
  count: number,
  word: string,
  tone: StatusTone = 'default',
): StatusItem {
  return {
    key,
    id: key,
    lead: null,
    trim: false,
    number: capCount(count),
    word,
    more: 0,
    tone,
    count,
    aria: `${count} ${word}`,
  };
}

/**
 * One plan's bar item: "Plan" leads a lone plan, the plan's title leads each
 * of two or more; "A/N" either way. `more` is the "+K" it carries. Pure.
 */
function planItem(plan: PlanSummary, lone: boolean, more: number): StatusItem {
  const lead = lone ? 'Plan' : plan.title;
  return {
    key: 'plan',
    id: `plan:${plan.id}`,
    lead,
    trim: !lone,
    number: `${capCount(plan.approved)}/${capCount(plan.total)}`,
    word: null,
    more: Math.max(0, more),
    tone: planTone(plan),
    count: plan.total,
    aria: `${lead} ${plan.approved} of ${plan.total} approved`,
  };
}

/**
 * The bar's items in the fixed order; zero and failed ones are left out. The
 * plans come first: one item per plan for the first {@link BAR_PLANS}, the
 * last of them carrying "+K" for the rest. Pure.
 */
export function statusItems(input: StatusInput): StatusItem[] {
  const items: StatusItem[] = [];
  const plans = input.plans ?? [];
  const shown = plans.slice(0, BAR_PLANS);
  shown.forEach((plan, i) => {
    const last = i === shown.length - 1;
    items.push(planItem(plan, plans.length === 1, last ? plans.length - shown.length : 0));
  });
  if (input.posts !== null && input.posts > 0) {
    items.push(countItem('posts', input.posts, postsWord(input.side)));
  }
  if (input.briefs !== null && input.briefs > 0) {
    items.push(countItem('briefs', input.briefs, plural(input.briefs, 'brief', 'briefs')));
  }
  const marks = input.marks;
  if (marks !== null) {
    if (marks.commitments > 0) {
      items.push(
        countItem(
          'commitments',
          marks.commitments,
          plural(marks.commitments, 'commitment', 'commitments'),
        ),
      );
    }
    if (marks.decisions > 0) {
      items.push(
        countItem('decisions', marks.decisions, plural(marks.decisions, 'decision', 'decisions')),
      );
    }
    if (marks.pending > 0) {
      items.push(countItem('pending', marks.pending, 'pending', marks.p1 > 0 ? 'warn' : 'default'));
    }
  }
  return items;
}

/** Whether any read of the round failed. Pure. */
export function anyReadFailed(input: StatusInput): boolean {
  return (
    input.plans === null || input.posts === null || input.briefs === null || input.marks === null
  );
}

/**
 * What the bar paints: its items; "Open posts and marks show up here." only when every
 * read succeeded with zero; else a blank inert bar (something failed and
 * nothing else is open, so it never claims nothing is). Pure.
 */
export type StatusBar =
  | { kind: 'items'; items: StatusItem[] }
  | { kind: 'empty' }
  | { kind: 'blank' };

export function statusBar(input: StatusInput): StatusBar {
  const items = statusItems(input);
  if (items.length > 0) return { kind: 'items', items };
  return anyReadFailed(input) ? { kind: 'blank' } : { kind: 'empty' };
}

/**
 * The first-paint gate: the 36px slot stays empty and inert until the posts,
 * side, marks, plans and briefs reads have all settled (ok or failed). Pure.
 */
export function statusReady(input: {
  posts: boolean;
  side: boolean;
  marks: boolean;
  plans: boolean;
  briefs: boolean;
}): boolean {
  return input.posts && input.side && input.marks && input.plans && input.briefs;
}

/**
 * Plans still open on `today` ("YYYY-MM-DD" in the workspace zone): ends_on on
 * or after today, ending soonest first (ties by start, title, id). Deleted
 * plans never reach here (RLS hides them). Pure.
 */
export function openPlans(bundles: Iterable<PlanBundle>, today: string): PlanBundle[] {
  return [...bundles]
    .filter((b) => b.plan.ends_on.slice(0, 10) >= today)
    .sort(
      (a, b) =>
        a.plan.ends_on.localeCompare(b.plan.ends_on) ||
        a.plan.starts_on.localeCompare(b.plan.starts_on) ||
        a.plan.title.localeCompare(b.plan.title) ||
        a.plan.id.localeCompare(b.plan.id),
    );
}

/**
 * The bar's plans: shared ones (audience 'client'; a draft never shows) whose
 * range holds `today` ("YYYY-MM-DD" in the workspace zone), so starts_on <=
 * today <= ends_on, ending soonest first (ties by start, then id). Deleted
 * plans never reach here (the read and RLS leave them out). Pure.
 */
export function currentSharedPlans(bundles: Iterable<PlanBundle>, today: string): PlanBundle[] {
  return [...bundles]
    .filter(
      (b) =>
        b.plan.audience === 'client' &&
        b.plan.starts_on.slice(0, 10) <= today &&
        b.plan.ends_on.slice(0, 10) >= today,
    )
    .sort(
      (a, b) =>
        a.plan.ends_on.localeCompare(b.plan.ends_on) ||
        a.plan.starts_on.localeCompare(b.plan.starts_on) ||
        a.plan.id.localeCompare(b.plan.id),
    );
}

const HOUR_MS = 3_600_000;

/**
 * The calendar days "today" can be anywhere at `now` (UTC-12 to UTC+14), so
 * one read with starts_on <= to and ends_on >= from holds every plan current
 * in any workspace zone; {@link currentSharedPlans} then keeps the exact
 * ones for the workspace's own today. Pure.
 */
export function currentPlanWindow(now: Date): { from: string; to: string } {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return { from: day(now.getTime() - 12 * HOUR_MS), to: day(now.getTime() + 14 * HOUR_MS) };
}

/** The bar's summaries of the current shared plans (already in order). Pure. */
export function planSummaries(
  plans: readonly PlanBundle[],
  progressOf: (bundle: PlanBundle) => { approved: number; total: number; changes: number },
): PlanSummary[] {
  return plans.map((bundle) => {
    const progress = progressOf(bundle);
    return {
      id: bundle.plan.id,
      title: bundle.plan.title,
      approved: progress.approved,
      total: progress.total,
      changes: progress.changes,
    };
  });
}

/** The drawer's sections for the bar's items: each key once, in the bar's order. Pure. */
export function drawerKeys(items: readonly StatusItem[]): StatusKey[] {
  return [...new Set(items.map((item) => item.key))];
}

/** A plan title's words, as compact mode drops them. Pure. */
export function titleWords(title: string): string[] {
  return title.split(/\s+/).filter((word) => word !== '');
}

/** The ellipsis a title with dropped words ends on. */
export const TITLE_ELLIPSIS = '\u2026';

/** A title kept to its first `keep` words (at least one); "…" when any dropped. Pure. */
export function keptTitle(title: string, keep: number): string {
  const words = titleWords(title);
  if (keep >= words.length) return title;
  return `${words.slice(0, Math.max(1, keep)).join(' ')}${TITLE_ELLIPSIS}`;
}

/**
 * Compact mode's plan titles, once every other item has dropped its word:
 * how many leading words each title keeps so the row stops overflowing.
 * `words[i][j]` is title i's word j width (with its leading space past the
 * first), `ellipsis` the "…" width a shortened title adds, `overflow` how far
 * the compact row is over its room. Drops the last word of the widest title
 * first, whole words only (never a cut glyph), never below one word. Pure.
 */
export function titleWordsKept(
  words: ReadonlyArray<readonly number[]>,
  ellipsis: number,
  overflow: number,
): number[] {
  const kept = words.map((w) => w.length);
  const width = (i: number): number =>
    (words[i] ?? []).slice(0, kept[i]).reduce((sum, w) => sum + w, 0) +
    ((kept[i] ?? 0) < (words[i] ?? []).length ? ellipsis : 0);
  let over = overflow;
  while (over > 0) {
    let pick = -1;
    for (let i = 0; i < kept.length; i += 1) {
      if ((kept[i] ?? 0) > 1 && (pick === -1 || width(i) > width(pick))) pick = i;
    }
    if (pick === -1) break;
    const before = width(pick);
    kept[pick] = (kept[pick] ?? 1) - 1;
    over -= before - width(pick);
  }
  return kept;
}

/** Which mark type a marks section lists. */
export const SECTION_MARK_TYPE: Record<'commitments' | 'decisions' | 'pending', MarkType> = {
  commitments: 'commitment',
  decisions: 'decision',
  pending: 'pending',
};

/** One marks section's rows: open marks of the type, newest message first. Pure. */
export function openMarksOfType(
  marks: Iterable<ChatMark>,
  type: MarkType,
  timeOf: (mark: ChatMark) => number,
): ChatMark[] {
  return [...marks]
    .filter((m) => !m.resolved && m.type === type)
    .sort((a, b) => timeOf(b) - timeOf(a));
}

/** The first rows of a section and whether a "See all N" row follows. Pure. */
export function sectionRows<T>(
  rows: readonly T[],
  total: number = rows.length,
): {
  rows: T[];
  seeAll: number | null;
} {
  const shown = rows.slice(0, SECTION_ROWS);
  return { rows: shown, seeAll: total > SECTION_ROWS ? total : null };
}

/** A section's uppercase label. Pure. */
export function sectionLabel(
  key: StatusKey,
  input: { postsHeading: string; plans: number },
): string {
  switch (key) {
    case 'plan':
      return input.plans > 1 ? 'Plans' : 'Plan';
    case 'posts':
      return input.postsHeading;
    case 'briefs':
      return 'Open briefs';
    case 'commitments':
      return 'Commitments';
    case 'decisions':
      return 'Decisions';
    case 'pending':
      return 'Pending';
  }
}

/** The plan section header's count: "A/N" for one plan, "N open" for more. Pure. */
export function planSectionCount(
  plans: number,
  first: Pick<PlanSummary, 'approved' | 'total'> | null,
): string {
  if (plans > 1) return `${plans} open`;
  return first !== null ? `${first.approved}/${first.total}` : '';
}

/** Plan bar segment per item. */
export type PlanSegment = 'client' | 'team' | 'changes' | 'waiting';

/**
 * One item's segment: client approved, changes asked, team approved only (the
 * agency side alone sees team status), else waiting. Pure.
 */
export function planSegment(
  state: { client: boolean; changes: boolean; team: boolean },
  side: ViewerSide,
): PlanSegment {
  if (state.client) return 'client';
  if (state.changes) return 'changes';
  if (side === 'agency' && state.team) return 'team';
  return 'waiting';
}

/** Item status pill copy per segment. */
export const SEGMENT_PILL: Record<PlanSegment, string> = {
  client: 'Approved',
  changes: 'Changes asked',
  team: 'Checked by creators',
  waiting: 'Waiting',
};

/**
 * The drawer's date column: "12 Oct" ("12 Oct 2025" off the current year). A
 * calendar date ("YYYY-MM-DD") reads as is; an instant reads on `timeZone`:
 * the workspace zone for a due date (a post's target_date), absent for a
 * moment (the viewer's device clock); '' when unparseable. Pure.
 */
export function drawerDay(value: string | null, timeZone?: string | null): string {
  if (value === null || value === '') return '';
  return formatDate(value, undefined, timeZone ?? undefined);
}

/**
 * Whether the open drawer should close itself: the bar is the empty line now
 * (the last open thing closed while it was open). Pure.
 */
export function drawerShouldClose(bar: StatusBar): boolean {
  return bar.kind !== 'items';
}
