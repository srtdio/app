import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconAssets, IconPin, IconPlus } from '@/components/ui/icons';
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

// Map the column count to a literal Tailwind grid class. The default (4)
// reproduces the post gallery's responsive grid byte-for-byte; the brief gallery
// passes 2. Literal strings keep both classes visible to the Tailwind JIT
// scanner, which cannot see interpolated class names.
function gridClass(columns: number): string {
  return columns === 2
    ? 'grid grid-cols-2 gap-3'
    : 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4';
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
}

/**
 * The gallery's presentational tree, kept hookless so the tree-walking unit tests
 * can exercise it without a DOM renderer. Renders the ordered thumbnail grid, or a
 * calm empty state when the post has no images. The optional columns / aspect /
 * showIndex props default to the post gallery's look, so callers that omit them
 * (the post detail page) render unchanged; the brief gallery overrides all three.
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
}: GalleryViewProps): ReactElement {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
        <p>No images on this post yet.</p>
        {onAddSlide !== undefined ? (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              aria-label="Add image"
              onClick={onAddSlide}
              className="inline-flex min-h-[44px] min-w-[44px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border-strong bg-panel-2 px-4 py-3 text-fg-3 transition-colors hover:bg-panel-3 hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <IconPlus size={22} />
              <span className="text-xs font-medium">Add</span>
            </button>
          </div>
        ) : null}
      </div>
    );
  }
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
 * A post's (or brief's) images as an ordered, view-only thumbnail grid. Tapping a
 * tile opens the PCS {@link PostLightbox} at that index. No add/reorder/remove
 * (F7) and no pins/annotations (F5) here; the lightbox carries the inert F5 seams.
 * The columns / aspect / showIndex props default to the post gallery's look, so
 * the post detail page renders unchanged; the brief gallery overrides them.
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
