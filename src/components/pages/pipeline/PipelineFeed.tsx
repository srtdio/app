import { cn } from '@/lib/cn';
import { GUTTER } from '@/components/ui/layout';
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconPipeline } from '@/components/ui/icons';
import { LIST_CARD_GRID } from '@/components/ui/ListCard';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { PostCard } from '@/components/pages/PostCard';
import { BOARD_CAP, StageEmpty } from '@/components/pages/pipeline/stage-meta';
import { readShown, writeShown } from '@/components/pages/pipeline/pipeline-query';
import type { PresignCache } from '@/lib/asset-presign';
import type { CoverLookup } from '@/lib/chat/post-covers';
import type { CardViewer } from '@/components/pages/pipeline/card-status';
import type { PipelinePost, Stage } from '@srtdio/posts';

interface PipelineFeedProps {
  /** The already filtered + sorted list; the feed slices it by the cap. */
  posts: PipelinePost[];
  /** 'all' shows every post; a Stage key shows just that stage. */
  activeStage: string;
  /** One shared presign cache for the whole list; never per-card. */
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace key, threaded into every card for its pretty /p link. */
  workspaceKey?: string | null;
  /** The card's ⋮ move rows (also reached by long-press or right-click). */
  onLongPressPost: (post: PipelinePost, to?: Stage) => void;
  /**
   * sessionStorage key for the Show more depth, built from the filter query, so
   * Back to the same filters restores the same depth. Absent: not remembered.
   */
  shownKey?: string;
  /** The workspace zone each card reads its target (due) day in. Absent: the device zone. */
  timeZone?: string | null;
  /** The viewer's role and approvers: each card's status line and its ⋮. */
  viewer?: CardViewer;
  /** Each post's first photo or video (a video with no poster shows the play placeholder). */
  covers?: CoverLookup;
}

/**
 * The cards in ui/ListCard's page grid (LIST_CARD_GRID: one column on phone,
 * auto-fill columns at least 360 wide on laptop, 12 apart). A plain helper (not
 * a component) so each PostCard is inlined into the feed tree and walkable by
 * the structure tests. `now` is the feed's one minute clock.
 */
function cardGrid(
  posts: PipelinePost[],
  cache: PresignCache,
  presignEnabled: boolean,
  onLongPressPost: (post: PipelinePost, to?: Stage) => void,
  workspaceKey: string | null,
  timeZone: string | null | undefined,
  viewer: CardViewer | undefined,
  covers: CoverLookup | undefined,
  now: Date,
): ReactElement {
  return (
    <div data-pipeline-list="" className={LIST_CARD_GRID}>
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          cache={cache}
          presignEnabled={presignEnabled}
          workspaceKey={workspaceKey}
          onMove={onLongPressPost}
          timeZone={timeZone}
          now={now}
          {...(viewer !== undefined ? { viewer } : {})}
          {...(covers !== undefined ? { cover: covers(post.id) } : {})}
        />
      ))}
    </div>
  );
}

/**
 * The Pipeline list, phone and laptop alike: the active stage's posts as
 * ui/ListCard cards in LIST_CARD_GRID, capped at BOARD_CAP with an in-place
 * Show more control that reveals another page rather than navigating away. The
 * 'all' chip shows every post; a stage chip shows just that stage, or the
 * stage's one-line empty state when it holds nothing. The shown count is keyed
 * by the filter query (shownKey) in sessionStorage: a new chip or filter starts
 * at the cap, and Back to the same filters restores the same depth. One minute
 * clock (useMinuteClock) for every card's due and status time.
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
  const nowMs = useMinuteClock();
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
    <div className={cn('py-4', GUTTER)}>
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
            timeZone,
            viewer,
            covers,
            new Date(nowMs),
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
