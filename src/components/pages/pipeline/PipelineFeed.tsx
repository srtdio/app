import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { PostCard } from '@/components/pages/PostCard';
import {
  BOARD_CAP,
  STAGE_DOT,
  emptyStageMessage,
  stageLabel,
} from '@/components/pages/pipeline/stage-meta';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost, Stage } from '@srtdio/posts';

export interface PipelineFeedProps {
  /** Full STAGE order, used to lay out the All view's grouped sections. */
  stages: Stage[];
  grouped: Record<Stage, PipelinePost[]>;
  /** 'all' shows grouped sections; a Stage key shows that one stage uncapped. */
  activeStage: string;
  /** One shared presign cache for the whole board; never per-section or per-card. */
  cache: PresignCache;
  presignEnabled: boolean;
  /** "View all N" on a capped All-view section; the page switches the active tab. */
  onViewAll: (stage: Stage) => void;
}

function StageDot({ stage }: { stage: Stage }): ReactElement {
  return <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', STAGE_DOT[stage])} />;
}

/**
 * A 2-column card grid. A plain helper (not a component) so the rendered cards
 * are inlined into the feed tree and walkable by the structure tests. Each card
 * wrapper reserves an inert long-press gesture target for the later move PR.
 */
function cardGrid(
  posts: PipelinePost[],
  cache: PresignCache,
  presignEnabled: boolean,
): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2">
      {posts.map((post) => {
        // TODO(PR4): long-press -> move sheet. Wrapper is the reserved gesture target; inert here.
        return (
          <div key={post.id} data-post-id={post.id} className="rounded-lg">
            <PostCard post={post} cache={cache} presignEnabled={presignEnabled} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Mobile feed driven entirely by the stage tabs. The All tab renders one grouped
 * section per stage in the locked order, each capped at BOARD_CAP with a View all
 * affordance when it overflows; a single-stage tab renders that stage uncapped,
 * or the EmptyState when it holds nothing. Pure (no hooks) so the structure is
 * unit-tested by walking the returned tree.
 */
export function PipelineFeed({
  stages,
  grouped,
  activeStage,
  cache,
  presignEnabled,
  onViewAll,
}: PipelineFeedProps): ReactElement {
  if (activeStage !== 'all') {
    const stage = activeStage as Stage;
    const posts = grouped[stage] ?? [];
    return (
      <div data-feed-single data-stage={stage} className="px-4 py-4">
        {posts.length === 0 ? (
          <EmptyState icon={<IconPipeline size={22} />} title={emptyStageMessage(stage)} />
        ) : (
          cardGrid(posts, cache, presignEnabled)
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-4 py-4">
      {stages.map((stage) => {
        const all = grouped[stage];
        const shown = all.slice(0, BOARD_CAP);
        const overflow = all.length > BOARD_CAP;
        return (
          <section key={stage} data-feed-section data-stage={stage}>
            <div className="mb-2 flex items-center gap-2">
              <StageDot stage={stage} />
              <span className="text-sm font-medium">{stageLabel(stage)}</span>
              <span className="text-xs tabular-nums text-fg-3">{all.length}</span>
              {overflow ? (
                <span className="ml-auto">
                  <Button
                    variant="ghost"
                    size="lg"
                    aria-label={`View all ${all.length}`}
                    onClick={() => onViewAll(stage)}
                  >
                    View all {all.length}
                  </Button>
                </span>
              ) : null}
            </div>
            {all.length === 0 ? (
              <div className="rounded-lg border border-border bg-panel-2 px-3 py-6 text-center text-sm text-fg-3">
                Empty
              </div>
            ) : (
              cardGrid(shown, cache, presignEnabled)
            )}
          </section>
        );
      })}
    </div>
  );
}
