// The mobile move sheet: a long-press on a pipeline card opens this bottom sheet
// to move the post to another stage. It is presentational only - it never calls
// the stage-transition proc itself; selecting a valid target calls up to the
// page's single move handler (PipelinePage owns the proc call + toast + regroup).
//
// Rows mirror the client-side transition map (canTransition): targets that are
// legal from the post's current stage are enabled, the rest are disabled with a
// "Blocked" hint. The server proc remains the real guard; this is UI gating only.

import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { StageDot, stageLabel } from '@/components/pages/pipeline/stage-meta';
import { STAGE_TRANSITIONS, canTransition } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';

/** All workflow stages in the locked transition-map order. */
const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

export interface MoveSheetProps {
  open: boolean;
  /** The post being moved; null renders nothing (closed). */
  post: PipelinePost | null;
  onClose: () => void;
  /** Calls up to the page's single move handler; never the proc directly. */
  onMove: (postId: string, toStage: Stage) => void;
  /** Disables targets while a move is in flight for this post. */
  busy?: boolean;
}

/**
 * Bottom sheet listing every OTHER stage as a move target. Reuses the shared
 * Sheet primitive (bottom on mobile, centered on desktop), the StageDot/label
 * metadata, and the canTransition mirror. Every row is a >=44px touch target;
 * colour comes only through token-backed classes, so light/dark track index.css.
 */
export function MoveSheet({
  open,
  post,
  onClose,
  onMove,
  busy = false,
}: MoveSheetProps): ReactElement | null {
  if (post === null) {
    return null;
  }
  // posts.stage is a DB text column (typed string); it is one of the Stage values.
  const currentStage = post.stage as Stage;
  const targets = STAGES.filter((stage) => stage !== currentStage);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Move post"
      footer={
        <Button variant="ghost" size="lg" className="ml-auto" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <div className="truncate text-sm font-medium">{post.title}</div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-3">
            <span>Currently in</span>
            <StageDot stage={currentStage} />
            <span>{stageLabel(currentStage)}</span>
          </div>
        </div>
        <ul className="flex flex-col gap-1">
          {targets.map((target) => {
            const allowed = canTransition(currentStage, target);
            return (
              <li key={target}>
                <button
                  type="button"
                  disabled={!allowed || busy}
                  aria-disabled={!allowed}
                  onClick={() => onMove(post.id, target)}
                  className={cn(
                    'flex w-full min-h-[44px] items-center gap-2.5 rounded-lg px-3 text-left transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    allowed
                      ? 'text-fg hover:bg-panel-2 disabled:opacity-50'
                      : 'cursor-not-allowed text-fg-3',
                  )}
                >
                  <StageDot stage={target} />
                  <span className="text-sm font-medium">{stageLabel(target)}</span>
                  {!allowed ? <span className="ml-auto text-xs text-fg-3">Blocked</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </Sheet>
  );
}
