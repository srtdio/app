import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Chip } from '@/components/ui/Chip';
import { IconFile, IconLink } from '@/components/ui/icons';
import { useInView } from '@/lib/use-in-view';
import { imageTileState } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import type { PipelinePost } from '@srtdio/posts';

export interface PostCardProps {
  post: PipelinePost;
  // TODO(PR3): PipelinePage must own a PresignCache and pass cache + presignEnabled; also widen its state from Post[] to PipelinePost[].
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
 * Lazily presign and keep fresh the thumbnail URL for a post that has a first
 * image attachment. Same recipe as the assets grid (useInView + the shared
 * PresignCache + imageTileState): off-screen cards never presign, the URL is
 * served from the cache when warm, and it is refreshed shortly before expiry so
 * a long-lived card never shows a 403. The card never owns a cache or calls the
 * worker directly; the board passes one shared cache in.
 */
function usePostThumbnail(
  post: PipelinePost,
  cache: PresignCache,
  enabled: boolean,
): {
  ref: React.RefObject<HTMLDivElement>;
  url: string | null;
  failed: boolean;
  onError: () => void;
} {
  const { ref, inView } = useInView<HTMLDivElement>();
  const versionId = post.thumbnailAssetVersionId;
  const active = enabled && versionId !== null;
  const [url, setUrl] = useState<string | null>(() =>
    active && versionId !== null ? (cache.peek(versionId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active || versionId === null || !inView) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const presigned = await cache.resolve(versionId);
        if (!live) return;
        setUrl(presigned.url);
        setFailed(false);
        const delay = Math.max(presigned.expiresAt - Date.now() - 60_000, 5_000);
        timer = setTimeout(() => {
          if (live) void load();
        }, delay);
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, versionId, inView, cache]);

  return { ref, url, failed, onError: () => setFailed(true) };
}

const FRAME = 'relative aspect-square w-full overflow-hidden rounded-[10px]';

/** The glyph fallback tile: a link or file/image glyph centered on a neutral panel. */
function GlyphTile({ format }: { format: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-panel-3 text-fg-2">
      {format === 'link' ? <IconLink size={24} /> : <IconFile size={24} />}
    </div>
  );
}

/** A caption-snippet tile for a text post with no image: clamped, italic body copy. */
function CaptionTile({ caption }: { caption: string }) {
  return (
    <div className="h-full w-full overflow-hidden bg-panel-2 p-3">
      <p className="line-clamp-4 text-xs italic leading-snug text-fg-2">{caption}</p>
    </div>
  );
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
 * A pipeline board card: a square thumbnail frame above the title, a chip for
 * platform, a chip for format, and the target date when present. The thumbnail
 * is a presigned image when the post has a first image attachment, a caption
 * snippet for an imageless text post, or a glyph fallback otherwise. The whole
 * card navigates to the post detail (PCS) view; stage changes happen only there,
 * never on the board. Navigation is a full-bleed overlay button so the display
 * Chips (which are themselves buttons) are never nested inside another button.
 */
export function PostCard({ post, cache, presignEnabled }: PostCardProps) {
  const navigate = useNavigate();
  const { ref, url, failed, onError } = usePostThumbnail(post, cache, presignEnabled);
  const versionId = post.thumbnailAssetVersionId;
  const hasCaption = post.caption !== null && post.caption.trim() !== '';

  let tile: ReactNode;
  if (versionId !== null) {
    const state = imageTileState({ enabled: presignEnabled, hasVersion: true, url, failed });
    tile =
      state === 'shimmer' ? (
        <div className="h-full w-full animate-pulse bg-panel-2" />
      ) : state === 'image' && url !== null ? (
        <img
          src={url}
          alt={post.title}
          loading="lazy"
          onError={onError}
          className="h-full w-full object-cover"
        />
      ) : (
        <GlyphTile format={post.format} />
      );
  } else if (post.format === 'text' && hasCaption && post.caption !== null) {
    tile = <CaptionTile caption={post.caption} />;
  } else {
    tile = <GlyphTile format={post.format} />;
  }

  return (
    <div className="relative flex flex-col gap-2 rounded-lg border border-border bg-panel p-3 transition-colors hover:bg-panel-2">
      <button
        type="button"
        aria-label={`Open post ${post.title}`}
        onClick={() => navigate(`/posts/${post.id}`)}
        className="absolute inset-0 rounded-lg"
      />
      <div ref={ref} className={cn(FRAME, 'bg-panel-2')}>
        {tile}
        {post.format === 'carousel' ? <CarouselBadge /> : null}
      </div>
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
  );
}
