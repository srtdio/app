import { useEffect, useRef, useState } from 'react';
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
} from 'react';
import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react';
import { IconAssets, IconImagePlus, IconPin } from '@/components/ui/icons';
import { useLongPress } from '@/components/ui/useLongPress';
import { PostLightbox, placePinFromEvent } from '@/components/pages/pcs/PostLightbox';
import { cn } from '@/lib/cn';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

/** Hold this long on a slide to arm pin placement (the relocated F5 flow). */
export const PIN_ARM_PRESS_MS = 500;

/** The gesture handlers a tile spreads for long-press + right-click. */
export interface TileGestures {
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

/** Lazily resolve and render one tile's inline thumbnail, falling back to a glyph. */
function GalleryThumb({
  item,
  cache,
  presignEnabled,
  fit = 'cover',
  onMeasure,
}: {
  item: GalleryItem;
  cache: PresignCache;
  presignEnabled: boolean;
  /** 'cover' crops to fill (the brief grid); 'contain' shows the whole image (the ribbon). */
  fit?: 'cover' | 'contain';
  /**
   * Ribbon only: report the image's intrinsic size once it decodes, so a tile
   * whose stored dimensions are null can still hug its true ratio. Never fires
   * with a zero or NaN dimension, and never on a load error.
   */
  onMeasure?: ((width: number, height: number) => void) | undefined;
}) {
  const versionId = item.assetVersionId;
  const renderable = presignEnabled && isImage(item) && versionId !== '';
  const [url, setUrl] = useState<string | null>(() =>
    renderable ? (cache.peek(versionId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

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

  if (renderable && url !== null && !failed) {
    return (
      <img
        src={url}
        alt={item.filename}
        loading="lazy"
        onError={() => setFailed(true)}
        onLoad={(event) => {
          if (onMeasure === undefined) return;
          const size = intrinsicSize(
            event.currentTarget.naturalWidth,
            event.currentTarget.naturalHeight,
          );
          if (size !== null) onMeasure(size.width, size.height);
        }}
        className={
          fit === 'contain' ? 'max-h-full max-w-full object-contain' : 'h-full w-full object-cover'
        }
      />
    );
  }
  // Fallback covers non-image kinds, a failed presign, and the unconfigured-env
  // case (presignEnabled false), so a tile never renders blank.
  return (
    <div className="flex h-full w-full items-center justify-center bg-panel-3 text-fg-3">
      <IconAssets size={22} />
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

// The ribbon's shared tile caps: never taller than the clamp, never wider than
// the viewport (minus the page's 1rem side paddings).
const RIBBON_TILE_MAX_HEIGHT = 'clamp(200px, 38vh, 320px)';
const RIBBON_TILE_MAX_WIDTH = 'calc(100vw - 2rem)';
// A solo image is not a peek ribbon: it fills the column at its own ratio, taller
// than a ribbon tile is allowed to be.
const SOLO_TILE_MAX_HEIGHT = '78vh';

/**
 * The reserved box for one ribbon tile. With both intrinsic dimensions known
 * the box is fixed up front (width from the height cap times the aspect ratio;
 * when the viewport cap bites, aspect-ratio pulls the auto height down), so
 * nothing shifts when the image loads and wide images render shorter, never
 * wider than the viewport. Unknown dimensions degrade to a stable 4/5 box the
 * contained image letterboxes inside. Pure.
 */
export function ribbonTileStyle(width: number | null, height: number | null): CSSProperties {
  if (width !== null && height !== null && width > 0 && height > 0) {
    return {
      width: `calc(${RIBBON_TILE_MAX_HEIGHT} * ${width / height})`,
      aspectRatio: `${width} / ${height}`,
      maxWidth: RIBBON_TILE_MAX_WIDTH,
      maxHeight: RIBBON_TILE_MAX_HEIGHT,
    };
  }
  return {
    height: RIBBON_TILE_MAX_HEIGHT,
    aspectRatio: '4 / 5',
    maxWidth: RIBBON_TILE_MAX_WIDTH,
  };
}

/**
 * The reserved box for the lone image in the ribbon branch: it fills the column
 * width and keeps its own aspect ratio (so the contained image never crops),
 * capped only in height. Unknown dimensions degrade to the same stable 4/5 box
 * the multi-image fallback uses. No fixed width means it can never overflow the
 * column on the X axis. Pure.
 */
export function soloTileStyle(width: number | null, height: number | null): CSSProperties {
  const aspectRatio =
    width !== null && height !== null && width > 0 && height > 0 ? `${width} / ${height}` : '4 / 5';
  return { width: '100%', aspectRatio, maxHeight: SOLO_TILE_MAX_HEIGHT };
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
  if (item.width !== null && item.height !== null && item.width > 0 && item.height > 0) {
    width = item.width;
    height = item.height;
  } else {
    const seen = measured[item.assetAttachmentId];
    if (seen !== undefined) {
      width = seen.width;
      height = seen.height;
    }
  }
  return solo ? soloTileStyle(width, height) : ribbonTileStyle(width, height);
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
}: GalleryViewProps): ReactElement {
  if (items.length === 0) {
    // Agency-side (onAddSlide present): a full-width "Add images" upload zone in
    // place of the empty text, wired to the append flow. Brief galleries omit
    // onAddSlide and keep the calm, view-only empty line unchanged.
    if (onAddSlide !== undefined) {
      return (
        <button
          type="button"
          onClick={onAddSlide}
          className="flex min-h-[44px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-panel-2 px-4 py-10 text-center transition-colors hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-panel-3 text-accent">
            <IconImagePlus size={26} />
          </span>
          <span className="text-sm font-medium text-fg">Add images</span>
          <span className="text-xs text-fg-3">Tap to upload</span>
        </button>
      );
    }
    return (
      <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
        <p>No images on this post yet.</p>
      </div>
    );
  }
  // Non-default columns (the brief gallery's 2-up): the overview grid, unchanged.
  if (columns !== 4) {
    return (
      <div className={gridClass(columns)}>
        {items.map((item, index) => {
          const pinCount = pinCountFor !== undefined ? pinCountFor(item) : 0;
          return (
            <button
              key={item.assetAttachmentId}
              type="button"
              aria-label={`View image ${index + 1}`}
              {...(slideGestures !== undefined ? slideGestures(index) : {})}
              onClick={() => {
                if (consumeClickSuppression !== undefined && consumeClickSuppression()) return;
                onOpen(index);
              }}
              className={`group relative ${aspectClass(aspect)} overflow-hidden rounded-xl border border-border bg-panel-2 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
            >
              <GalleryThumb item={item} cache={cache} presignEnabled={presignEnabled} />
              {showIndex ? (
                <span className="absolute left-1.5 bottom-1.5 rounded bg-overlay px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-overlay-fg">
                  {index + 1}/{items.length}
                </span>
              ) : null}
              {pinCount > 0 ? (
                <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-overlay px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-overlay-fg">
                  <IconPin size={11} />
                  {pinCount}
                </span>
              ) : null}
            </button>
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
  return (
    <div>
      <div className="relative">
        {pinArmedIndex !== null ? (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-overlay-surface px-3 py-1.5 text-xs font-medium text-overlay-fg"
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
            return (
              <button
                key={item.assetAttachmentId}
                type="button"
                aria-label={`View image ${index + 1}`}
                style={resolveRibbonTileStyle(item, measuredDimensions, items.length === 1)}
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
                  'group relative flex shrink-0 snap-start items-center justify-center overflow-hidden rounded-xl border border-border bg-panel-2 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  pinArmedIndex === index && 'cursor-crosshair',
                )}
              >
                <GalleryThumb
                  item={item}
                  cache={cache}
                  presignEnabled={presignEnabled}
                  fit="contain"
                  onMeasure={
                    onMeasure !== undefined
                      ? (width, height) => onMeasure(item.assetAttachmentId, width, height)
                      : undefined
                  }
                />
                {pinCount > 0 ? (
                  <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-overlay px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-overlay-fg">
                    <IconPin size={11} />
                    {pinCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {showIndex ? (
          <span
            aria-live="polite"
            className="pointer-events-none absolute left-2 bottom-2 rounded bg-overlay px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-overlay-fg"
          >
            {`${active + 1}/${items.length}`}
          </span>
        ) : null}
      </div>
      {items.length > 1 ? (
        <div className="flex flex-wrap items-center justify-center">
          {items.map((item, index) => (
            <button
              key={item.assetAttachmentId}
              type="button"
              aria-label={`Go to slide ${index + 1}`}
              aria-current={index === active}
              onClick={() => {
                if (onDotClick !== undefined) onDotClick(index);
              }}
              className="flex h-11 min-h-[44px] w-11 min-w-[44px] items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span
                className={`h-2 w-2 rounded-full transition-colors ${
                  index === active ? 'bg-accent' : 'bg-border-strong'
                }`}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface PostGalleryProps {
  items: GalleryItem[];
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
  /** Lightbox manage row: make-first over the existing gallery_set commit path. */
  onMakeFirst?: ((index: number) => void) | undefined;
  /** Lightbox manage row: the existing move-left path. */
  onMoveLeft?: ((index: number) => void) | undefined;
  /** Lightbox manage row: the existing move-right path. */
  onMoveRight?: ((index: number) => void) | undefined;
  /** Lightbox manage row: make-last over the existing gallery_set commit path. */
  onMakeLast?: ((index: number) => void) | undefined;
  /** Lightbox manage row: the existing insert-after add/upload flow. */
  onAddAfter?: ((index: number) => void) | undefined;
  /** Lightbox manage bar: remove the slide over the existing gallery_set commit. */
  onRemove?: ((index: number) => void) | undefined;
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
  onSlideActions,
  onAddSlide,
  onMakeFirst,
  onMoveLeft,
  onMoveRight,
  onMakeLast,
  onAddAfter,
  onRemove,
}: PostGalleryProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

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
  // its index on pointer-down. In the carousel a fired long-press arms pin
  // placement; in the grid (briefs) it keeps opening the slide actions.
  const pressIndexRef = useRef(0);
  const pressPointerTypeRef = useRef('');
  const { handlers, consumeClickSuppression } = useLongPress(
    () => {
      if (canPlacePins) {
        setPinArmedIndex(pressIndexRef.current);
        onRequestPin?.(pressIndexRef.current);
        return;
      }
      if (onSlideActions !== undefined) onSlideActions(pressIndexRef.current);
    },
    { thresholdMs: PIN_ARM_PRESS_MS },
  );

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

  // A carousel slide tap routes through the arming state: place on the armed
  // slide (existing onPlacePin path, percentage coords), disarm elsewhere,
  // otherwise open the lightbox.
  const handleSlideTap = (index: number, event: ReactMouseEvent<HTMLButtonElement>): void => {
    const action = slideTapAction(pinArmedIndex, index, consumeClickSuppression());
    if (action === 'suppress') return;
    if (action === 'place') {
      const point = placePinFromEvent(event.currentTarget, event.clientX, event.clientY);
      setPinArmedIndex(null);
      if (point !== null) onPlacePin?.(index, point.x, point.y);
      return;
    }
    if (action === 'disarm') {
      setPinArmedIndex(null);
      return;
    }
    setOpenIndex(index);
  };

  const manage =
    onMakeFirst !== undefined &&
    onMoveLeft !== undefined &&
    onMoveRight !== undefined &&
    onMakeLast !== undefined &&
    onAddAfter !== undefined &&
    onRemove !== undefined
      ? { onMakeFirst, onMoveLeft, onMoveRight, onMakeLast, onAddAfter, onRemove }
      : undefined;

  // When a tile is open the in-place viewer takes the ribbon's slot (the page
  // continues below it); closing returns to the ribbon. The empty and upload
  // states have no open index, so they always fall through to the ribbon branch.
  return viewerReplacesRibbon(openIndex, items.length) && openIndex !== null ? (
    <PostLightbox
      items={items}
      index={openIndex}
      presignEnabled={presignEnabled}
      cache={cache}
      deps={deps}
      onIndexChange={setOpenIndex}
      onClose={() => setOpenIndex(null)}
      pinOverlay={pinOverlay}
      manage={manage}
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
    })
  );
}
