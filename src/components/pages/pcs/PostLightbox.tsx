import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
  ReactElement,
  ReactNode,
  Ref,
  SyntheticEvent,
} from 'react';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconPlus,
  IconTrash,
  IconX,
} from '@/components/ui/icons';
import type { IconProps } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { requestPresignedUrl, type PresignCache, type PresignDeps } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

/** Continuous zoom bounds: pinch scale between 1x and 5x. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 5;
/** Double-tap toggles to this scale, centred on the tap point. */
export const DOUBLE_TAP_SCALE = 2;
/** Two taps within this window and radius read as one double-tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_RADIUS_PX = 32;

/** True when this item renders as an inline <img> (vs a <video> or a download). */
function isImage(item: GalleryItem): boolean {
  return item.kind === 'image' || (item.mimeType ?? '').startsWith('image/');
}

/** True when this item renders as an inline <video>. */
function isVideo(item: GalleryItem): boolean {
  return item.kind === 'video' || (item.mimeType ?? '').startsWith('video/');
}

/** Whether the item can be shown in place at all (vs a download-only panel). */
function isInlineRenderable(item: GalleryItem): boolean {
  return isImage(item) || isVideo(item);
}

/** The mono top-bar counter: "n / N". Pure. */
export function lightboxCounter(index: number, count: number): string {
  return `${index + 1} / ${count}`;
}

/**
 * Wrap an index by `delta` over `n` items, cycling past either end. Pure. No
 * longer used by this viewer (its track clamps), but the comment-image lightbox
 * still navigates with it.
 */
export function wrapIndex(index: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return (((index + delta) % n) + n) % n;
}

/** The minimal rect shape the pin math reads off the rendered image. */
interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Normalised [0,1] point of a click inside an image rect, or null when the click
 * falls outside the rect (those taps are ignored). The in-range result is clamped
 * defensively so a float edge never escapes [0,1]. Pure. (F5 placement.)
 */
export function pinPointFromRect(
  rect: RectLike,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: clamp01(x), y: clamp01(y) };
}

/** As {@link pinPointFromRect}, but reading the rect off the tapped element. */
export function placePinFromEvent(
  target: { getBoundingClientRect: () => RectLike },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  return pinPointFromRect(target.getBoundingClientRect(), clientX, clientY);
}

/**
 * The slide the native scroller currently rests on, from its scroll offset;
 * clamped into [0, count). Pure so the snap math is unit-testable without a DOM.
 */
export function slideFromScroll(scrollLeft: number, slideWidth: number, count: number): number {
  if (count <= 0 || slideWidth <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / slideWidth)));
}

/** An item's intrinsic size: stored asset dimensions, else the measured fallback. */
export function intrinsicSize(
  item: GalleryItem,
  measured: Readonly<Record<string, { width: number; height: number }>>,
): { width: number; height: number } | null {
  if (item.width !== null && item.height !== null && item.width > 0 && item.height > 0) {
    return { width: item.width, height: item.height };
  }
  return measured[item.assetVersionId] ?? null;
}

/**
 * The frame style: an aspect-ratio box constrained by the fixed stage
 * (w-full + max-h-full transfer through aspect-ratio), so the WHOLE image is
 * always visible with no scrolling regardless of ratio. Pure.
 */
export function fitFrameStyle(width: number, height: number): CSSProperties {
  return { aspectRatio: `${width} / ${height}` };
}

// Double-chevron glyphs for make-first / make-last; local because the shared icon
// set has no Chevrons* pair and this surface is the only consumer.
function IconChevronsLeft({ className, size = 18 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 6l-6 6 6 6M19 6l-6 6 6 6" />
    </svg>
  );
}

function IconChevronsRight({ className, size = 18 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 6l6 6-6 6M13 6l6 6-6 6" />
    </svg>
  );
}

// Icon buttons overlaid on the image (counter/close/prev/next): a translucent
// chip keeps them legible over any photo, dark in both app themes.
const OVERLAY_BUTTON =
  'inline-flex h-11 w-11 items-center justify-center rounded-lg bg-overlay-surface text-overlay-fg ' +
  'hover:bg-overlay-line disabled:opacity-40 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

// Icon buttons in the action bar below the image, which sits on the viewer's own
// dark backdrop, so they need no chip of their own.
const TOOLBAR_BUTTON =
  'inline-flex h-11 w-11 items-center justify-center rounded-lg text-overlay-fg ' +
  'hover:bg-overlay-surface disabled:opacity-40 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

/** The agency manage actions, prewired to the current slide. */
export interface LightboxManage {
  onMakeFirst: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onMakeLast: () => void;
  onAddAfter: () => void;
  onRemove: () => void;
}

/** Pointer gesture handlers the zoom layer spreads onto each slide stage. */
export interface StageGestures {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export interface LightboxViewProps {
  items: GalleryItem[];
  index: number;
  presignEnabled: boolean;
  chrome: boolean;
  busy: boolean;
  zoom: { scale: number; x: number; y: number };
  srcFor: (item: GalleryItem) => string | null;
  failedFor: (item: GalleryItem) => boolean;
  dimsFor: (item: GalleryItem) => { width: number; height: number } | null;
  onClose: () => void;
  /** Step the carousel back one slide (overlay arrow; clamps at the first). */
  onPrev: () => void;
  /** Step the carousel forward one slide (overlay arrow; clamps at the last). */
  onNext: () => void;
  onDownload: () => void;
  onTrackScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  onImageLoad: (item: GalleryItem, event: SyntheticEvent<HTMLImageElement>) => void;
  stageGestures: StageGestures;
  trackRef?: Ref<HTMLDivElement> | undefined;
  /** Agency-only manage bar; absent for clients (their bar shows download only). */
  manage?: LightboxManage | undefined;
  /** Whether the delete confirm row has replaced the bottom-bar controls. */
  removeConfirming?: boolean;
  /** Delete tapped: swap the bottom bar for the inline confirm row. */
  onRequestRemove?: (() => void) | undefined;
  /** Cancel in the confirm row: restore the bottom-bar controls. */
  onCancelRemove?: (() => void) | undefined;
  /** Remove in the confirm row: run the existing remove handler, then dismiss. */
  onConfirmRemove?: (() => void) | undefined;
  /** F5 seam: overlay rendered over the sharp image; nothing when omitted. */
  pinOverlay?: ((item: GalleryItem, index: number) => ReactNode) | undefined;
}

/** One slide's stage: the fully-visible sharp image, no letterbox filler. */
function fitSlide(props: LightboxViewProps, item: GalleryItem, i: number): ReactElement {
  const { zoom, srcFor, failedFor, dimsFor, presignEnabled, onImageLoad, pinOverlay } = props;
  const src = srcFor(item);
  const failed = failedFor(item);
  const dims = dimsFor(item);
  const active = i === props.index;
  const zoomed = active && zoom.scale > 1;
  const zoomStyle: CSSProperties | undefined = zoomed
    ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }
    : undefined;
  const showImage = presignEnabled && isImage(item) && src !== null && !failed;
  const showVideo = presignEnabled && isVideo(item) && src !== null && !failed;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      {...props.stageGestures}
      style={zoomed ? { touchAction: 'none' } : undefined}
    >
      {showImage && dims !== null ? (
        // The frame is an aspect-ratio box constrained directly by this fixed
        // stage (never an auto-height wrapper), so max-h/max-w always resolve
        // and the whole image stays visible at every ratio.
        <div
          className="relative w-full max-h-full max-w-full"
          style={{ ...fitFrameStyle(dims.width, dims.height), ...zoomStyle }}
        >
          <img
            src={src}
            alt={`Slide ${i + 1}`}
            draggable={false}
            onLoad={(event) => onImageLoad(item, event)}
            className="h-full w-full object-contain"
          />
          {pinOverlay !== undefined && !zoomed ? (
            <div className="pointer-events-none absolute inset-0">{pinOverlay(item, i)}</div>
          ) : null}
        </div>
      ) : showImage ? (
        <img
          src={src}
          alt={`Slide ${i + 1}`}
          draggable={false}
          onLoad={(event) => onImageLoad(item, event)}
          style={zoomStyle}
          className="max-h-full max-w-full object-contain"
        />
      ) : showVideo ? (
        <video src={src} controls className="max-h-full max-w-full" />
      ) : !presignEnabled ? (
        <GracefulPanel message="Image previews are unavailable in this environment." />
      ) : isInlineRenderable(item) && !failed ? (
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-overlay-line border-t-overlay-fg" />
      ) : (
        <GracefulPanel
          message={failed ? 'This image could not be loaded.' : 'Preview unavailable.'}
          onDownload={props.onDownload}
          busy={props.busy}
        />
      )}
    </div>
  );
}

/**
 * The lightbox's presentational tree, kept hookless so it can be exercised by the
 * tree-walking unit tests (the node test environment has no DOM renderer). All
 * state and gestures live in {@link PostLightbox}; this only maps props to JSX.
 * No filename ever renders on this surface.
 */
export function lightboxView(props: LightboxViewProps): ReactElement {
  const { items, index, chrome, busy, zoom, manage } = props;
  const count = items.length;
  const chromeVisible = chrome;
  const removeConfirming = props.removeConfirming === true;
  // A gallery can never be emptied, so delete is inert on the last image.
  const canDelete = count > 1;

  // The image region is a full-width aspect-ratio box following the CURRENT
  // item's ratio (stored dims or measured fallback), so the whole image shows
  // with no letterbox and no viewport clamp. Unknown dims fall back to 4/5 until
  // the image decodes and reports its true ratio.
  const current = items[index];
  const dims = current !== undefined ? props.dimsFor(current) : null;
  const ratioStyle: CSSProperties = {
    aspectRatio: dims !== null ? `${dims.width} / ${dims.height}` : '4 / 5',
  };
  const atStart = index <= 0;
  const atEnd = index >= count - 1;

  // Opacity only: no translate or rotate is introduced anywhere on this surface.
  const chromeMotion = (visible: boolean): string =>
    cn(
      'transition-opacity duration-base',
      visible ? 'opacity-100' : 'pointer-events-none opacity-0',
    );

  return (
    // In-flow, full-width block (no longer a modal): the viewer replaces the
    // ribbon in normal page flow, the post content continues below it. It carries
    // its own dark backdrop and stays dark in both app themes.
    <div aria-label="Image viewer" className="relative w-full overflow-hidden bg-overlay">
      {/* Image region: the native scroll-snap carousel, one slide per width, in a
          full-width aspect-ratio box that follows the current image's ratio. The
          counter, close, and prev/next arrows overlay this region. */}
      <div className="relative w-full overflow-hidden" style={ratioStyle}>
        <div
          ref={props.trackRef}
          onScroll={props.onTrackScroll}
          aria-roledescription="carousel"
          data-motion-axis="x"
          className={cn(
            'absolute inset-0 flex overscroll-x-contain',
            zoom.scale > 1 ? 'overflow-x-hidden' : 'snap-x snap-mandatory overflow-x-auto',
          )}
        >
          {items.map((slide, i) => (
            <div
              key={slide.assetAttachmentId}
              className="relative h-full w-full shrink-0 snap-center overflow-hidden"
            >
              {fitSlide(props, slide, i)}
            </div>
          ))}
        </div>

        {/* Counter overlaid top-left, close overlaid top-right; translucent chips
            keep both legible over any photo. */}
        <span
          className={cn(
            'pointer-events-none absolute left-2 top-2 rounded-md bg-overlay-surface px-2 py-1 font-mono text-sm tabular-nums text-overlay-fg',
            chromeMotion(chromeVisible),
          )}
        >
          {lightboxCounter(index, count)}
        </span>
        <button
          type="button"
          aria-label="Close viewer"
          onClick={props.onClose}
          className={cn(OVERLAY_BUTTON, 'absolute right-2 top-2', chromeMotion(chromeVisible))}
        >
          <IconX size={20} />
        </button>

        {/* Prev / next overlay arrows for click; swipe still drives the track.
            Centred by flex (no translate), edge-disabled. */}
        {count > 1 ? (
          <div
            className={cn(
              'pointer-events-none absolute inset-0 flex items-center justify-between px-2',
              chromeMotion(chromeVisible),
            )}
          >
            <button
              type="button"
              aria-label="Previous image"
              disabled={atStart}
              onClick={props.onPrev}
              className={cn(OVERLAY_BUTTON, 'pointer-events-auto')}
            >
              <IconChevronLeft size={22} />
            </button>
            <button
              type="button"
              aria-label="Next image"
              disabled={atEnd}
              onClick={props.onNext}
              className={cn(OVERLAY_BUTTON, 'pointer-events-auto')}
            >
              <IconChevronRight size={22} />
            </button>
          </div>
        ) : null}
      </div>

      {/* Action bar: a slim full-width bar directly below the image (not
          overlapping it) with the agency 7-control set (reorder · divider ·
          download/add/delete), or download only for clients and read-only.
          Delete swaps the whole bar for an inline confirm row. */}
      <div
        className={cn('flex h-12 w-full items-center justify-center', chromeMotion(chromeVisible))}
      >
        {manage === undefined ? (
          <button
            type="button"
            aria-label="Download"
            disabled={busy}
            onClick={props.onDownload}
            className={TOOLBAR_BUTTON}
          >
            <IconDownload size={20} />
          </button>
        ) : removeConfirming ? (
          <div className="flex items-center gap-2 px-3">
            <span className="text-sm text-overlay-fg">Remove this image?</span>
            <button
              type="button"
              onClick={props.onCancelRemove}
              className="inline-flex h-11 items-center rounded-lg px-3 text-sm text-overlay-fg-dim hover:text-overlay-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg/70"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={props.onConfirmRemove}
              className="inline-flex h-11 items-center rounded-lg border border-bad px-3 text-sm font-medium text-bad hover:bg-bad/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bad"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="flex items-center">
            <button
              type="button"
              aria-label="Make first"
              disabled={index === 0}
              onClick={manage.onMakeFirst}
              className={TOOLBAR_BUTTON}
            >
              <IconChevronsLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="Move left"
              disabled={index === 0}
              onClick={manage.onMoveLeft}
              className={TOOLBAR_BUTTON}
            >
              <IconChevronLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="Move right"
              disabled={index === count - 1}
              onClick={manage.onMoveRight}
              className={TOOLBAR_BUTTON}
            >
              <IconChevronRight size={20} />
            </button>
            <button
              type="button"
              aria-label="Make last"
              disabled={index === count - 1}
              onClick={manage.onMakeLast}
              className={TOOLBAR_BUTTON}
            >
              <IconChevronsRight size={20} />
            </button>
            <span aria-hidden className="mx-2 h-5 w-px bg-overlay-line" />
            <button
              type="button"
              aria-label="Download"
              disabled={busy}
              onClick={props.onDownload}
              className={TOOLBAR_BUTTON}
            >
              <IconDownload size={20} />
            </button>
            <button
              type="button"
              aria-label="Add image"
              onClick={manage.onAddAfter}
              className={cn(TOOLBAR_BUTTON, 'text-accent')}
            >
              <IconPlus size={20} />
            </button>
            <button
              type="button"
              aria-label="Delete image"
              disabled={!canDelete}
              onClick={props.onRequestRemove}
              className={cn(TOOLBAR_BUTTON, 'hover:text-bad')}
            >
              <IconTrash size={20} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function GracefulPanel({
  message,
  onDownload,
  busy,
}: {
  message: string;
  onDownload?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="m-4 flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-panel p-8 text-center text-fg shadow-xl">
      <p className="text-xs text-fg-3">{message}</p>
      {onDownload !== undefined ? (
        <button
          type="button"
          onClick={onDownload}
          disabled={busy}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconDownload size={16} />
          Download
        </button>
      ) : null}
    </div>
  );
}

interface PostLightboxProps {
  /** The ordered gallery. */
  items: GalleryItem[];
  index: number;
  presignEnabled: boolean;
  cache: PresignCache;
  /** Presign deps, used to mint an attachment URL for the download action. */
  deps: PresignDeps;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** F5 seam: overlay rendered over the image area; nothing renders when omitted. */
  pinOverlay?: ((item: GalleryItem, index: number) => ReactNode) | undefined;
  /**
   * Agency manage-row callbacks, each taking the slide index. They MUST be wired
   * to the existing slide-mutation paths (gallery-transforms + gallery_set commit
   * and the existing add/upload flow); this component creates no write path.
   */
  manage?:
    | {
        onMakeFirst: (index: number) => void;
        onMoveLeft: (index: number) => void;
        onMoveRight: (index: number) => void;
        onMakeLast: (index: number) => void;
        onAddAfter: (index: number) => void;
        onRemove: (index: number) => void;
      }
    | undefined;
}

/**
 * In-place post-gallery viewer: a full-width, in-flow block (no modal, no
 * overlay sheet, no body scroll lock) with a native horizontal scroll-snap track
 * (one slide per width), overlaid counter/close/prev-next, tap-toggled chrome,
 * pinch and double-tap zoom, and the agency manage row below the image. Pins are
 * placed from the inline gallery now, never here.
 */
export function PostLightbox({
  items,
  index,
  presignEnabled,
  cache,
  deps,
  onIndexChange,
  onClose,
  pinOverlay,
  manage,
}: PostLightboxProps) {
  const [srcs, setSrcs] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [chrome, setChrome] = useState(true);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  // The delete confirm row replaces the bottom-bar controls until resolved.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const trackRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  // Resolve every slide's inline URL through the shared cache (it bounds
  // concurrency and dedupes), so swiping never waits on a cold presign.
  useEffect(() => {
    if (!presignEnabled) return;
    let live = true;
    for (const item of items) {
      if (!isInlineRenderable(item)) continue;
      const versionId = item.assetVersionId;
      cache
        .resolve(versionId)
        .then((presigned) => {
          if (live)
            setSrcs((prev) =>
              prev[versionId] === presigned.url ? prev : { ...prev, [versionId]: presigned.url },
            );
        })
        .catch(() => {
          if (live)
            setFailed((prev) => (prev[versionId] === true ? prev : { ...prev, [versionId]: true }));
        });
    }
    return () => {
      live = false;
    };
  }, [items, presignEnabled, cache]);

  // Keep the native scroller on the viewed slide: instantly on mount, smoothly
  // when the index is changed from outside the scroll itself (dots, keyboard,
  // a manage move). All slide motion stays native scrolling on the X axis.
  const mounted = useRef(false);
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return;
    const width = el.clientWidth;
    if (width <= 0) return;
    const resting = slideFromScroll(el.scrollLeft, width, items.length);
    if (resting === index) return;
    el.scrollTo({ left: index * width, behavior: mounted.current ? 'smooth' : 'auto' });
  }, [index, items.length]);
  useEffect(() => {
    mounted.current = true;
  }, []);

  // Zoom resets whenever the slide changes; a pending delete confirm is dropped
  // too, so swiping away from a slide never leaves its confirm row armed.
  useEffect(() => {
    setZoom({ scale: 1, x: 0, y: 0 });
    setConfirmingRemove(false);
  }, [index]);

  // Esc closes; arrows nudge the native scroller. The viewer is in-flow now, so
  // it never locks body scroll.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      } else if (event.key === 'ArrowLeft') {
        onIndexChange(Math.max(0, indexRef.current - 1));
      } else if (event.key === 'ArrowRight') {
        onIndexChange(Math.min(items.length - 1, indexRef.current + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, onIndexChange, items.length]);

  const handleTrackScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>): void => {
      const el = event.currentTarget;
      const next = slideFromScroll(el.scrollLeft, el.clientWidth, items.length);
      if (next !== indexRef.current) onIndexChange(next);
    },
    [items.length, onIndexChange],
  );

  // --- Zoom gestures. The transform is driven only by the user's gesture:
  // pinch (two pointers) 1..5x with pan, and double-tap toggling 2x at the tap
  // point with drag-pan while zoomed. No animation, no rotation.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ d: number; scale: number; x: number; y: number } | null>(null);
  const panStart = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (singleTapTimer.current !== null) clearTimeout(singleTapTimer.current);
    },
    [],
  );

  const clampPan = useCallback((scale: number, x: number, y: number, rect: RectLike) => {
    const maxX = ((scale - 1) * rect.width) / 2;
    const maxY = ((scale - 1) * rect.height) / 2;
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  }, []);

  const applyZoomAt = useCallback(
    (nextScale: number, clientX: number, clientY: number, rect: RectLike): void => {
      setZoom((z) => {
        const scale = clamp(nextScale, ZOOM_MIN, ZOOM_MAX);
        if (scale <= 1) return { scale: 1, x: 0, y: 0 };
        // Keep the focal point stationary: p' = p - (p - t) * (s'/s).
        const px = clientX - rect.left - rect.width / 2;
        const py = clientY - rect.top - rect.height / 2;
        const k = scale / z.scale;
        const pan = clampPan(scale, px - (px - z.x) * k, py - (py - z.y) * k, rect);
        return { scale, ...pan };
      });
    },
    [clampPan],
  );

  const stageGestures = useMemo<StageGestures>(
    () => ({
      onPointerDown: (event) => {
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        movedRef.current = false;
        const pts = [...pointers.current.values()];
        if (pts.length === 2) {
          const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
          pinchStart.current = {
            d: Math.hypot(a.x - b.x, a.y - b.y),
            scale: zoom.scale,
            x: zoom.x,
            y: zoom.y,
          };
          panStart.current = null;
          event.currentTarget.setPointerCapture(event.pointerId);
        } else if (pts.length === 1 && zoom.scale > 1) {
          panStart.current = { px: event.clientX, py: event.clientY, x: zoom.x, y: zoom.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      },
      onPointerMove: (event) => {
        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const rect = event.currentTarget.getBoundingClientRect();
        const pts = [...pointers.current.values()];
        if (pts.length === 2 && pinchStart.current !== null) {
          const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d <= 0 || pinchStart.current.d <= 0) return;
          movedRef.current = true;
          const start = pinchStart.current;
          const scale = clamp(start.scale * (d / start.d), ZOOM_MIN, ZOOM_MAX);
          const cx = (a.x + b.x) / 2;
          const cy = (a.y + b.y) / 2;
          applyZoomAt(scale, cx, cy, rect);
        } else if (pts.length === 1 && panStart.current !== null) {
          const start = panStart.current;
          const dx = event.clientX - start.px;
          const dy = event.clientY - start.py;
          if (Math.abs(dx) + Math.abs(dy) > 2) movedRef.current = true;
          setZoom((z) => ({
            scale: z.scale,
            ...clampPan(z.scale, start.x + dx, start.y + dy, rect),
          }));
        }
      },
      onPointerUp: (event) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size < 2) pinchStart.current = null;
        if (pointers.current.size === 0) {
          panStart.current = null;
          // A pinch released near 1x snaps fully out.
          setZoom((z) => (z.scale <= 1.05 ? { scale: 1, x: 0, y: 0 } : z));
        }
      },
      onPointerCancel: (event) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size < 2) pinchStart.current = null;
        if (pointers.current.size === 0) panStart.current = null;
      },
      onClick: (event) => {
        if (movedRef.current) {
          movedRef.current = false;
          return;
        }
        const now = Date.now();
        const rect = event.currentTarget.getBoundingClientRect();
        const tap = { t: now, x: event.clientX, y: event.clientY };
        const prev = lastTap.current;
        const isDouble =
          prev !== null &&
          now - prev.t < DOUBLE_TAP_MS &&
          Math.hypot(tap.x - prev.x, tap.y - prev.y) < DOUBLE_TAP_RADIUS_PX;
        if (isDouble) {
          lastTap.current = null;
          if (singleTapTimer.current !== null) {
            clearTimeout(singleTapTimer.current);
            singleTapTimer.current = null;
          }
          // Double-tap: 2x at the tap point, or fully out.
          if (zoom.scale > 1) setZoom({ scale: 1, x: 0, y: 0 });
          else applyZoomAt(DOUBLE_TAP_SCALE, tap.x, tap.y, rect);
          return;
        }
        lastTap.current = tap;
        if (singleTapTimer.current !== null) clearTimeout(singleTapTimer.current);
        singleTapTimer.current = setTimeout(() => {
          singleTapTimer.current = null;
          // Single tap: toggle the chrome.
          setChrome((c) => !c);
        }, DOUBLE_TAP_MS);
      },
    }),
    [zoom, applyZoomAt, clampPan],
  );

  const item = items[index];
  if (item === undefined) return null;
  const current: GalleryItem = item;

  // Download saves the file in place via an attachment-disposition presigned URL;
  // a throwaway anchor with the download attribute keeps the page from navigating.
  const handleDownload = (): void => {
    setBusy(true);
    void requestPresignedUrl(deps, current.assetVersionId, 'attachment')
      .then((presigned) => {
        const anchor = document.createElement('a');
        anchor.href = presigned.url;
        anchor.download = current.filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  // After a manage move the viewed slide keeps being viewed: the index follows
  // the slide and the scroll effect above brings the track along.
  const manageView: LightboxManage | undefined =
    manage !== undefined
      ? {
          onMakeFirst: () => {
            if (index <= 0) return;
            manage.onMakeFirst(index);
            onIndexChange(0);
          },
          onMoveLeft: () => {
            if (index <= 0) return;
            manage.onMoveLeft(index);
            onIndexChange(index - 1);
          },
          onMoveRight: () => {
            if (index >= items.length - 1) return;
            manage.onMoveRight(index);
            onIndexChange(index + 1);
          },
          onMakeLast: () => {
            if (index >= items.length - 1) return;
            manage.onMakeLast(index);
            onIndexChange(items.length - 1);
          },
          onAddAfter: () => {
            manage.onAddAfter(index);
          },
          // Remove the viewed slide via the existing gallery_set commit, then
          // keep a valid slide in view (the last one shrinks to its predecessor).
          onRemove: () => {
            if (items.length <= 1) return;
            manage.onRemove(index);
            onIndexChange(Math.min(index, items.length - 2));
          },
        }
      : undefined;

  return lightboxView({
    items,
    index,
    presignEnabled,
    chrome,
    busy,
    zoom,
    srcFor: (it) => srcs[it.assetVersionId] ?? null,
    failedFor: (it) => failed[it.assetVersionId] === true,
    dimsFor: (it) => intrinsicSize(it, measured),
    onClose,
    onPrev: () => onIndexChange(Math.max(0, index - 1)),
    onNext: () => onIndexChange(Math.min(items.length - 1, index + 1)),
    onDownload: handleDownload,
    onTrackScroll: handleTrackScroll,
    onImageLoad: (it, event) => {
      const img = event.currentTarget;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        const versionId = it.assetVersionId;
        setMeasured((prev) =>
          prev[versionId] !== undefined
            ? prev
            : { ...prev, [versionId]: { width: img.naturalWidth, height: img.naturalHeight } },
        );
      }
    },
    stageGestures,
    trackRef,
    manage: manageView,
    removeConfirming: confirmingRemove,
    onRequestRemove: () => setConfirmingRemove(true),
    onCancelRemove: () => setConfirmingRemove(false),
    onConfirmRemove: () => {
      manageView?.onRemove();
      setConfirmingRemove(false);
    },
    pinOverlay,
  });
}
