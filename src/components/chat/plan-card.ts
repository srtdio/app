// Pure helpers behind the plan card and the Plan, Item and New plan screens:
// progress maths, chips, status pills, kind labels, the default week and the
// draft checks. No React, no reads, so every rule is unit-tested directly.

import { planItemDayInZone } from '@/lib/chat/plans';
import type {
  PlanAudience,
  PlanBundle,
  PlanItemRow,
  PlanReviewRow,
  ReviewSide,
  ReviewStatus,
} from '@/lib/chat/plans';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { isOwnerOrAdmin } from '@/components/pages/pcs/roles';
import { civilToday, formatCivilDayHeader } from '@/lib/plan-week';

/** Card and screen copy. */
export const PLAN_EYEBROW = 'PLAN';
export const PLAN_NOT_AVAILABLE = 'Plan not available';
/** A card whose plan can no longer be read (deleted, or no longer visible). */
export const PLAN_DELETED = 'Plan deleted';
export const PLAN_SHARED_TOAST = 'Plan shared';
/** An Agency only comment's tag (plan comments' visibility). */
export const TEAM_ONLY_LABEL = 'Agency only';
/** A Draft plan (audience team): the chip, the subtitle and the progress side. */
export const PLAN_DRAFT_LABEL = 'Draft';
/** An Open plan (audience client): the subtitle. */
export const PLAN_OPEN_LABEL = 'Shared with client';
export const TEAM_APPROVE_CONFIRM =
  'Mark as agency approved? Only the agency sees this. The client still approves separately.';
/** The "In this chat" chip on a plan already shared here (the Plans sheet). */
export const IN_THIS_CHAT_LABEL = 'In this chat';
/** The Forward list's tag on a chat known to have a client (a Draft plan). */
export const HAS_CLIENT_TAG = 'Has client';
/** A draft post's pill, and a client's sub line on its row. */
export const DRAFT_LABEL = 'Draft';
export const DRAFT_NOT_READY = 'Not ready to view yet';
export const COMMENT_FAILED = "Couldn't send. Try again.";

/** The longest plan, in days between From and To (plans_dates). */
export const PLAN_MAX_DAYS = 92;
/** Title bounds (plans.title). */
export const PLAN_TITLE_MAX = 200;
/** Files per concept (plan_concept_add). */
export const CONCEPT_FILES_MAX = 20;

/** The client confirm for approving a concept. Pure. */
export function clientApproveConfirm(title: string): string {
  return `Approve "${title}"? The agency will go ahead and make this into a post.`;
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

/**
 * Whether the client has approved this item: its client review row, for a
 * concept and a post item alike (a post's slot approval never reads or moves
 * posts.stage). Pure.
 */
export function clientApproved(bundle: PlanBundle, item: PlanItemRow): boolean {
  return reviewStatus(bundle, item.id, 'client') === 'approved';
}

/** Whether the client asked changes on this item (its client review row). Pure. */
export function clientChanges(bundle: PlanBundle, item: PlanItemRow): boolean {
  return reviewStatus(bundle, item.id, 'client') === 'changes';
}

/**
 * The one review side a plan shows, for everyone: a Draft plan (audience team)
 * the team side, an Open plan (audience client) the client side. Team reviews
 * are never shown on an Open plan. Pure.
 */
export function shownReviewSide(audience: PlanAudience): ReviewSide {
  return audience === 'client' ? 'client' : 'team';
}

export interface PlanProgress {
  /** Client approved: the item's client review (concepts and post slots). */
  approved: number;
  /** Team approved: the item's team review (concepts and posts). */
  teamApproved: number;
  /** Every item; a post the viewer cannot read counts here, never as approved. */
  total: number;
  /** Client changes asked (the item's client review). */
  changes: number;
  /** The side the plan shows (shownReviewSide); absent reads as the client side. */
  side?: ReviewSide;
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
  return {
    approved,
    teamApproved,
    total: bundle.items.length,
    changes,
    side: shownReviewSide(bundle.plan.audience),
  };
}

/** The shown side's approved count. Pure. */
function shownApproved(progress: PlanProgress): number {
  return (progress.side ?? 'client') === 'team' ? progress.teamApproved : progress.approved;
}

/**
 * The progress line, the same for every viewer: a Draft plan "Team X of N",
 * an Open plan "Client X of N" (never a team count on an Open plan). `side`
 * is kept for the callers. Pure.
 */
export function progressLabel(progress: PlanProgress, side?: ViewerSide): string {
  void side;
  const who = (progress.side ?? 'client') === 'team' ? 'Team' : 'Client';
  return `${who} ${shownApproved(progress)} of ${progress.total}`;
}

/** The bar's fill (the shown side's approval), 0..100. Pure. */
export function progressPercent(progress: PlanProgress): number {
  if (progress.total === 0) return 0;
  return Math.round((shownApproved(progress) / progress.total) * 100);
}

export interface PlanChip {
  label: string;
  tone: 'neutral' | 'warn' | 'accent';
}

/** Count chips, then "Draft" for a Draft (team) plan. Pure. */
export function planChips(bundle: PlanBundle): PlanChip[] {
  const concepts = bundle.items.filter((i) => i.kind === 'concept').length;
  const posts = bundle.items.filter((i) => i.kind === 'post').length;
  const chips: PlanChip[] = [
    { label: plural(concepts, 'concept'), tone: 'neutral' },
    { label: plural(posts, 'post'), tone: 'neutral' },
  ];
  if (bundle.plan.audience === 'team') chips.push({ label: PLAN_DRAFT_LABEL, tone: 'warn' });
  return chips;
}

/** The Plans sheet's chips: the card's, then "In this chat" when shared here. Pure. */
export function pickerChips(bundle: PlanBundle, inThisChat: boolean): PlanChip[] {
  const chips = planChips(bundle);
  if (inThisChat) chips.push({ label: IN_THIS_CHAT_LABEL, tone: 'accent' });
  return chips;
}

/** Forward shows on every plan for the agency, and on a client plan for a client. Pure. */
export function canForwardPlan(side: ViewerSide, audience: PlanAudience): boolean {
  if (side === 'agency') return true;
  return side === 'client' && audience === 'client';
}

/** Forward on a Draft card into a chat with a client: nothing is sent. */
export const OPEN_FOR_CLIENT_FIRST = 'Open the plan for client first.';

/**
 * Whether a forward is refused before any write: a Draft plan into a chat
 * known to have a client (an unknown chat is sent, and the server's refusal
 * says the same). Pure.
 */
export function forwardBlocked(audience: PlanAudience, hasClient: boolean | null): boolean {
  return audience === 'team' && hasClient === true;
}

/**
 * Whether a chat is known, from data already loaded, to have a client: a DM
 * whose other person is a client. Groups are unknown here (null). Pure.
 */
export function summaryHasClient(channel: {
  channelType: string;
  role?: string | null;
}): boolean | null {
  if (channel.channelType === 'dm' && channel.role !== undefined && channel.role !== null) {
    return channel.role === 'client';
  }
  return null;
}

/** Whether an item is a draft post (a draft row, or a readable post at stage draft). Pure. */
export function isDraftPost(bundle: Pick<PlanBundle, 'postStages'>, item: PlanItemRow): boolean {
  if (item.kind !== 'post') return false;
  if (item.draft_row === true) return true;
  return item.post_id !== null && bundle.postStages[item.post_id] === 'draft';
}

/** A draft post is inert for anyone but the agency: name only, no open. Pure. */
export function draftLocked(
  bundle: Pick<PlanBundle, 'postStages'>,
  item: PlanItemRow,
  side: ViewerSide,
): boolean {
  return side !== 'agency' && isDraftPost(bundle, item);
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
  timeZone = 'UTC',
): { label: string; dated: boolean } {
  const day = planItemDayInZone(item, bundle.postInfo, timeZone);
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
  /** "Agency · Approved" for the agency side, "Approved" alone for a client. */
  label: string;
  tone: PillTone;
  side: ReviewSide;
}

function toneOf(status: ReviewStatus): PillTone {
  if (status === 'approved') return 'good';
  if (status === 'changes') return 'review';
  return 'neutral';
}

/** The client side's status for an item: its client review row (concept or post slot). Pure. */
export function clientStatus(bundle: PlanBundle, item: PlanItemRow): ReviewStatus {
  return reviewStatus(bundle, item.id, 'client');
}

/**
 * A row's pills: the agency sees Team and Client on a Draft plan and the
 * client's alone on an Open plan (never a team status there); a client sees
 * one (no side prefix). Unknown side shows the client pill only. Pure.
 */
export function itemPills(bundle: PlanBundle, item: PlanItemRow, side: ViewerSide): StatusPill[] {
  const client = clientStatus(bundle, item);
  if (side !== 'agency') {
    return [{ label: STATUS_LABELS[client], tone: toneOf(client), side: 'client' }];
  }
  if (bundle.plan.audience === 'client') {
    return [{ label: `Client · ${STATUS_LABELS[client]}`, tone: toneOf(client), side: 'client' }];
  }
  const team = reviewStatus(bundle, item.id, 'team');
  return [
    { label: `Agency · ${STATUS_LABELS[team]}`, tone: toneOf(team), side: 'team' },
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

/** Whether the Plan tray tile is live: agency side only (unknown keeps it off). Pure. */
export function planTileEnabled(side: ViewerSide): boolean {
  return side === 'agency';
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

// ---------------------------------------------------------------------------
// Slot approval (the Plan screen's per-row checkbox)
// ---------------------------------------------------------------------------

/** Toast and error copy for a slot tick. */
export const SLOT_REMOVED_TOAST = 'Slot approval removed';
export const SLOT_FAILED = "Couldn't update this slot. Try again.";
export const SLOT_POST_NOT_READY = "This post isn't ready yet.";
export const SLOT_UNDO = 'Undo';
/** How long the "Slot approved" toast (and its Undo) stays. */
export const SLOT_UNDO_MS = 5_000;
/** The post item header's subtitle. */
export const SLOT_APPROVED_LABEL = 'Slot approved';
export const SLOT_PENDING_LABEL = 'Slot pending';

/** "Slot approved · Tue 14 Oct", or "Slot approved" for an undated item. Pure. */
export function slotApprovedToast(dayHeader: string | null): string {
  return dayHeader === null ? SLOT_APPROVED_LABEL : `${SLOT_APPROVED_LABEL} · ${dayHeader}`;
}

/** A failed slot write's copy: the draft refusal, else the generic one. Pure. */
export function slotErrorCopy(message: string): string {
  return message.includes('post_not_ready') ? SLOT_POST_NOT_READY : SLOT_FAILED;
}

/**
 * Which review side the viewer's slot checkbox WRITES: on a Draft plan the
 * agency ticks the team side; on an Open plan a client ticks the client side
 * and the agency writes nothing (its boxes are read-only). An unknown side,
 * or a client on a Draft plan, writes nothing. Pure.
 */
export function slotSide(side: ViewerSide, audience: PlanAudience): ReviewSide | null {
  if (audience === 'team') return side === 'agency' ? 'team' : null;
  return side === 'client' ? 'client' : null;
}

/** A row's checkbox: the side it shows and whether the viewer may tick it. */
export interface SlotView {
  side: ReviewSide;
  writable: boolean;
}

/**
 * The checkbox a viewer sees: Draft, the team side (agency only, writable);
 * Open, the client side for everyone (a client ticks it, the agency sees it
 * read-only). An unknown side sees none (first paint waits for the side). Pure.
 */
export function slotView(side: ViewerSide, audience: PlanAudience): SlotView | null {
  if (side === 'unknown') return null;
  if (audience === 'team') return side === 'agency' ? { side: 'team', writable: true } : null;
  return { side: 'client', writable: side === 'client' };
}

/** Whether a row shows the checkbox (and which): a slot view, not a draft locked to the viewer. Pure. */
export function slotCheckboxShown(
  bundle: Pick<PlanBundle, 'postStages' | 'plan'>,
  item: PlanItemRow,
  side: ViewerSide,
): SlotView | null {
  if (draftLocked(bundle, item, side)) return null;
  return slotView(side, bundle.plan.audience);
}

/** A ticked slot: the side's review is approved ('changes' shows unticked). Pure. */
export function slotTicked(bundle: PlanBundle, itemId: string, side: ReviewSide): boolean {
  return reviewStatus(bundle, itemId, side) === 'approved';
}

/**
 * The bundle with local (optimistic) review statuses laid over its reviews for
 * one side, so the rows, pills, counts and bar all read the same state. The
 * same bundle when there is nothing to lay over. Pure.
 */
export function withReviewOverrides(
  bundle: PlanBundle,
  side: ReviewSide,
  overrides: Readonly<Record<string, ReviewStatus>>,
): PlanBundle {
  const ids = Object.keys(overrides);
  if (ids.length === 0) return bundle;
  const reviews = bundle.reviews.filter((r) => !(r.side === side && ids.includes(r.item_id)));
  for (const id of ids) {
    const status = overrides[id];
    if (status !== undefined) reviews.push({ item_id: id, side, status });
  }
  return { ...bundle, reviews };
}

/**
 * The post item header's review side: a client reads the client side; the
 * agency the client side on a client plan and the team side on a team plan.
 * An unknown side reads nothing. Pure.
 */
export function itemSlotSide(side: ViewerSide, audience: PlanAudience): ReviewSide | null {
  if (side === 'client') return 'client';
  if (side === 'agency') return audience === 'client' ? 'client' : 'team';
  return null;
}

/** The post item header's subtitle: "Slot approved" / "Slot pending", or null. Pure. */
export function itemSlotSubtitle(
  bundle: PlanBundle,
  item: PlanItemRow,
  side: ViewerSide,
): string | null {
  if (item.kind !== 'post') return null;
  const reviewSide = itemSlotSide(side, bundle.plan.audience);
  if (reviewSide === null) return null;
  return slotTicked(bundle, item.id, reviewSide) ? SLOT_APPROVED_LABEL : SLOT_PENDING_LABEL;
}

/** What a settled slot write shows: a toast title and whether it offers Undo. Pure. */
export function slotToastSpec(
  kind: 'tick' | 'untick' | 'undo',
  outcome: { ok: true } | { ok: false; message: string },
  dayHeader: string | null,
): { title: string; undo: boolean } | null {
  if (!outcome.ok) return { title: slotErrorCopy(outcome.message), undo: false };
  if (kind === 'tick') return { title: slotApprovedToast(dayHeader), undo: true };
  if (kind === 'untick') return { title: SLOT_REMOVED_TOAST, undo: false };
  return null;
}

/**
 * What Undo writes after a tick: the exact status the tick replaced
 * ('changes' stays 'changes'; waiting or no row is 'waiting'). Pure.
 */
export function slotUndoStatus(previous: ReviewStatus): ReviewStatus {
  return previous === 'changes' ? 'changes' : 'waiting';
}

// ---------------------------------------------------------------------------
// The aligned Plan list: header, progress, status line, add and move copy
// ---------------------------------------------------------------------------

/** "12 to 16 Oct" in one month, "28 Oct to 3 Nov" across two. Pure. */
export function planRangeShort(startsOn: string, endsOn: string): string {
  const [, sm] = startsOn.split('-');
  const [, em] = endsOn.split('-');
  if (sm === em && startsOn.slice(0, 4) === endsOn.slice(0, 4)) {
    return `${Number(startsOn.slice(8, 10))} to ${shortDay(endsOn)}`;
  }
  return `${shortDay(startsOn)} to ${shortDay(endsOn)}`;
}

/**
 * The Plan screen's subtitle, the same for every viewer: the range, then
 * "Draft" (audience team) or "Shared with client" (audience client). Pure.
 */
export function planHeaderSubtitle(
  plan: Pick<PlanBundle['plan'], 'starts_on' | 'ends_on' | 'audience'>,
): string {
  const range = planRangeShort(plan.starts_on, plan.ends_on);
  return `${range} · ${plan.audience === 'team' ? PLAN_DRAFT_LABEL : PLAN_OPEN_LABEL}`;
}

/** The progress block: the label, the bar's fill and tone. */
export interface ProgressView {
  lead: string;
  percent: number;
  tone: 'accent' | 'good';
}

/**
 * The same for every viewer: Draft "Team X of N" (the bar, accent), Open
 * "Client X of N" (the bar, good). Pure.
 */
export function planProgressView(bundle: PlanBundle): ProgressView {
  const p = planProgress(bundle);
  return {
    lead: progressLabel(p),
    percent: progressPercent(p),
    tone: p.side === 'team' ? 'accent' : 'good',
  };
}

/** The agency's status line under a row ("Client waiting"); null for anyone else. Pure. */
export function itemStatusLine(
  bundle: PlanBundle,
  item: PlanItemRow,
  side: ViewerSide,
): { label: string; tone: PillTone } | null {
  if (side !== 'agency') return null;
  const status = clientStatus(bundle, item);
  const word =
    status === 'approved' ? 'approved' : status === 'changes' ? 'changes asked' : 'waiting';
  return { label: `Client ${word}`, tone: toneOf(status) };
}

/** The Add sheet's title: "Add to Wed 14 Oct", or "Add to plan" with no day. Pure. */
export function addSheetTitle(dayHeader: string | null): string {
  return dayHeader === null ? 'Add to plan' : `Add to ${dayHeader}`;
}

/** The toast after an add: "Added to Wed 14 Oct" / "Concept added to Wed 14 Oct". Pure. */
export function addedToast(kind: 'concept' | 'post', dayHeader: string | null): string {
  const where = dayHeader === null ? 'the plan' : dayHeader;
  return kind === 'concept' ? `Concept added to ${where}` : `Added to ${where}`;
}

/** Add and move failure copy. */
export const ADD_FAILED = "Couldn't add. Try again.";
export const MOVE_FAILED = "Couldn't move this item. Try again.";
export const DATE_OUTSIDE_PLAN = 'That day is outside this plan.';
export const REMOVED_TOAST = 'Removed from plan';
export const REMOVE_FAILED = "Couldn't remove. Try again.";

/** A failed add or move's copy: the day refusal, else `fallback`. Pure. */
export function planWriteErrorCopy(message: string, fallback: string): string {
  return message.includes('date_outside_plan') ? DATE_OUTSIDE_PLAN : fallback;
}

/**
 * The toast after a move to another day: "Moved to Thu 15 Oct." and, when the
 * item had a tick that was not waiting, "Its ticks were reset." Pure.
 */
export function movedToast(dayHeader: string | null, ticksReset: boolean): string {
  const where = `Moved to ${dayHeader ?? 'No date'}.`;
  return ticksReset ? `${where} Its ticks were reset.` : where;
}

/** A row's visible comment count: "1 comment" / "N comments"; null when none. Pure. */
export function commentsLabel(count: number): string | null {
  if (!(count > 0)) return null;
  return count === 1 ? '1 comment' : `${count} comments`;
}

/**
 * The toast after a move that kept the approval: "Moved to Thu 15 Oct." (or
 * "Moved to No date."). Pure.
 */
export function movedKeptToast(dayHeader: string | null): string {
  return movedToast(dayHeader, false);
}

// ---------------------------------------------------------------------------
// Draft / Open: header menu, rename, delete, open for client, send, keep approval
// ---------------------------------------------------------------------------

export const RENAME_LABEL = 'Rename';
export const RENAMED_TOAST = 'Renamed';
export const RENAME_FAILED = "Couldn't rename. Try again.";
export const DELETE_PLAN_LABEL = 'Delete plan';
export const DELETE_PLAN_TITLE = 'Delete this plan?';
export const PLAN_DELETED_TOAST = 'Plan deleted';
export const DELETE_FORBIDDEN = "Only the plan's creator or a workspace admin can delete it.";
export const DELETE_FAILED = "Couldn't delete. Try again.";
export const OPEN_FOR_CLIENT_LABEL = 'Open for client';
export const OPEN_FOR_CLIENT_TITLE = 'Open this plan for client?';
export const OPEN_FOR_CLIENT_BODY =
  'Client can open it from any plan card in chat and tick slots. They get a notification. This cannot be undone.';
export const OPEN_FOR_CLIENT_TOAST = 'Open for client';
export const OPEN_FOR_CLIENT_FAILED = "Couldn't open for client. Try again.";
export const SEND_NEEDS_OPEN = 'Open the plan for client to send it here.';
export const SEND_FAILED = "Couldn't send. Try again.";
export const GO_TO_CARD_LABEL = 'Go to card';
export const CREATE_PLAN_LABEL = 'Create plan';
export const KEEP_APPROVAL_YES = 'Yes, keep it';
export const KEEP_APPROVAL_NO = 'No, ask again';

/** "Send in {chat name}". Pure. */
export function sendInLabel(chatName: string): string {
  return `Send in ${chatName}`;
}

/**
 * The delete confirm's body: the cards line, " Client gets a notification."
 * only on an Open plan, then " This cannot be undone." Pure.
 */
export function deletePlanBody(audience: PlanAudience): string {
  const notify = audience === 'client' ? ' Client gets a notification.' : '';
  return `Cards already in chat will show Plan deleted.${notify} This cannot be undone.`;
}

/** A delete's failure copy: forbidden_role names who may, else the generic line. Pure. */
export function deletePlanErrorCopy(message: string): string {
  return message.includes('forbidden_role') ? DELETE_FORBIDDEN : DELETE_FAILED;
}

/** Whether the viewer may delete the plan: its creator, or a workspace owner/admin. Pure. */
export function canDeletePlan(
  plan: Pick<PlanBundle['plan'], 'created_by'>,
  userId: string | null,
  role: string | null,
): boolean {
  if (userId !== null && plan.created_by !== null && plan.created_by === userId) return true;
  return isOwnerOrAdmin(role);
}

/** A rename's title, trimmed; null when it is outside 1 to 200 characters. Pure. */
export function renameTitle(raw: string): string | null {
  const title = raw.trim();
  return title.length >= 1 && title.length <= PLAN_TITLE_MAX ? title : null;
}

/**
 * The plan screen's send button: none outside a chat; "Go to card" when the
 * chat already holds a card for this plan; on the agency side "Send in
 * {chat}", disabled with SEND_NEEDS_OPEN on a Draft plan in a chat with a
 * client. A client only ever gets "Go to card".
 */
export type SendAction =
  | { kind: 'none' }
  | { kind: 'go' }
  | { kind: 'send'; label: string; disabled: boolean; hint: string | null };

/** The plan screen's send action (see SendAction). Pure. */
export function planSendAction(input: {
  side: ViewerSide;
  audience: PlanAudience;
  chat: { name: string; hasClient: boolean | null; cardInChat: boolean } | null;
}): SendAction {
  const chat = input.chat;
  if (chat === null) return { kind: 'none' };
  if (chat.cardInChat) return { kind: 'go' };
  if (input.side !== 'agency') return { kind: 'none' };
  const blocked = input.audience === 'team' && chat.hasClient === true;
  return {
    kind: 'send',
    label: sendInLabel(chat.name),
    disabled: blocked,
    hint: blocked ? SEND_NEEDS_OPEN : null,
  };
}

const CLIENT_REVIEW_ROWS = new WeakMap<PlanBundle, Map<string, PlanReviewRow>>();

/**
 * An item's client review row, when one is on record: indexed once per bundle
 * (no row scans the review list). Pure.
 */
export function clientReviewOf(bundle: PlanBundle, itemId: string): PlanReviewRow | undefined {
  let index = CLIENT_REVIEW_ROWS.get(bundle);
  if (index === undefined) {
    index = new Map();
    for (const r of bundle.reviews) if (r.side === 'client') index.set(r.item_id, r);
    CLIENT_REVIEW_ROWS.set(bundle, index);
  }
  return index.get(itemId);
}

/**
 * Who approved a slot and when, for an Open plan's client-approved row; null
 * otherwise (a Draft plan, not approved, or not recorded yet). Pure.
 */
export function approvedBy(
  bundle: PlanBundle,
  item: PlanItemRow,
): { userId: string | null; at: string } | null {
  if (bundle.plan.audience !== 'client') return null;
  const review = clientReviewOf(bundle, item.id);
  if (review === undefined || review.status !== 'approved') return null;
  if (review.reviewed_at === undefined || review.reviewed_at === null) return null;
  return { userId: review.reviewed_by ?? null, at: review.reviewed_at };
}

/** The user ids behind every Approved by line of a bundle (one batched name read). Pure. */
export function approverIds(bundle: PlanBundle): string[] {
  if (bundle.plan.audience !== 'client') return [];
  const ids = new Set<string>();
  for (const r of bundle.reviews) {
    if (r.side === 'client' && r.status === 'approved' && r.reviewed_by != null) {
      ids.add(r.reviewed_by);
    }
  }
  return [...ids];
}

/** "6:45 pm" for an instant in the zone. Pure. */
function clockInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${Number(get('hour'))}:${get('minute')} ${get('dayPeriod').toLowerCase()}`;
}

/**
 * When a slot was approved, in the workspace zone: "today, 6:45 pm",
 * "yesterday, 6:45 pm", else "12 Oct, 6:45 pm". Pure (given the clock).
 */
export function approvedWhen(iso: string, now: Date, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = todayInZone(at, timeZone);
  const today = civilToday(now, timeZone);
  const yesterday = addDays(today, -1);
  const lead = day === today ? 'today' : day === yesterday ? 'yesterday' : shortDay(day);
  return `${lead}, ${clockInZone(at, timeZone)}`;
}

/** "Approved by {name} · {when}". Pure. */
export function approvedByLine(name: string, when: string): string {
  return `Approved by ${name} · ${when}`;
}

/** The Also in pill: "Also in {title}", or "Also in N plans" for more than one. Pure. */
export function alsoInLabel(titles: readonly string[]): string | null {
  const first = titles[0];
  if (first === undefined) return null;
  return titles.length === 1 ? `Also in ${first}` : `Also in ${titles.length} plans`;
}

/**
 * Whether a move must ask "Keep the approval?": an Open plan, a day change,
 * and the item's client review approved. Every other move resets. Pure.
 */
export function moveAsksKeep(
  bundle: PlanBundle,
  item: PlanItemRow,
  fromDay: string | null,
  toDay: string | null,
): boolean {
  return bundle.plan.audience === 'client' && fromDay !== toDay && clientApproved(bundle, item);
}

/** The keep sheet's title: "Slot approved by {name}". Pure. */
export function keepApprovalTitle(name: string): string {
  return `Slot approved by ${name}`;
}

/** The keep sheet's body: "Moving it to {day}. Keep the approval?" Pure. */
export function keepApprovalBody(dayHeader: string | null): string {
  return `Moving it to ${dayHeader ?? NO_DATE_LABEL}. Keep the approval?`;
}

/** A day's header for toasts and sheets ("Thu 15 Oct"), null for No date. Pure. */
export function dayHeaderOf(day: string | null): string | null {
  return day !== null ? formatCivilDayHeader(day) : null;
}
