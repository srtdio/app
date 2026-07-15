// Shared, stage-agnostic display metadata for the Pipeline board surfaces
// (desktop kanban + mobile feed). Stage values flow in from the @srtdio/posts
// type; no workflow literals are invented here beyond the per-stage dot colour.

import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
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

/** Empty-stage copy for the single-stage feed view. */
export function emptyStageMessage(stage: Stage): string {
  return `Nothing in ${stageLabel(stage)}. Posts land here when moved.`;
}
