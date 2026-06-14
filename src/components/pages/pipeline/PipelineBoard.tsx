import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { PostCard } from '@/components/pages/PostCard';
import { STAGE_DOT, stageLabel } from '@/components/pages/pipeline/stage-meta';
import type { PresignCache } from '@/lib/asset-presign';
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
}

function StageDot({ stage }: { stage: Stage }): ReactElement {
  return <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', STAGE_DOT[stage])} />;
}

/**
 * Desktop kanban: one fixed-width column per stage in the locked STAGE order,
 * horizontally scrolled. Each column is a drag-READY container and each card a
 * drag-READY item (the data-* wrappers a DnD layer would attach to) but NO drag
 * behaviour, onDrop, or stage change is wired here; that lands in the move PR.
 * Capped columns surface a View all control at the foot. Pure (no hooks) so the
 * structure is unit-tested by walking the returned tree.
 */
export function PipelineBoard({
  stages,
  grouped,
  cap,
  cache,
  presignEnabled,
  onViewAll,
}: PipelineBoardProps): ReactElement {
  return (
    <div className="flex gap-3 overflow-x-auto px-4 py-4 md:px-6">
      {stages.map((stage) => {
        const all = grouped[stage];
        const shown = cap === null ? all : all.slice(0, cap);
        const overflow = cap !== null && all.length > cap;
        return (
          <div
            key={stage}
            data-drag-container
            data-stage={stage}
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
                {shown.map((post) => {
                  // TODO(PR4): drag handlers / onDrop wire onto this item; structural only here.
                  return (
                    <div key={post.id} data-drag-item data-post-id={post.id} className="rounded-lg">
                      <PostCard post={post} cache={cache} presignEnabled={presignEnabled} />
                    </div>
                  );
                })}
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
