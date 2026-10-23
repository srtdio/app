import { useNavigate } from 'react-router-dom';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { IconPlay } from '@/components/ui/icons';
import { FORMAT_GLYPH_LABEL, formatIcon, type FormatGlyphToken } from '@/components/ui/format-icon';
import type { PresignCache } from '@/lib/asset-presign';
import { entityUrlPath } from '@/lib/entityRef';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { StageDot, stageLabel } from '@/components/pages/pipeline/stage-meta';
import {
  hasAllowedMove,
  reviewStatus,
  type CardViewer,
} from '@/components/pages/pipeline/card-status';
import { civilDate } from '@/lib/list-sort';
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
  /** Opens the move sheet for this post; renders the ⋯ on the picture's corner. */
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
  cover?: CardFirstMedia | null;
  /** The clock for the time-in-stage reading. Default: now. */
  now?: Date;
  /** The All view: the meta line leads with the post's stage dot and label. */
  showStage?: boolean;
  /**
   * The workspace's IANA zone (the one the move sheet and approve confirm use).
   * target_date is a timestamptz, so its day is read in this zone, never the
   * browser's. Default UTC.
   */
  timeZone?: string;
}

/**
 * The card's due line: "Due 15 Mar" (day and short month, in that order), the
 * day read in the workspace zone by {@link formatTargetDate}.
 */
export function dueLabel(value: string, timeZone = 'UTC'): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return `Due ${value}`;
  let civil: string;
  try {
    civil = civilDate(instant, timeZone);
  } catch {
    civil = civilDate(instant, 'UTC');
  }
  const [, m, d] = civil.split('-').map((part) => Number(part));
  return `Due ${d!} ${DUE_MONTHS[m! - 1] ?? ''}`.trimEnd();
}

const DUE_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

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

/**
 * The target date's day in the workspace zone, as a date only ("15 Mar 2026",
 * locale-ordered). The instant is read to a civil 'YYYY-MM-DD' in `timeZone`
 * (civilDate, the filter's own reading), then that civil day is formatted at
 * UTC so the browser zone can never shift it. A bad zone reads as UTC; an
 * unparseable value is shown as stored.
 */
export function formatTargetDate(value: string, timeZone = 'UTC'): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  let civil: string;
  try {
    civil = civilDate(instant, timeZone);
  } catch {
    civil = civilDate(instant, 'UTC');
  }
  const [y, m, d] = civil.split('-').map((part) => Number(part));
  const day = new Date(Date.UTC(y!, m! - 1, d!));
  return day.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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
 * | 'link'). One source for both the meta-line glyph and the fallback tile.
 */
function formatToken(format: string): FormatGlyphToken {
  return format === 'single_image' ? 'image' : (format as FormatGlyphToken);
}

/**
 * The format-aware fallback tile for a post with no usable image: a premium
 * gradient tile carrying the format eyebrow plus a clamped body snippet (the
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
      className="pointer-events-none absolute left-1.5 top-1.5 inline-flex h-6 min-w-[24px] items-center justify-center rounded-md bg-black/55 text-white"
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

/** Three dots in a row: the ⋯ glyph on the picture's corner. */
function MoreIcon() {
  return (
    <svg
      aria-hidden
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={5} cy={12} r={1.3} />
      <circle cx={12} cy={12} r={1.3} />
      <circle cx={19} cy={12} r={1.3} />
    </svg>
  );
}

/** A centred play badge painted over a video post's poster image. */
function PlayBadge() {
  return (
    <span
      aria-label="Video"
      className="pointer-events-none absolute left-1/2 top-1/2 inline-flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white"
    >
      <IconPlay size={18} />
    </span>
  );
}

/**
 * A pipeline board card: a full-bleed picture in the post's platform frame
 * (4:5 for an Instagram post, the chat card's shape) above the title, the
 * review status line, and one quiet meta line (the stage in the All view, the
 * format glyph, and "Due {d MMM}" when dated). The picture is the shared
 * Thumbnail tile, so an image post, an imageless post, and a glyph post share
 * ONE tile background by state. The whole card navigates to the post detail
 * (PCS) view; when the board passes onMove and the viewer has an allowed move,
 * a ⋯ circle on the picture's top-right corner (44px tap area, about 30px
 * visible) opens the move sheet, so the title gets the full card width.
 * Navigation is a full-bleed overlay button laid behind the card content.
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
  const status =
    viewer !== undefined
      ? reviewStatus(stage, post.stage_entered_at, viewer, now ?? new Date())
      : null;
  const canMove =
    onMove !== undefined && (viewer === undefined || hasAllowedMove(viewer.role, stage));

  return (
    <div
      data-induction={INDUCTION_KEYS.pipelinePostRow}
      data-induction-post={post.id}
      className="relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-panel transition-colors hover:bg-panel-2"
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
      {canMove && onMove !== undefined ? (
        // On the picture's top-right corner, above the Open post overlay (z-10)
        // so a tap moves, not opens. Pointer down stops here so the feed's
        // long-press never arms under it. The carousel badge sits on the left
        // corner so the two never overlap.
        <button
          type="button"
          aria-label={`Move post ${post.title}`}
          data-post-card-move=""
          draggable={false}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onMove(post)}
          className="group absolute right-0 top-0 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full focus:outline-none"
        >
          <span className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors duration-fast ease-enter group-hover:bg-black/60 group-focus-visible:ring-2 group-focus-visible:ring-accent">
            <MoreIcon />
          </span>
        </button>
      ) : null}
      <div data-post-card-body="" className="flex min-w-0 flex-col gap-1.5 p-3">
        <div
          data-post-card-title=""
          className="line-clamp-2 text-sm font-medium leading-snug [overflow-wrap:anywhere]"
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
              'flex min-w-0 items-center gap-1.5 text-xs',
              status.tone === 'you' ? 'font-semibold text-accent' : 'text-fg-2',
            )}
          >
            {status.tone === 'you' ? (
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
            ) : (
              <StageDot stage={stage} />
            )}
            <span className="truncate">{status.text}</span>
          </div>
        ) : null}
        {/* One quiet meta line: the stage (All view only, when no status line
          names it), the format glyph, and the due date. The row never wraps. */}
        <div className="flex min-w-0 items-center gap-1.5">
          {showStage && status === null ? (
            <span
              data-post-card-stage=""
              className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-2"
            >
              <StageDot stage={stage} />
              {stageLabel(stage)}
            </span>
          ) : null}
          <span className="inline-flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-md text-fg-3">
            {formatIcon(formatToken(post.format), 13)}
          </span>
          {post.target_date !== null ? (
            <span data-post-card-due="" className="ml-auto truncate text-xs tabular-nums text-fg-3">
              {dueLabel(post.target_date, timeZone)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
