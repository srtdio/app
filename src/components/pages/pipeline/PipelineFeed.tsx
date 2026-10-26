import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconPipeline } from '@/components/ui/icons';
import { PostCard } from '@/components/pages/PostCard';
import { BOARD_CAP, StageEmpty } from '@/components/pages/pipeline/stage-meta';
import { readShown, writeShown } from '@/components/pages/pipeline/pipeline-query';
import type { PresignCache } from '@/lib/asset-presign';
import type { CoverLookup } from '@/lib/chat/post-covers';
import type { CardViewer } from '@/components/pages/pipeline/card-status';
import type { PipelinePost, Stage } from '@srtdio/posts';

interface PipelineFeedProps {
  /** The already filtered + sorted board list; the feed slices it by the cap. */
  posts: PipelinePost[];
  /** 'all' shows every post; a Stage key shows just that stage. */
  activeStage: string;
  /** One shared presign cache for the whole board; never per-section or per-card. */
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace key, threaded into every card for its pretty /p link. */
  workspaceKey?: string | null;
  /** The card's ⋯ Move row (also reached by long-press or right-click) opens the move sheet. */
  onLongPressPost: (post: PipelinePost, to?: Stage) => void;
  /**
   * sessionStorage key for the Show more depth, built from the filter query, so
   * Back to the same filters restores the same depth. Absent: not remembered.
   */
  shownKey?: string;
  /** The workspace zone each card reads its target (due) day in. Absent: the device zone. */
  timeZone?: string | null;
  /** The viewer's role and approvers: each card's status line and its ⋯. */
  viewer?: CardViewer;
  /** Each post's first photo or video, so its card takes the platform frame. */
  covers?: CoverLookup;
}

/**
 * One mobile card's cell. PostCard owns the gesture: a long-press (touch) or a
 * right-click (laptop) opens the card's ⋯ menu (Open, Copy link, Move), the
 * same menu on every surface, while a short tap falls through to its
 * navigation. PostCard is received as children so the board structure tests
 * can still find it by walking the element tree.
 */
function FeedCard({ post, children }: { post: PipelinePost; children: ReactNode }): ReactElement {
  return (
    <div data-post-id={post.id} className="h-full min-w-0 rounded-lg">
      {children}
    </div>
  );
}

/**
 * A 2-column card grid. A plain helper (not a component) so each card's PostCard
 * is inlined into the feed tree (via FeedCard's children) and walkable by the
 * structure tests. Each card's long-press / right-click opens its ⋯ menu.
 */
function cardGrid(
  posts: PipelinePost[],
  cache: PresignCache,
  presignEnabled: boolean,
  onLongPressPost: (post: PipelinePost, to?: Stage) => void,
  workspaceKey: string | null,
  showStage: boolean,
  timeZone: string | null | undefined,
  viewer: CardViewer | undefined,
  covers: CoverLookup | undefined,
): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2">
      {posts.map((post) => (
        <FeedCard key={post.id} post={post}>
          <PostCard
            post={post}
            cache={cache}
            presignEnabled={presignEnabled}
            workspaceKey={workspaceKey}
            onMove={onLongPressPost}
            showStage={showStage}
            timeZone={timeZone}
            {...(viewer !== undefined ? { viewer } : {})}
            {...(covers !== undefined ? { cover: covers(post.id) } : {})}
          />
        </FeedCard>
      ))}
    </div>
  );
}

/**
 * Mobile feed: one flat 2-column grid over the active stage's posts, capped at
 * BOARD_CAP with an in-place Show more control that reveals another page rather
 * than navigating away. The 'all' tab shows every post; a single-stage tab shows
 * just that stage, or the stage's one-line empty state when it holds nothing. The shown count is
 * keyed by the filter query (shownKey) in sessionStorage: a new tab or filter
 * starts at the cap, and Back to the same filters restores the same depth.
 */
export function PipelineFeed({
  posts,
  activeStage,
  cache,
  presignEnabled,
  workspaceKey = null,
  onLongPressPost,
  shownKey,
  timeZone,
  viewer,
  covers,
}: PipelineFeedProps): ReactElement {
  const depthKey = shownKey ?? null;
  const [shown, setShown] = useState(() =>
    depthKey === null ? BOARD_CAP : readShown(depthKey, BOARD_CAP),
  );
  useEffect(
    () => setShown(depthKey === null ? BOARD_CAP : readShown(depthKey, BOARD_CAP)),
    [activeStage, depthKey],
  );
  const showMore = (): void => {
    const next = shown + BOARD_CAP;
    setShown(next);
    if (depthKey !== null) writeShown(depthKey, next);
  };

  const list = activeStage === 'all' ? posts : posts.filter((post) => post.stage === activeStage);
  const view = list.slice(0, shown);

  return (
    <div className="px-4 py-4">
      {list.length === 0 ? (
        activeStage === 'all' ? (
          <EmptyState icon={<IconPipeline size={ICON_SIZE.tray} />} title="Posts show up here." />
        ) : (
          <StageEmpty stage={activeStage as Stage} compact />
        )
      ) : (
        <>
          {cardGrid(
            view,
            cache,
            presignEnabled,
            onLongPressPost,
            workspaceKey,
            activeStage === 'all',
            timeZone,
            viewer,
            covers,
          )}
          {list.length > shown ? (
            <div className="mt-4 flex justify-center">
              <Button variant="default" onClick={showMore}>
                Show {Math.min(BOARD_CAP, list.length - shown)} more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
