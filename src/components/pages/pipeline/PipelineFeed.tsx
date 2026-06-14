import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { useLongPress } from '@/components/ui/useLongPress';
import { PostCard } from '@/components/pages/PostCard';
import {
  BOARD_CAP,
  StageDot,
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
  /** A long-press on a card asks the page to open the move sheet for that post. */
  onLongPressPost: (post: PipelinePost) => void;
}

/**
 * One mobile card: a long-press (press-and-hold) target that asks the page to
 * open the move sheet, while a short tap still falls through to PostCard's own
 * navigation. PostCard is received as children so the board structure tests can
 * still find it by walking the element tree. The click that trails a long-press
 * is swallowed in the capture phase, before it reaches PostCard's nav button.
 */
function FeedCard({
  post,
  onLongPressPost,
  children,
}: {
  post: PipelinePost;
  onLongPressPost: (post: PipelinePost) => void;
  children: ReactNode;
}): ReactElement {
  const { handlers, consumeClickSuppression } = useLongPress(() => onLongPressPost(post));
  return (
    <div
      data-post-id={post.id}
      className="rounded-lg"
      onPointerDown={(event) => handlers.onPointerDown(event)}
      onPointerMove={(event) => handlers.onPointerMove(event)}
      onPointerUp={() => handlers.onPointerUp()}
      onPointerCancel={() => handlers.onPointerCancel()}
      onClickCapture={(event) => {
        if (consumeClickSuppression()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {children}
    </div>
  );
}

/**
 * A 2-column card grid. A plain helper (not a component) so each card's PostCard
 * is inlined into the feed tree (via FeedCard's children) and walkable by the
 * structure tests. Each card carries the long-press -> move gesture.
 */
function cardGrid(
  posts: PipelinePost[],
  cache: PresignCache,
  presignEnabled: boolean,
  onLongPressPost: (post: PipelinePost) => void,
): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2">
      {posts.map((post) => (
        <FeedCard key={post.id} post={post} onLongPressPost={onLongPressPost}>
          <PostCard post={post} cache={cache} presignEnabled={presignEnabled} />
        </FeedCard>
      ))}
    </div>
  );
}

/**
 * Mobile feed driven entirely by the stage tabs. The All tab renders one grouped
 * section per stage in the locked order, each capped at BOARD_CAP with a View all
 * affordance when it overflows; a single-stage tab renders that stage uncapped,
 * or the EmptyState when it holds nothing. Hookless at the top level (the only
 * hook lives in the per-card FeedCard) so the structure is unit-tested by walking
 * the returned tree.
 */
export function PipelineFeed({
  stages,
  grouped,
  activeStage,
  cache,
  presignEnabled,
  onViewAll,
  onLongPressPost,
}: PipelineFeedProps): ReactElement {
  if (activeStage !== 'all') {
    const stage = activeStage as Stage;
    const posts = grouped[stage] ?? [];
    return (
      <div data-feed-single data-stage={stage} className="px-4 py-4">
        {posts.length === 0 ? (
          <EmptyState icon={<IconPipeline size={22} />} title={emptyStageMessage(stage)} />
        ) : (
          cardGrid(posts, cache, presignEnabled, onLongPressPost)
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
              cardGrid(shown, cache, presignEnabled, onLongPressPost)
            )}
          </section>
        );
      })}
    </div>
  );
}
