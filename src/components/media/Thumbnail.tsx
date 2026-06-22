import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { IconFile, IconLink } from '@/components/ui/icons';
import { formatIcon, type FormatGlyphToken } from '@/components/ui/format-icon';
import { imageTileState } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import { useThumbnail } from './use-thumbnail';

/**
 * What the non-image tile should be. Unifies AssetCard's link/file Fallback with
 * PostCard's GlyphTile/CaptionTile into one discriminated description so callers
 * say what the fallback is, not how to render it. The 'post' kind is the
 * format-aware premium tile the Pipeline card uses when a post has no image.
 */
export type ThumbnailFallback =
  | { kind: 'link'; label: string }
  | { kind: 'file'; extension: string }
  | { kind: 'text'; caption: string }
  | {
      kind: 'post';
      glyph: FormatGlyphToken;
      label: string;
      body: string | null;
      layout: 'text' | 'media';
    }
  | { kind: 'glyph' };

export interface ThumbnailProps {
  /** The version to presign, or null for a fallback-only tile (links, docs, imageless posts). */
  assetVersionId: string | null;
  /** The page-owned presign cache, passed down; the tile never makes its own. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the tile shows the fallback. */
  presignEnabled: boolean;
  /** Frame aspect ratio. Defaults to square (the locked Pipeline choice). */
  aspect?: 'square' | '4/3';
  /** What to show when there is no usable image preview. */
  fallback: ThumbnailFallback;
  /** Accessible label for the rendered <img>; usually the asset or post name. */
  alt: string;
  /** Optional overlay decoration (e.g. a carousel badge) painted over the tile. */
  children?: ReactNode;
}

const ASPECT: Record<NonNullable<ThumbnailProps['aspect']>, string> = {
  square: 'aspect-square',
  '4/3': 'aspect-[4/3]',
};

/** The glyph/label/caption tile shown when there is no usable image preview. */
function FallbackTile({ fallback }: { fallback: ThumbnailFallback }) {
  if (fallback.kind === 'post') {
    const eyebrow = (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-3">
        {formatIcon(fallback.glyph, 13)}
        {fallback.label}
      </span>
    );
    if (fallback.layout === 'media') {
      return (
        <div className="relative flex h-full w-full flex-col items-center justify-center gap-2.5 bg-gradient-to-br from-panel-2 to-panel-3 p-3 text-center">
          <span className="absolute left-3 top-3">{eyebrow}</span>
          <span className="text-fg-3">{formatIcon(fallback.glyph, 26)}</span>
          {fallback.body !== null ? (
            <p className="line-clamp-2 text-xs leading-snug text-fg-2">{fallback.body}</p>
          ) : null}
        </div>
      );
    }
    return (
      <div className="flex h-full w-full flex-col bg-gradient-to-br from-panel-2 to-panel-3 p-3">
        {eyebrow}
        {fallback.body !== null ? (
          <p className="mt-auto line-clamp-4 text-xs leading-snug text-fg-2">{fallback.body}</p>
        ) : null}
      </div>
    );
  }
  if (fallback.kind === 'text') {
    return (
      <div className="h-full w-full overflow-hidden p-3">
        <p className="line-clamp-4 text-xs italic leading-snug text-fg-2">{fallback.caption}</p>
      </div>
    );
  }
  if (fallback.kind === 'link') {
    return (
      <div className="flex flex-col items-center gap-1 px-3 text-center text-fg-2">
        <IconLink size={22} />
        {fallback.label !== '' ? (
          <span className="max-w-full truncate text-xs">{fallback.label}</span>
        ) : null}
      </div>
    );
  }
  const ext = fallback.kind === 'file' ? fallback.extension : '';
  return (
    <div className="flex flex-col items-center gap-1 text-fg-2">
      <IconFile size={24} />
      {ext !== '' ? <span className="text-[11px] font-medium tabular-nums">{ext}</span> : null}
    </div>
  );
}

/**
 * The one authoritative thumbnail tile for Assets, Pipeline and Briefs. Renders a
 * shimmer while presigning, a full-bleed <img object-cover> when resolved, and the
 * caller's fallback otherwise. The tile background switches by state only
 * (image=bg-panel-2, fallback=bg-panel-3) on a SINGLE tile, never per-fallback. It
 * adds no inner rounding or outer padding: the caller's card supplies overflow-hidden
 * and the radius, so the tile is edge-to-edge and never looks inset or floated.
 */
export function Thumbnail({
  assetVersionId,
  cache,
  presignEnabled,
  aspect = 'square',
  fallback,
  alt,
  children,
}: ThumbnailProps) {
  const { ref, url, failed, onError } = useThumbnail<HTMLDivElement>({
    assetVersionId,
    cache,
    enabled: presignEnabled,
  });
  const state = imageTileState({
    enabled: presignEnabled,
    hasVersion: assetVersionId !== null,
    url,
    failed,
  });

  return (
    <div
      ref={ref}
      className={cn(
        'relative flex w-full items-center justify-center overflow-hidden',
        ASPECT[aspect],
        state === 'image' ? 'bg-panel-2' : 'bg-panel-3',
      )}
    >
      {state === 'shimmer' ? (
        <div className="h-full w-full animate-pulse bg-panel-2" />
      ) : state === 'image' && url !== null ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          onError={onError}
          className="h-full w-full object-cover"
        />
      ) : (
        <FallbackTile fallback={fallback} />
      )}
      {children}
    </div>
  );
}
