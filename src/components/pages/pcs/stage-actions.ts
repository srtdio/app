// The role-gated stage rail. The SET of transition targets comes only from the
// authoritative STAGE_TRANSITIONS map (never re-decided here); this layer maps
// each legal target to a labelled button and decides VISIBILITY per role so the
// client only ever sees Approve / Reject, and the agency side sees Approve /
// Reject (on the client's behalf) plus Park / Send-or-move to review. This
// mirrors the server exactly: it never surfaces a button the stage_transition
// proc would reject. Pure, unit-tested.

import { STAGE_TRANSITIONS, canTransition, type Stage } from '@srtdio/posts';
import { isAgencySide, isClient, onBehalfOf } from '@/components/pages/pcs/roles';

/** One rendered stage button: its target stage, its label, and its emphasis. */
export interface StageAction {
  to: Stage;
  label: string;
  variant: 'primary' | 'default' | 'danger';
}

/**
 * The old on-behalf confirm line: "You are approving on behalf of Zomato."
 * The post screen now opens OnBehalfApproveSheet instead; kept for the
 * surfaces that still show the line.
 */
export function onBehalfConfirmLine(brand: string | null | undefined): string {
  return `You are approving ${onBehalfOf(brand)}.`;
}

/** The agency's review helper copy on the post page. */
export function agencyReviewHelper(brand: string | null | undefined): string {
  const name = brand?.trim() ?? '';
  const who = name !== '' ? `${name}'s approvers` : 'approvers';
  return `Waiting on ${who}. You can approve on their behalf.`;
}

/**
 * Whether a viewer in `role` may trigger a move INTO `to`, mirroring the
 * stage_transition proc: approved / rejected need post.approve (client and the
 * agency side); parked / review need post.edit (agency side only). An unknown
 * role may trigger nothing. Legality from the current stage is separate
 * ({@link canRoleMove}).
 */
export function roleMayTarget(role: string | null, to: Stage): boolean {
  if (to === 'approved' || to === 'rejected') return isClient(role) || isAgencySide(role);
  if (to === 'parked' || to === 'review') return isAgencySide(role);
  return false;
}

/** A legal move (STAGE_TRANSITIONS) that this role may also trigger. */
export function canRoleMove(role: string | null, from: Stage, to: Stage): boolean {
  return canTransition(from, to) && roleMayTarget(role, to);
}

/**
 * The buttons a viewer in `role` may press from `stage`. Walks the legal targets
 * in map order and keeps only the ones this role is allowed to trigger:
 *   approved  -> "Approve"          (client, or agency side on the client's behalf)
 *   rejected  -> "Reject"           (client, or agency side on the client's behalf)
 *   parked    -> "Park"             (agency side only)
 *   review    -> "Send for review" from draft, parked and rejected (agency)
 * An unknown role keeps nothing, so the caller falls back to a read-only status.
 */
export function visibleStageActions(stage: Stage, role: string | null): StageAction[] {
  const targets = STAGE_TRANSITIONS[stage] as readonly Stage[];
  const out: StageAction[] = [];
  for (const to of targets) {
    if (!roleMayTarget(role, to)) continue;
    if (to === 'approved') {
      out.push({ to, label: 'Approve', variant: 'primary' });
    } else if (to === 'rejected') {
      out.push({ to, label: 'Reject', variant: 'danger' });
    } else if (to === 'parked') {
      out.push({ to, label: 'Park', variant: 'default' });
    } else if (to === 'review') {
      out.push({ to, label: 'Send for review', variant: 'primary' });
    }
  }
  return out;
}

/** The confirm a reject or park opens on the post page, and its Undo toast label. */
export interface StageReasonConfirmCopy {
  title: string;
  confirmLabel: string;
  undoLabel: string;
}

/** The optional reason field's label, shared by the reject and park confirms. */
export const STAGE_REASON_LABEL = 'Reason (optional), goes to the comments';

/**
 * Reject and Park ask first (with an optional reason) and commit behind an Undo
 * window; every other target returns null and keeps its existing path.
 */
export function stageReasonConfirm(to: Stage): StageReasonConfirmCopy | null {
  if (to === 'rejected') {
    return { title: 'Reject this post?', confirmLabel: 'Reject', undoLabel: 'Post rejected' };
  }
  if (to === 'parked') {
    return { title: 'Park this post?', confirmLabel: 'Park', undoLabel: 'Post parked' };
  }
  return null;
}

/** The reason as a comment body: trimmed, or null when nothing was typed. */
export function stageReasonComment(reason: string): string | null {
  const body = reason.trim();
  return body === '' ? null : body;
}
