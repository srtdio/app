// Shared, stage-agnostic display metadata for the Pipeline board surfaces
// (desktop kanban + mobile feed). Stage values flow in from the @srtdio/posts
// type; no workflow literals are invented here beyond the per-stage dot colour.

import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { canRoleMove, roleMayTarget } from '@/components/pages/pcs/stage-actions';
import { STAGE_TRANSITIONS } from '@srtdio/posts';
import type { Stage } from '@srtdio/posts';

/** Cards shown before the Show more control (mobile feed) and per kanban column. */
export const BOARD_CAP = 6;

/** Title-case a single workflow stage for display. */
export function stageLabel(stage: Stage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/**
 * Stage dot background per stage, sourced from the existing stage-* theme tokens
 * (tailwind.config.ts + src/index.css), so light/dark parity is automatic. Draft
 * has no stage token, so it reuses the neutral fg-3 token rather than minting a
 * new hardcoded hex.
 */
const STAGE_DOT: Record<Stage, string> = {
  draft: 'bg-fg-3',
  review: 'bg-stage-review',
  approved: 'bg-stage-approved',
  parked: 'bg-stage-parked',
  rejected: 'bg-stage-rejected',
};

/**
 * The small per-stage colour dot. Single source for both board surfaces (desktop
 * kanban + mobile feed) and the move sheet; previously duplicated verbatim in
 * PipelineBoard and PipelineFeed.
 */
export function StageDot({ stage }: { stage: Stage }): ReactElement {
  return <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', STAGE_DOT[stage])} />;
}

/**
 * The one line an empty stage shows (phone feed, laptop column and laptop
 * single-stage grid alike). No heading.
 */
const EMPTY_STAGE_LINE: Record<Stage, string> = {
  draft: 'New posts start here.',
  review: 'Posts sent for review show up here.',
  approved: 'Approved posts show up here.',
  parked: 'Posts set aside for later show up here.',
  rejected: 'Posts sent back for changes show up here.',
};

/** Empty-stage copy: one line per stage. */
export function emptyStageMessage(stage: Stage): string {
  return EMPTY_STAGE_LINE[stage];
}

/** A blocked drop on Approved for a role that may not approve. */
export const APPROVE_ROLE_BLOCKED = 'Only approvers can approve.';

/** "Review", "Review or Parked", "Approved, Rejected or Parked". Pure. */
export function joinOr(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/** The stages this role may move a post into from `from`, in transition-map order. */
export function allowedTargets(role: string | null, from: Stage): Stage[] {
  return (STAGE_TRANSITIONS[from] as readonly Stage[]).filter((to) => canRoleMove(role, from, to));
}

/**
 * Why a drop from `from` onto `to` is blocked for this role, or null when the
 * move is allowed (or is a drop back onto its own stage). A role that may not
 * approve dropping on Approved: "Only approvers can approve." Otherwise the
 * moves this role has from here: "Draft posts can move to Review or Parked."
 * Null too when the role has no move at all (its cards are not draggable).
 */
export function moveBlockedReason(role: string | null, from: Stage, to: Stage): string | null {
  if (from === to || canRoleMove(role, from, to)) return null;
  if (to === 'approved' && !roleMayTarget(role, 'approved')) return APPROVE_ROLE_BLOCKED;
  const allowed = allowedTargets(role, from);
  if (allowed.length === 0) return null;
  return `${stageLabel(from)} posts can move to ${joinOr(allowed.map(stageLabel))}.`;
}

/**
 * An empty stage, the same on the phone feed and the laptop board: the shared
 * EmptyState with the pipeline icon and the stage's one line, no heading and
 * no action (the toolbar's New post is the one way to create). `compact` drops
 * the 320px min-height (the phone feed and a kanban column). Hookless, so the
 * tree is unit tested by walking it.
 */
export function StageEmpty({
  stage,
  compact = false,
}: {
  stage: Stage;
  compact?: boolean;
}): ReactElement {
  return (
    <div data-stage-empty={stage}>
      <EmptyState
        icon={<IconPipeline size={22} />}
        title={emptyStageMessage(stage)}
        compact={compact}
      />
    </div>
  );
}
