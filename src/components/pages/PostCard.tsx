import { mark } from '@/lib/perf-marks';
import type { ReactNode } from 'react';
import { useNavigate, type NavigateOptions } from 'react-router-dom';
import { Thumbnail } from '@/components/media';
import { ICON_SIZE, IconCarousel, IconPlay } from '@/components/ui/icons';
import type { PresignCache } from '@/lib/asset-presign';
import { entityUrlPath, refOpenState } from '@/lib/entityRef';
import { confirmPostOpen, prefetchPostOpen } from '@/lib/post-prefetch';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { stageLabel } from '@/components/pages/pipeline/stage-meta';
import { reviewStatus, type CardViewer } from '@/components/pages/pipeline/card-status';
import { daysFromToday, formatDue, formatOverdue } from '@/lib/time';
import {
  ListCard,
  type ListCardHooks,
  type ListCardPicture,
  type ListCardSelect,
} from '@/components/ui/ListCard';
import { PostPlaceholder, postPlaceholderKind } from '@/components/ui/PostPlaceholder';
import {
  peekEntityUnreadComment,
  unreadCommentsLabel,
  useEntityUnread,
  useEntityUnreadComment,
  withCommentTarget,
} from '@/lib/inbox/unread-entities';
import { rememberCard } from '@/lib/motion';
import { useGrowBackIntoCard } from '@/lib/motion/pages';
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
   * The viewer's role and the workspace approvers: drives the review status
   * line ("With Maya · 3h", "Waiting on you"). Absent: no status line.
   */
  viewer?: CardViewer;
  /**
   * The Pipeline's select mode (useListSelection().selectFor): long-press or
   * right-click ticks this card; the old ⋮ rows live on the page's SelectBar.
   * Absent: long-press and right-click do nothing.
   */
  select?: ListCardSelect | undefined;
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
 * Line 1's time: "Today", "Tomorrow", "Fri", "12 Nov" (formatDue) while the
 * day is today or ahead; once the civil day (on the workspace zone) has
 * passed, "2d late" / "2mo late" (formatOverdue) in the bad tone. An approved
 * post is done, so it never reads late. An unparseable value reads '' (no
 * time). Pure.
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
 * Where a card opens: the pretty link (/p/KEY-N) with the post id in router
 * state (so /p/:ref renders without looking the ref up), else the classic
 * /posts/:id route while the key has not resolved. Pure.
 */
export function postCardHref(
  post: Pick<PipelinePost, 'id' | 'number'>,
  workspaceKey: string | null,
): string {
  return workspaceKey !== null
    ? entityUrlPath('post', workspaceKey, post.number)
    : `/posts/${post.id}`;
}

/** The router state the pretty link carries (the post id), or undefined. Pure. */
export function postCardOpenOptions(
  post: Pick<PipelinePost, 'id' | 'number'>,
  workspaceKey: string | null,
): NavigateOptions | undefined {
  return workspaceKey !== null
    ? { state: refOpenState('post', workspaceKey, post.number, post.id) }
    : undefined;
}

/**
 * Open a post from outside its card (the select bar's Open): it lands on the
 * newest unread comment like a tap does and grows out of the card when it is
 * on screen. Opens with the id (no ref lookup) but reads afresh: no press to join.
 */
export function openPostCard(
  navigate: (to: string, options?: NavigateOptions) => void,
  post: Pick<PipelinePost, 'id' | 'number'>,
  workspaceKey: string | null,
): void {
  const card =
    typeof document === 'undefined'
      ? null
      : document.querySelector(`[data-post-id="${CSS.escape(post.id)}"]`);
  rememberCard(post.id, card);
  navigate(
    withCommentTarget(postCardHref(post, workspaceKey), peekEntityUnreadComment('post', post.id)),
    postCardOpenOptions(post, workspaceKey),
  );
}

/**
 * Line 2's preview: the review status ("With Maya · 3h", "Waiting on you")
 * then " · " and the caption, on one line; the caption alone when there is no
 * status. Captions are plain text (never formatted).
 */
function cardPreview(
  status: { tone: string; text: string } | null,
  caption: string | null,
): ReactNode {
  if (status === null) return caption;
  return (
    <>
      <span data-post-card-status={status.tone}>{status.text}</span>
      {caption !== null ? (
        <>
          {' · '}
          <span data-post-card-caption="">{caption}</span>
        </>
      ) : null}
    </>
  );
}

/**
 * A Pipeline post on ui/ListCard. Picture: the post's picture, else the play
 * placeholder (a video with no poster) or "Aa" (a text post). Line 1: the
 * title and the due words ("Today", "Fri", "12 Nov"; "2d late" in the bad
 * tone unless approved). Line 2: the review status then the caption on one
 * line, the stage tag with its dot, and the unread dot (unread comments). The
 * whole card opens the post (onPress). No ⋮: with `select`, a long-press on
 * touch or a right-click on laptop ticks the card (ListCard wires it) and the
 * Pipeline's SelectBar carries Open, Copy link and the moves.
 */
export function PostCard({
  post,
  cache,
  presignEnabled,
  workspaceKey = null,
  viewer,
  select,
  cover,
  now,
  timeZone,
}: PostCardProps) {
  const navigate = useNavigate();
  const href = postCardHref(post, workspaceKey);
  const openOptions = postCardOpenOptions(post, workspaceKey);
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
    navigate(withCommentTarget(href, latestUnread), openOptions);
  };
  const caption = captionPreview(post);
  const stage = post.stage as Stage;
  const coverKind = cardCoverKind(post, cover);
  const clock = now ?? new Date();
  const status =
    viewer !== undefined ? reviewStatus(stage, post.stage_entered_at, viewer, clock) : null;
  const due = post.target_date !== null ? cardDue(post.target_date, stage, timeZone, clock) : null;
  // The viewer's unread comments on this post (the same rows Activity shows):
  // the unread dot on line 2, the count in the card's name.
  const unreadComments = useEntityUnread('post', post.id);

  const { picture, hooks: pictureHooks } = cardPicture(post, coverKind, cache, presignEnabled);

  return (
    <ListCard
      rootRef={cardRef}
      surface={{
        'data-post-id': post.id,
        'data-induction': INDUCTION_KEYS.pipelinePostRow,
        'data-induction-post': post.id,
        ...(unreadComments > 0 ? { 'data-post-card-unread': String(unreadComments) } : {}),
      }}
      select={select}
      onPress={open}
      press={{
        'aria-label':
          unreadComments > 0
            ? `Open post ${post.title}, ${unreadCommentsLabel(unreadComments)}`
            : `Open post ${post.title}`,
        onPointerDown: pressPrefetch,
        onTouchStart: pressPrefetch,
      }}
      picture={picture}
      pictureHooks={pictureHooks}
      title={post.title}
      unread={unreadComments > 0}
      preview={cardPreview(status, caption)}
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
      tagDot={stage}
      tagHooks={{ 'data-post-card-stage': stage }}
    />
  );
}
