// Pure order math behind the Plan screen's edit mode (drag, the day chip,
// remove): the list as day groups in display order, one item moved to a day
// at an index, the full plan order plan_item_move takes, and the edit queue:
// the plan_save ops a Save changes sends, in order, and the bundle as those
// ops leave it (what edit mode paints before anything is written). No React,
// no reads, so every case is unit-tested directly.

import type { PlanSaveOp } from '@srtdio/rpc';
import { planItemDayInZone, sortPlanItemsByDate, type PlanBundle } from '@/lib/chat/plans';
import { civilNoonInZoneIso } from '@/lib/plan-week';

/** One day group of the list, in display order: its day (null = No date) and item ids. */
export interface DayIds {
  day: string | null;
  ids: string[];
}

/** Where an item sits: its day group's day and its index within it. */
export interface DayIndex {
  day: string | null;
  index: number;
}

/** The full plan order: every day group's ids in display order. Pure. */
export function flattenOrder(days: readonly DayIds[]): string[] {
  return days.flatMap((d) => d.ids);
}

/** Where `itemId` sits now, or null when it is in no group. Pure. */
export function findItem(days: readonly DayIds[], itemId: string): DayIndex | null {
  for (const d of days) {
    const index = d.ids.indexOf(itemId);
    if (index >= 0) return { day: d.day, index };
  }
  return null;
}

/**
 * The groups with `itemId` taken out of its day and put into `toDay` at
 * `toIndex` (clamped; the index counts the target day's items without the
 * moved one). A day not yet in the groups is ignored (the item stays). Pure.
 */
export function moveItem(
  days: readonly DayIds[],
  itemId: string,
  toDay: string | null,
  toIndex: number,
): DayIds[] {
  if (findItem(days, itemId) === null || !days.some((d) => d.day === toDay)) {
    return days.map((d) => ({ day: d.day, ids: [...d.ids] }));
  }
  return days.map((d) => {
    const ids = d.ids.filter((id) => id !== itemId);
    if (d.day !== toDay) return { day: d.day, ids };
    const at = Math.max(0, Math.min(toIndex, ids.length));
    ids.splice(at, 0, itemId);
    return { day: d.day, ids };
  });
}

/** The groups with `itemId` moved to the end of `toDay` (the Move sheet). Pure. */
export function moveToEnd(days: readonly DayIds[], itemId: string, toDay: string | null): DayIds[] {
  const target = days.find((d) => d.day === toDay);
  const size = target === undefined ? 0 : target.ids.filter((id) => id !== itemId).length;
  return moveItem(days, itemId, toDay, size);
}

/** Whether a move changes nothing (same day, same index). Pure. */
export function isNoop(days: readonly DayIds[], itemId: string, to: DayIndex): boolean {
  const from = findItem(days, itemId);
  return from !== null && from.day === to.day && from.index === to.index;
}

/**
 * The drop index within a day from the pointer: how many of the day's rows
 * (the dragged one left out) have their middle above `y`. Pure.
 */
export function dropIndex(rowMiddles: readonly number[], y: number): number {
  let index = 0;
  for (const middle of rowMiddles) if (middle < y) index += 1;
  return index;
}

/**
 * The bundle as a move leaves it, for the optimistic paint: the item's day set
 * (a concept's plan_items.target_date; a post slot's post date, noon in the
 * workspace zone, as plan_item_move writes it), every position taken from
 * `order`, the items re-sorted by date, and the item's reviews dropped (read
 * as waiting) when its day changed, as the server resets them, unless the
 * move keeps them (`keep`). Pure.
 */
export function applyMove(
  bundle: PlanBundle,
  itemId: string,
  toDay: string | null,
  order: readonly string[],
  timeZone = 'UTC',
  keep = false,
): PlanBundle {
  const position = new Map(order.map((id, i) => [id, i]));
  const before = bundle.items.find((i) => i.id === itemId);
  const fromDay =
    before === undefined ? null : planItemDayInZone(before, bundle.postInfo, timeZone);
  const dayChanged = before !== undefined && fromDay !== toDay;
  const postId = before?.kind === 'post' ? before.post_id : null;
  const postInfo =
    postId !== null && dayChanged
      ? {
          ...bundle.postInfo,
          [postId]: {
            ...(bundle.postInfo[postId] ?? { title: '' }),
            target_date: toDay !== null ? civilNoonInZoneIso(toDay, timeZone) : null,
          },
        }
      : bundle.postInfo;
  const items = bundle.items.map((i) => ({
    ...i,
    position: position.get(i.id) ?? i.position,
    ...(i.id === itemId && i.kind === 'concept' ? { target_date: toDay } : {}),
  }));
  return {
    ...bundle,
    postInfo,
    items: sortPlanItemsByDate(items, postInfo, timeZone),
    reviews:
      dayChanged && !keep ? bundle.reviews.filter((r) => r.item_id !== itemId) : bundle.reviews,
  };
}

/** Whether the item has any slot tick that is not waiting (its move resets it). Pure. */
export function hasTicks(bundle: Pick<PlanBundle, 'reviews'>, itemId: string): boolean {
  return bundle.reviews.some((r) => r.item_id === itemId && r.status !== 'waiting');
}

// ---------------------------------------------------------------------------
// The edit queue (Save changes)
// ---------------------------------------------------------------------------

/** The title and dates edit mode's header holds. */
export interface PlanHeaderDraft {
  title: string;
  startsOn: string;
  endsOn: string;
}

/** The header draft as the plan is now. Pure. */
export function headerDraftOf(
  plan: Pick<PlanBundle['plan'], 'title' | 'starts_on' | 'ends_on'>,
): PlanHeaderDraft {
  return { title: plan.title, startsOn: plan.starts_on, endsOn: plan.ends_on };
}

/**
 * The queue with the header draft laid in: one 'update' op, first (dates
 * widen before any move lands on a new day), replaced on every edit and
 * dropped when the draft is back to what the plan holds. The title is
 * trimmed; an empty one keeps the plan's. Pure.
 */
export function withHeaderUpdate(
  ops: readonly PlanSaveOp[],
  plan: Pick<PlanBundle['plan'], 'title' | 'starts_on' | 'ends_on'>,
  draft: PlanHeaderDraft,
): PlanSaveOp[] {
  const rest = ops.filter((op) => op.op !== 'update');
  const title = draft.title.trim() === '' ? plan.title : draft.title.trim();
  const same =
    title === plan.title && draft.startsOn === plan.starts_on && draft.endsOn === plan.ends_on;
  if (same) return rest;
  return [
    { op: 'update', title, starts_on: draft.startsOn, ends_on: draft.endsOn },
    ...rest,
  ];
}

/** The queue with one more op at its end. Pure. */
export function queueOp(ops: readonly PlanSaveOp[], op: PlanSaveOp): PlanSaveOp[] {
  return [...ops, op];
}

/** Whether a Save would write anything. Pure. */
export function hasQueuedOps(ops: readonly PlanSaveOp[]): boolean {
  return ops.length > 0;
}

/** The item ids a 'remove' op in the queue hides. Pure. */
export function removedIds(ops: readonly PlanSaveOp[]): Set<string> {
  const out = new Set<string>();
  for (const op of ops) if (op.op === 'remove') out.add(op.item_id);
  return out;
}

/**
 * The bundle as the queue leaves it, for edit mode's paint: the header
 * update on the plan, removed items (and their reviews) gone, each move as
 * applyMove paints it, each reorder's positions. Nothing is written. Pure.
 */
export function applyPlanOps(
  bundle: PlanBundle,
  ops: readonly PlanSaveOp[],
  timeZone = 'UTC',
): PlanBundle {
  let next = bundle;
  for (const op of ops) {
    if (op.op === 'update') {
      next = {
        ...next,
        plan: { ...next.plan, title: op.title, starts_on: op.starts_on, ends_on: op.ends_on },
      };
    } else if (op.op === 'remove') {
      next = {
        ...next,
        items: next.items.filter((i) => i.id !== op.item_id),
        reviews: next.reviews.filter((r) => r.item_id !== op.item_id),
      };
    } else if (op.op === 'move') {
      next = applyMove(next, op.item_id, op.target_date, op.item_ids, timeZone, op.keep_reviews);
    } else {
      const position = new Map(op.item_ids.map((id, i) => [id, i]));
      const items = next.items.map((i) => ({ ...i, position: position.get(i.id) ?? i.position }));
      next = { ...next, items: sortPlanItemsByDate(items, next.postInfo, timeZone) };
    }
  }
  return next;
}
