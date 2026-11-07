import { mark } from '@/lib/perf-marks';
import { useState, type ComponentType, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Thumbnail } from '@/components/media';
import {
  ICON_SIZE,
  IconArrowUpRight,
  IconCarousel,
  IconCheck,
  IconLink,
  IconPause,
  IconPlay,
  IconSwitch,
  IconX,
  type IconProps,
} from '@/components/ui/icons';
import type { PresignCache } from '@/lib/asset-presign';
import { entityUrlPath, refOpenState } from '@/lib/entityRef';
import { confirmPostOpen, prefetchPostOpen } from '@/lib/post-prefetch';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { stageLabel } from '@/components/pages/pipeline/stage-meta';
import { moveActions } from '@/components/pages/pipeline/MoveSheet';
import {
  hasAllowedMove,
  reviewStatus,
  type CardViewer,
} from '@/components/pages/pipeline/card-status';
import { daysFromToday, formatDue, formatOverdue } from '@/lib/time';
import { ActionMenu, type ActionMenuItem, ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { ListCard, type ListCardHooks, type ListCardPicture } from '@/components/ui/ListCard';
import { PostPlaceholder, postPlaceholderKind } from '@/components/ui/PostPlaceholder';
import {
  unreadCommentsLabel,
  useEntityUnread,
  useEntityUnreadComment,
  withCommentTarget,
} from '@/lib/inbox/unread-entities';
import { rememberCard } from '@/lib/motion';
import { useGrowBackIntoCard } from '@/lib/motion/pages';
import { useMenuGesture } from '@/components/ui/useLongPress';
import { useOptionalToast } from '@/components/ui/toast';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { buildPostLink } from '@/lib/post-share';
import type { CardFirstMedia } from '../../../packages/posts/src/reads';
import type { PipelinePost, Stage } from '@srtdio/posts';

export interface PostCardProps {
  post: PipelinePost;
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace's key, used to build the pretty /p/KEY-N link. When
   *  absent the card falls back to the classic /posts/:id route. */
  workspaceKey?: string | null;
  /**
   * Renders the ⋮ (ui/ActionMenu) at the end of line 3. With a known role the
   * menu lists each move this viewer can make (Send for review, Approve, Park,
   * Reject) and calls this with its target; without one it has a single Move
   * row that calls it with no target (the move sheet).
   */
  onMove?: (post: PipelinePost, to?: Stage) => void;
  /**
   * The viewer's role and the workspace approvers: drives the review status line
   * and hides the ⋮ menu's Move row when this viewer has no allowed move.
   * Absent: no status line, and Move shows whenever onMove is passed.
   */
  viewer?: CardViewer;
  /**
   * The post's first photo or video (the chat card's cover read): a video with
   * no poster shows the play placeholder. undefined while unknown.
   */
  cover?: CardFirstMedia | null | undefined;
  /**
   * The clock the due and status times read against: the list's one minute
   * clock (useMinuteClock in PipelineFeed), never a timer per card. Default: now.
   */
  now?: Date;
  /**
   * The workspace's IANA zone: target_date is a due date, a calendar day on the
   * workspace zone (src/lib/time.ts). Absent or null: the device zone.
   */
  timeZone?: string | null | undefined;
}

/** The card's due reading: the due line, or the overdue line in the bad tone. */
export interface CardDue {
  text: string;
  overdue: boolean;
}

/**
 * Line 3's time: "Due today", "Due tomorrow", "Due in 3 days", "Due 12 Dec"
 * (formatDue) while the day is today or ahead; once the civil day (on the
 * workspace zone) has passed, "Overdue 1 day" / "Overdue 2 months"
 * (formatOverdue) in the bad tone. An approved post is done, so it never reads
 * overdue. An unparseable value reads '' (no time). Pure.
 */
export function cardDue(
  value: string,
  stage: Stage,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): CardDue {
  const days = daysFromToday(value, workspaceZone, now);
  if (days === undefined) return { text: '', overdue: false };
  if (days < 0 && stage !== 'approved') {
    return { text: formatOverdue(value, workspaceZone, now).text, overdue: true };
  }
  return { text: formatDue(value, workspaceZone, now), overdue: false };
}

/** Formats whose media is a video. */
const VIDEO_FORMATS: readonly string[] = ['video', 'reel', 'story', 'short'];

/**
 * What the card's picture shows: the post's picture ('image'), the play
 * placeholder for a video with no poster ('video'), or the "Aa" placeholder
 * for a post with no media ('none', a text post). Pure.
 */
export type CardCoverKind = 'image' | 'video' | 'none';

export function cardCoverKind(
  post: Pick<PipelinePost, 'format' | 'thumbnailAssetVersionId'>,
  cover: CardFirstMedia | null | undefined,
): CardCoverKind {
  if (post.thumbnailAssetVersionId !== null) return 'image';
  if (cover?.kind === 'video' || VIDEO_FORMATS.includes(post.format)) return 'video';
  return 'none';
}

/** The caption as plain text (captions never format), or null when there is none. */
export function captionPreview(post: Pick<PipelinePost, 'caption'>): string | null {
  return post.caption !== null && post.caption.trim() !== '' ? post.caption : null;
}

/** The ⋮ trigger's name: "Actions for {title}", then the unread comments when any. Pure. */
export function cardMenuLabel(title: string, unreadComments: number): string {
  return unreadComments > 0
    ? `Actions for ${title}, ${unreadCommentsLabel(unreadComments)}`
    : `Actions for ${title}`;
}

/** A small "multiple images" badge (stacked squares) on a carousel post's picture. */
function CarouselBadge() {
  return (
    <span
      aria-label="Carousel"
      className="pointer-events-none absolute left-1 top-1 inline-flex h-6 min-w-6 items-center justify-center rounded-lg bg-overlay-badge text-overlay-fg lit-media"
    >
      <IconCarousel size={ICON_SIZE.inline} />
    </span>
  );
}

/** A centred play badge painted over a video post's poster picture. */
function PlayBadge() {
  return (
    <span
      aria-label="Video"
      className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-overlay-badge text-overlay-fg lit-media"
    >
      <IconPlay size={ICON_SIZE.inline} />
    </span>
  );
}

/** One move row in the card's ⋮ menu (the move sheet's actions, moveActions). */
export interface CardMoveRow {
  to: Stage;
  label: string;
  tone: 'default' | 'bad';
  onSelect: () => void;
}

/** What the card's ⋮ menu runs. */
export interface CardMenuActions {
  onOpen: () => void;
  onCopyLink: () => void;
  /** The viewer's moves, each its own row; when present, no Move row. */
  moves?: readonly CardMoveRow[];
  /** Absent: this viewer has no allowed move, so the Move row is hidden. */
  onMove?: () => void;
}

/** One icon per move: Send for review arrow, Approve check, Park pause, Reject X. */
const MOVE_ICON: Record<Stage, ComponentType<IconProps>> = {
  draft: IconSwitch,
  review: IconArrowUpRight,
  approved: IconCheck,
  parked: IconPause,
  rejected: IconX,
};

/**
 * The card's ⋮ rows: Open, Copy link, then every move this viewer can make
 * (the same moves the move sheet lists), else Move when allowed. Pure.
 */
export function cardMenuItems(actions: CardMenuActions): ActionMenuItem[] {
  const moves: ActionMenuItem[] =
    actions.moves !== undefined && actions.moves.length > 0
      ? actions.moves.map((move) => ({
          id: `move-${move.to}`,
          label: move.label,
          icon: MOVE_ICON[move.to],
          ...(move.tone === 'bad' ? { tone: 'danger' as const } : {}),
          onSelect: move.onSelect,
        }))
      : actions.onMove !== undefined
        ? [{ id: 'move', label: 'Move', icon: IconSwitch, onSelect: actions.onMove }]
        : [];
  return [
    { id: 'open', label: 'Open', icon: IconArrowUpRight, onSelect: actions.onOpen },
    { id: 'copy-link', label: 'Copy link', icon: IconLink, onSelect: actions.onCopyLink },
    ...moves,
  ];
}

/**
 * The picture slot: the post's picture (its small copy; the "Aa" or play
 * placeholder while it cannot show), the play placeholder for a video with no
 * poster, or "Aa" for a text post. Pure.
 */
function cardPicture(
  post: PipelinePost,
  coverKind: CardCoverKind,
  cache: PresignCache,
  presignEnabled: boolean,
): { picture: ListCardPicture; hooks: ListCardHooks } {
  if (coverKind === 'image') {
    let badge: ReactNode = null;
    if (post.format === 'carousel') badge = <CarouselBadge />;
    else if (post.format === 'video') badge = <PlayBadge />;
    return {
      picture: {
        kind: 'image',
        node: (
          <Thumbnail
            assetVersionId={post.thumbnailAssetVersionId}
            cache={cache}
            presignEnabled={presignEnabled}
            aspect="square"
            fallback={{ kind: 'glyph' }}
            fallbackTile={
              <PostPlaceholder
                kind={postPlaceholderKind(post.format)}
                size={ICON_SIZE.picture}
                fill
              />
            }
            alt={post.title}
          >
            {badge}
          </Thumbnail>
        ),
      },
      hooks: { 'data-post-card-thumb': '' },
    };
  }
  if (coverKind === 'video') {
    return {
      picture: { kind: 'placeholder', placeholder: 'video' },
      hooks: { 'data-post-card-play': '' },
    };
  }
  return { picture: { kind: 'placeholder', placeholder: 'text' }, hooks: {} };
}

/**
 * A Pipeline post on ui/ListCard. Picture: the post's picture, else the play
 * placeholder (a video with no poster) or "Aa" (a text post). Line 1: the
 * title and the unread dot (unread comments). Line 2: the review status line
 * ("With Maya · 3 hours ago", "Waiting on you") over the caption on one line,
 * or the caption on two lines when there is no status. Line 3: the due or
 * overdue time, the stage tag and the ⋮ (Open, Copy link and the viewer's
 * moves; its name carries the unread comment count). The whole card opens the
 * post (onPress); a long-press on touch or a right-click on laptop opens the
 * same ⋮ menu (useMenuGesture).
 */
export function PostCard({
  post,
  cache,
  presignEnabled,
  workspaceKey = null,
  onMove,
  viewer,
  cover,
  now,
  timeZone,
}: PostCardProps) {
  const navigate = useNavigate();
  const toast = useOptionalToast();
  // Prefer the pretty link (/p/KEY-N); the classic /posts/:id route remains a
  // working fallback when the key has not resolved yet.
  const href =
    workspaceKey !== null ? entityUrlPath('post', workspaceKey, post.number) : `/posts/${post.id}`;
  // The card already holds the post's id: the pretty link carries it in router
  // state, so /p/:ref renders the post without looking the ref up.
  const openState =
    workspaceKey !== null ? refOpenState('post', workspaceKey, post.number, post.id) : undefined;
  // A press starts the page chunk and its first reads (src/lib/post-prefetch.ts);
  // only the click that follows lets the page join them.
  const pressPrefetch = (): void => prefetchPostOpen(post.id);
  // growFromCard: the page grows out of this card; Back grows it back in.
  const cardRef = useGrowBackIntoCard<HTMLElement>(post.id);
  // The newest unread comment on this post: the card's open lands on it.
  const latestUnread = useEntityUnreadComment('post', post.id);
  const open = (): void => {
    mark('post:open:tap');
    mark('post:click');
    confirmPostOpen(post.id);
    rememberCard(post.id, cardRef.current);
    // Unread comments: land on the newest one (jump to latest), else the top.
    navigate(
      withCommentTarget(href, latestUnread),
      openState === undefined ? undefined : { state: openState },
    );
  };
  const caption = captionPreview(post);
  const stage = post.stage as Stage;
  const coverKind = cardCoverKind(post, cover);
  const clock = now ?? new Date();
  const status =
    viewer !== undefined ? reviewStatus(stage, post.stage_entered_at, viewer, clock) : null;
  const canMove =
    onMove !== undefined && (viewer === undefined || hasAllowedMove(viewer.role, stage));
  const copyLink = (): void => {
    void copyText(buildPostLink(window.location.origin, href)).then((ok) =>
      toast?.show(ok ? { title: 'Link copied' } : { title: COPY_FAILED, tone: 'error' }),
    );
  };
  const due = post.target_date !== null ? cardDue(post.target_date, stage, timeZone, clock) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const gesture = useMenuGesture(() => setMenuOpen(true));
  const hasMenu = onMove !== undefined;
  // A known role lists its moves in the menu; while it loads, the Move row.
  const directMoves =
    viewer !== undefined && viewer.pending !== true ? moveActions(viewer.role, stage) : [];
  // The viewer's unread comments on this post (the same rows Activity shows):
  // the dot on line 1, the count in the ⋮'s name.
  const unreadComments = useEntityUnread('post', post.id);

  const menu =
    onMove !== undefined ? (
      // Pointer down and right-click stop here (the menu rows included, through
      // the React tree) so the card's own menu gesture never arms under it.
      <span
        data-post-card-menu=""
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        className="flex"
      >
        <ActionMenu
          title={post.title}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={cardMenuItems({
            // Opens with the id (no ref lookup) but reads afresh: no press to join.
            onOpen: () => {
              rememberCard(post.id, cardRef.current);
              navigate(
                withCommentTarget(href, latestUnread),
                openState === undefined ? undefined : { state: openState },
              );
            },
            onCopyLink: copyLink,
            ...(canMove && directMoves.length > 0
              ? {
                  moves: directMoves.map((move) => ({
                    ...move,
                    onSelect: () => onMove(post, move.to),
                  })),
                }
              : canMove
                ? { onMove: () => onMove(post) }
                : {}),
          })}
          trigger={
            // ListCard's line 3 holds it; ActionMenuTrigger's trailing rule puts
            // the glyph on the card's content edge.
            <ActionMenuTrigger
              type="button"
              label={cardMenuLabel(post.title, unreadComments)}
              data-post-card-move=""
              draggable={false}
              className="text-fg-3"
            />
          }
        />
      </span>
    ) : undefined;

  const { picture, hooks: pictureHooks } = cardPicture(post, coverKind, cache, presignEnabled);

  // Line 2: the status line over the caption on one line; the caption alone
  // takes both lines. Captions are plain text (never formatted).
  const preview =
    status !== null ? (
      <>
        <span data-post-card-status={status.tone} className="block truncate">
          {status.text}
        </span>
        {caption !== null ? (
          <span data-post-card-caption="" className="block truncate">
            {caption}
          </span>
        ) : null}
      </>
    ) : (
      caption
    );

  return (
    <ListCard
      rootRef={cardRef}
      surface={{
        'data-post-id': post.id,
        'data-induction': INDUCTION_KEYS.pipelinePostRow,
        'data-induction-post': post.id,
        ...(unreadComments > 0 ? { 'data-post-card-unread': String(unreadComments) } : {}),
        ...(hasMenu
          ? {
              ...gesture.handlers,
              // A hold released with no click left its click guard set: a new
              // press is never the tail of that hold. Capture, so menu rows
              // (whose wrapper stops pointerdown) clear it too.
              onPointerDownCapture: () => {
                gesture.consumeClickSuppression();
              },
              // The click that trails a long-press never reaches Open post.
              onClickCapture: (event: MouseEvent) => {
                if (gesture.consumeClickSuppression()) {
                  event.preventDefault();
                  event.stopPropagation();
                }
              },
            }
          : {}),
      }}
      onPress={open}
      press={{
        'aria-label': `Open post ${post.title}`,
        onPointerDown: pressPrefetch,
        onTouchStart: pressPrefetch,
      }}
      picture={picture}
      pictureHooks={pictureHooks}
      title={post.title}
      unread={unreadComments > 0}
      preview={preview}
      {...(status === null && caption !== null
        ? { previewHooks: { 'data-post-card-caption': '' } }
        : {})}
      {...(due !== null && due.text !== ''
        ? {
            time: due.text,
            timeBad: due.overdue,
            timeHooks: { 'data-post-card-due': due.overdue ? 'overdue' : '' },
          }
        : {})}
      tag={stageLabel(stage)}
      tagHooks={{ 'data-post-card-stage': stage }}
      {...(menu !== undefined ? { menu } : {})}
    />
  );
}
