import { mark } from '@/lib/perf-marks';
import { useState, type ComponentType, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import {
  ICON_SIZE,
  IconArrowUpRight,
  IconCarousel,
  IconCheck,
  IconLink,
  IconMore,
  IconPause,
  IconPlay,
  IconSwitch,
  IconX,
  type IconProps,
} from '@/components/ui/icons';
import { type FormatGlyphToken } from '@/components/ui/format-icon';
import { postFormatLabel } from '@/lib/post-format';
import type { PresignCache } from '@/lib/asset-presign';
import { entityUrlPath, refOpenState } from '@/lib/entityRef';
import { confirmPostOpen, prefetchPostOpen } from '@/lib/post-prefetch';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { StageDot, stageLabel } from '@/components/pages/pipeline/stage-meta';
import { moveActions } from '@/components/pages/pipeline/MoveSheet';
import {
  hasAllowedMove,
  reservesStatusLine,
  reviewStatus,
  type CardViewer,
} from '@/components/pages/pipeline/card-status';
import { civilDay, formatDue, formatOverdue } from '@/lib/time';
import { frameFor } from '@/lib/platform-specs';
import { cn } from '@/lib/cn';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
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
   * Renders the ⋯ (ui/ActionMenu) at the right end of the due row. With a
   * known role the menu lists each move this viewer can make (Send for review,
   * Approve, Park, Reject) and calls this with its target; without one it has a
   * single Move row that calls it with no target (the move sheet).
   */
  onMove?: (post: PipelinePost, to?: Stage) => void;
  /**
   * The viewer's role and the workspace approvers: drives the review status line
   * and hides the ⋯ menu's Move row when this viewer has no allowed move.
   * Absent: no status line, and Move shows whenever onMove is passed.
   */
  viewer?: CardViewer;
  /**
   * The post's first photo or video (the chat card's cover read): a video with
   * no poster shows the play glyph in the cover box. undefined while unknown.
   */
  cover?: CardFirstMedia | null | undefined;
  /** The clock for the time-in-stage reading. Default: now. */
  now?: Date;
  /** The phone All view: the meta line leads with the post's stage dot and label. */
  showStage?: boolean;
  /**
   * The card sits in a kanban column that already names its stage: the card
   * never repeats the stage name or its dot (the status line drops its dot).
   */
  inColumn?: boolean;
  /**
   * The workspace's IANA zone: target_date is a due date, a calendar day on the
   * workspace zone (src/lib/time.ts). Absent or null: the device zone.
   */
  timeZone?: string | null | undefined;
}

/**
 * The card's due line via the app formatter: "Due 15 Mar" ("Due 4 Jan 2027"
 * outside now's year), the day read on the workspace zone. An unparseable value
 * shows as stored.
 */
export function dueLabel(
  value: string,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return `Due ${value}`;
  return formatDue(value, workspaceZone, now);
}

/** The card's due reading: the due line, or the overdue line in the bad tone. */
export interface CardDue {
  text: string;
  overdue: boolean;
}

/**
 * "Due 15 Mar" while the day is today or ahead; once the civil day (on the
 * workspace zone) has passed, "Overdue · 12 Oct" / "Overdue 5 months" via the
 * shared formatter. An approved post is done, so it never reads overdue. An
 * unparseable value shows as stored.
 */
export function cardDue(
  value: string,
  stage: Stage,
  workspaceZone: string | null | undefined,
  now: Date = new Date(),
): CardDue {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return { text: `Due ${value}`, overdue: false };
  const zone = workspaceZone ?? undefined;
  const civil = civilDay(value, zone);
  if (stage !== 'approved' && civil < civilDay(now, zone)) {
    return { text: formatOverdue(civil, workspaceZone, now).text, overdue: true };
  }
  return { text: dueLabel(value, workspaceZone, now), overdue: false };
}

/**
 * The card's cover box ratio (w / h): ONE fixed box per workspace platform,
 * the platform's default image frame (4:5 for Instagram), whatever the post's
 * format or its media's own size. Every card in a row then has the same
 * picture height; the picture fills it with object-cover. null for a platform
 * with no frame: the box falls back to square. Pure.
 */
export function cardRatio(post: Pick<PipelinePost, 'platform'>): number | null {
  const frame = frameFor(post.platform, 'single_image', null);
  return frame === null ? null : frame.ratio;
}

/** Formats whose media is a video. */
const VIDEO_FORMATS: readonly string[] = ['video', 'reel', 'story', 'short'];

/**
 * What the card's cover box shows: the picture ('image'), a centred play glyph
 * for a video with no poster ('video'), or no box at all for a post with no
 * media ('none', a text-only post: the card starts at the title). Pure.
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

/** A post with no media of its own: the tile is the format fallback. */
function hasNoMedia(post: PipelinePost): boolean {
  return post.thumbnailAssetVersionId === null;
}

/** The caption preview text for a no-media card, or null when there is none. */
export function captionPreview(post: PipelinePost): string | null {
  if (!hasNoMedia(post)) return null;
  return post.caption !== null && post.caption.trim() !== '' ? post.caption : null;
}

/**
 * Map the DB post format to a glyph token: single_image folds into 'image'; every
 * other format value is already a FormatGlyphToken ('text' | 'carousel' | 'video'
 * | 'link'). Used by the fallback tile.
 */
function formatToken(format: string): FormatGlyphToken {
  return format === 'single_image' ? 'image' : (format as FormatGlyphToken);
}

/**
 * The format-aware fallback tile for a post with no usable image: a plain
 * panel tile carrying the format icon plus a clamped body snippet (the
 * caption when present, else the title). Video/link posts use the centred 'media'
 * layout; everything else uses the text-forward layout. When the post has a
 * thumbnail this is only used if the presign fails or is disabled.
 */
function postFallback(post: PipelinePost): ThumbnailFallback {
  const token = formatToken(post.format);
  // A no-media card shows its caption under the title, so the tile does not
  // repeat it; a media post whose presign fails keeps it.
  const hasCaption = post.caption !== null && post.caption.trim() !== '';
  const body = captionPreview(post) !== null ? null : hasCaption ? post.caption : post.title;
  const layout = token === 'video' || token === 'link' ? 'media' : 'text';
  return {
    kind: 'post',
    glyph: token,
    label: postFormatLabel(post.format, post.platform),
    body,
    layout,
  };
}

/** A small "multiple images" badge (stacked squares) shown on carousel posts. */
function CarouselBadge() {
  return (
    <span
      aria-label="Carousel"
      className="pointer-events-none absolute left-1.5 top-1.5 inline-flex h-6 min-w-[24px] items-center justify-center rounded-lg bg-overlay-badge text-overlay-fg"
    >
      <IconCarousel size={ICON_SIZE.inline} />
    </span>
  );
}

/** A centred play badge painted over a video post's poster image. */
function PlayBadge() {
  return (
    <span
      aria-label="Video"
      className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-overlay-badge text-overlay-fg"
    >
      <IconPlay size={ICON_SIZE.control} />
    </span>
  );
}

/** One move row in the card's ⋯ menu (the move sheet's actions, moveActions). */
export interface CardMoveRow {
  to: Stage;
  label: string;
  tone: 'default' | 'bad';
  onSelect: () => void;
}

/** What the card's ⋯ menu runs. */
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
 * The card's ⋯ rows: Open, Copy link, then every move this viewer can make
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
 * A pipeline board card: a full-bleed picture in the workspace platform's one
 * fixed cover box (4:5 for Instagram, object-cover), a play glyph in that box
 * for a video with no poster, or no box for a text-only post, above the title, the
 * review status line, and one quiet meta line (the stage in the phone All
 * view, the due or overdue reading, and the ⋯). The picture is the shared
 * Thumbnail tile, so an image post, an imageless post, and a glyph post share
 * ONE tile background by state. The format shows once: the carousel badge or
 * play badge on the picture, never a glyph on the meta line. The card fills
 * its grid cell (h-full) and the title holds two lines, so every card in a row
 * ends on the same line. The whole card navigates to the post detail (PCS)
 * view; when the board passes onMove, a plain ⋯ at the right end of the meta
 * line (44x44 tap area, negative margins so the row keeps its height) opens
 * the shared ActionMenu: Open, Copy link (toast "Link copied") and, when the
 * viewer has an allowed move, Move (the move sheet). A long-press on touch or
 * a right-click on laptop opens the same menu (useMenuGesture). Navigation is
 * a full-bleed overlay button laid behind the card content.
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
  showStage = false,
  inColumn = false,
  timeZone,
}: PostCardProps) {
  const navigate = useNavigate();
  const toast = useOptionalToast();
  const hasPoster = post.thumbnailAssetVersionId !== null;
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
  const open = (): void => {
    mark('post:open:tap');
    mark('post:click');
    confirmPostOpen(post.id);
    navigate(href, openState === undefined ? undefined : { state: openState });
  };
  const caption = captionPreview(post);
  const stage = post.stage as Stage;
  const ratio = cardRatio(post);
  const coverKind = cardCoverKind(post, cover);
  const clock = now ?? new Date();
  const status =
    viewer !== undefined ? reviewStatus(stage, post.stage_entered_at, viewer, clock) : null;
  const reserveStatus = status === null && reservesStatusLine(stage, viewer);
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

  return (
    <div
      data-induction={INDUCTION_KEYS.pipelinePostRow}
      data-induction-post={post.id}
      {...(hasMenu
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
        : {})}
      className="relative flex h-full min-w-0 flex-col rounded-xl border border-border bg-panel transition-colors hover:bg-panel-2"
    >
      <PressableRow
        type="button"
        aria-label={`Open post ${post.title}`}
        onPointerDown={pressPrefetch}
        onTouchStart={pressPrefetch}
        onClick={open}
        className="absolute inset-0"
      />
      {/* The cover and the body are relative so they paint above the absolute
          Open post button (whose hover fill would otherwise cover the text);
          pointer-events-none lets a tap on them reach the button. The
          picture clips to the card's top corners itself: the card root does not
          clip, so the laptop ⋯ popover can open past the card's edge. */}
      {coverKind === 'image' ? (
        <div data-post-card-thumb="" className="pointer-events-none relative overflow-hidden rounded-t-xl">
          <Thumbnail
            assetVersionId={post.thumbnailAssetVersionId}
            cache={cache}
            presignEnabled={presignEnabled}
            aspect="square"
            {...(ratio !== null ? { ratio } : {})}
            fallback={postFallback(post)}
            alt={post.title}
          >
            {post.format === 'carousel' ? (
              <CarouselBadge />
            ) : post.format === 'video' && hasPoster ? (
              <PlayBadge />
            ) : null}
          </Thumbnail>
        </div>
      ) : coverKind === 'video' ? (
        <div data-post-card-thumb="" className="pointer-events-none relative overflow-hidden rounded-t-xl">
          <div
            data-post-card-play=""
            className={cn(
              'flex w-full items-center justify-center bg-panel-3 text-fg-3',
              ratio === null ? 'aspect-square' : null,
            )}
            {...(ratio !== null ? { style: { aspectRatio: String(ratio) } } : {})}
          >
            <span role="img" aria-label="Video" className="inline-flex">
              <IconPlay size={ICON_SIZE.status} />
            </span>
          </div>
        </div>
      ) : null}
      <div
        data-post-card-body=""
        className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-1.5 p-3"
      >
        <div
          data-post-card-title=""
          className="line-clamp-2 min-h-[2.75em] text-base font-medium leading-snug [overflow-wrap:anywhere]"
        >
          {post.title}
        </div>
        {caption !== null ? (
          <p
            data-post-card-caption=""
            className="line-clamp-2 text-sm leading-snug text-fg-3 [overflow-wrap:anywhere]"
          >
            {caption}
          </p>
        ) : null}
        {status !== null ? (
          // A creator's line shows the dot and the time in stage only ("2 days
          // ago"); the full phrase stays as its title and aria-label.
          <div
            data-post-card-status={status.tone}
            {...(status.tone === 'with' ? { title: status.text, 'aria-label': status.text } : {})}
            className={cn(
              'flex h-4 min-w-0 items-center gap-1.5 text-sm',
              status.tone === 'you' ? 'font-semibold text-accent' : 'text-fg-2',
            )}
          >
            {status.tone === 'you' ? (
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
            ) : inColumn ? null : (
              <StageDot stage={stage} />
            )}
            <span className="truncate">{status.tone === 'with' ? status.ago : status.text}</span>
          </div>
        ) : reserveStatus ? (
          // The role is still loading: hold the status line's height.
          <div aria-hidden data-post-card-status-pending="" className="h-4" />
        ) : null}
        {/* One quiet meta line, pinned to the card's foot: the stage (phone All
          view only, when no status line names it), the due or overdue reading,
          and the ⋯. The row never wraps and keeps its height. */}
        <div data-post-card-meta="" className="mt-auto flex h-5 min-w-0 items-center gap-1.5">
          {showStage && !inColumn && status === null ? (
            <span
              data-post-card-stage=""
              className="inline-flex shrink-0 items-center gap-1.5 text-sm text-fg-2"
            >
              <StageDot stage={stage} />
              {stageLabel(stage)}
            </span>
          ) : null}
          {due !== null ? (
            <span
              data-post-card-due={due.overdue ? 'overdue' : ''}
              className={cn(
                'min-w-0 truncate whitespace-nowrap font-mono text-sm tabular-nums',
                due.overdue ? 'text-bad' : 'text-fg-3',
              )}
            >
              {due.text}
            </span>
          ) : null}
          {onMove !== undefined ? (
            // Above the Open post overlay (z-10) so a tap opens the menu, not
            // the post; pointer-events-auto re-enables it inside the body. Pointer down and right-click stop here (the menu rows
            // included, through the React tree) so the card's own menu gesture
            // never arms under it. The negative margins keep the 44px target
            // from growing the row.
            <div
              data-post-card-menu=""
              onPointerDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.stopPropagation()}
              className="pointer-events-auto ml-auto flex shrink-0"
            >
              <ActionMenu
                title={post.title}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                items={cardMenuItems({
                  // Opens with the id (no ref lookup) but reads afresh: no press to join.
                  onOpen: () =>
                    navigate(href, openState === undefined ? undefined : { state: openState }),
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
                  <IconButton
                    type="button"
                    label={`More actions for ${post.title}`}
                    aria-haspopup="menu"
                    data-post-card-move=""
                    draggable={false}
                    className="pointer-events-auto relative z-10 -my-3 -mr-3 text-fg-3"
                  >
                    <IconMore size={ICON_SIZE.control} />
                  </IconButton>
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
