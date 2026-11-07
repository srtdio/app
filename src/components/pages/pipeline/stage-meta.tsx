// Shared, stage-agnostic display metadata for the Pipeline surfaces (the
// list, the stage chips and the move sheet). Stage values flow in from the @srtdio/posts
// type; no workflow literals are invented here beyond the per-stage dot colour.

import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconPipeline } from '@/components/ui/icons';
import type { Stage } from '@srtdio/posts';

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

/** The small per-stage colour dot: the stage chips and the move sheet. */
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

/** The approve refusal a role that may not approve reads (never a move sheet row). */
export const APPROVE_ROLE_BLOCKED = 'Only approvers can approve.';

/**
 * An empty stage, the same on phone and laptop: the shared EmptyState with the
 * pipeline icon and the stage's one line, no heading and no action (the
 * toolbar's New post is the one way to create). `compact` drops the 320px
 * min-height (the list). Hookless, so the
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
        icon={<IconPipeline size={ICON_SIZE.tray} />}
        title={emptyStageMessage(stage)}
        compact={compact}
      />
    </div>
  );
}
