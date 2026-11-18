import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
} from 'react';
import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react';
import {
  ICON_SIZE,
  IconAssets,
  IconChevronLeft,
  IconChevronRight,
  IconGrip,
  IconHistory,
  IconImagePlus,
  IconLock,
  IconPlus,
} from '@/components/ui/icons';
import { ArrangeSheet } from '@/components/pages/pcs/ArrangeSheet';
import { useLongPress } from '@/components/ui/useLongPress';
import { PostLightbox } from '@/components/pages/pcs/PostLightbox';
import { FileTile, storedThumbnailMeta } from '@/components/ui/FileTile';
import { classifyFileKind, type FileKind } from '@/lib/chat/attachments';
import { cn } from '@/lib/cn';
import { SIGNOUT_EVENT } from '@/lib/events';
import { mark } from '@/lib/perf-marks';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { DropZone } from '@/components/ui/DropZone';
import { PressableRow } from '@/components/ui/PressableRow';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import { frameFor, PLATFORM_SPECS, type Frame } from '@/lib/platform-specs';
import { galleryItemMedia } from '@/components/media/PlatformFrame';
import {
  cutPercent,
  frameMap,
  IDENTITY_MAP,
  type FrameMap,
} from '@/components/pages/pcs/pin-annotations';
import { LEADING_PULL, PHONE_TOOLS_SCROLL, TRAILING_PULL } from '@/components/ui/layout';
import { isPostPlatform, type GalleryItem } from '@srtdio/posts';

/** The gesture handlers a tile spreads for long-press + right-click. */
interface TileGestures {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}

/** True when this item has an inline image preview worth resolving for a tile. */
function isImage(item: GalleryItem): boolean {
  return item.kind === 'image' || (item.mimeType ?? '').startsWith('image/');
}

/** True when this item is a video (by stored kind or mime). */
function isVideo(item: GalleryItem): boolean {
  return item.kind === 'video' || (item.mimeType ?? '').startsWith('video/');
}

/**
 * The file tile kind for a non-image item, from its stored kind and the
 * server-detected mime (never the file name); null for images. Pure.
 */
export function galleryFileKind(item: GalleryItem): FileKind | null {
  if (isImage(item)) return null;
  if (isVideo(item)) return 'video';
  return classifyFileKind(item.mimeType ?? '');
}

/**
 * The usable intrinsic size from a decoded image's naturalWidth/naturalHeight,
 * or null when either is zero, negative, or NaN (an undecoded or broken image
 * reports zeros). Pure, so the ribbon never reports a size that would poison the
 * measured-dimensions state. Exported for unit coverage.
 */
export function intrinsicSize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } | null {
  if (naturalWidth > 0 && naturalHeight > 0) return { width: naturalWidth, height: naturalHeight };
  return null;
}

// Versions whose full image has decoded this session: a remount (a reopened
// post) paints the full image at once, with no cover first. Cleared on signout.
const decodedFull = new Set<string>();

if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, () => decodedFull.clear());
}

/**
 * The small copy already known for a version (the Pipeline card's cover URL,
 * from the shared presign cache), or null. Synchronous: never a network read.
 */
function knownCover(cache: PresignCache, versionId: string): string | null {
  if (decodedFull.has(versionId)) return null;
  return cache.peekThumbnail(versionId)?.url ?? null;
}

/**
 * Lazily resolve and render one tile's inline thumbnail, falling back to a glyph.
 *
 * Cover first (post ribbon only, `coverLoading` set): when the version's small
 * copy is already known (the Pipeline card showed it), it paints on the first
 * frame in the same box and fit as the full image, and the full image swaps in
 * only once it has loaded and decoded. No cover known: exactly as before.
 */
function GalleryThumb({
  item,
  cache,
  presignEnabled,
  fit = 'cover',
  onMeasure,
  coverLoading,
  paintMarks = false,
}: {
  item: GalleryItem;
  cache: PresignCache;
  presignEnabled: boolean;
  /**
   * 'cover' crops to fill (the brief grid and the small thumbnails); 'fit'
   * scales the whole image into its box, never cropping (the post ribbon,
   * whose tile box already carries the image's own ratio).
   */
  fit?: 'cover' | 'fit';
  /**
   * Ribbon only: report the image's intrinsic size once it decodes, so a tile
   * whose stored dimensions are null can still hug its true ratio. Never fires
   * with a zero or NaN dimension, and never on a load error.
   */
  onMeasure?: ((width: number, height: number) => void) | undefined;
  /**
   * Post ribbon only: paint the known small copy first (eager for the slide on
   * screen, lazy for the rest). Absent: no cover (brief grid, snapshots, reorder).
   */
  coverLoading?: 'eager' | 'lazy' | undefined;
  /** Drop the post:media:* perf marks (the ribbon's first slide). */
  paintMarks?: boolean;
}) {
  const versionId = item.assetVersionId;
  const renderable = presignEnabled && isImage(item) && versionId !== '';
  const [url, setUrl] = useState<string | null>(() =>
    renderable ? (cache.peek(versionId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);
  // The cover is read once per version, synchronously, on the first render.
  const [cover] = useState<{ versionId: string; url: string } | null>(() => {
    if (!renderable || coverLoading === undefined) return null;
    const known = knownCover(cache, versionId);
    return known === null ? null : { versionId, url: known };
  });
  // Layered (cover under, full over) for the whole mount once a cover was
  // known, so the full <img> never remounts when the cover leaves.
  const layered = cover !== null && cover.versionId === versionId;
  const [coverFailed, setCoverFailed] = useState(false);
  // The version whose full image has loaded and decoded on this mount.
  const [fullReady, setFullReady] = useState<string | null>(null);
  const fullShown = fullReady === versionId;
  const coverUrl = cover !== null && layered && !coverFailed && !fullShown ? cover.url : null;
  const fullRef = useRef<HTMLImageElement>(null);

  const swapToFull = (): void => {
    decodedFull.add(versionId);
    setFullReady(versionId);
    if (paintMarks) mark('post:media:full-swap');
  };

  // A full image already decoded in the browser (memory cache) shows before
  // the first paint, so nothing paints later than it did before covers.
  useLayoutEffect(() => {
    if (!layered || fullShown) return;
    const img = fullRef.current;
    if (
      img !== null &&
      img.complete &&
      intrinsicSize(img.naturalWidth, img.naturalHeight) !== null
    ) {
      decodedFull.add(versionId);
      setFullReady(versionId);
      if (paintMarks) mark('post:media:full-swap');
    }
  }, [layered, fullShown, url, versionId, paintMarks]);

  useEffect(() => {
    if (!renderable) return;
    let live = true;
    cache
      .resolve(versionId)
      .then((presigned) => {
        if (live) setUrl(presigned.url);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [renderable, versionId, cache]);

  const fitClass = fit === 'fit' ? 'object-contain' : 'object-cover';
  const measure = (img: HTMLImageElement): void => {
    if (onMeasure === undefined) return;
    const size = intrinsicSize(img.naturalWidth, img.naturalHeight);
    if (size !== null) onMeasure(size.width, size.height);
  };

  if (layered && renderable) {
    // Cover under, full over (hidden until decoded): one box, one fit, so the
    // swap moves nothing. A failed full image keeps the cover; a failed cover
    // shows the full image as it loads, as before.
    const fullUsable = url !== null && !failed;
    if (fullUsable || coverUrl !== null) {
      return (
        <span className="relative block h-full w-full">
          {coverUrl !== null ? (
            <img
              src={coverUrl}
              alt=""
              aria-hidden="true"
              data-gallery-cover=""
              loading={coverLoading}
              decoding="async"
              onLoad={() => {
                if (paintMarks) mark('post:media:cover-paint');
              }}
              onError={() => setCoverFailed(true)}
              className={cn('absolute inset-0 h-full w-full', fitClass)}
            />
          ) : null}
          {fullUsable ? (
            <img
              ref={fullRef}
              src={url}
              alt={item.filename}
              loading="lazy"
              decoding="async"
              data-gallery-full=""
              onError={() => setFailed(true)}
              onLoad={(event) => {
                const img = event.currentTarget;
                measure(img);
                if (fullShown) return;
                // Swap only once the full image is decoded, never on bytes alone.
                if (typeof img.decode !== 'function') {
                  swapToFull();
                  return;
                }
                img.decode().then(swapToFull, swapToFull);
              }}
              className={cn(
                'absolute inset-0 h-full w-full',
                fitClass,
                coverUrl !== null ? 'opacity-0' : null,
              )}
            />
          ) : null}
        </span>
      );
    }
  }

  if (renderable && url !== null && !failed) {
    return (
      <img
        src={url}
        alt={item.filename}
        loading="lazy"
        data-gallery-full=""
        onError={() => setFailed(true)}
        onLoad={(event) => measure(event.currentTarget)}
        className={cn('h-full w-full', fitClass)}
      />
    );
  }
  // PDF, video, Office and other files: the file tile (stored thumbnail or
  // icon card, name and meta). Tapping it opens the file as before.
  const fileKind = galleryFileKind(item);
  if (fileKind !== null) {
    return (
      <FileTile
        kind={fileKind}
        mime={item.mimeType ?? ''}
        name={item.filename}
        versionId={versionId}
        pageCount={item.pageCount}
        cache={cache}
        presignEnabled={presignEnabled}
      />
    );
  }
  // Fallback covers a failed image presign and the unconfigured-env case
  // (presignEnabled false), so a tile never renders blank.
  return (
    <div className="flex h-full w-full items-center justify-center bg-panel-3 text-fg-3">
      <IconAssets size={ICON_SIZE.tray} />
    </div>
  );
}

// Map the column count to a literal Tailwind grid class. The brief gallery
// passes 2 and keeps its overview grid; any other explicit override keeps the
// old responsive grid. The post gallery default (4, i.e. the prop omitted)
// renders the scroll-snap carousel instead and never reaches this. Literal
// strings keep both classes visible to the Tailwind JIT scanner, which cannot
// see interpolated class names.
function gridClass(columns: number): string {
  return columns === 2
    ? 'grid grid-cols-2 gap-3'
    : 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4';
}

/**
 * The ribbon tile whose left edge is nearest the scroller's scrollLeft, given
 * each tile's measured left offset within the scroller. Tiles hug their images
 * so their widths vary by aspect ratio; the offsets are measured, never assumed
 * uniform. Pure so the scroll math is unit-testable without a DOM.
 */
export function nearestTileIndex(scrollLeft: number, tileOffsets: readonly number[]): number {
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let i = 0; i < tileOffsets.length; i += 1) {
    const distance = Math.abs((tileOffsets[i] ?? 0) - scrollLeft);
    if (distance < nearestDistance) {
      nearest = i;
      nearestDistance = distance;
    }
  }
  return nearest;
}

// The ribbon's shared tile height cap. Width never passes the scroller column:
// every tile box caps at 100% of a definite width (the scroller, or the solo
// slot), never a shrink-to-fit parent, so no percentage is ever cyclic and an
// undecoded or huge image can never widen its tile.
const RIBBON_TILE_MAX_HEIGHT = 'clamp(200px, 38vh, 320px)';
// A solo image is not a peek ribbon: it fills the column at its own ratio, taller
// than a ribbon tile is allowed to be.
const SOLO_TILE_MAX_HEIGHT = '78vh';
// Unknown dimensions: a stable 4/5 box the image fits inside until it decodes.
const FALLBACK_RATIO = 4 / 5;

/** The usable w / h ratio, or the 4/5 fallback. Pure. */
function tileRatio(width: number | null, height: number | null): number {
  return width !== null && height !== null && width > 0 && height > 0
    ? width / height
    : FALLBACK_RATIO;
}

/**
 * The reserved box for one ribbon tile when the ribbon holds several. Width is
 * the height cap times the ratio, capped at the scroller's width (the tile is
 * the scroller's own flex item, so 100% is definite); aspect-ratio carries the
 * height, so a wide image renders shorter, never wider than the column. The
 * box holds no in-flow content, so the image can never size it. Pure.
 */
export function ribbonTileStyle(width: number | null, height: number | null): CSSProperties {
  const ratio = tileRatio(width, height);
  return {
    width: `calc(${RIBBON_TILE_MAX_HEIGHT} * ${ratio})`,
    aspectRatio: `${ratio}`,
    maxWidth: '100%',
  };
}

/**
 * The reserved box for the lone image: it fills the column width at its own
 * ratio, and a tall image narrows (width follows the 78vh height cap) instead
 * of overflowing. The box sits in a full-width slot, so 100% is definite. No
 * fixed width, so it can never be wider than the column. Pure.
 */
export function soloTileStyle(width: number | null, height: number | null): CSSProperties {
  const ratio = tileRatio(width, height);
  return {
    width: `min(100%, calc(${SOLO_TILE_MAX_HEIGHT} * ${ratio}))`,
    aspectRatio: `${ratio}`,
    maxWidth: '100%',
  };
}

/** A tile's intrinsic size measured from the decoded image, keyed by attachment id. */
export type MeasuredDimensions = Record<string, { width: number; height: number }>;

/**
 * The reserved box for one ribbon tile, resolving size by precedence: stored
 * intrinsic dimensions first, then the pair measured from the decoded image,
 * then the stable 4/5 fallback (until that image loads). The resolved dimensions
 * feed one authoritative sizing function: a peek tile ({@link ribbonTileStyle})
 * when the ribbon holds several images, or the full-width solo box
 * ({@link soloTileStyle}) when it holds exactly one. Pure.
 */
export function resolveRibbonTileStyle(
  item: GalleryItem,
  measured: MeasuredDimensions,
  solo = false,
): CSSProperties {
  let width: number | null = null;
  let height: number | null = null;
  const thumb = isImage(item)
    ? null
    : storedThumbnailMeta(item.assetVersionId, item.mimeType ?? '');
  if (item.width !== null && item.height !== null && item.width > 0 && item.height > 0) {
    width = item.width;
    height = item.height;
  } else if (thumb !== null) {
    // A file with a stored thumbnail: its box comes from the thumbnail's size.
    width = thumb.thumbW;
    height = thumb.thumbH;
  } else {
    const seen = measured[item.assetAttachmentId];
    if (seen !== undefined) {
      width = seen.width;
      height = seen.height;
    }
  }
  return solo ? soloTileStyle(width, height) : ribbonTileStyle(width, height);
}

/** An item's intrinsic size: stored first, then measured from the decoded image. */
function itemDims(
  item: GalleryItem,
  measured: MeasuredDimensions,
): { w: number; h: number } | null {
  if (item.width !== null && item.height !== null && item.width > 0 && item.height > 0) {
    return { w: item.width, h: item.height };
  }
  const seen = measured[item.assetAttachmentId];
  return seen !== undefined ? { w: seen.width, h: seen.height } : null;
}

/**
 * The post's platform frame from the shared frame rule, fed the FIRST item (a
 * carousel's first slide sets every slide's frame); null when the format has no
 * media box. Pure.
 */
export function galleryFrame(
  platform: string,
  format: string,
  items: readonly GalleryItem[],
  measured: MeasuredDimensions,
): Frame | null {
  const first = items[0];
  return frameFor(
    platform,
    format,
    first === undefined ? null : galleryItemMedia(first, itemDims(first, measured)),
  );
}

/** The frame's ratio (w / h) alone, or null. Pure. */
export function galleryFrameRatio(
  platform: string,
  format: string,
  items: readonly GalleryItem[],
  measured: MeasuredDimensions,
): number | null {
  return galleryFrame(platform, format, items, measured)?.ratio ?? null;
}

/** How one slide sits in the frame: cropped (cover) or fit with bands. Pure. */
export function slideMap(item: GalleryItem, measured: MeasuredDimensions, frame: Frame): FrameMap {
  return isImage(item) ? frameMap(itemDims(item, measured), frame.ratio, frame.fit) : IDENTITY_MAP;
}

/**
 * The platform's one-line note for the first slide's kind (YouTube Shorts with
 * an image: "Shorts are video only."), the same line the preview panel shows.
 */
export function frameKindNote(platform: string, items: readonly GalleryItem[]): string | null {
  const first = items[0];
  if (first === undefined || !isImage(first) || !isPostPlatform(platform)) return null;
  return PLATFORM_SPECS[platform].imageUnsupported ?? null;
}

/**
 * How much of a slide the platform frame cuts, as a whole percent: 0 with no
 * frame, a banded frame (nothing is cut), or a slide that is not an image. It
 * only decides the warning line under the picture; the post screen never crops.
 * Pure.
 */
export function frameCut(
  item: GalleryItem | undefined,
  measured: MeasuredDimensions,
  frame: Frame | null,
): number {
  if (frame === null || frame.fit !== 'cover' || item === undefined || !isImage(item)) return 0;
  return cutPercent(slideMap(item, measured, frame));
}

/**
 * Whether the in-place viewer takes the ribbon's slot: a tile is open (openIndex
 * set) and the gallery has images. Empty and upload states carry no open index,
 * so they always fall through to the ribbon branch. Pure so the ribbon<->viewer
 * swap is unit-testable without a DOM renderer.
 */
export function viewerReplacesRibbon(openIndex: number | null, itemCount: number): boolean {
  return openIndex !== null && itemCount > 0;
}

// Map the aspect token to a literal Tailwind arbitrary-aspect class, for the same
// JIT-visibility reason. The default (4/5) matches the post gallery's tiles; the
// brief gallery passes 3/2.
function aspectClass(aspect: string): string {
  return aspect === '3/2' ? 'aspect-[3/2]' : 'aspect-[4/5]';
}

interface GalleryViewProps {
  items: GalleryItem[];
  cache: PresignCache;
  presignEnabled: boolean;
  onOpen: (index: number) => void;
  /** Grid columns. Defaults to the post gallery's responsive 4-up grid. */
  columns?: number;
  /** Tile aspect ratio token. Defaults to the post gallery's 4/5. */
  aspect?: string;
  /** Per-tile index badge. Defaults to on, as the post gallery shows it. */
  showIndex?: boolean;
  /** Gesture handlers per tile (long-press + right-click). */
  slideGestures?: ((index: number) => TileGestures) | undefined;
  /** Swallow the click that trails a long-press. */
  consumeClickSuppression?: (() => boolean) | undefined;
  /** F7: agency-only append flow, wired to the zero-asset empty-state upload zone. */
  onAddSlide?: (() => void) | undefined;
  /** Carousel: the slide the counter and dots highlight. Defaults to the first. */
  activeIndex?: number;
  /** Carousel: ref to the native scroller so a dot tap can scroll it. */
  scrollerRef?: Ref<HTMLDivElement> | undefined;
  /** Carousel: native scroll listener that derives the active index. */
  onScroll?: ((event: ReactUIEvent<HTMLDivElement>) => void) | undefined;
  /**
   * Strip (laptop): the round arrow keys on its edges. prev / next say whether
   * there is more that way; onStep slides the strip one screen.
   */
  arrows?: { prev: boolean; next: boolean; onStep: (direction: -1 | 1) => void } | undefined;
  /** Ribbon: dimensions measured from decoded images, keyed by attachment id. */
  measuredDimensions?: MeasuredDimensions;
  /** Ribbon: report a tile's intrinsic size once its image decodes. */
  onMeasure?: ((assetAttachmentId: string, width: number, height: number) => void) | undefined;
  /**
   * The post's platform frame. Never crops: the ribbon always shows every
   * picture whole. It only decides the warning line under the picture.
   */
  frame?: Frame | null;
  /** The platform's one-line note under the picture (Shorts with an image). */
  frameNote?: string | null;
  /** The platform's display name, for the warning line. */
  platformLabel?: string;
  /** The warning line's "See preview": opens the platform Preview panel. */
  onSeePreview?: (() => void) | undefined;
  /**
   * The post gallery's one toolbar row (Add, Arrange, v{n}), rendered under
   * the strip. Absent on the brief grid.
   */
  toolbar?: ReactNode;
}

/** What the gallery tools row under the picture needs. */
export interface GalleryToolsModel {
  /** Creator on draft / review / parked / rejected: Add and Arrange show. */
  canEdit: boolean;
  /** Spec B4: a creator on an approved post sees a lock in place of the tools. */
  locked?: boolean;
  itemCount: number;
  /** The current version number; the v{n} button hides when null. */
  versionNumber: number | null;
  saving: boolean;
  /** The one inline error line from the last failed gallery write. */
  error: string | null;
  onAdd: () => void;
  /** Open the Arrange sheet (reorder and remove, one save on Done). */
  onArrange: () => void;
  onVersions: () => void;
}

/**
 * The one toolbar row under the strip (18 Nov 2026). Left: Add and Arrange
 * (creators on an editable stage), the first glyph on the page edge
 * (LEADING_PULL over the Tool's 12 padding); a creator on an approved post
 * sees one 14px lock in place of the edit tools. Right: the v{n} button that
 * opens the versions sheet, its text on the page edge (TRAILING_PULL). Replace
 * and Remove live on the opened picture; reordering lives in Arrange. One row,
 * never wrapping. Nothing when there is nothing to show. Pure.
 */
export function galleryToolsRow(model: GalleryToolsModel): ReactElement | null {
  const { canEdit, itemCount, saving, error, versionNumber } = model;
  const locked = !canEdit && model.locked === true;
  if (!canEdit && !locked && versionNumber === null) return null;
  return (
    <div data-gallery-tools="" className="mt-2 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div
          data-gallery-tool-keys=""
          className={cn('flex min-w-0 flex-1 items-center', PHONE_TOOLS_SCROLL)}
        >
          {locked ? (
            <span
              aria-hidden
              data-gallery-lock=""
              className={cn(
                'inline-flex h-11 w-11 items-center justify-center text-fg-3',
                LEADING_PULL,
                // Phone: the lock's ink sits on the page edge (no 44 box to
                // centre in, so no pull; LEADING_PULL slides the ink).
                'max-md:ml-0 max-md:w-auto',
              )}
            >
              <IconLock size={ICON_SIZE.inline} />
            </span>
          ) : null}
          {canEdit ? (
            <>
              <Button
                type="button"
                data-gallery-add=""
                disabled={saving}
                onClick={model.onAdd}
                variant="ghost"
                className={cn('px-3', LEADING_PULL)}
              >
                <IconPlus size={ICON_SIZE.inline} />
                Add
              </Button>
              <Button
                type="button"
                data-gallery-arrange=""
                aria-haspopup="dialog"
                disabled={saving || itemCount === 0}
                onClick={model.onArrange}
                variant="ghost"
                className="px-3"
              >
                <IconGrip size={ICON_SIZE.inline} />
                Arrange
              </Button>
            </>
          ) : null}
        </div>
        {versionNumber !== null ? (
          <Button
            type="button"
            data-gallery-versions=""
            onClick={model.onVersions}
            aria-label={`Versions, current version ${versionNumber}`}
            aria-haspopup="dialog"
            variant="ghost"
            // The text ends on the page edge; the clock glyph before it keeps
            // its place (the pull's phone ink slide is for a trailing glyph).
            className={cn(
              'shrink-0 px-3 tabular-nums',
              TRAILING_PULL,
              'max-md:[&>svg]:translate-x-0',
            )}
          >
            <IconHistory size={ICON_SIZE.inline} />
            {`v${versionNumber}`}
          </Button>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" data-gallery-error="" className="text-base text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * #35: a version's pictures as small platform-shaped thumbnails (the versions
 * sheet rows and the old-version view). Read-only: no buttons, no gestures.
 */
export function SnapshotThumbs({
  items,
  cache,
  presignEnabled,
  ratio,
  size = 'sm',
  max,
}: {
  items: readonly GalleryItem[];
  cache: PresignCache;
  presignEnabled: boolean;
  /** Platform frame ratio (w / h). */
  ratio: number;
  /** 'xs' for the versions sheet rows, 'sm' for small rows, 'lg' for the old-version view. */
  size?: 'xs' | 'sm' | 'lg';
  /** Show at most this many, then a +n count. */
  max?: number;
}) {
  const shown = max !== undefined ? items.slice(0, max) : items;
  const extra = items.length - shown.length;
  return (
    <div
      data-snapshot-thumbs=""
      className={cn('flex items-center', size === 'lg' ? 'gap-2 overflow-x-auto' : 'gap-1')}
    >
      {shown.map((item) => (
        <div
          key={item.assetAttachmentId}
          style={{ aspectRatio: `${ratio}` }}
          className={cn(
            'shrink-0 overflow-hidden border border-border bg-panel-2 lit-pill',
            size === 'xs' ? 'h-8 rounded' : size === 'sm' ? 'h-10 rounded' : 'h-40 rounded-lg',
          )}
        >
          <GalleryThumb item={item} cache={cache} presignEnabled={presignEnabled} />
        </div>
      ))}
      {extra > 0 ? (
        <span className="shrink-0 text-sm tabular-nums text-fg-3">{`+${extra}`}</span>
      ) : null}
    </div>
  );
}

// T13: a long-press on a slide must never open the browser's image callout or
// start a text selection; the callout property is inherited by the image inside.
const SLIDE_PRESS_CLASS = 'select-none [-webkit-touch-callout:none]';

/**
 * The gallery's presentational tree, kept hookless so the tree-walking unit tests
 * can exercise it without a DOM renderer. The post gallery default (columns
 * omitted) renders an uncropped horizontal snap ribbon: a native overflow-x
 * scroller with x-mandatory snapping and snap-start tiles that hug their images
 * at true aspect ratio (heights vary by ratio inside the shared caps), an n/N
 * counter, and 44px dot indicators. A lone image is not a peek tile: it fills the
 * column at its own ratio. There is no add tile on the ribbon; the zero-asset
 * empty state carries the only add affordance. No JS-driven animation; all motion
 * is native scrolling on the X axis. The brief gallery overrides columns / aspect
 * / showIndex and keeps its
 * cropped overview grid; the empty and upload states are unchanged.
 */
export function galleryView({
  items,
  cache,
  presignEnabled,
  onOpen,
  columns = 4,
  aspect = '4/5',
  showIndex = true,
  slideGestures,
  consumeClickSuppression,
  onAddSlide,
  activeIndex = 0,
  scrollerRef,
  onScroll,
  arrows,
  measuredDimensions = {},
  onMeasure,
  frame = null,
  frameNote = null,
  platformLabel = '',
  onSeePreview,
  toolbar,
}: GalleryViewProps): ReactElement {
  if (items.length === 0) {
    // Agency-side (onAddSlide present): a full-width "Add images" upload zone in
    // place of the empty text, wired to the append flow. Brief galleries omit
    // onAddSlide and keep the calm, view-only empty line unchanged.
    if (onAddSlide !== undefined) {
      const zone = (
        <DropZone type="button" minHeight="panel" onClick={onAddSlide}>
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-panel-3 text-accent">
            <IconImagePlus size={ICON_SIZE.status} />
          </span>
          <span className="text-base font-medium text-fg">Add images</span>
          <span className="text-sm text-fg-3">Tap to upload</span>
        </DropZone>
      );
      return toolbar !== undefined && toolbar !== null ? (
        <div>
          {zone}
          {toolbar}
        </div>
      ) : (
        zone
      );
    }
    const none = (
      <div className="px-4 py-8 text-center text-base text-fg-3">
        <p>No images on this post yet.</p>
      </div>
    );
    return toolbar !== undefined && toolbar !== null ? (
      <div>
        {none}
        {toolbar}
      </div>
    ) : (
      none
    );
  }
  // Non-default columns (the brief gallery's 2-up): the overview grid, unchanged.
  if (columns !== 4) {
    return (
      <div className={gridClass(columns)}>
        {items.map((item, index) => (
          <PressableRow
            key={item.assetAttachmentId}
            type="button"
            aria-label={`View image ${index + 1}`}
            {...(slideGestures !== undefined ? slideGestures(index) : {})}
            onClick={() => {
              if (consumeClickSuppression !== undefined && consumeClickSuppression()) return;
              onOpen(index);
            }}
            className={`group relative ${aspectClass(aspect)} overflow-hidden border border-border bg-panel-2 mv-tint hover:border-border-strong`}
          >
            <GalleryThumb item={item} cache={cache} presignEnabled={presignEnabled} />
            {showIndex ? (
              <span className="absolute left-2 bottom-2 rounded bg-overlay px-2 py-1 text-xs font-medium tabular-nums text-overlay-fg lit-media">
                {index + 1}/{items.length}
              </span>
            ) : null}
          </PressableRow>
        ))}
      </div>
    );
  }

  // Post gallery default: the uncropped horizontal snap ribbon. Each tile hugs
  // its image at true aspect ratio inside the shared caps, so tile widths and
  // heights vary; motion stays native scrolling on the X axis only. The counter
  // and dots reflect activeIndex, clamped so a shrinking gallery never points
  // past the end while the scroll listener catches up.
  const active = Math.min(Math.max(activeIndex, 0), items.length - 1);
  // The warning line under the picture: how much the platform cuts the slide on
  // show. The picture itself is never cropped; the Preview panel shows the cut.
  const cut = frameCut(items[active], measuredDimensions, frame);
  const solo = items.length === 1;
  return (
    <div>
      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          aria-roledescription="carousel"
          data-ribbon=""
          className="flex items-center gap-2 overflow-x-auto overscroll-x-contain rounded-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item, index) => {
            // The tile box carries the reserved size; everything inside it is
            // absolutely placed, so the image can never size the box.
            const tile = (
              <div
                key={item.assetAttachmentId}
                data-ribbon-tile=""
                style={resolveRibbonTileStyle(item, measuredDimensions, solo)}
                className="relative shrink-0 overflow-hidden rounded-xl"
              >
                <PressableRow
                  insetFocus
                  type="button"
                  aria-label={`View image ${index + 1}`}
                  {...(slideGestures !== undefined ? slideGestures(index) : {})}
                  onClick={() => {
                    if (consumeClickSuppression !== undefined && consumeClickSuppression()) return;
                    onOpen(index);
                  }}
                  className={cn(
                    'group absolute inset-0 flex items-center justify-center border border-border bg-panel-2 mv-tint hover:border-border-strong',
                    SLIDE_PRESS_CLASS,
                  )}
                >
                  <GalleryThumb
                    item={item}
                    cache={cache}
                    presignEnabled={presignEnabled}
                    fit="fit"
                    // The slide on screen paints its known cover at once; the
                    // rest fetch theirs only as they near the screen.
                    coverLoading={index === 0 ? 'eager' : 'lazy'}
                    paintMarks={index === 0}
                    onMeasure={
                      onMeasure !== undefined
                        ? (width, height) => onMeasure(item.assetAttachmentId, width, height)
                        : undefined
                    }
                  />
                </PressableRow>
              </div>
            );
            // A lone tile sits in a full-width snap slot (a definite width for
            // its 100%), centred when a tall image narrows it.
            return solo ? (
              <div
                key={item.assetAttachmentId}
                data-ribbon-slot=""
                className="flex w-full shrink-0 justify-center"
              >
                {tile}
              </div>
            ) : (
              tile
            );
          })}
        </div>
        {arrows !== undefined && !solo && arrows.prev ? (
          <IconButton
            type="button"
            label="Earlier pictures"
            data-ribbon-prev=""
            onClick={() => arrows.onStep(-1)}
            className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full border border-border bg-panel lit-float md:inline-flex"
          >
            <IconChevronLeft size={ICON_SIZE.control} />
          </IconButton>
        ) : null}
        {arrows !== undefined && !solo && arrows.next ? (
          <IconButton
            type="button"
            label="More pictures"
            data-ribbon-next=""
            onClick={() => arrows.onStep(1)}
            className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full border border-border bg-panel lit-float md:inline-flex"
          >
            <IconChevronRight size={ICON_SIZE.control} />
          </IconButton>
        ) : null}
      </div>
      {cut > 0 ? (
        <div data-frame-cut="" className="mt-1 flex flex-wrap items-center gap-x-1">
          <p className="text-base text-fg-2">{`${platformLabel} cuts ${cut}% of this.`}</p>
          {onSeePreview !== undefined ? (
            <Button type="button" variant="link" data-see-preview="" onClick={onSeePreview}>
              See preview
            </Button>
          ) : null}
        </div>
      ) : null}
      {frameNote !== null ? (
        <p data-frame-note className="mt-1 text-base text-fg-2">
          {frameNote}
        </p>
      ) : null}
      {toolbar}
    </div>
  );
}

interface PostGalleryProps {
  items: GalleryItem[];
  /** The post's (or brief's) title: the open viewer's slide alt reads "{title}, slide N". */
  title?: string | undefined;
  cache: PresignCache;
  deps: PresignDeps;
  presignEnabled: boolean;
  /** Grid columns. Defaults to the post gallery's strip. */
  columns?: number;
  /** Tile aspect ratio token. Defaults to the post gallery's 4/5. */
  aspect?: string;
  /** Per-tile index badge on the brief grid. */
  showIndex?: boolean;
  /** Creator side: the add flow, used by the zero-asset empty state. */
  onAddSlide?: (() => void) | undefined;
  /**
   * Creator side: remove the picture at this index (the page's one Remove,
   * behind its Undo strip). The opened picture's Remove key calls it.
   */
  onRemove?: ((index: number) => void) | undefined;
  /**
   * A gallery write is in flight: the tools wait and the opened picture shows
   * "Saving…", so two full-list writes never overlap.
   */
  saving?: boolean | undefined;
  /**
   * The post's platform (workspace platform + format). Never crops the picture;
   * it only decides the warning line under it. Absent on briefs.
   */
  frame?: { platform: string; format: string; platformLabel: string } | undefined;
  /** The warning line's "See preview": opens the platform Preview panel. */
  onSeePreview?: (() => void) | undefined;
  /**
   * The tools row under the strip (post gallery only). Absent on briefs.
   * canEdit false (approvers, approved posts) leaves only the v{n} button and
   * also drops every edit path the gallery owns (Arrange, the opened picture's
   * Replace and Remove, the empty-state upload zone).
   */
  tools?: GalleryTools | undefined;
  /**
   * The picture the strip currently shows first, reported whenever it changes,
   * so the page can aim the header sheet's Remove image at it.
   */
  onActiveIndexChange?: ((index: number) => void) | undefined;
}

/** The page's side of the tools row. */
interface GalleryTools {
  canEdit: boolean;
  /** Spec B4: an approved post, seen by a creator: the tools row shows a lock. */
  locked?: boolean;
  versionNumber: number | null;
  /** The inline line from the last failed gallery write, or null. */
  error: string | null;
  onVersions: () => void;
  onAdd: () => void;
  /** Replace the picture at this index (one gallery_set). */
  onReplace: (index: number) => void;
  /** Save the whole list with one gallery_set (Arrange's Done); resolves true on success. */
  onSaveOrder: (assetVersionIds: string[]) => Promise<boolean>;
}

/** How far one arrow key slides the strip: most of one screen of it. */
const STRIP_STEP = 0.8;

/**
 * A post's pictures as a strip (18 Nov 2026): side by side, each whole at its
 * own shape, sliding freely (or a brief's as its overview grid, via the
 * columns override). Tapping a picture opens the PCS {@link PostLightbox} at
 * that index. Holding a picture (phone) or right-clicking it (laptop) opens
 * the Arrange sheet, as the Arrange tool does.
 */
export function PostGallery({
  items,
  title,
  cache,
  deps,
  presignEnabled,
  columns = 4,
  aspect = '4/5',
  showIndex = true,
  saving = false,
  frame,
  onSeePreview,
  tools,
  onActiveIndexChange,
  onAddSlide: onAddSlideProp,
  onRemove,
}: PostGalleryProps) {
  // An approved post (or an approver) gets no edit path from the gallery,
  // whatever the page wired: no Arrange, no Replace or Remove, no upload zone.
  const editLocked = tools !== undefined && !tools.canEdit;
  const canArrange = tools !== undefined && tools.canEdit && columns === 4;
  const onAddSlide = editLocked ? undefined : onAddSlideProp;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  // Leaving the editable state (approved, a role change) closes Arrange.
  useEffect(() => {
    if (!canArrange) setArrangeOpen(false);
  }, [canArrange]);

  // Deleting the last image empties the gallery: the in-place viewer has nothing
  // to show, so clear the open index and let the strip branch fall through to
  // the zero-asset empty state.
  useEffect(() => {
    if (items.length === 0) setOpenIndex(null);
  }, [items.length]);

  // Strip state: the picture on show is derived from the native scroller's
  // offset (no JS animation, scrolling stays native), and so is whether there
  // is more to either side (the laptop's arrow keys).
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [edges, setEdges] = useState({ prev: false, next: false });
  const shownIndex = items.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), items.length - 1);
  useEffect(() => {
    onActiveIndexChange?.(shownIndex);
  }, [shownIndex, onActiveIndexChange]);
  const readEdges = useCallback((el: HTMLElement): void => {
    const prev = el.scrollLeft > 4;
    const next = el.scrollLeft < el.scrollWidth - el.clientWidth - 4;
    setEdges((current) =>
      current.prev === prev && current.next === next ? current : { prev, next },
    );
  }, []);
  const handleScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    // Measure each image tile's left edge; tile widths vary with aspect ratio, so
    // offsets are never assumed uniform.
    const offsets: number[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const tile = el.children.item(i);
      offsets.push(tile instanceof HTMLElement ? tile.offsetLeft - el.offsetLeft : 0);
    }
    const next = nearestTileIndex(el.scrollLeft, offsets);
    setActiveIndex((prev) => (prev === next ? prev : next));
    readEdges(el);
  };
  const stepStrip = (direction: -1 | 1): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    el.scrollBy({ left: direction * el.clientWidth * STRIP_STEP, behavior: 'smooth' });
  };

  // Strip: intrinsic sizes recovered from decoded images, keyed by attachment
  // id, for tiles whose stored asset_versions.width/height are still null. Set
  // once per tile on first load so the tile takes its true ratio and never
  // resizes again; a zero/NaN natural dimension is filtered upstream in
  // GalleryThumb and never reaches here.
  const [measuredDimensions, setMeasuredDimensions] = useState<MeasuredDimensions>({});
  const handleMeasure = (assetAttachmentId: string, width: number, height: number): void => {
    setMeasuredDimensions((prev) =>
      prev[assetAttachmentId] !== undefined
        ? prev
        : { ...prev, [assetAttachmentId]: { width, height } },
    );
  };
  // The arrows follow the strip's real width: read again whenever the pictures
  // or their measured shapes change, and when the viewer hands the slot back.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el !== null) readEdges(el);
  }, [items, measuredDimensions, openIndex, readEdges]);

  // One long-press controller for the whole gallery: a fired long-press (the
  // one LONG_PRESS_MS) opens Arrange.
  const pressPointerTypeRef = useRef('');
  const { handlers, consumeClickSuppression } = useLongPress(() => {
    if (canArrange) setArrangeOpen(true);
  });
  const slideGestures = canArrange
    ? (): TileGestures => ({
        onPointerDown: (event) => {
          pressPointerTypeRef.current = event.pointerType;
          handlers.onPointerDown(event);
        },
        onPointerMove: (event) => handlers.onPointerMove(event),
        onPointerUp: () => handlers.onPointerUp(),
        onPointerCancel: () => handlers.onPointerCancel(),
        onContextMenu: (event) => {
          event.preventDefault();
          // Right-click opens Arrange on a laptop. Touch long-presses also emit
          // contextmenu in some browsers; those already opened it above, so
          // only a real mouse opens it here.
          if (pressPointerTypeRef.current !== 'touch') setArrangeOpen(true);
        },
      })
    : undefined;

  // The platform frame only decides the warning line under the picture.
  const postFrame =
    frame !== undefined && columns === 4
      ? galleryFrame(frame.platform, frame.format, items, measuredDimensions)
      : null;

  // The opened picture's creator keys, wired to the page's own write paths.
  const manage =
    canArrange && tools !== undefined
      ? { onReplace: tools.onReplace, ...(onRemove !== undefined ? { onRemove } : {}) }
      : undefined;

  const toolsRow =
    tools !== undefined && columns === 4
      ? galleryToolsRow({
          canEdit: tools.canEdit,
          locked: tools.locked === true,
          itemCount: items.length,
          versionNumber: tools.versionNumber,
          saving,
          error: tools.error,
          onAdd: tools.onAdd,
          onArrange: () => {
            setOpenIndex(null);
            setArrangeOpen(true);
          },
          onVersions: tools.onVersions,
        })
      : null;

  // When a tile is open the in-place viewer takes the strip's slot (the page
  // continues below it); closing returns to the strip. The empty and upload
  // states have no open index, so they always fall through to the strip branch.
  return (
    <>
      {viewerReplacesRibbon(openIndex, items.length) && openIndex !== null ? (
        <PostLightbox
          items={items}
          title={title}
          index={openIndex}
          presignEnabled={presignEnabled}
          cache={cache}
          deps={deps}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          manage={manage}
          saving={saving}
        />
      ) : (
        galleryView({
          items,
          cache,
          presignEnabled,
          onOpen: setOpenIndex,
          columns,
          aspect,
          showIndex,
          slideGestures,
          consumeClickSuppression: canArrange ? consumeClickSuppression : undefined,
          onAddSlide,
          activeIndex,
          scrollerRef,
          onScroll: handleScroll,
          arrows: columns === 4 ? { ...edges, onStep: stepStrip } : undefined,
          measuredDimensions,
          onMeasure: columns === 4 ? handleMeasure : undefined,
          frame: postFrame,
          frameNote:
            postFrame !== null && frame !== undefined ? frameKindNote(frame.platform, items) : null,
          platformLabel: frame?.platformLabel ?? '',
          onSeePreview,
          // One toolbar row under the strip; nothing sits on the picture.
          toolbar: toolsRow ?? undefined,
        })
      )}
      {canArrange && tools !== undefined ? (
        <ArrangeSheet
          open={arrangeOpen}
          onClose={() => setArrangeOpen(false)}
          items={items}
          renderThumb={(item) => (
            <GalleryThumb item={item} cache={cache} presignEnabled={presignEnabled} />
          )}
          onSave={tools.onSaveOrder}
          error={tools.error}
        />
      ) : null}
    </>
  );
}
