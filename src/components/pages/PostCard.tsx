import { useNavigate } from 'react-router-dom';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { IconPlay } from '@/components/ui/icons';
import { FORMAT_GLYPH_LABEL, formatIcon, type FormatGlyphToken } from '@/components/ui/format-icon';
import type { PresignCache } from '@/lib/asset-presign';
import { entityUrlPath } from '@/lib/entityRef';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { StageDot, stageLabel } from '@/components/pages/pipeline/stage-meta';
import type { PipelinePost, Stage } from '@srtdio/posts';

export interface PostCardProps {
  post: PipelinePost;
  cache: PresignCache;
  presignEnabled: boolean;
  /** The active workspace's key, used to build the pretty /p/KEY-N link. When
   *  absent the card falls back to the classic /posts/:id route. */
  workspaceKey?: string | null;
  /** Opens the move sheet for this post; renders the card's Move button. */
  onMove?: (post: PipelinePost) => void;
  /** The All view: the meta line leads with the post's stage dot and label. */
  showStage?: boolean;
}

/** Format an ISO date as a date only (no time), matching the board reference. */
function formatTargetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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
  const body = post.caption !== null && post.caption.trim() !== '' ? post.caption : post.title;
  const layout = token === 'video' || token === 'link' ? 'media' : 'text';
  return { kind: 'post', glyph: token, label: FORMAT_GLYPH_LABEL[token], body, layout };
}

/** A small "multiple images" badge (stacked squares) shown on carousel posts. */
function CarouselBadge() {
  return (
    <span
      aria-label="Carousel"
      className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-6 min-w-[24px] items-center justify-center rounded-md bg-black/55 text-white"
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

/** Two opposed arrows: the Move button's swap glyph. */
function SwapIcon() {
  return (
    <svg
      aria-hidden
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 4 3 8l4 4" />
      <path d="M3 8h14" />
      <path d="m17 20 4-4-4-4" />
      <path d="M21 16H7" />
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
 * A pipeline board card: a full-bleed square thumbnail above the title and one
 * quiet meta line (a platform mark, the format glyph, and the target date when
 * present). The thumbnail is the shared Thumbnail tile (same one Assets uses), so
 * an image post, an imageless post, and a glyph post all share ONE tile background
 * by state. The whole card navigates to the post detail (PCS) view; when the
 * board passes onMove, a 44px Move button on the thumbnail corner opens the move
 * sheet.
 * Navigation is a full-bleed overlay button laid behind the card content.
 */
export function PostCard({
  post,
  cache,
  presignEnabled,
  workspaceKey = null,
  onMove,
  showStage = false,
}: PostCardProps) {
  const navigate = useNavigate();
  const hasPoster = post.thumbnailAssetVersionId !== null;
  // Prefer the pretty link (/p/KEY-N); the classic /posts/:id route remains a
  // working fallback when the key has not resolved yet.
  const href =
    workspaceKey !== null ? entityUrlPath('post', workspaceKey, post.number) : `/posts/${post.id}`;

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
      {onMove !== undefined ? (
        // Over the thumbnail's top-left corner, above the Open post overlay (z-10)
        // so a tap moves, not opens. Pointer down stops here so the feed's
        // long-press never arms under it.
        <button
          type="button"
          aria-label={`Move post ${post.title}`}
          data-post-card-move=""
          draggable={false}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onMove(post)}
          className="absolute left-1.5 top-1.5 z-10 inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-panel/90 text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <SwapIcon />
        </button>
      ) : null}
      {/* The tile is relative, so it would paint over the absolute Open post button;
          pointer-events-none lets a tap on the thumbnail reach the button. */}
      <div data-post-card-thumb="" className="pointer-events-none">
        <Thumbnail
          assetVersionId={post.thumbnailAssetVersionId}
          cache={cache}
          presignEnabled={presignEnabled}
          aspect="square"
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
      <div className="flex flex-col gap-2 p-3">
        <div
          data-post-card-title=""
          className="line-clamp-2 text-sm font-medium leading-snug [overflow-wrap:anywhere]"
        >
          {post.title}
        </div>
        {/* One quiet meta line: the stage (All view only), the platform mark, the
            format glyph, and the date pushed to the trailing edge. No two-pill
            stack; the row never wraps. */}
        <div className="flex items-center gap-1.5">
          {showStage ? (
            <span
              data-post-card-stage=""
              className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-2"
            >
              <StageDot stage={post.stage as Stage} />
              {stageLabel(post.stage as Stage)}
            </span>
          ) : null}
          <PlatformMark platform={post.platform} />
          <span className="inline-flex h-[19px] w-[19px] items-center justify-center rounded-md text-fg-3">
            {formatIcon(formatToken(post.format), 13)}
          </span>
          {post.target_date !== null ? (
            <span className="ml-auto shrink-0 text-xs tabular-nums text-fg-3">
              {formatTargetDate(post.target_date)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
