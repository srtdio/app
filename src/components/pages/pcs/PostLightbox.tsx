import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
  WheelEvent as ReactWheelEvent,
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
  IconText,
  IconX,
} from '@/components/ui/icons';
import type { IconProps } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { requestPresignedUrl, type PresignCache, type PresignDeps } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

/** Continuous zoom bounds: pinch/wheel scale between 1x and 5x. */
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

const TOOLBAR_BUTTON =
  'inline-flex h-11 w-11 items-center justify-center rounded-lg text-overlay-fg ' +
  'hover:bg-overlay-surface disabled:opacity-40 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

/** The five 44px agency manage actions, prewired to the current slide. */
export interface LightboxManage {
  onMakeFirst: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onMakeLast: () => void;
  onAddAfter: () => void;
}

/** Pointer/wheel gesture handlers the zoom layer spreads onto each slide stage. */
export interface StageGestures {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
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
  onDownload: () => void;
  onDotClick: (index: number) => void;
  onTrackScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  onImageLoad: (item: GalleryItem, event: SyntheticEvent<HTMLImageElement>) => void;
  stageGestures: StageGestures;
  trackRef?: Ref<HTMLDivElement> | undefined;
  /** Agency-only manage row; absent for clients. */
  manage?: LightboxManage | undefined;
  /** F5 seam: overlay rendered over the sharp image; nothing when omitted. */
  pinOverlay?: ((item: GalleryItem, index: number) => ReactNode) | undefined;
  /** Read-only post caption; nothing renders (toggle included) when null/empty. */
  caption?: string | null;
  /** Whether the caption block is shown (the top-chrome toggle's state). */
  captionVisible?: boolean;
  /** Whether the caption is expanded to its scrollable panel. */
  captionExpanded?: boolean;
  /** The top-chrome caption toggle. */
  onToggleCaption?: (() => void) | undefined;
  /** A tap on the caption text, flipping clamp and panel. */
  onToggleCaptionExpand?: (() => void) | undefined;
}

/** One slide's stage: blurred cover backdrop + fully-visible sharp image. */
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
    <>
      {/* Letterbox filler: a blurred, darkened cover copy of the same slide. */}
      {showImage ? (
        <>
          <img
            src={src}
            alt=""
            aria-hidden
            draggable={false}
            className="absolute inset-0 h-full w-full scale-110 object-cover blur-[48px]"
          />
          <div aria-hidden className="absolute inset-0 bg-black/30" />
        </>
      ) : null}
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
    </>
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
  const caption = props.caption ?? null;
  const hasCaption = caption !== null && caption.trim() !== '';
  const captionShown = hasCaption && props.captionVisible === true;
  const captionExpanded = props.captionExpanded === true;

  const chromeMotion = (visible: boolean, hiddenShift: string): string =>
    cn(
      'transition-[opacity,transform] duration-base',
      visible ? 'opacity-100 translate-y-0' : `pointer-events-none opacity-0 ${hiddenShift}`,
    );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-50 bg-overlay"
    >
      {/* Slide track: declared motion axis X, native scroll-snap only. While
          zoomed (scale > 1) swiping is disabled so the gesture never fights. */}
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

      {/* Top chrome: close · mono counter · Download. Nothing else. */}
      <div
        className={cn(
          'absolute inset-x-0 top-0 z-20',
          chromeMotion(chromeVisible, '-translate-y-2'),
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-overlay to-transparent"
        />
        <div className="relative flex h-14 items-center gap-1 px-3">
          <button
            type="button"
            aria-label="Close viewer"
            onClick={props.onClose}
            className={TOOLBAR_BUTTON}
          >
            <IconX size={20} />
          </button>
          <span className="px-1 font-mono text-sm tabular-nums text-overlay-fg-dim">
            {lightboxCounter(index, count)}
          </span>
          <div className="flex-1" />
          {hasCaption ? (
            <button
              type="button"
              aria-label="Toggle caption"
              aria-pressed={props.captionVisible === true}
              onClick={props.onToggleCaption}
              className={TOOLBAR_BUTTON}
            >
              <IconText size={20} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Download"
            disabled={busy}
            onClick={props.onDownload}
            className={TOOLBAR_BUTTON}
          >
            <IconDownload size={20} />
          </button>
        </div>
      </div>

      {/* Bottom chrome: dots · agency manage row. */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 z-20',
          chromeMotion(chromeVisible, 'translate-y-2'),
        )}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-overlay to-transparent"
        />
        <div className="relative flex flex-col items-center gap-1 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2">
          {captionShown ? (
            <button
              type="button"
              aria-label={captionExpanded ? 'Collapse caption' : 'Expand caption'}
              aria-expanded={captionExpanded}
              onClick={props.onToggleCaptionExpand}
              className={cn(
                'min-h-[44px] w-full max-w-xl px-4 py-2 text-left text-sm leading-relaxed text-overlay-fg',
                captionExpanded && 'max-h-[34vh] overflow-y-auto',
              )}
            >
              <span className={cn('whitespace-pre-wrap', !captionExpanded && 'line-clamp-2')}>
                {caption}
              </span>
            </button>
          ) : null}
          {count > 1 ? (
            <div className="flex flex-wrap items-center justify-center">
              {items.map((slide, dot) => (
                <button
                  key={slide.assetAttachmentId}
                  type="button"
                  aria-label={`Go to image ${dot + 1}`}
                  aria-current={dot === index}
                  onClick={() => props.onDotClick(dot)}
                  className="inline-flex h-11 w-11 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg/70"
                >
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full transition-colors',
                      dot === index ? 'bg-overlay-fg' : 'bg-overlay-dot',
                    )}
                  />
                </button>
              ))}
            </div>
          ) : null}

          {manage !== undefined ? (
            <div className="flex items-center gap-1">
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
                aria-label="Add image"
                onClick={manage.onAddAfter}
                className={cn(TOOLBAR_BUTTON, 'text-accent')}
              >
                <IconPlus size={20} />
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
            </div>
          ) : null}
        </div>
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
   * The post's caption, rendered read-only under the slide track. Null or empty
   * renders nothing and hides the top-chrome caption toggle.
   */
  caption?: string | null;
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
      }
    | undefined;
}

/**
 * Fullscreen post-gallery viewer: a fixed inset-0 stage with a native horizontal
 * scroll-snap track (one slide per viewport), tap-toggled chrome, pinch/wheel/
 * double-tap zoom, and the agency manage row. Pins are placed from the inline
 * gallery now, never here.
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
  caption = null,
  manage,
}: PostLightboxProps) {
  const [srcs, setSrcs] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [chrome, setChrome] = useState(true);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  // The caption is per-post, so its visibility and expansion survive slide changes.
  const [captionVisible, setCaptionVisible] = useState(true);
  const [captionExpanded, setCaptionExpanded] = useState(false);

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

  // Zoom resets whenever the slide changes.
  useEffect(() => {
    setZoom({ scale: 1, x: 0, y: 0 });
  }, [index]);

  // Esc closes; arrows nudge the native scroller. Body scroll is locked while open.
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
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
  // pinch (two pointers) 1..5x with pan, wheel zoom + drag pan on desktop,
  // double-tap toggling 2x at the tap point. No animation, no rotation.
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
      onWheel: (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * 0.0022);
        applyZoomAt(zoom.scale * factor, event.clientX, event.clientY, rect);
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
    onDownload: handleDownload,
    onDotClick: onIndexChange,
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
    pinOverlay,
    caption,
    captionVisible,
    captionExpanded,
    onToggleCaption: () => setCaptionVisible((v) => !v),
    onToggleCaptionExpand: () => setCaptionExpanded((e) => !e),
  });
}
