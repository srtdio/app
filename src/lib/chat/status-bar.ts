// The chat status ticker's pure pieces: which items the bar shows and how each
// reads (fixed order, zero items omitted, 99+ cap, plural words, side wording,
// plan colour), the open-plan filter and pick (ends_on >= today in the
// workspace zone, ending soonest first), the empty and failed-read rules, the
// first-paint gate and the drawer's per-section rows. No React and no reads,
// so every rule is unit-tested directly.

import { NOTHING_OPEN, type MarkCounts, type ChatMark, type MarkType } from '@/lib/chat/marks';
import type { PlanBundle } from '@/lib/chat/plans';
import type { ViewerSide } from '@/lib/chat/viewer-role';

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
export const BAR_CAP = 99;

/** A count as the bar shows it: "99+" over the cap. Pure. */
export function capCount(n: number): string {
  return n > BAR_CAP ? `${BAR_CAP}+` : String(Math.max(0, n));
}

/** What the bar reads of the soonest-ending open plan. */
export interface PlanSummary {
  /** Items the client approved. */
  approved: number;
  /** Every item. */
  total: number;
  /** Items the client asked changes on. */
  changes: number;
  /** Other open plans (the "+K"). */
  more: number;
}

/**
 * One settled round of every read the bar counts. `null` is a read that
 * failed (its item is omitted and the bar never says nothing is open).
 */
export interface StatusInput {
  /** The soonest-ending open plan, or 'none' when no plan is open. */
  plan: PlanSummary | 'none' | null;
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
  /** Kept in compact mode: the plan's "Plan". */
  lead: string | null;
  /** The number as shown ("3", "99+", "2/5"). */
  number: string;
  /** Dropped in compact mode: "in review", "briefs". */
  word: string | null;
  /** The plan's "+K" (other open plans); 0 for none. Hidden in compact mode. */
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
    lead: null,
    number: capCount(count),
    word,
    more: 0,
    tone,
    count,
    aria: `${count} ${word}`,
  };
}

/** The bar's items in the fixed order; zero and failed ones are left out. Pure. */
export function statusItems(input: StatusInput): StatusItem[] {
  const items: StatusItem[] = [];
  const plan = input.plan;
  if (plan !== null && plan !== 'none') {
    items.push({
      key: 'plan',
      lead: 'Plan',
      number: `${capCount(plan.approved)}/${capCount(plan.total)}`,
      word: null,
      more: Math.max(0, plan.more),
      tone: planTone(plan),
      count: plan.total,
      aria: `Plan ${plan.approved} of ${plan.total} approved by client`,
    });
  }
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
    input.plan === null || input.posts === null || input.briefs === null || input.marks === null
  );
}

/**
 * What the bar paints: its items; "Nothing open between you" only when every
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

/** The bar's plan summary over the open plans (already sorted soonest first). Pure. */
export function planSummary(
  open: readonly PlanBundle[],
  progressOf: (bundle: PlanBundle) => { approved: number; total: number; changes: number },
): PlanSummary | 'none' {
  const [first] = open;
  if (first === undefined) return 'none';
  const progress = progressOf(first);
  return {
    approved: progress.approved,
    total: progress.total,
    changes: progress.changes,
    more: open.length - 1,
  };
}

/** Distinct shared plan ids over message rows, first seen first. Pure. */
export function distinctPlanIds(
  rows: ReadonlyArray<{ shared_plan_ids?: readonly string[] | null }>,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const id of row.shared_plan_ids ?? []) {
      if (typeof id === 'string' && id !== '') seen.add(id);
    }
  }
  return [...seen];
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
export function planSectionCount(plans: number, first: PlanSummary | null): string {
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
  client: 'Client approved',
  changes: 'Changes asked',
  team: 'Team approved',
  waiting: 'Waiting',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The drawer's date column: "12 Oct". A calendar date ("YYYY-MM-DD") reads
 * as is; an instant reads on the workspace clock; '' when unparseable. Pure.
 */
export function drawerDay(value: string | null, timeZone: string): string {
  if (value === null || value === '') return '';
  let day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  if (day === '') {
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return '';
    try {
      day = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(at);
    } catch {
      day = at.toISOString().slice(0, 10);
    }
  }
  const [, m, d] = day.split('-');
  const month = MONTHS[Number(m) - 1];
  return month === undefined ? '' : `${Number(d)} ${month}`;
}

/**
 * Whether the open drawer should close itself: the bar is the empty line now
 * (the last open thing closed while it was open). Pure.
 */
export function drawerShouldClose(bar: StatusBar): boolean {
  return bar.kind !== 'items';
}
