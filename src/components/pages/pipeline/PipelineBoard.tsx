import type { DragEvent, ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { PostCard } from '@/components/pages/PostCard';
import { StageDot, stageLabel } from '@/components/pages/pipeline/stage-meta';
import type { PresignCache } from '@/lib/asset-presign';
import { canTransition } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';

export interface PipelineBoardProps {
  /** Columns to render, in the locked STAGE order (all stages, or one per-stage view). */
  stages: Stage[];
  grouped: Record<Stage, PipelinePost[]>;
  /** Cards per column before the View all foot control; null shows them all (per-stage view). */
  cap: number | null;
  /** One shared presign cache for the whole board; never per-column or per-card. */
  cache: PresignCache;
  presignEnabled: boolean;
  /** Foot control on an overflowing column; the page decides what it switches to. */
  onViewAll: (stage: Stage) => void;
  /** A confirmed, legal drop calls up to the page's single move handler. */
  onMovePost: (postId: string, toStage: Stage) => void;
}

// Native HTML5 DnD keeps dataTransfer unreadable during dragover (it is exposed
// only on drop), so the source stage is stashed here on dragstart purely to drive
// the per-column drop affordance. The authoritative payload still rides
// dataTransfer ("fromStage:postId") and is re-read and re-checked on drop, so the
// move never relies on this module variable for correctness.
let draggingFrom: Stage | null = null;

const DROP_OK = ['ring-2', 'ring-accent', 'ring-inset'];

function onCardDragStart(event: DragEvent<HTMLDivElement>, post: PipelinePost): void {
  // posts.stage is a DB text column (typed string); it is one of the Stage values.
  draggingFrom = post.stage as Stage;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', `${post.stage}:${post.id}`);
}

function onCardDragEnd(): void {
  draggingFrom = null;
}

function onColumnDragOver(event: DragEvent<HTMLDivElement>, toStage: Stage): void {
  // Allow the drop (and show the affordance) only for a legal target.
  if (draggingFrom === null || !canTransition(draggingFrom, toStage)) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add(...DROP_OK);
}

function onColumnDragLeave(event: DragEvent<HTMLDivElement>): void {
  event.currentTarget.classList.remove(...DROP_OK);
}

function onColumnDrop(
  event: DragEvent<HTMLDivElement>,
  toStage: Stage,
  onMovePost: (postId: string, toStage: Stage) => void,
): void {
  event.preventDefault();
  event.currentTarget.classList.remove(...DROP_OK);
  draggingFrom = null;
  const [fromStage, postId] = event.dataTransfer.getData('text/plain').split(':');
  if (postId === undefined || postId === '') {
    return;
  }
  // Bounce an illegal drop: no state change, no error toast (the proc would only
  // re-reject it). canTransition is the same UI mirror the move sheet uses.
  if (!canTransition(fromStage as Stage, toStage)) {
    return;
  }
  onMovePost(postId, toStage);
}

/**
 * Desktop kanban: one fixed-width column per stage in the locked STAGE order,
 * horizontally scrolled. Cards are native-draggable items and columns are drop
 * targets; a drop onto a legal target (canTransition) calls up to the page's move
 * handler, an illegal drop bounces. No DnD library, native events only, and no
 * stageTransition call lives here. Capped columns surface a View all control at
 * the foot. Hookless (drag affordance toggles classes on the event target and the
 * payload rides dataTransfer) so the structure stays unit-testable by walking the
 * returned tree.
 */
export function PipelineBoard({
  stages,
  grouped,
  cap,
  cache,
  presignEnabled,
  onViewAll,
  onMovePost,
}: PipelineBoardProps): ReactElement {
  return (
    // Lock scrolling to the horizontal axis only: with bare overflow-x-auto the
    // y-axis resolves to auto, so a both-axis scroll fights the app-shell main.
    // overflow-y-hidden + min-h-0 keep vertical scrolling owned by the page.
    <div
      data-board-scroll
      className="flex min-h-0 gap-3 overflow-x-auto overflow-y-hidden px-4 py-4 md:px-6"
    >
      {stages.map((stage) => {
        const all = grouped[stage];
        const shown = cap === null ? all : all.slice(0, cap);
        const overflow = cap !== null && all.length > cap;
        return (
          <div
            key={stage}
            data-drag-container
            data-stage={stage}
            onDragOver={(event) => onColumnDragOver(event, stage)}
            onDragLeave={onColumnDragLeave}
            onDrop={(event) => onColumnDrop(event, stage, onMovePost)}
            className="flex w-[260px] shrink-0 flex-col rounded-xl border border-border bg-panel-2"
          >
            <div className="flex h-11 items-center gap-2 border-b border-border px-3">
              <StageDot stage={stage} />
              <span className="text-sm font-medium">{stageLabel(stage)}</span>
              <span className="ml-auto text-xs tabular-nums text-fg-3">{all.length}</span>
            </div>
            {all.length === 0 ? (
              <div className="flex min-h-[160px] items-center justify-center px-3 py-6 text-sm text-fg-3">
                Empty
              </div>
            ) : (
              <div className="flex flex-col gap-2 p-2">
                {shown.map((post) => (
                  <div
                    key={post.id}
                    data-drag-item
                    data-post-id={post.id}
                    draggable
                    onDragStart={(event) => onCardDragStart(event, post)}
                    onDragEnd={onCardDragEnd}
                    className="rounded-lg"
                  >
                    <PostCard post={post} cache={cache} presignEnabled={presignEnabled} />
                  </div>
                ))}
              </div>
            )}
            {overflow ? (
              <div className="border-t border-border p-2">
                <Button
                  variant="ghost"
                  size="lg"
                  className="w-full"
                  aria-label={`View all ${all.length}`}
                  onClick={() => onViewAll(stage)}
                >
                  View all {all.length}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
