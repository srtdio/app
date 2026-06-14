import { useNavigate } from 'react-router-dom';
import { Chip } from '@/components/ui/Chip';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost } from '@srtdio/posts';

export interface PostCardProps {
  post: PipelinePost;
  cache: PresignCache;
  presignEnabled: boolean;
}

/** Format an ISO date as a date only (no time), matching the board reference. */
function formatTargetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The non-image tile for a post: a clamped caption snippet for an imageless text
 * post, a link glyph for a link post, or a plain file glyph otherwise. When the
 * post has a thumbnail this is only used if the presign fails or is disabled.
 */
function postFallback(post: PipelinePost): ThumbnailFallback {
  if (post.format === 'text' && post.caption !== null && post.caption.trim() !== '') {
    return { kind: 'text', caption: post.caption };
  }
  if (post.format === 'link') return { kind: 'link', label: '' };
  return { kind: 'glyph' };
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

/**
 * A pipeline board card: a full-bleed square thumbnail above the title, a chip for
 * platform, a chip for format, and the target date when present. The thumbnail is
 * the shared Thumbnail tile (same one Assets uses), so a single_image, a text, and
 * a glyph post all share ONE tile background by state. The whole card navigates to
 * the post detail (PCS) view; stage changes happen only there, never on the board.
 * Navigation is a full-bleed overlay button so the display Chips (which are
 * themselves buttons) are never nested inside another button.
 */
export function PostCard({ post, cache, presignEnabled }: PostCardProps) {
  const navigate = useNavigate();

  return (
    <div className="relative flex flex-col overflow-hidden rounded-lg border border-border bg-panel transition-colors hover:bg-panel-2">
      <button
        type="button"
        aria-label={`Open post ${post.title}`}
        onClick={() => navigate(`/posts/${post.id}`)}
        className="absolute inset-0 rounded-lg"
      />
      <Thumbnail
        assetVersionId={post.thumbnailAssetVersionId}
        cache={cache}
        presignEnabled={presignEnabled}
        aspect="square"
        fallback={postFallback(post)}
        alt={post.title}
      >
        {post.format === 'carousel' ? <CarouselBadge /> : null}
      </Thumbnail>
      <div className="flex flex-col gap-2 p-3">
        <div className="truncate text-sm font-medium leading-snug">{post.title}</div>
        <div className="flex items-center gap-1.5">
          <Chip label={post.platform} />
          <Chip label={post.format} />
          {post.target_date !== null ? (
            <span className="ml-auto text-xs tabular-nums text-fg-3">
              {formatTargetDate(post.target_date)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
