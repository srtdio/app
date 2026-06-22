import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { useLongPress } from '@/components/ui/useLongPress';
import { PostCard } from '@/components/pages/PostCard';
import { BOARD_CAP, emptyStageMessage } from '@/components/pages/pipeline/stage-meta';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost, Stage } from '@srtdio/posts';

export interface PipelineFeedProps {
  /** The already filtered + sorted board list; the feed slices it by the cap. */
  posts: PipelinePost[];
  /** 'all' shows every post; a Stage key shows just that stage. */
  activeStage: string;
  /** One shared presign cache for the whole board; never per-section or per-card. */
  cache: PresignCache;
  presignEnabled: boolean;
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
 * Mobile feed: one flat 2-column grid over the active stage's posts, capped at
 * BOARD_CAP with an in-place Show more control that reveals another page rather
 * than navigating away. The 'all' tab shows every post; a single-stage tab shows
 * just that stage, or the EmptyState when it holds nothing. The shown count
 * resets whenever the active stage changes, so switching tabs never strands a
 * stale "expanded" depth on the new list.
 */
export function PipelineFeed({
  posts,
  activeStage,
  cache,
  presignEnabled,
  onLongPressPost,
}: PipelineFeedProps): ReactElement {
  const [shown, setShown] = useState(BOARD_CAP);
  useEffect(() => setShown(BOARD_CAP), [activeStage]);

  const list = activeStage === 'all' ? posts : posts.filter((post) => post.stage === activeStage);
  const view = list.slice(0, shown);

  return (
    <div className="px-4 py-4">
      {list.length === 0 ? (
        <EmptyState
          icon={<IconPipeline size={22} />}
          title={activeStage === 'all' ? 'No posts yet' : emptyStageMessage(activeStage as Stage)}
        />
      ) : (
        <>
          {cardGrid(view, cache, presignEnabled, onLongPressPost)}
          {list.length > shown ? (
            <div className="mt-4 flex justify-center">
              <Button variant="default" size="lg" onClick={() => setShown((s) => s + BOARD_CAP)}>
                Show {Math.min(BOARD_CAP, list.length - shown)} more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
