// The Bank's pure parts (the Plan tab's Bank chip, src/components/pages/plan-tab/BankList.tsx):
// its sorts and filter, the star-first order, the 90-day cut, the applied
// filter line's labels, the zero copy, the Plan it branch, the share
// warnings, the error copy and the bulk write limiter. No React, no reads.

import type { BucketOption } from '@/lib/buckets';
import type { BankIdea, BankSort, PlanRow } from '@/lib/chat/plans';
import { sideForRole } from '@/lib/chat/viewer-role';
import { errorText } from '@/lib/error-copy';
import { isDraftPlan } from '@/lib/plan-tab';
import { formatCivilShort } from '@/lib/plan-week';
import { postFormatLabel } from '@/lib/post-format';

/** The Bank's sort options, in menu order (Recently active by default). */
export const BANK_SORT_OPTIONS: ReadonlyArray<{ value: BankSort; label: string }> = [
  { value: 'active', label: 'Recently active' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name' },
];
export const BANK_SORT_DEFAULT: BankSort = 'active';

/** A sort's label. Pure. */
export function bankSortLabel(sort: BankSort): string {
  return BANK_SORT_OPTIONS.find((o) => o.value === sort)?.label ?? 'Recently active';
}

/** What narrows the Bank: one bucket, the sort, archived only, the 90-day review. */
export interface BankFilter {
  sort: BankSort;
  bucketId: string | null;
  archived: boolean;
  /** Untouched for 90 days: live ideas last active over 90 days ago. */
  review: boolean;
}

export const BANK_FILTER_DEFAULT: BankFilter = {
  sort: BANK_SORT_DEFAULT,
  bucketId: null,
  archived: false,
  review: false,
};

/** A stored filter made safe (an unknown sort reads as the default). Pure. */
export function sanitizeBankFilter(value: Partial<BankFilter> | null | undefined): BankFilter {
  const sort = BANK_SORT_OPTIONS.some((o) => o.value === value?.sort)
    ? (value?.sort as BankSort)
    : BANK_SORT_DEFAULT;
  return {
    sort,
    bucketId: typeof value?.bucketId === 'string' ? value.bucketId : null,
    archived: value?.archived === true,
    review: value?.review === true && value.archived !== true,
  };
}

/** The sort key a row compares by. Pure. */
function sortValue(idea: BankIdea, sort: BankSort): string {
  switch (sort) {
    case 'newest':
    case 'oldest':
      return idea.created_at;
    case 'name':
      return (idea.title ?? '').toLowerCase();
    default:
      return idea.last_active_at ?? idea.created_at;
  }
}

/**
 * The ideas in the sort's order, starred first (each group in the sort's
 * order), ties by id: the order the server pages in, so an own write lands
 * where the next read would put it. Pure, stable.
 */
export function sortBankIdeas(ideas: readonly BankIdea[], sort: BankSort): BankIdea[] {
  const ascending = sort === 'oldest' || sort === 'name';
  return [...ideas].sort((a, b) => {
    const sa = a.starred_at != null ? 0 : 1;
    const sb = b.starred_at != null ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const va = sortValue(a, sort);
    const vb = sortValue(b, sort);
    const byKey = ascending ? va.localeCompare(vb) : vb.localeCompare(va);
    if (byKey !== 0) return byKey;
    return ascending ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id);
  });
}

/** The Untouched for 90 days list's bulk archive: "Archive all {n}". Pure. */
export function archiveAllLabel(n: number): string {
  return `Archive all ${n}`;
}

/** The Filter and sort switch and its pill. */
export const UNTOUCHED_LABEL = 'Untouched for 90 days';
export const UNTOUCHED_PILL = 'Untouched 90 days';

/** One small removable pill of the applied filter line. */
export interface FilterPill {
  key: 'bucket' | 'archived' | 'sort' | 'review';
  label: string;
}

/**
 * The applied filter line's pills, in order: bucket, archived, the review,
 * then a sort other than the default ("Sort: Name"). Empty when nothing is
 * applied (the line is not drawn). A bucket no longer listed draws nothing. Pure.
 */
export function filterPills(
  filter: BankFilter,
  buckets: ReadonlyArray<{ id: string; name: string }>,
): FilterPill[] {
  const out: FilterPill[] = [];
  if (filter.bucketId !== null) {
    const bucket = buckets.find((b) => b.id === filter.bucketId);
    if (bucket !== undefined) out.push({ key: 'bucket', label: bucket.name });
  }
  if (filter.archived) out.push({ key: 'archived', label: 'Archived' });
  if (filter.review) out.push({ key: 'review', label: UNTOUCHED_PILL });
  if (filter.sort !== BANK_SORT_DEFAULT) {
    out.push({ key: 'sort', label: `Sort: ${bankSortLabel(filter.sort)}` });
  }
  return out;
}

/** The filter with one pill removed. Pure. */
export function withoutPill(filter: BankFilter, key: FilterPill['key']): BankFilter {
  switch (key) {
    case 'bucket':
      return { ...filter, bucketId: null };
    case 'archived':
      return { ...filter, archived: false };
    case 'review':
      return { ...filter, review: false };
    default:
      return { ...filter, sort: BANK_SORT_DEFAULT };
  }
}

/** Whether anything is applied (the filter line shows). Pure. */
export function filterApplied(filter: BankFilter): boolean {
  return (
    filter.bucketId !== null ||
    filter.archived ||
    filter.review ||
    filter.sort !== BANK_SORT_DEFAULT
  );
}

/** The zero line: a search or bucket with nothing, archived, or the plain bank. Pure. */
export function bankZeroCopy(filter: BankFilter, searching: boolean): string {
  if (searching || filter.bucketId !== null || filter.review)
    return 'Try another search or bucket.';
  if (filter.archived) return 'Archived ideas show up here.';
  return 'Ideas show up here.';
}

/**
 * An idea card's one tag: its first bucket's name (in the idea's own order),
 * or none. Pure.
 */
export function ideaBucketTag(
  idea: Pick<BankIdea, 'bucket_ids'>,
  buckets: readonly BucketOption[],
): string | undefined {
  for (const id of idea.bucket_ids ?? []) {
    const bucket = buckets.find((b) => b.id === id);
    if (bucket !== undefined) return bucket.name;
  }
  return undefined;
}

/** The idea's format line: its linked post's format, else Idea. Pure. */
export function ideaFormatLine(idea: Pick<BankIdea, 'format'>): string {
  return idea.format !== null && idea.format !== '' ? postFormatLabel(idea.format) : 'Idea';
}

/** "+N" on a thumbnail when the idea holds more than one file; null otherwise. Pure. */
export function moreFilesLabel(fileCount: number): string | null {
  return fileCount > 1 ? `+${fileCount - 1}` : null;
}

export const CLIENT_CAN_SEE = 'Client can see';
export const TEAM_ONLY = 'Team only';

// ---------------------------------------------------------------------------
// Plan it
// ---------------------------------------------------------------------------

/** The plans whose dates hold `day`. Pure. */
export function plansCoveringDay(plans: readonly PlanRow[], day: string): PlanRow[] {
  return plans.filter((p) => p.starts_on <= day && p.ends_on >= day);
}

/** Where Plan it goes for a day: one plan places at once, none offers Make plan, several a picker. Pure. */
export type PlanItChoice =
  | { kind: 'past' }
  | { kind: 'one'; plan: PlanRow }
  | { kind: 'none' }
  | { kind: 'several'; plans: PlanRow[] };

export function planItChoice(plans: readonly PlanRow[], day: string, today: string): PlanItChoice {
  if (day < today) return { kind: 'past' };
  const covering = plansCoveringDay(plans, day);
  if (covering.length === 0) return { kind: 'none' };
  if (covering.length === 1 && covering[0] !== undefined) return { kind: 'one', plan: covering[0] };
  return { kind: 'several', plans: covering };
}

/** Into a shared plan, an idea the client cannot see yet asks first. Pure. */
export function needsSharedWarning(
  plan: Pick<PlanRow, 'audience'>,
  idea: Pick<BankIdea, 'show_to_client'>,
): boolean {
  return !isDraftPlan(plan) && idea.show_to_client !== true;
}

/** A plan's line in the several-plans picker: shared or Draft. Pure. */
export function planAudienceLabel(plan: Pick<PlanRow, 'audience'>): string {
  return isDraftPlan(plan) ? 'Draft' : 'shared';
}

/** The shared-plan warning. Pure. */
export function sharedPlanWarning(planTitle: string, comments: number): string {
  return `${planTitle} is shared with approvers. Once it is in, they see the idea and all ${comments} ${comments === 1 ? 'comment' : 'comments'}.`;
}

/** "No plan covers {date}". Pure. */
export function noPlanTitle(day: string): string {
  return `No plan covers ${formatCivilShort(day)}`;
}

/** "Planned in {plan}, {date}". Pure. */
export function plannedToast(planTitle: string, day: string): string {
  return `Planned in ${planTitle}, ${formatCivilShort(day)}`;
}

export const PAST_DAY_ERROR = "Couldn't plan it. Past days can't be planned.";

/** A Plan it failure's copy: past_date gets its own line. Pure. */
export function planItError(message: string): string {
  return message.includes('past_date') ? PAST_DAY_ERROR : errorText('plan it', message);
}

// ---------------------------------------------------------------------------
// Show to client
// ---------------------------------------------------------------------------

/** Names in a sentence: "A", "A and B", "A, B and C"; none: "Approvers". Pure. */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return 'Approvers';
  if (names.length === 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/** The workspace's active approvers (client side) by name, from the members read. Pure. */
export function approverNames(
  rows: ReadonlyArray<{ user_id: string; role: string; active: boolean }>,
  profiles: ReadonlyMap<string, { displayName: string }>,
): string[] {
  return rows
    .filter((r) => r.active && sideForRole(r.role) === 'client')
    .map((r) => profiles.get(r.user_id)?.displayName ?? '')
    .filter((n) => n !== '')
    .sort((a, b) => a.localeCompare(b));
}

/** "{names} will see this idea and all {n} comments, team ones included." Pure. */
export function showToClientWarning(names: readonly string[], comments: number): string {
  const who = joinNames(names);
  return `${who} will see this idea and all ${comments} ${comments === 1 ? 'comment' : 'comments'}, team ones included.`;
}

// ---------------------------------------------------------------------------
// Bulk writes and routes
// ---------------------------------------------------------------------------

/** Bulk writes in flight at most. */
export const BANK_BULK_LIMIT = 12;

/**
 * Run every task with at most `limit` in flight (Promise.all over workers),
 * results in task order. A rejected task rejects the whole run.
 */
export async function runLimited<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number = BANK_BULK_LIMIT,
): Promise<T[]> {
  const out: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const at = next;
      next += 1;
      const task = tasks[at];
      if (task !== undefined) out[at] = await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return out;
}

/** "{n} selected". Pure. */
export function selectedLabel(n: number): string {
  return `${n} selected`;
}

/**
 * A bank idea's route (PlanPage.tsx planBankItemRoute; a test pins them
 * equal). Kept here so the Plan tab chunk does not load the Plan page's.
 */
export function bankItemHref(itemId: string): string {
  return `/plan/bank?${new URLSearchParams({ item: itemId }).toString()}`;
}

/**
 * A bucket delete's second line: none for an empty bucket, "1 idea keeps its
 * other buckets", "{n} ideas keep their other buckets". Pure.
 */
export function bucketDeleteLine(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 idea keeps its other buckets' : `${n} ideas keep their other buckets`;
}

/** The ideas a bucket holds, from the loaded ideas. Pure. */
export function bucketIdeaCount(ideas: readonly BankIdea[], bucketId: string): number {
  return ideas.filter((i) => (i.bucket_ids ?? []).includes(bucketId)).length;
}
