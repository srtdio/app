import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
} from 'react';
import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react';
import {
  ICON_SIZE,
  IconAssets,
  IconGrip,
  IconHistory,
  IconImagePlus,
  IconLock,
  IconPin,
  IconPlus,
  IconSwitch,
} from '@/components/ui/icons';
import { dropIndex, moveTo } from '@/components/pages/pcs/gallery-transforms';
import { useLongPress } from '@/components/ui/useLongPress';
import { PostLightbox, placePinFromEvent } from '@/components/pages/pcs/PostLightbox';
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
  originalToFrame,
  pinName,
  type FrameMap,
  type PinDot,
} from '@/components/pages/pcs/pin-annotations';
import { pinMarker } from '@/components/pages/pcs/PinOverlay';
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

const EDGE_SHIFT: Record<string, string> = {
  left: 'translate-x-0 -translate-y-1/2',
  right: '-translate-x-full -translate-y-1/2',
  top: '-translate-x-1/2 translate-y-0',
  bottom: '-translate-x-1/2 -translate-y-full',
};

/**
 * Pins over a slide. Stored points are relative to the original; each is mapped
 * through the shown window (the post ribbon shows the whole original, so it
 * passes {@link IDENTITY_MAP}). Inside: the checkpoint circle (or the agency
 * pin's ink dot) at its exact spot. Outside: the small inline circle on the
 * nearest frame edge, still a 44px button.
 */
export function framePins(
  pins: readonly PinDot[],
  map: FrameMap,
  onPinClick: ((commentId: string) => void) | undefined,
): ReactElement {
  return (
    <div className="pointer-events-none absolute inset-0">
      {pins.map((pin) => {
        const at = originalToFrame(pin, map);
        return (
          <IconButton
            key={pin.annotationId}
            type="button"
            data-pin-edge={at.edge ?? undefined}
            data-pin-state={pin.state}
            label={at.edge === null ? pinName(pin) : `${pinName(pin)}, outside the frame`}
            onClick={() => onPinClick?.(pin.commentId)}
            style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
            className={cn(
              'pointer-events-auto absolute focus-visible:lit-focus',
              at.edge === null ? '-translate-x-1/2 -translate-y-1/2' : EDGE_SHIFT[at.edge],
            )}
          >
            {pinMarker(pin, at.edge === null ? 'marker' : 'inline')}
          </IconButton>
        );
      })}
    </div>
  );
}

/**
 * What a slide tap does given the pin-arming state: the click trailing the
 * arming long-press is swallowed, a tap on the armed slide places the pin, a
 * tap anywhere else while armed just disarms, and an unarmed tap opens the
 * lightbox. Pure so the relocated placement flow is unit-testable without a DOM.
 */
export function slideTapAction(
  armedIndex: number | null,
  index: number,
  suppressed: boolean,
): 'suppress' | 'place' | 'disarm' | 'open' {
  if (suppressed) return 'suppress';
  if (armedIndex === index) return 'place';
  if (armedIndex !== null) return 'disarm';
  return 'open';
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
  /** F7: pin-count badge per tile; the badge renders only when this returns > 0. */
  pinCountFor?: ((item: GalleryItem) => number) | undefined;
  /** F7: agency-only append flow, wired to the zero-asset empty-state upload zone. */
  onAddSlide?: (() => void) | undefined;
  /** Carousel: the slide the counter and dots highlight. Defaults to the first. */
  activeIndex?: number;
  /** Carousel: ref to the native scroller so a dot tap can scroll it. */
  scrollerRef?: Ref<HTMLDivElement> | undefined;
  /** Carousel: native scroll listener that derives the active index. */
  onScroll?: ((event: ReactUIEvent<HTMLDivElement>) => void) | undefined;
  /** Carousel: a dot tap requests a native smooth scroll to that slide. */
  onDotClick?: ((index: number) => void) | undefined;
  /** F5 relocation: the slide index armed for pin placement, or null. */
  pinArmedIndex?: number | null;
  /** F5 relocation: an armed tap on a slide, with the click event for the rect. */
  onSlideTap?: ((index: number, event: ReactMouseEvent<HTMLButtonElement>) => void) | undefined;
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
  /** Current-version pins per slide (relative to the original). */
  pinsFor?: ((item: GalleryItem) => PinDot[]) | undefined;
  onPinClick?: ((commentId: string) => void) | undefined;
  /**
   * H2: the visible "Add pin" button under the carousel arms placement on the
   * current slide (the long-press still works); absent for viewers who cannot
   * comment and on the brief grid.
   */
  onArmPin?: ((index: number) => void) | undefined;
  /** H2: the Cancel shown while armed. */
  onDisarmPin?: (() => void) | undefined;
  /**
   * The post gallery's one toolbar row (Add, Replace, Reorder, Add pin, v{n}),
   * rendered under the dots in place of the standalone pin row. Absent keeps the
   * standalone pin row.
   */
  toolbar?: ReactNode;
}

/**
 * The pin toolbar button: "Add pin" (pin icon + text, 44px) for anyone who can
 * comment, or Cancel while a slide is armed. Nothing when pins are not on
 * offer. Pure.
 */
export function pinButton(
  active: number,
  pinArmedIndex: number | null,
  onArmPin: ((index: number) => void) | undefined,
  onDisarmPin: (() => void) | undefined,
): ReactElement | null {
  if (onArmPin === undefined) return null;
  return pinArmedIndex === null ? (
    <Button type="button" variant="ghost" data-add-pin="" onClick={() => onArmPin(active)}>
      <IconPin size={ICON_SIZE.inline} />
      Add pin
    </Button>
  ) : (
    <Button type="button" variant="ghost" data-cancel-pin="" onClick={() => onDisarmPin?.()}>
      Cancel
    </Button>
  );
}

/**
 * The standalone pin row under the carousel, used only when the gallery has no
 * toolbar row (the toolbar otherwise carries the pin button). Pure.
 */
export function pinControls(
  active: number,
  pinArmedIndex: number | null,
  onArmPin: ((index: number) => void) | undefined,
  onDisarmPin: (() => void) | undefined,
): ReactElement | null {
  const button = pinButton(active, pinArmedIndex, onArmPin, onDisarmPin);
  if (button === null) return null;
  return <div className="mt-2 flex items-center gap-2">{button}</div>;
}

/** What the gallery tools row under the picture needs. */
export interface GalleryToolsModel {
  /** Creator on draft / review / parked / rejected: Add, Replace, Reorder show. */
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
  onReplace: () => void;
  onReorder: () => void;
  onVersions: () => void;
  /** The Add pin (or Cancel while armed) button, from {@link pinButton}. */
  pin?: ReactElement | null;
  /**
   * A client: the row is Add pin only (no edit tools, no lock, no v{n}). The
   * agency row is Add, Replace, Reorder, Add pin and v{n}.
   */
  pinOnly?: boolean;
  /**
   * Reorder mode is on: Reorder shows pressed and leaves it (each drop already
   * saved); Add, Replace and the pin wait until it is off.
   */
  reordering?: boolean;
}

/**
 * #26: the one toolbar row under the dots. Left: Add, Replace, Reorder (creators
 * on an editable stage), then Add pin (anyone who can comment); a creator on an
 * approved post sees one 14px lock in place of the edit tools. Right: the v{n}
 * button that opens the versions sheet. A client's row (pinOnly) is Add pin
 * alone. The left group wraps inside its own column so v{n} stays on the right
 * at 360px. Nothing when there is nothing to show. Pure.
 */
export function galleryToolsRow(model: GalleryToolsModel): ReactElement | null {
  const { itemCount, saving, error } = model;
  const pinOnly = model.pinOnly === true;
  const canEdit = model.canEdit && !pinOnly;
  const versionNumber = pinOnly ? null : model.versionNumber;
  const reordering = model.reordering === true;
  const pin = reordering ? null : (model.pin ?? null);
  const locked = !canEdit && !pinOnly && model.locked === true;
  if (!canEdit && !locked && versionNumber === null && pin === null) return null;
  return (
    <div data-gallery-tools="" className="mt-2 flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {locked ? (
            <span
              aria-hidden
              data-gallery-lock=""
              className="inline-flex h-11 w-11 items-center justify-center text-fg-3"
            >
              <IconLock size={ICON_SIZE.inline} />
            </span>
          ) : null}
          {canEdit ? (
            <>
              <Button
                type="button"
                data-gallery-add=""
                disabled={saving || reordering}
                onClick={model.onAdd}
                variant="ghost"
              >
                <IconPlus size={ICON_SIZE.inline} />
                Add
              </Button>
              <Button
                type="button"
                data-gallery-replace=""
                disabled={saving || reordering || itemCount === 0}
                onClick={model.onReplace}
                variant="ghost"
              >
                <IconSwitch size={ICON_SIZE.inline} />
                Replace
              </Button>
              <Button
                type="button"
                data-gallery-reorder=""
                aria-pressed={reordering}
                disabled={saving || (!reordering && itemCount < 2)}
                onClick={model.onReorder}
                variant="ghost"
              >
                <IconGrip size={ICON_SIZE.inline} />
                Reorder
              </Button>
            </>
          ) : null}
          {pin}
        </div>
        {versionNumber !== null ? (
          <Button
            type="button"
            data-gallery-versions=""
            onClick={model.onVersions}
            aria-label={`Versions, current version ${versionNumber}`}
            aria-haspopup="dialog"
            variant="ghost"
            className="shrink-0 tabular-nums"
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

/** The reorder mode's one helper line. */
export const REORDER_HELPER = 'Hold and drag a photo to reorder';

/** What the reorder strip needs; the wrapper owns the order and the drag state. */
export interface ReorderModel {
  /** The order on show (the saved order, or the one a drop is saving). */
  items: readonly GalleryItem[];
  cache: PresignCache;
  presignEnabled: boolean;
  /** Platform frame ratio (w / h) for the tiles; 4/5 when the post has none. */
  ratio: number;
  /** The tile held and lifted, and how far it has travelled along the row. */
  drag: { id: string; dx: number } | null;
  saving: boolean;
  error: string | null;
  /** Keyboard: move a tile one place; saved at once, like a drop. */
  onMove: (id: string, delta: -1 | 1) => void;
  onTilePointerDown: (id: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onTilePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  /** Release: a lifted tile drops (and the new order saves). */
  onTilePointerUp: () => void;
  /** The browser took the pointer: no drop, nothing saved. */
  onTilePointerCancel: () => void;
  /** The scrolling row (the wrapper holds its touch scroll while a tile is lifted). */
  stripRef?: Ref<HTMLDivElement> | undefined;
  tileRef?: ((id: string, el: HTMLButtonElement | null) => void) | undefined;
  /** The tools row under the strip, Reorder pressed (tapping it leaves the mode). */
  toolbar?: ReactNode;
}

/**
 * #26 reorder mode, hold-and-drag only. The slides sit in one horizontal row
 * that scrolls natively; holding a photo (LONG_PRESS_MS) lifts it, and it then
 * drags along the row only (translateX, no rotation, no scale). The drop saves
 * the new order at once (one gallery_set); there are no move or save buttons.
 * The arrow keys move a focused tile one place, saved the same way. The lifted
 * tile follows the pointer directly; nothing else animates, so reduced motion
 * needs no special case. Pure.
 */
export function reorderView(model: ReorderModel): ReactElement {
  const { items, drag, error, ratio } = model;
  return (
    <div data-reorder="" className="flex flex-col gap-2">
      <p data-reorder-helper="" className="text-base text-fg-2">
        {REORDER_HELPER}
      </p>
      <div
        ref={model.stripRef}
        className="flex gap-2 overflow-x-auto overscroll-x-contain py-1"
        role="list"
      >
        {items.map((item, index) => {
          const dragging = drag !== null && drag.id === item.assetAttachmentId;
          return (
            <div key={item.assetAttachmentId} role="listitem" className="shrink-0">
              <PressableRow
                inline
                type="button"
                buttonRef={
                  model.tileRef !== undefined
                    ? (el) => model.tileRef?.(item.assetAttachmentId, el)
                    : undefined
                }
                data-reorder-tile=""
                {...(dragging ? { 'data-reorder-lifted': '' } : {})}
                aria-label={`Slide ${index + 1} of ${items.length}. Use the arrow keys to move it.`}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    model.onMove(item.assetAttachmentId, event.key === 'ArrowLeft' ? -1 : 1);
                  }
                }}
                onPointerDown={(event) => model.onTilePointerDown(item.assetAttachmentId, event)}
                onPointerMove={model.onTilePointerMove}
                onPointerUp={model.onTilePointerUp}
                onPointerCancel={model.onTilePointerCancel}
                style={
                  dragging && drag !== null
                    ? { aspectRatio: `${ratio}`, transform: `translateX(${drag.dx}px)` }
                    : { aspectRatio: `${ratio}` }
                }
                className={cn(
                  'relative flex h-24 min-w-11 cursor-grab items-center justify-center overflow-hidden border bg-panel-2 mv-tint',
                  SLIDE_PRESS_CLASS,
                  slideEdge(dragging),
                  dragging && 'z-raised cursor-grabbing lit-float',
                )}
              >
                <GalleryThumb
                  item={item}
                  cache={model.cache}
                  presignEnabled={model.presignEnabled}
                />
                <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-overlay px-1 text-xs font-medium tabular-nums text-overlay-fg lit-media">
                  {index + 1}
                </span>
              </PressableRow>
            </div>
          );
        })}
      </div>
      {error !== null && model.toolbar === undefined ? (
        <p role="alert" data-gallery-error="" className="text-base text-bad">
          {error}
        </p>
      ) : null}
      {model.toolbar}
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
 * A slide's edge: the selected look (the lifted reorder tile), else the
 * hairline; never both on one slide (guard: outline-rules.test.ts). A lifted
 * slide adds lit-float.
 */
function slideEdge(selected: boolean): string {
  return selected ? 'lit-selected' : 'border-border';
}

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
 * cropped overview grid; the empty and upload states are unchanged. Pin
 * placement is armed by a long-press on a ribbon tile (pinArmedIndex shows the
 * hint pill) and the next tap routes through onSlideTap.
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
  pinCountFor,
  onAddSlide,
  activeIndex = 0,
  scrollerRef,
  onScroll,
  onDotClick,
  pinArmedIndex = null,
  onSlideTap,
  measuredDimensions = {},
  onMeasure,
  frame = null,
  frameNote = null,
  platformLabel = '',
  onSeePreview,
  pinsFor,
  onPinClick,
  onArmPin,
  onDisarmPin,
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
        {items.map((item, index) => {
          const pinCount = pinCountFor !== undefined ? pinCountFor(item) : 0;
          return (
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
              {pinCount > 0 ? (
                <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-overlay px-2 py-1 text-xs font-medium tabular-nums text-overlay-fg lit-media">
                  <IconPin size={ICON_SIZE.inline} />
                  {pinCount}
                </span>
              ) : null}
            </PressableRow>
          );
        })}
      </div>
    );
  }

  // Post gallery default: the uncropped horizontal snap ribbon. Each tile hugs
  // its image at true aspect ratio inside the shared caps, so tile widths and
  // heights vary; motion stays native scrolling on the X axis only. The counter
  // and dots reflect activeIndex, clamped so a shrinking gallery never points
  // past the end while the scroll listener catches up.
  const active = Math.min(Math.max(activeIndex, 0), items.length - 1);
  const dots =
    items.length > 1 ? (
      <div className="flex flex-wrap items-center justify-center">
        {items.map((item, index) => (
          <IconButton
            key={item.assetAttachmentId}
            type="button"
            label={`Go to slide ${index + 1}`}
            aria-current={index === active}
            onClick={() => {
              if (onDotClick !== undefined) onDotClick(index);
            }}
          >
            <span
              className={`h-2 w-2 rounded-full mv-tint ${
                index === active ? 'bg-accent' : 'bg-border-strong'
              }`}
            />
          </IconButton>
        ))}
      </div>
    ) : null;

  // The warning line under the picture: how much the platform cuts the slide on
  // show. The picture itself is never cropped; the Preview panel shows the cut.
  const cut = frameCut(items[active], measuredDimensions, frame);
  const solo = items.length === 1;
  return (
    <div>
      <div className="relative">
        {pinArmedIndex !== null ? (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-3 z-raised -translate-x-1/2 rounded-full bg-overlay-surface px-3 py-2 text-sm font-medium text-overlay-fg lit-media"
          >
            Tap the image to place a pin
          </div>
        ) : null}
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          aria-roledescription="carousel"
          className="flex snap-x snap-mandatory items-center gap-3 overflow-x-auto overscroll-x-contain rounded-xl"
        >
          {items.map((item, index) => {
            const pinCount = pinCountFor !== undefined ? pinCountFor(item) : 0;
            // The tile box carries the reserved size; everything inside it is
            // absolutely placed, so the image can never size the box.
            const tile = (
              <div
                key={item.assetAttachmentId}
                data-ribbon-tile=""
                style={resolveRibbonTileStyle(item, measuredDimensions, solo)}
                className={cn('relative shrink-0 overflow-hidden', !solo && 'snap-start')}
              >
                <PressableRow
                  insetFocus
                  type="button"
                  aria-label={`View image ${index + 1}`}
                  {...(slideGestures !== undefined ? slideGestures(index) : {})}
                  onClick={(event) => {
                    if (onSlideTap !== undefined) {
                      onSlideTap(index, event);
                      return;
                    }
                    if (consumeClickSuppression !== undefined && consumeClickSuppression()) return;
                    onOpen(index);
                  }}
                  className={cn(
                    'group absolute inset-0 flex items-center justify-center border border-border bg-panel-2 mv-tint hover:border-border-strong',
                    SLIDE_PRESS_CLASS,
                    pinArmedIndex === index && 'cursor-crosshair',
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
                {pinsFor !== undefined ? framePins(pinsFor(item), IDENTITY_MAP, onPinClick) : null}
                {pinsFor === undefined && pinCount > 0 ? (
                  <span className="pointer-events-none absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-overlay px-2 py-1 text-xs font-medium tabular-nums text-overlay-fg lit-media">
                    <IconPin size={ICON_SIZE.inline} />
                    {pinCount}
                  </span>
                ) : null}
              </div>
            );
            // A lone tile sits in a full-width snap slot (a definite width for
            // its 100%), centred when a tall image narrows it.
            return solo ? (
              <div
                key={item.assetAttachmentId}
                data-ribbon-slot=""
                className="flex w-full shrink-0 snap-start justify-center"
              >
                {tile}
              </div>
            ) : (
              tile
            );
          })}
        </div>
        {showIndex ? (
          <span
            aria-live="polite"
            className="pointer-events-none absolute left-2 bottom-2 rounded bg-overlay px-2 py-1 text-xs font-medium tabular-nums text-overlay-fg lit-media"
          >
            {`${active + 1}/${items.length}`}
          </span>
        ) : null}
      </div>
      {dots}
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
      {toolbar ?? pinControls(active, pinArmedIndex, onArmPin, onDisarmPin)}
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
  /** Grid columns. Defaults to the post gallery's responsive 4-up grid. */
  columns?: number;
  /** Tile aspect ratio token. Defaults to the post gallery's 4/5. */
  aspect?: string;
  /** Per-tile index badge. Defaults to on, as the post gallery shows it. */
  showIndex?: boolean;
  /** F5: overlay rendered over the open slide (numbered pins); none when omitted. */
  pinOverlay?: (item: GalleryItem, index: number) => ReactNode;
  /** F5: fired when a long-press arms placement (clears any stale pin error). */
  onRequestPin?: (index: number) => void;
  /** F5: a placed pin reports the slide index + normalised point. */
  onPlacePin?: (index: number, x: number, y: number) => void;
  /** F7: pin-count badge per tile; the badge renders only when this returns > 0. */
  pinCountFor?: ((item: GalleryItem) => number) | undefined;
  /**
   * F7 (agency-side): open the slide-actions sheet (replace / remove) for a
   * slide. Reached by right-click on a slide; the lightbox no longer links here.
   */
  onSlideActions?: ((index: number) => void) | undefined;
  /** F7 (agency-side): the append flow, used by the zero-asset empty state. */
  onAddSlide?: (() => void) | undefined;
  /**
   * Lightbox manage row: the existing insert-after add/upload flow. #26: the
   * lightbox has no per-tap reorder (hold-and-drag in Reorder mode) and no
   * Delete image (Remove image in the post ⋯ menu and the slide actions).
   */
  onAddAfter?: ((index: number) => void) | undefined;
  /**
   * A gallery write is in flight: reorder waits and the lightbox shows
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
  /** Current-version pins per slide, at their stored original-relative spots. */
  pinsFor?: ((item: GalleryItem) => PinDot[]) | undefined;
  onPinClick?: ((commentId: string) => void) | undefined;
  /**
   * #26: the tools row under the picture (post gallery only). Absent on briefs.
   * canEdit false (approvers, approved posts) leaves only the v{n} button and
   * also drops every edit path the gallery owns (slide ⋯, lightbox manage row,
   * the empty-state upload zone).
   */
  tools?: GalleryTools | undefined;
  /**
   * The slide the carousel currently shows, reported whenever it changes, so the
   * page can aim the header sheet's Remove image at it.
   */
  onActiveIndexChange?: ((index: number) => void) | undefined;
}

const EMPTY_EDIT: Pick<PostGalleryProps, 'onAddAfter'> = {};

/** A reorder tile under the finger, before the hold lifts it. */
interface HeldTile {
  id: string;
  el: HTMLButtonElement;
  pointerId: number;
  /** The pointer's latest x, where the drag starts once lifted. */
  x: number;
}

/** The page's side of the #26 tools row. */
interface GalleryTools {
  canEdit: boolean;
  /** Spec B4: an approved post, seen by a creator: the tools row shows a lock. */
  locked?: boolean;
  /** A client: the tools row is Add pin only. */
  pinOnly?: boolean;
  versionNumber: number | null;
  /** The inline line from the last failed gallery write, or null. */
  error: string | null;
  onVersions: () => void;
  onAdd: () => void;
  /** Replace the picture at this index (one gallery_set). */
  onReplace: (index: number) => void;
  /** Save the whole order with one gallery_set (each drop); resolves true on success. */
  onSaveOrder: (assetVersionIds: string[]) => Promise<boolean>;
}

/**
 * A post's images as an uncropped horizontal snap ribbon (or a brief's as its
 * overview grid, via the columns override). Tapping a tile opens the PCS
 * {@link PostLightbox} at that index. Pin placement lives here now: a ~500ms
 * long-press on a tile arms it (hint pill), and the next tap on that tile
 * converts to percentage coordinates and calls the existing onPlacePin path.
 * The slide-actions sheet stays reachable by right-click on a tile.
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
  pinOverlay,
  onRequestPin,
  onPlacePin,
  pinCountFor,
  saving = false,
  frame,
  onSeePreview,
  pinsFor,
  onPinClick,
  tools,
  onActiveIndexChange,
  ...editProps
}: PostGalleryProps) {
  // #26: an approved post (or an approver) gets no edit path from the gallery,
  // whatever the page wired: no slide ⋯, no lightbox manage row, no upload zone.
  const editLocked = tools !== undefined && !tools.canEdit;
  const onSlideActions = editLocked ? undefined : editProps.onSlideActions;
  const onAddSlide = editLocked ? undefined : editProps.onAddSlide;
  const { onAddAfter } = editLocked ? EMPTY_EDIT : editProps;
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // #26 reorder mode, hold-and-drag only: the order on show (attachment ids;
  // null when not reordering), the held tile, and the lifted tile's travel.
  // Each drop saves at once; a refused save puts the saved order back.
  const [reorderIds, setReorderIds] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null);
  const dragRef = useRef<{ id: string; startX: number; step: number; dx: number } | null>(null);
  const pressRef = useRef<HeldTile | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const tileEls = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterMove.current;
    if (id === null) return;
    focusAfterMove.current = null;
    tileEls.current.get(id)?.focus();
  }, [reorderIds]);
  // Leaving the editable state (approved, or the gallery emptied) leaves the mode.
  useEffect(() => {
    if (editLocked || items.length < 2) setReorderIds(null);
  }, [editLocked, items.length]);
  // Holding a photo lifts it (the one LONG_PRESS_MS); a move before that is a
  // scroll of the row, never a drag.
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const { handlers: holdHandlers } = useLongPress(() => {
    const press = pressRef.current;
    if (press === null || savingRef.current) return;
    try {
      press.el.setPointerCapture(press.pointerId);
    } catch {
      // The pointer already ended; the drop below still runs on release.
    }
    // One step is a tile plus the row's gap-2 (8px).
    dragRef.current = { id: press.id, startX: press.x, step: press.el.offsetWidth + 8, dx: 0 };
    setDrag({ id: press.id, dx: 0 });
  });
  // While a tile is lifted the row's own touch scroll is held, so the finger
  // drags the tile instead of the row (a non-passive listener; React's are passive).
  const reordering = reorderIds !== null;
  useEffect(() => {
    const el = stripRef.current;
    if (!reordering || el === null) return;
    const onTouchMove = (event: TouchEvent): void => {
      if (dragRef.current !== null && event.cancelable) event.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, [reordering]);

  // Deleting the last image empties the gallery: the in-place viewer has nothing
  // to show, so clear the open index and let the ribbon branch fall through to
  // the zero-asset empty state.
  useEffect(() => {
    if (items.length === 0) setOpenIndex(null);
  }, [items.length]);

  // Carousel state: the active slide is derived from the native scroller's
  // offset (no JS animation, scrolling stays native). A dot tap asks the
  // scroller for a native smooth scroll to that slide's snap point.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const shownIndex = items.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), items.length - 1);
  useEffect(() => {
    onActiveIndexChange?.(shownIndex);
  }, [shownIndex, onActiveIndexChange]);
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
  };
  const scrollToSlide = (index: number): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const slide = el.children.item(index);
    if (slide instanceof HTMLElement) {
      el.scrollTo({ left: slide.offsetLeft - el.offsetLeft, behavior: 'smooth' });
    }
  };

  // Ribbon: intrinsic sizes recovered from decoded images, keyed by attachment
  // id, for tiles whose stored asset_versions.width/height are still null. Set
  // once per tile on first load so the tile snaps to its true ratio and never
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

  // F5 relocation: the slide currently armed for pin placement, or null.
  const [pinArmedIndex, setPinArmedIndex] = useState<number | null>(null);
  const canPlacePins = columns === 4 && onPlacePin !== undefined;

  // One long-press controller for the whole gallery: the pressed tile records
  // its index on pointer-down. In the carousel a fired long-press (the one
  // LONG_PRESS_MS) arms pin placement; in the grid (briefs) it keeps opening
  // the slide actions.
  const pressIndexRef = useRef(0);
  const pressPointerTypeRef = useRef('');
  const { handlers, consumeClickSuppression } = useLongPress(() => {
    if (canPlacePins) {
      setPinArmedIndex(pressIndexRef.current);
      onRequestPin?.(pressIndexRef.current);
      return;
    }
    if (onSlideActions !== undefined) onSlideActions(pressIndexRef.current);
  });

  const wantsGestures = canPlacePins || onSlideActions !== undefined;
  const slideGestures = wantsGestures
    ? (index: number): TileGestures => ({
        onPointerDown: (event) => {
          pressIndexRef.current = index;
          pressPointerTypeRef.current = event.pointerType;
          handlers.onPointerDown(event);
        },
        onPointerMove: (event) => handlers.onPointerMove(event),
        onPointerUp: () => handlers.onPointerUp(),
        onPointerCancel: () => handlers.onPointerCancel(),
        onContextMenu: (event) => {
          event.preventDefault();
          // Right-click keeps the slide-actions sheet reachable. Touch
          // long-presses also emit contextmenu in some browsers; those already
          // armed pin placement above, so only a real mouse opens the sheet.
          if (onSlideActions !== undefined && pressPointerTypeRef.current !== 'touch') {
            onSlideActions(index);
          }
        },
      })
    : undefined;

  // The platform frame only decides the warning line under the picture.
  const postFrame =
    frame !== undefined && columns === 4
      ? galleryFrame(frame.platform, frame.format, items, measuredDimensions)
      : null;

  // A carousel slide tap routes through the arming state: place on the armed
  // slide (existing onPlacePin path, percentage coords), disarm elsewhere,
  // otherwise open the lightbox.
  const handleSlideTap = (index: number, event: ReactMouseEvent<HTMLButtonElement>): void => {
    const action = slideTapAction(pinArmedIndex, index, consumeClickSuppression());
    if (action === 'suppress') return;
    if (action === 'place') {
      const point = placePinFromEvent(event.currentTarget, event.clientX, event.clientY);
      setPinArmedIndex(null);
      // The tile shows the whole original at its own ratio, so the tap point is
      // already original-relative: the stored image_x / image_y.
      if (point !== null) onPlacePin?.(index, point.x, point.y);
      return;
    }
    if (action === 'disarm') {
      setPinArmedIndex(null);
      return;
    }
    setOpenIndex(index);
  };

  const manage = onAddAfter !== undefined ? { onAddAfter } : undefined;

  // #26 reorder mode: the order on show as items (unknown ids dropped, new items
  // appended so a concurrent refresh never loses a slide).
  const draftItems: GalleryItem[] | null =
    reorderIds === null
      ? null
      : [
          ...reorderIds
            .map((id) => items.find((item) => item.assetAttachmentId === id))
            .filter((item): item is GalleryItem => item !== undefined),
          ...items.filter((item) => !reorderIds.includes(item.assetAttachmentId)),
        ];
  // A drop (or an arrow key) saves the new order at once: one gallery_set. A
  // refused save puts the saved order back (the tools row shows the error).
  const saveOrder = (nextIds: string[]): void => {
    if (tools === undefined) return;
    const saved = items.map((item) => item.assetAttachmentId);
    const versionIds = [
      ...nextIds
        .map((id) => items.find((item) => item.assetAttachmentId === id))
        .filter((item): item is GalleryItem => item !== undefined),
      ...items.filter((item) => !nextIds.includes(item.assetAttachmentId)),
    ].map((item) => item.assetVersionId);
    setReorderIds(nextIds);
    void tools.onSaveOrder(versionIds).then((ok) => {
      if (!ok) setReorderIds((current) => (current === null ? current : saved));
    });
  };
  const moveBy = (id: string, delta: -1 | 1): void => {
    if (reorderIds === null || saving) return;
    const from = reorderIds.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= reorderIds.length) return;
    focusAfterMove.current = id;
    saveOrder(moveTo(reorderIds, from, to));
  };
  // The pin button: the visible Add pin arms the same state the long-press does.
  const armPin = canPlacePins
    ? (index: number) => {
        setPinArmedIndex(index);
        onRequestPin?.(index);
      }
    : undefined;
  const disarmPin = canPlacePins ? () => setPinArmedIndex(null) : undefined;
  const toolsRow =
    tools !== undefined && columns === 4
      ? galleryToolsRow({
          canEdit: tools.canEdit,
          locked: tools.locked === true,
          pinOnly: tools.pinOnly === true,
          itemCount: items.length,
          versionNumber: tools.versionNumber,
          saving,
          error: tools.error,
          // Add inserts after the slide on show (the old slide ⋯ "Add image
          // after this"); an empty gallery or no insert path appends.
          onAdd: () => {
            if (onAddAfter !== undefined && items.length > 0) onAddAfter(shownIndex);
            else tools.onAdd();
          },
          onReplace: () => tools.onReplace(shownIndex),
          // Reorder enters the mode; pressed, it leaves (every drop is saved).
          onReorder: () => {
            if (reorderIds !== null) {
              setReorderIds(null);
              setDrag(null);
              dragRef.current = null;
              return;
            }
            setOpenIndex(null);
            setPinArmedIndex(null);
            setReorderIds(items.map((item) => item.assetAttachmentId));
          },
          onVersions: tools.onVersions,
          pin: pinButton(shownIndex, canPlacePins ? pinArmedIndex : null, armPin, disarmPin),
          reordering: reorderIds !== null,
        })
      : null;

  if (tools !== undefined && tools.canEdit && draftItems !== null) {
    return reorderView({
      items: draftItems,
      cache,
      presignEnabled,
      ratio: postFrame?.ratio ?? 4 / 5,
      drag,
      saving,
      error: tools.error,
      onMove: moveBy,
      onTilePointerDown: (id, event) => {
        if (saving || (event.pointerType === 'mouse' && event.button !== 0)) return;
        pressRef.current = {
          id,
          el: event.currentTarget,
          pointerId: event.pointerId,
          x: event.clientX,
        };
        holdHandlers.onPointerDown(event);
      },
      onTilePointerMove: (event) => {
        const current = dragRef.current;
        if (current === null) {
          // Still holding: a move past the slop is a scroll and cancels the hold.
          holdHandlers.onPointerMove(event);
          if (pressRef.current !== null) pressRef.current.x = event.clientX;
          return;
        }
        current.dx = event.clientX - current.startX;
        setDrag({ id: current.id, dx: current.dx });
      },
      onTilePointerUp: () => {
        holdHandlers.onPointerUp();
        pressRef.current = null;
        const current = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (current === null || reorderIds === null) return;
        const from = reorderIds.indexOf(current.id);
        if (from < 0) return;
        const to = dropIndex(from, current.dx, current.step, reorderIds.length);
        if (to !== from) saveOrder(moveTo(reorderIds, from, to));
      },
      onTilePointerCancel: () => {
        holdHandlers.onPointerCancel();
        pressRef.current = null;
        dragRef.current = null;
        setDrag(null);
      },
      stripRef,
      tileRef: (id, el) => {
        if (el === null) tileEls.current.delete(id);
        else tileEls.current.set(id, el);
      },
      toolbar: toolsRow ?? undefined,
    });
  }

  // When a tile is open the in-place viewer takes the ribbon's slot (the page
  // continues below it); closing returns to the ribbon. The empty and upload
  // states have no open index, so they always fall through to the ribbon branch.
  return viewerReplacesRibbon(openIndex, items.length) && openIndex !== null ? (
    <PostLightbox
      items={items}
      title={title}
      index={openIndex}
      presignEnabled={presignEnabled}
      cache={cache}
      deps={deps}
      onIndexChange={setOpenIndex}
      onClose={() => setOpenIndex(null)}
      pinOverlay={pinOverlay}
      manage={manage}
      saving={saving}
    />
  ) : (
    <>
      {galleryView({
        items,
        cache,
        presignEnabled,
        onOpen: setOpenIndex,
        columns,
        aspect,
        showIndex,
        slideGestures,
        consumeClickSuppression: wantsGestures ? consumeClickSuppression : undefined,
        pinCountFor,
        onAddSlide,
        activeIndex,
        scrollerRef,
        onScroll: handleScroll,
        onDotClick: scrollToSlide,
        pinArmedIndex: canPlacePins ? pinArmedIndex : null,
        onSlideTap: columns === 4 ? handleSlideTap : undefined,
        measuredDimensions,
        onMeasure: columns === 4 ? handleMeasure : undefined,
        frame: postFrame,
        frameNote:
          postFrame !== null && frame !== undefined ? frameKindNote(frame.platform, items) : null,
        platformLabel: frame?.platformLabel ?? '',
        onSeePreview,
        pinsFor,
        onPinClick,
        onArmPin: armPin,
        onDisarmPin: disarmPin,
        // One toolbar row under the dots; no ⋮ on the picture.
        toolbar: toolsRow ?? undefined,
      })}
    </>
  );
}
