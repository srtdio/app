import { useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { SIGNOUT_EVENT } from '@/lib/events';
import { ICON_SIZE, IconFile, IconLink } from '@/components/ui/icons';
import { formatIcon, type FormatGlyphToken } from '@/components/ui/format-icon';
import { imageTileState } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import { useThumbnail } from './use-thumbnail';
import { useNearViewport, useStoredThumbnail } from '@/components/ui/FileTile';

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

interface ThumbnailProps {
  /** The version to presign, or null for a fallback-only tile (links, docs, imageless posts). */
  assetVersionId: string | null;
  /** The page-owned presign cache, passed down; the tile never makes its own. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the tile shows the fallback. */
  presignEnabled: boolean;
  /** Frame aspect ratio. Defaults to square (the locked Pipeline choice). */
  aspect?: 'square' | '4/3';
  /**
   * An exact frame ratio (w / h), e.g. the post's platform frame (4:5 for an
   * Instagram post). When set it wins over `aspect`.
   */
  ratio?: number;
  /** What to show when there is no usable image preview. */
  fallback: ThumbnailFallback;
  /** Accessible label for the rendered <img>; usually the asset or post name. */
  alt: string;
  /** Optional overlay decoration (e.g. a carousel badge) painted over the tile. */
  children?: ReactNode;
  /** Lines of body text the 'post' text tile clamps to. Defaults to 4 (Pipeline). */
  bodyLines?: 3 | 4;
  /** A caller-drawn tile shown instead of `fallback` when there is no usable image. */
  fallbackTile?: ReactNode;
}

const ASPECT: Record<NonNullable<ThumbnailProps['aspect']>, string> = {
  square: 'aspect-square',
  '4/3': 'aspect-[4/3]',
};

// Full class strings, so the default (Pipeline's) markup stays exactly as it was.
const BODY_CLASS: Record<NonNullable<ThumbnailProps['bodyLines']>, string> = {
  3: 'mt-auto line-clamp-3 text-sm leading-snug text-fg-2',
  4: 'mt-auto line-clamp-4 text-sm leading-snug text-fg-2',
};

// Versions whose original has shown this session: a remount (a tab return)
// paints it at once, with no fade. Cleared on signout.
const shownOriginals = new Set<string>();

if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, () => shownOriginals.clear());
}

/** The glyph/label/caption tile shown when there is no usable image preview. */
function FallbackTile({
  fallback,
  bodyLines = 4,
}: {
  fallback: ThumbnailFallback;
  bodyLines?: 3 | 4;
}) {
  if (fallback.kind === 'post') {
    // A plain tile on the Thumbnail's own bg-panel-3: the format icon and the
    // body snippet, no decorative gradient and no uppercase format label.
    if (fallback.layout === 'media') {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2.5 p-3 text-center">
          <span className="text-fg-3">{formatIcon(fallback.glyph, 26)}</span>
          {fallback.body !== null ? (
            <p className="line-clamp-2 text-sm leading-snug text-fg-2">{fallback.body}</p>
          ) : null}
        </div>
      );
    }
    return (
      <div className="flex h-full w-full flex-col p-3">
        <span className="text-fg-3">{formatIcon(fallback.glyph, 16)}</span>
        {fallback.body !== null ? <p className={BODY_CLASS[bodyLines]}>{fallback.body}</p> : null}
      </div>
    );
  }
  if (fallback.kind === 'text') {
    return (
      <div className="h-full w-full overflow-hidden p-3">
        <p className="line-clamp-4 text-sm italic leading-snug text-fg-2">{fallback.caption}</p>
      </div>
    );
  }
  if (fallback.kind === 'link') {
    return (
      <div className="flex flex-col items-center gap-1 px-3 text-center text-fg-2">
        <IconLink size={ICON_SIZE.tray} />
        {fallback.label !== '' ? (
          <span className="max-w-full truncate text-sm">{fallback.label}</span>
        ) : null}
      </div>
    );
  }
  const ext = fallback.kind === 'file' ? fallback.extension : '';
  return (
    <div className="flex flex-col items-center gap-1 text-fg-2">
      <IconFile size={ICON_SIZE.status} />
      {ext !== '' ? <span className="text-sm font-medium tabular-nums">{ext}</span> : null}
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
 *
 * Fast first paint: the version's small stored copy (a few KB) paints first,
 * on the first frame when it is already known. A tile only ever shows the small
 * copy, even where it is slightly soft (decided 20 Oct 2026: grids never pull
 * the full-size original). The original loads only for a version with no small
 * copy, or when the small copy fails to load.
 */
export function Thumbnail({
  assetVersionId,
  cache,
  presignEnabled,
  aspect = 'square',
  ratio,
  fallback,
  alt,
  children,
  bodyLines = 4,
  fallbackTile,
}: ThumbnailProps) {
  const active = presignEnabled && assetVersionId !== null;
  const versionId = assetVersionId ?? '';
  const boxRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(boxRef);
  // A small copy already known (this session or kept on the device) paints at once.
  const knownSmall = active ? (cache.peekThumbnail(versionId)?.url ?? null) : null;
  const stored = useStoredThumbnail(versionId, cache, active && near);
  const [smallFailed, setSmallFailed] = useState<string | null>(null);
  const smallUrl = smallFailed === versionId ? null : (stored.url ?? knownSmall);
  // The original loads only when there is no small copy to show.
  const wantOriginal = active && (stored.missing || smallFailed === versionId);
  const original = useThumbnail<HTMLSpanElement>({
    assetVersionId: wantOriginal ? assetVersionId : null,
    cache,
    enabled: presignEnabled,
  });
  const originalUrl = wantOriginal && !original.failed ? original.url : null;
  const state = imageTileState({
    enabled: presignEnabled,
    hasVersion: assetVersionId !== null,
    url: smallUrl ?? originalUrl,
    failed: smallUrl === null && original.failed,
  });
  // Which url has painted: the onboarding guide waits for on-screen photos
  // (data-thumb-loading) before it points at anything.
  const [painted, setPainted] = useState<string | null>(null);
  const [sharp, setSharp] = useState<string | null>(null);
  const loading =
    state === 'shimmer' || (state === 'image' && painted !== smallUrl && painted !== originalUrl);
  // The version this mount faded in itself: it keeps its fade to the end.
  const [fadedIn, setFadedIn] = useState<string | null>(null);
  const instant = shownOriginals.has(versionId) && fadedIn !== versionId;
  const originalShown =
    originalUrl !== null && (instant || smallUrl === null || sharp === originalUrl);

  return (
    <div
      ref={boxRef}
      {...(loading ? { 'data-thumb-loading': '' } : {})}
      className={cn(
        'relative flex w-full items-center justify-center overflow-hidden',
        ratio === undefined ? ASPECT[aspect] : null,
        state === 'image' ? 'bg-panel-2' : 'bg-panel-3',
      )}
      {...(ratio !== undefined ? { style: { aspectRatio: String(ratio) } } : {})}
    >
      <span
        ref={original.ref}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
      />
      {state === 'shimmer' ? (
        <div className="h-full w-full animate-pulse bg-panel-2" />
      ) : state === 'image' ? (
        <>
          {smallUrl !== null ? (
            <img
              src={smallUrl}
              alt={originalShown ? '' : alt}
              decoding="async"
              data-thumb-small=""
              onLoad={() => setPainted((now) => now ?? smallUrl)}
              onError={() => setSmallFailed(versionId)}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          {originalUrl !== null ? (
            <img
              src={originalUrl}
              alt={originalShown ? alt : ''}
              loading="lazy"
              decoding="async"
              onLoad={() => {
                if (!shownOriginals.has(versionId)) {
                  shownOriginals.add(versionId);
                  setFadedIn(versionId);
                }
                setSharp(originalUrl);
                setPainted(originalUrl);
              }}
              onError={original.onError}
              className={cn(
                'absolute inset-0 h-full w-full object-cover',
                instant ? null : 'transition-opacity duration-150 motion-reduce:transition-none',
                originalShown ? 'opacity-100' : 'opacity-0',
              )}
            />
          ) : null}
        </>
      ) : fallbackTile !== undefined ? (
        fallbackTile
      ) : (
        <FallbackTile fallback={fallback} bodyLines={bodyLines} />
      )}
      {children}
    </div>
  );
}
