// Pure copy helpers for the Pipeline card and the move surfaces: whose turn a
// review post is, the approver names in the move helper, and the creator name
// in the reject confirm. "Approver" is the client role, "creator" the agency
// side (owner, admin, agency). No React, so every line is unit tested.

import { formatAgo } from '@/lib/display-date';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';
import { canRoleMove } from '@/components/pages/pcs/stage-actions';
import { STAGE_TRANSITIONS } from '@srtdio/posts';
import type { Stage } from '@srtdio/posts';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

/** What the card knows about the viewer: their role and the workspace's approvers. */
export interface CardViewer {
  role: string | null;
  /** The workspace's active approvers' first names, in member order. */
  approverFirstNames: readonly string[];
}

/** A review post's status line: the approver's turn, or who the creator is waiting on. */
export type ReviewStatus = { tone: 'you'; text: string } | { tone: 'with'; text: string };

/** The first word of a display name ("Meera Shah" -> "Meera"); '' for a blank name. */
export function firstNameOf(displayName: string | null | undefined): string {
  return (displayName ?? '').trim().split(/\s+/)[0] ?? '';
}

/**
 * The status line for a review post, or null for every other stage or an
 * unknown role. An approver sees "Waiting on you". A creator sees
 * "With {approver first name} · {time in stage}" when the workspace has one
 * approver, else "With approvers · {time}".
 */
export function reviewStatus(
  stage: Stage,
  stageEnteredAt: string,
  viewer: CardViewer,
  now: Date,
): ReviewStatus | null {
  if (stage !== 'review') return null;
  if (isClient(viewer.role)) return { tone: 'you', text: 'Waiting on you' };
  if (!isAgencySide(viewer.role)) return null;
  const only = viewer.approverFirstNames.length === 1 ? viewer.approverFirstNames[0] : undefined;
  const who = only !== undefined && only !== '' ? only : 'approvers';
  return { tone: 'with', text: `With ${who} · ${formatAgo(stageEnteredAt, now)}` };
}

/** Whether this viewer may make any move at all from `stage` (the card's ⋯ shows only then). */
export function hasAllowedMove(role: string | null, stage: Stage): boolean {
  return STAGES.some((to) => to !== stage && canRoleMove(role, stage, to));
}

/** "Meera", "Meera and Arjun", "Meera, Arjun and Kim". Pure. */
export function joinNames(names: readonly string[]): string {
  const clean = names.filter((name) => name !== '');
  if (clean.length <= 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

/** The Send for review helper: "{approver names} get it to approve." */
export function sendForReviewHelper(approverFirstNames: readonly string[]): string {
  const names = joinNames(approverFirstNames);
  if (names === '') return 'Approvers get it to approve.';
  const one = approverFirstNames.filter((name) => name !== '').length === 1;
  return `${names} ${one ? 'gets' : 'get'} it to approve.`;
}

/** The reject confirm body: "{creator first name} gets it back to rework. You can send a reason." */
export function rejectConfirmBody(creatorFirstName: string | null | undefined): string {
  const name = creatorFirstName?.trim() ?? '';
  return `${name !== '' ? name : 'The creator'} gets it back to rework. You can send a reason.`;
}
