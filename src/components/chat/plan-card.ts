// Pure helpers behind the plan card and the Plan, Item and New plan screens:
// progress maths, chips, status pills, kind labels, the default week and the
// draft checks. No React, no reads, so every rule is unit-tested directly.

import { planItemDay } from '@/lib/chat/plans';
import type {
  PlanAudience,
  PlanBundle,
  PlanItemRow,
  ReviewSide,
  ReviewStatus,
} from '@/lib/chat/plans';
import type { ViewerSide } from '@/lib/chat/viewer-role';

/** Card and screen copy. */
export const PLAN_EYEBROW = 'PLAN';
export const PLAN_NOT_AVAILABLE = 'Plan not available';
export const PLAN_SHARED_TOAST = 'Plan shared';
export const TEAM_ONLY_LABEL = 'Team only';
export const PLAN_HAS_DRAFTS_COPY = 'Remove the draft posts first.';
export const AUDIENCE_HINTS: Record<PlanAudience, string> = {
  client: "Client sees concepts, posts and Everyone comments. Drafts can't be added.",
  team: 'Only your team sees this plan. Drafts allowed. Share with the client later, once no drafts are left.',
};
export const TEAM_APPROVE_CONFIRM =
  'Mark as team approved? Only the team sees this. The client still approves separately.';
export const COMMENT_FAILED = "Couldn't send. Try again.";

/** The longest plan, in days between From and To (plans_dates). */
export const PLAN_MAX_DAYS = 92;
/** Title bounds (plans.title). */
export const PLAN_TITLE_MAX = 200;
/** Files per concept (plan_concept_add). */
export const CONCEPT_FILES_MAX = 20;

/** The client confirm for approving a concept. Pure. */
export function clientApproveConfirm(title: string): string {
  return `Approve "${title}"? The team will go ahead and make this into a post.`;
}

/** The toast after a forward. Pure. */
export function forwardedToast(name: string): string {
  return `Forwarded to ${name}`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

const REVIEW_INDEX = new WeakMap<PlanBundle, Map<string, ReviewStatus>>();

/**
 * The bundle's reviews keyed by item id and side, built once per bundle (a
 * fresh read is a fresh bundle), so no row scans the review list. Pure.
 */
function reviewIndex(bundle: PlanBundle): Map<string, ReviewStatus> {
  let index = REVIEW_INDEX.get(bundle);
  if (index === undefined) {
    index = new Map();
    for (const r of bundle.reviews) index.set(`${r.item_id}:${r.side}`, r.status);
    REVIEW_INDEX.set(bundle, index);
  }
  return index;
}

/** One review's status for an item and side, 'waiting' when none is on record. Pure. */
export function reviewStatus(bundle: PlanBundle, itemId: string, side: ReviewSide): ReviewStatus {
  return reviewIndex(bundle).get(`${itemId}:${side}`) ?? 'waiting';
}

/** Whether the client has approved this item: a concept's client review, or a post's stage. Pure. */
export function clientApproved(bundle: PlanBundle, item: PlanItemRow): boolean {
  if (item.kind === 'post') {
    return item.post_id !== null && bundle.postStages[item.post_id] === 'approved';
  }
  return reviewStatus(bundle, item.id, 'client') === 'approved';
}

/** Whether the client asked changes on this item (concepts only). Pure. */
export function clientChanges(bundle: PlanBundle, item: PlanItemRow): boolean {
  return item.kind === 'concept' && reviewStatus(bundle, item.id, 'client') === 'changes';
}

export interface PlanProgress {
  /** Client approved: a concept's client review, or a post at stage approved. */
  approved: number;
  /** Team approved: the item's team review (concepts and posts). */
  teamApproved: number;
  /** Every item; a post the viewer cannot read counts here, never as approved. */
  total: number;
  /** Client changes asked (concepts). */
  changes: number;
}

/** Team and client approval across the plan's items, one pass. Pure. */
export function planProgress(bundle: PlanBundle): PlanProgress {
  let approved = 0;
  let teamApproved = 0;
  let changes = 0;
  for (const item of bundle.items) {
    if (clientApproved(bundle, item)) approved += 1;
    if (reviewStatus(bundle, item.id, 'team') === 'approved') teamApproved += 1;
    if (clientChanges(bundle, item)) changes += 1;
  }
  return { approved, teamApproved, total: bundle.items.length, changes };
}

function changesPart(changes: number): string {
  return changes === 0 ? '' : ` · ${changes} ${changes === 1 ? 'change' : 'changes'} asked`;
}

/**
 * The progress line. Agency: "Team A of N · Client B of N", then
 * "· K changes asked" when K > 0. Anyone else (client, unknown) sees the
 * client count only, never a team status. Pure.
 */
export function progressLabel(progress: PlanProgress, side: ViewerSide): string {
  const n = progress.total;
  const base =
    side === 'agency'
      ? `Team ${progress.teamApproved} of ${n} · Client ${progress.approved} of ${n}`
      : `${progress.approved} of ${n} approved by client`;
  return `${base}${changesPart(progress.changes)}`;
}

/** The bar's fill (client approval), 0..100. Pure. */
export function progressPercent(progress: PlanProgress): number {
  if (progress.total === 0) return 0;
  return Math.round((progress.approved / progress.total) * 100);
}

export interface PlanChip {
  label: string;
  tone: 'neutral' | 'warn';
}

/** Count chips, then "Team only" for a team plan. Pure. */
export function planChips(bundle: PlanBundle): PlanChip[] {
  const concepts = bundle.items.filter((i) => i.kind === 'concept').length;
  const posts = bundle.items.filter((i) => i.kind === 'post').length;
  const chips: PlanChip[] = [
    { label: plural(concepts, 'concept'), tone: 'neutral' },
    { label: plural(posts, 'post'), tone: 'neutral' },
  ];
  if (bundle.plan.audience === 'team') chips.push({ label: TEAM_ONLY_LABEL, tone: 'warn' });
  return chips;
}

/** Forward shows only for a client viewer on a client plan. Pure. */
export function canForwardPlan(side: ViewerSide, audience: PlanAudience): boolean {
  return side === 'client' && audience === 'client';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Oct" from "2026-10-12" (a calendar date, no zone). Pure. */
export function shortDay(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  const month = MONTHS[Number(m) - 1] ?? '';
  return `${Number(d)} ${month}`;
}

/** "12 Oct - 18 Oct". Pure. */
export function planRangeLabel(startsOn: string, endsOn: string): string {
  return `${shortDay(startsOn)} - ${shortDay(endsOn)}`;
}

/** The label of an item with no date. */
export const NO_DATE_LABEL = 'No date';

/** An item's date label: its day ("12 Oct"), or "No date" (muted). Pure. */
export function itemDateLabel(
  bundle: Pick<PlanBundle, 'postInfo'>,
  item: PlanItemRow,
): { label: string; dated: boolean } {
  const day = planItemDay(item, bundle.postInfo);
  return day === null
    ? { label: NO_DATE_LABEL, dated: false }
    : { label: shortDay(day), dated: true };
}

/** Status pill copy. */
export const STATUS_LABELS: Record<ReviewStatus, string> = {
  waiting: 'Waiting',
  approved: 'Approved',
  changes: 'Changes asked',
};

const STAGE_LABELS: Record<string, string> = {
  draft: 'Draft',
  review: 'In review',
  approved: 'Approved',
  parked: 'Parked',
  rejected: 'Rejected',
};

/** A post stage's label. Pure. */
export function stageLabel(stage: string | undefined): string {
  if (stage === undefined) return 'Unknown';
  return STAGE_LABELS[stage] ?? stage.charAt(0).toUpperCase() + stage.slice(1);
}

export type PillTone = 'good' | 'review' | 'neutral';

export interface StatusPill {
  /** "Team · Approved" for the agency side, "Approved" alone for a client. */
  label: string;
  tone: PillTone;
  side: ReviewSide;
}

function toneOf(status: ReviewStatus): PillTone {
  if (status === 'approved') return 'good';
  if (status === 'changes') return 'review';
  return 'neutral';
}

/** The client side's status for an item: a concept's review, or a post's stage mapped. Pure. */
export function clientStatus(bundle: PlanBundle, item: PlanItemRow): ReviewStatus {
  if (item.kind === 'post') return clientApproved(bundle, item) ? 'approved' : 'waiting';
  return reviewStatus(bundle, item.id, 'client');
}

/**
 * A row's pills: the agency sees Team and Client, a client sees one (no side
 * prefix). Unknown side shows the client pill only (never a team status). Pure.
 */
export function itemPills(bundle: PlanBundle, item: PlanItemRow, side: ViewerSide): StatusPill[] {
  const client = clientStatus(bundle, item);
  if (side !== 'agency') {
    return [{ label: STATUS_LABELS[client], tone: toneOf(client), side: 'client' }];
  }
  const team = reviewStatus(bundle, item.id, 'team');
  return [
    { label: `Team · ${STATUS_LABELS[team]}`, tone: toneOf(team), side: 'team' },
    { label: `Client · ${STATUS_LABELS[client]}`, tone: toneOf(client), side: 'client' },
  ];
}

/**
 * "Concept 1 of 3" / "Post 2 of 4": the item's place among its kind, in the
 * bundle's date order (plans.ts sorts items by date when it assembles). Pure.
 */
export function itemKindLabel(items: readonly PlanItemRow[], item: PlanItemRow): string {
  const same = items.filter((i) => i.kind === item.kind);
  const at = same.findIndex((i) => i.id === item.id) + 1;
  return `${item.kind === 'concept' ? 'Concept' : 'Post'} ${at} of ${same.length}`;
}

/** The plan screen's sub line. Pure. */
export function planSharedLine(side: ViewerSide, name: string): string {
  return side === 'agency' ? `Shared with ${name}` : `Shared by ${name}`;
}

/** Whether the Plan tray tile is live: agency side only (unknown keeps it off). Pure. */
export function planTileEnabled(side: ViewerSide): boolean {
  return side === 'agency';
}

/**
 * Whether a Team only plan is blocked here: the chat has a client, or its
 * members are still unknown (never shared on a guess). Pure.
 */
export function teamPlanBlocked(audience: PlanAudience, hasClient: boolean | null): boolean {
  return audience === 'team' && hasClient !== false;
}

/** Whether "Add drafts" shows: a team plan in a chat known to have no client. Pure. */
export function draftsButtonShown(audience: PlanAudience, hasClient: boolean | null): boolean {
  return audience === 'team' && hasClient === false;
}

/** "YYYY-MM-DD" for `now` in the zone. Pure (given the clock). */
export function todayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const at = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000);
  return at.toISOString().slice(0, 10);
}

/** Days from `a` to `b` (calendar dates). Pure. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** This week, Monday to Sunday, in the workspace zone. Pure (given the clock). */
export function defaultPlanRange(
  now: Date,
  timeZone: string,
): { startsOn: string; endsOn: string } {
  const today = todayInZone(now, timeZone);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const back = (dow + 6) % 7;
  const startsOn = addDays(today, -back);
  return { startsOn, endsOn: addDays(startsOn, 6) };
}

export type DraftProblem = 'title' | 'dates' | 'too_long' | null;

/** The first thing stopping a share, or null. Pure. */
export function draftProblem(input: {
  title: string;
  startsOn: string;
  endsOn: string;
}): DraftProblem {
  const title = input.title.trim();
  if (title.length < 1 || title.length > PLAN_TITLE_MAX) return 'title';
  if (input.startsOn === '' || input.endsOn === '') return 'dates';
  const days = daysBetween(input.startsOn, input.endsOn);
  if (Number.isNaN(days) || days < 0) return 'dates';
  if (days > PLAN_MAX_DAYS) return 'too_long';
  return null;
}

/** Inline copy per problem. */
export const DRAFT_PROBLEM_COPY: Record<Exclude<DraftProblem, null>, string> = {
  title: 'Add a title.',
  dates: 'To must be on or after From.',
  too_long: 'A plan can cover at most 92 days.',
};
