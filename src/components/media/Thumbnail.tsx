import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '@/lib/cn';
import { IconFile, IconLink } from '@/components/ui/icons';
import { formatIcon, type FormatGlyphToken } from '@/components/ui/format-icon';
import { imageTileState } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import { useThumbnail } from './use-thumbnail';
import { useNearViewport, useStoredThumbnail } from '@/components/ui/FileTile';
import { IMAGE_THUMBNAIL_MAX_WIDTH } from '@/lib/files/thumbnail';

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
 *
 * Fast first paint: the version's small stored copy (a few KB, and its URL kept
 * on the device) paints first, on the first frame when it is already known. A
 * tile wider than the small copy can fill sharply also loads the original and
 * fades it in over the small copy once it has loaded (opacity only, no
 * movement), so the picture appears at once and then sharpens. A version with
 * no small copy loads the original as before.
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
  const active = presignEnabled && assetVersionId !== null;
  const versionId = assetVersionId ?? '';
  const boxRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(boxRef);
  // A small copy already known (this session or kept on the device) paints at once.
  const knownSmall = active ? (cache.peekThumbnail(versionId)?.url ?? null) : null;
  const stored = useStoredThumbnail(versionId, cache, active && near);
  const [smallFailed, setSmallFailed] = useState<string | null>(null);
  const smallUrl = smallFailed === versionId ? null : (stored.url ?? knownSmall);
  const sharpNeeded = useNeedsSharp(boxRef, active);
  // An original already signed this session is used too: it is the sharpest
  // picture and most likely already in the browser's cache.
  const knownOriginal = active && cache.peek(versionId) !== null;
  const wantOriginal =
    active && (sharpNeeded || knownOriginal || stored.missing || smallFailed === versionId);
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
  const originalShown = originalUrl !== null && (smallUrl === null || sharp === originalUrl);

  return (
    <div
      ref={boxRef}
      {...(loading ? { 'data-thumb-loading': '' } : {})}
      className={cn(
        'relative flex w-full items-center justify-center overflow-hidden',
        ASPECT[aspect],
        state === 'image' ? 'bg-panel-2' : 'bg-panel-3',
      )}
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
                setSharp(originalUrl);
                setPainted(originalUrl);
              }}
              onError={original.onError}
              className={cn(
                'absolute inset-0 h-full w-full object-cover transition-opacity duration-150 motion-reduce:transition-none',
                originalShown ? 'opacity-100' : 'opacity-0',
              )}
            />
          ) : null}
        </>
      ) : (
        <FallbackTile fallback={fallback} />
      )}
      {children}
    </div>
  );
}

/**
 * True when the tile is wider (in device pixels) than the small copy can fill
 * sharply, so the original should load over it. Measured once before paint.
 */
// A layout effect in the browser (measured before paint), a plain effect in SSR
// and static renders, where it never runs either way.
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useNeedsSharp(ref: RefObject<HTMLElement>, active: boolean): boolean {
  const [needs, setNeeds] = useState(false);
  useBeforePaint(() => {
    if (!active) return;
    const el = ref.current;
    if (el === null || typeof window === 'undefined') return;
    const ratio = window.devicePixelRatio || 1;
    setNeeds(el.getBoundingClientRect().width * ratio > IMAGE_THUMBNAIL_MAX_WIDTH);
  }, [ref, active]);
  return needs;
}
