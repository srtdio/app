import { useNavigate } from 'react-router-dom';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { IconPlay } from '@/components/ui/icons';
import { FORMAT_GLYPH_LABEL, type FormatGlyphToken } from '@/components/ui/format-icon';
import type { PresignCache } from '@/lib/asset-presign';
import { entityUrlPath } from '@/lib/entityRef';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { StageDot, stageLabel } from '@/components/pages/pipeline/stage-meta';
import {
  hasAllowedMove,
  reservesStatusLine,
  reviewStatus,
  type CardViewer,
} from '@/components/pages/pipeline/card-status';
import { civilDate } from '@/lib/list-sort';
import { formatDue, formatOverdue } from '@/lib/display-date';
import { frameFor } from '@/lib/platform-specs';
import { cn } from '@/lib/cn';
import type { CardFirstMedia } from '../../../packages/posts/src/reads';
import type { PipelinePost, Stage } from '@srtdio/posts';

export interface PostCardProps {
  post: PipelinePost;
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace's key, used to build the pretty /p/KEY-N link. When
   *  absent the card falls back to the classic /posts/:id route. */
  workspaceKey?: string | null;
  /** Opens the move sheet for this post; renders the ⋯ at the right end of the due row. */
  onMove?: (post: PipelinePost) => void;
  /**
   * The viewer's role and the workspace approvers: drives the review status line
   * and hides the ⋯ when this viewer has no allowed move. Absent: no status
   * line, and the ⋯ shows whenever onMove is passed.
   */
  viewer?: CardViewer;
  /**
   * The post's first photo or video with its stored size (the chat card's
   * cover read), so the picture takes the same platform frame as the chat card.
   * undefined while unknown: the format's default frame.
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
   * The workspace's IANA zone (the one the move sheet and approve confirm use).
   * target_date is a timestamptz, so its day is read in this zone, never the
   * browser's. Default UTC.
   */
  timeZone?: string;
}

/**
 * The card's due line via the app formatter: "Due 15 Mar" ("Due 4 Jan 2027"
 * outside now's year). The instant is read to its civil day in the workspace
 * zone (civilDate, the filter's own reading; a bad zone reads as UTC), and that
 * date-only day is formatted so the browser zone can never shift it. An
 * unparseable value shows as stored.
 */
export function dueLabel(value: string, timeZone = 'UTC', now: Date = new Date()): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return `Due ${value}`;
  let civil: string;
  try {
    civil = civilDate(instant, timeZone);
  } catch {
    civil = civilDate(instant, 'UTC');
  }
  return formatDue(civil, 'UTC', now);
}

/** The card's due reading: the due line, or the overdue line in the bad tone. */
export interface CardDue {
  text: string;
  overdue: boolean;
}

/**
 * "Due 15 Mar" while the day is today or ahead; once the civil day (in the
 * workspace zone) has passed, "Overdue · 12 Oct" / "Overdue 5 months" via the
 * shared formatter. An approved post is done, so it never reads overdue. An
 * unparseable value shows as stored.
 */
export function cardDue(
  value: string,
  stage: Stage,
  timeZone = 'UTC',
  now: Date = new Date(),
): CardDue {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return { text: `Due ${value}`, overdue: false };
  const read = (at: Date): string => {
    try {
      return civilDate(at, timeZone);
    } catch {
      return civilDate(at, 'UTC');
    }
  };
  const civil = read(instant);
  if (stage !== 'approved' && civil < read(now)) {
    return { text: formatOverdue(civil, timeZone, now).text, overdue: true };
  }
  return { text: dueLabel(value, timeZone, now), overdue: false };
}

/**
 * The card's picture frame ratio (w / h): the post's platform + format frame
 * fed the cover's stored size, the same rule the chat card uses (cardFrame),
 * so both show one shape for one post. null for a format with no media box
 * (text, link): the card keeps its square fallback tile. Pure.
 */
export function cardRatio(
  post: Pick<PipelinePost, 'platform' | 'format'>,
  cover: CardFirstMedia | null | undefined,
): number | null {
  const first = cover ?? null;
  const frame = frameFor(
    post.platform,
    post.format,
    first === null ? null : { kind: first.kind, w: first.width, h: first.height },
  );
  return frame === null ? null : frame.ratio;
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
  return { kind: 'post', glyph: token, label: FORMAT_GLYPH_LABEL[token], body, layout };
}

/** A small "multiple images" badge (stacked squares) shown on carousel posts. */
function CarouselBadge() {
  return (
    <span
      aria-label="Carousel"
      className="pointer-events-none absolute left-1.5 top-1.5 inline-flex h-6 min-w-[24px] items-center justify-center rounded-md bg-overlay-badge text-overlay-fg"
    >
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x={8} y={8} width={11} height={11} rx={2} />
        <path d="M5 15V5a1 1 0 0 1 1-1h9" />
      </svg>
    </span>
  );
}

/** Three dots in a row: the plain 18px ⋯ glyph at the right end of the due row. */
function MoreIcon() {
  return (
    <svg aria-hidden width={18} height={18} viewBox="0 0 24 24" fill="currentColor">
      <circle cx={5} cy={12} r={1.75} />
      <circle cx={12} cy={12} r={1.75} />
      <circle cx={19} cy={12} r={1.75} />
    </svg>
  );
}

/** A centred play badge painted over a video post's poster image. */
function PlayBadge() {
  return (
    <span
      aria-label="Video"
      className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-overlay-badge text-overlay-fg"
    >
      <IconPlay size={18} />
    </span>
  );
}

/**
 * A pipeline board card: a full-bleed picture in the post's platform frame
 * (4:5 for an Instagram post, the chat card's shape; before the cover loads
 * the frame is the platform's default for the format) above the title, the
 * review status line, and one quiet meta line (the stage in the phone All
 * view, the due or overdue reading, and the ⋯). The picture is the shared
 * Thumbnail tile, so an image post, an imageless post, and a glyph post share
 * ONE tile background by state. The format shows once: the carousel badge or
 * play badge on the picture, never a glyph on the meta line. The card fills
 * its grid cell (h-full) and the title holds two lines, so every card in a row
 * ends on the same line. The whole card navigates to the post detail (PCS)
 * view; when the board passes onMove and the viewer has an allowed move, a
 * plain ⋯ glyph at the right end of the meta line (44x44 tap area, negative
 * margins so the row keeps its height) opens the move sheet. Navigation is a
 * full-bleed overlay button laid behind the card content.
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
  timeZone = 'UTC',
}: PostCardProps) {
  const navigate = useNavigate();
  const hasPoster = post.thumbnailAssetVersionId !== null;
  // Prefer the pretty link (/p/KEY-N); the classic /posts/:id route remains a
  // working fallback when the key has not resolved yet.
  const href =
    workspaceKey !== null ? entityUrlPath('post', workspaceKey, post.number) : `/posts/${post.id}`;
  const caption = captionPreview(post);
  const stage = post.stage as Stage;
  const ratio = cardRatio(post, cover);
  const clock = now ?? new Date();
  const status =
    viewer !== undefined ? reviewStatus(stage, post.stage_entered_at, viewer, clock) : null;
  const reserveStatus = status === null && reservesStatusLine(stage, viewer);
  const canMove =
    onMove !== undefined && (viewer === undefined || hasAllowedMove(viewer.role, stage));
  const due = post.target_date !== null ? cardDue(post.target_date, stage, timeZone, clock) : null;

  return (
    <div
      data-induction={INDUCTION_KEYS.pipelinePostRow}
      data-induction-post={post.id}
      className="relative flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-panel transition-colors hover:bg-panel-2"
    >
      <button
        type="button"
        aria-label={`Open post ${post.title}`}
        onClick={() => navigate(href)}
        className="absolute inset-0 rounded-lg"
      />
      {/* The tile is relative, so it would paint over the absolute Open post button;
          pointer-events-none lets a tap on the thumbnail reach the button. */}
      <div data-post-card-thumb="" className="pointer-events-none">
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
      <div data-post-card-body="" className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
        <div
          data-post-card-title=""
          className="line-clamp-2 min-h-[2.75em] text-sm font-medium leading-snug [overflow-wrap:anywhere]"
        >
          {post.title}
        </div>
        {caption !== null ? (
          <p
            data-post-card-caption=""
            className="line-clamp-2 text-xs leading-snug text-fg-3 [overflow-wrap:anywhere]"
          >
            {caption}
          </p>
        ) : null}
        {status !== null ? (
          <div
            data-post-card-status={status.tone}
            className={cn(
              'flex h-4 min-w-0 items-center gap-1.5 text-xs',
              status.tone === 'you' ? 'font-semibold text-accent' : 'text-fg-2',
            )}
          >
            {status.tone === 'you' ? (
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
            ) : inColumn ? null : (
              <StageDot stage={stage} />
            )}
            <span className="truncate">{status.text}</span>
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
              className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-2"
            >
              <StageDot stage={stage} />
              {stageLabel(stage)}
            </span>
          ) : null}
          {due !== null ? (
            <span
              data-post-card-due={due.overdue ? 'overdue' : ''}
              className={cn(
                'min-w-0 truncate whitespace-nowrap text-xs tabular-nums',
                due.overdue ? 'text-bad' : 'text-fg-3',
              )}
            >
              {due.text}
            </span>
          ) : null}
          {canMove && onMove !== undefined ? (
            // Above the Open post overlay (z-10) so a tap moves, not opens.
            // Pointer down stops here so the feed's long-press never arms under
            // it. The negative margins keep the 44px target from growing the row.
            <button
              type="button"
              aria-label={`Move post ${post.title}`}
              data-post-card-move=""
              draggable={false}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onMove(post)}
              className="relative z-10 -my-3 -mr-3 ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-3 transition-colors duration-fast ease-enter hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <MoreIcon />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
