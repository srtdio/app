import { useEffect, useRef, useState } from 'react';
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
} from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { IconAssets, IconImagePlus, IconPin } from '@/components/ui/icons';
import { useLongPress } from '@/components/ui/useLongPress';
import { PostLightbox } from '@/components/pages/pcs/PostLightbox';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

/** The gesture handlers an agency-side tile spreads for long-press + right-click. */
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

/** Lazily resolve and render one tile's inline thumbnail, falling back to a glyph. */
function GalleryThumb({
  item,
  cache,
  presignEnabled,
}: {
  item: GalleryItem;
  cache: PresignCache;
  presignEnabled: boolean;
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
        className="h-full w-full object-cover"
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
 * The slide the native scroller currently rests on, from its scroll offset.
 * Slides are one scroller-width wide, so round(scrollLeft / width) is the
 * nearest snap point; the result is clamped into [0, count). Pure so the
 * scroll math is unit-testable without a DOM.
 */
export function activeSlideIndex(scrollLeft: number, slideWidth: number, count: number): number {
  if (count <= 0 || slideWidth <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / slideWidth)));
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
  /** F7: agency-side gesture handlers per tile (long-press + right-click). */
  slideGestures?: ((index: number) => TileGestures) | undefined;
  /** F7: swallow the click that trails a long-press so it does not open the lightbox. */
  consumeClickSuppression?: (() => boolean) | undefined;
  /** F7: pin-count badge per tile; the badge renders only when this returns > 0. */
  pinCountFor?: ((item: GalleryItem) => number) | undefined;
  /** F7: agency-only dashed Add tile at the end of the grid (append flow). */
  onAddSlide?: (() => void) | undefined;
  /** Carousel: the slide the counter and dots highlight. Defaults to the first. */
  activeIndex?: number;
  /** Carousel: ref to the native scroller so a dot tap can scroll it. */
  scrollerRef?: Ref<HTMLDivElement> | undefined;
  /** Carousel: native scroll listener that derives the active index. */
  onScroll?: ((event: ReactUIEvent<HTMLDivElement>) => void) | undefined;
  /** Carousel: a dot tap requests a native smooth scroll to that slide. */
  onDotClick?: ((index: number) => void) | undefined;
}

/**
 * The gallery's presentational tree, kept hookless so the tree-walking unit tests
 * can exercise it without a DOM renderer. The post gallery default (columns
 * omitted) renders a one-slide-visible horizontal scroll-snap carousel: a native
 * overflow-x scroller with x-mandatory snapping, an n/N counter, and 44px dot
 * indicators. No JS-driven animation; all motion is native scrolling on the X
 * axis. The brief gallery overrides columns / aspect / showIndex and keeps its
 * overview grid; the empty and upload states are unchanged.
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

  // Post gallery default: the one-slide scroll-snap carousel. The counter and
  // dots reflect activeIndex, clamped so a shrinking gallery never points past
  // the end while the scroll listener catches up.
  const active = Math.min(Math.max(activeIndex, 0), items.length - 1);
  return (
    <div>
      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          aria-roledescription="carousel"
          className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain rounded-xl"
        >
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
                className={`group relative ${aspectClass(aspect)} w-full shrink-0 snap-center overflow-hidden rounded-xl border border-border bg-panel-2 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
              >
                <GalleryThumb item={item} cache={cache} presignEnabled={presignEnabled} />
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
  /** F5: the lightbox [pin] button seam; the button is inert when omitted. */
  onRequestPin?: (index: number) => void;
  /** F5: a placed pin reports the slide index + normalised point. */
  onPlacePin?: (index: number, x: number, y: number) => void;
  /** F7: pin-count badge per tile; the badge renders only when this returns > 0. */
  pinCountFor?: ((item: GalleryItem) => number) | undefined;
  /**
   * F7 (agency-side): open the slide-actions sheet for a slide. When provided,
   * grid tiles gain long-press + right-click and the lightbox gains a kebab.
   */
  onSlideActions?: ((index: number) => void) | undefined;
  /** F7 (agency-side): the dashed Add tile at the grid's end (append flow). */
  onAddSlide?: (() => void) | undefined;
}

/**
 * A post's images as a one-slide horizontal scroll-snap carousel (or a brief's as
 * its overview grid, via the columns override). Tapping a slide opens the PCS
 * {@link PostLightbox} at that index. No add/reorder/remove (F7) and no
 * pins/annotations (F5) here; the lightbox carries the inert F5 seams. The
 * columns / aspect / showIndex props default to the post gallery's look; the
 * brief gallery overrides them and keeps its grid.
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
}: PostGalleryProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // Carousel state: the active slide is derived from the native scroller's
  // offset (no JS animation, scrolling stays native). A dot tap asks the
  // scroller for a native smooth scroll to that slide's snap point.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const handleScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    const next = activeSlideIndex(el.scrollLeft, el.clientWidth, items.length);
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

  // One long-press controller for the whole grid: the pressed tile records its
  // index on pointer-down, and a fired long-press opens that slide's actions.
  // Only one press is live at a time, so a single controller is sufficient.
  const pressIndexRef = useRef(0);
  const { handlers, consumeClickSuppression } = useLongPress(() => {
    if (onSlideActions !== undefined) onSlideActions(pressIndexRef.current);
  });

  const slideGestures =
    onSlideActions !== undefined
      ? (index: number): TileGestures => ({
          onPointerDown: (event) => {
            pressIndexRef.current = index;
            handlers.onPointerDown(event);
          },
          onPointerMove: (event) => handlers.onPointerMove(event),
          onPointerUp: () => handlers.onPointerUp(),
          onPointerCancel: () => handlers.onPointerCancel(),
          onContextMenu: (event) => {
            event.preventDefault();
            onSlideActions(index);
          },
        })
      : undefined;

  return (
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
        consumeClickSuppression: onSlideActions !== undefined ? consumeClickSuppression : undefined,
        pinCountFor,
        onAddSlide,
        activeIndex,
        scrollerRef,
        onScroll: handleScroll,
        onDotClick: scrollToSlide,
      })}
      {openIndex !== null ? (
        <PostLightbox
          items={items}
          index={openIndex}
          presignEnabled={presignEnabled}
          cache={cache}
          deps={deps}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          pinOverlay={pinOverlay}
          onRequestPin={onRequestPin}
          onPlacePin={onPlacePin}
          onSlideActions={onSlideActions}
        />
      ) : null}
    </>
  );
}
