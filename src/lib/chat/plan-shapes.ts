// Which shape each plan card takes for this viewer, for this tab session: a
// full plan card (exactly its skeleton's 217px, PLAN_CARD) or another shape
// (a plan the viewer cannot read paints the shorter unavailable card). Shape
// only, never data: no plan bundle from an earlier read is ever painted (the
// cards still read their own, PlanCardsProvider). A kept chat open (its page
// remembered) paints its rows in the first frame only while every plan card
// on that page is known to be a full card: its skeleton then has the card's
// final height and the card fills in place without moving a row. A card of
// unknown or other shape keeps the open on its hold instead (MessageThread).
//
// Filled from every open's settled plan read and from the pre-warm's one
// batched read of the plans on the pages it kept. A failed read records
// nothing. Keyed by user and workspace; cleared with the chat memory
// (open-cache.ts: sign-out, account or workspace switch).

import type { PlanBundle } from '@/lib/chat/plans';

/** The shape a plan card paints in: 'card' is exactly the skeleton's height. */
export type PlanShape = 'card' | 'other';

const shapes = new Map<string, PlanShape>();

function shapeKey(userId: string, workspaceId: string, planId: string): string {
  return `${userId}\n${workspaceId}\n${planId}`;
}

/**
 * A settled plan read for `asked`: each id it returned is a full card, each
 * it did not is another shape (not readable here). Ids whose read failed
 * (`failed`) are left as they were.
 */
export function notePlanShapes(
  userId: string,
  workspaceId: string,
  asked: readonly string[],
  bundles: ReadonlyMap<string, PlanBundle>,
  failed: readonly string[] = [],
): void {
  const skip = new Set(failed);
  for (const id of asked) {
    if (skip.has(id)) continue;
    shapes.set(shapeKey(userId, workspaceId, id), bundles.has(id) ? 'card' : 'other');
  }
}

/** Whether every one of these plan cards is known to paint at its skeleton's height. */
export function planCardsSized(
  userId: string,
  workspaceId: string,
  planIds: readonly string[],
): boolean {
  return planIds.every((id) => shapes.get(shapeKey(userId, workspaceId, id)) === 'card');
}

/** Forget every shape (the chat memory was cleared; tests). */
export function clearPlanShapes(): void {
  shapes.clear();
}
