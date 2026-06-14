import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconPin,
  IconX,
  IconZoomIn,
  IconZoomOut,
} from '@/components/ui/icons';
import { requestPresignedUrl, type PresignCache, type PresignDeps } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

const SWIPE_THRESHOLD = 48;

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

/** Wrap an index by `delta` over `n` items, cycling past either end. Pure. */
export function wrapIndex(index: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return (((index + delta) % n) + n) % n;
}

/** The "{i} of {n}" counter the top bar shows beside the filename. Pure. */
export function lightboxCounter(index: number, count: number): string {
  return `${index + 1} of ${count}`;
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
 * What the [pin] button does given the current zoom/arm state. Placement is
 * disabled while zoomed (object-contain vs the zoom scroller skews coordinates),
 * so a zoomed click first exits zoom rather than arming. Pure. (F5 placement.)
 */
export function pinButtonAction(zoomed: boolean, armed: boolean): 'exit-zoom' | 'arm' | 'disarm' {
  if (zoomed) return 'exit-zoom';
  return armed ? 'disarm' : 'arm';
}

/** The image's className for the current zoom/arm state (crosshair while armed). */
function imageClass(zoomed: boolean, armed: boolean): string {
  if (armed) return 'max-h-full max-w-full cursor-crosshair object-contain';
  return zoomed
    ? 'max-w-none cursor-zoom-out'
    : 'max-h-full max-w-full cursor-zoom-in object-contain';
}

interface LightboxViewProps {
  item: GalleryItem;
  index: number;
  count: number;
  presignEnabled: boolean;
  mediaSrc: string | null;
  mediaFailed: boolean;
  zoomed: boolean;
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
  onClose: () => void;
  onToggleZoom: () => void;
  onDownload: () => void;
  onScrimTouchStart: (event: React.TouchEvent) => void;
  onScrimTouchEnd: (event: React.TouchEvent) => void;
  /** Overlay slot for future pins (F5); nothing renders when undefined. */
  pinOverlay?: ((item: GalleryItem, index: number) => ReactNode) | undefined;
  /** Pin request (F5); the [pin] button is disabled/no-op when undefined. */
  onRequestPin?: ((index: number) => void) | undefined;
  /** Placement-armed (F5): a tap on the image drops a pin instead of zooming. */
  armed?: boolean;
  /** Image tap while armed (F5): captures the pin point from the rendered image. */
  onPlace?: ((event: React.MouseEvent<HTMLImageElement>) => void) | undefined;
}

const TOOLBAR_BUTTON =
  'inline-flex h-11 w-11 items-center justify-center rounded-lg text-overlay-fg ' +
  'hover:bg-overlay-surface disabled:opacity-40 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

const ARROW_BUTTON =
  'absolute top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center ' +
  'rounded-full bg-overlay-surface text-overlay-fg hover:bg-overlay-line ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

/**
 * The lightbox's presentational tree, kept hookless so it can be exercised by the
 * tree-walking unit tests (the node test environment has no DOM renderer). All
 * state and side effects live in {@link PostLightbox}; this only maps props to JSX.
 */
export function lightboxView({
  item,
  index,
  count,
  presignEnabled,
  mediaSrc,
  mediaFailed,
  zoomed,
  busy,
  onPrev,
  onNext,
  onJump,
  onClose,
  onToggleZoom,
  onDownload,
  onScrimTouchStart,
  onScrimTouchEnd,
  pinOverlay,
  onRequestPin,
  armed = false,
  onPlace,
}: LightboxViewProps): ReactElement {
  const canPin = onRequestPin !== undefined;
  const showInline =
    presignEnabled && isInlineRenderable(item) && mediaSrc !== null && !mediaFailed;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${item.filename}`}
      className="fixed inset-0 z-50 flex flex-col bg-overlay"
    >
      {/* Top bar: filename + counter on the left, the 44x44 toolbar on the right. */}
      <div className="flex h-14 shrink-0 items-center gap-3 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <span className="min-w-0 truncate font-medium text-overlay-fg">{item.filename}</span>
          <span aria-hidden className="text-overlay-fg-dim">
            ·
          </span>
          <span className="shrink-0 tabular-nums text-overlay-fg-dim">
            {lightboxCounter(index, count)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Add pin"
            disabled={!canPin}
            onClick={canPin ? () => onRequestPin(index) : undefined}
            className={TOOLBAR_BUTTON}
          >
            <IconPin size={20} />
          </button>
          <button
            type="button"
            aria-label={zoomed ? 'Zoom out' : 'Zoom in'}
            onClick={onToggleZoom}
            className={TOOLBAR_BUTTON}
          >
            {zoomed ? <IconZoomOut size={20} /> : <IconZoomIn size={20} />}
          </button>
          <button
            type="button"
            aria-label="Download"
            disabled={busy}
            onClick={onDownload}
            className={TOOLBAR_BUTTON}
          >
            <IconDownload size={20} />
          </button>
          <button
            type="button"
            aria-label="Close viewer"
            onClick={onClose}
            className={TOOLBAR_BUTTON}
          >
            <IconX size={20} />
          </button>
        </div>
      </div>

      {/* Media stage. A tap on the empty scrim (not the media) closes. */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-auto p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onTouchStart={onScrimTouchStart}
        onTouchEnd={onScrimTouchEnd}
      >
        {armed ? (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-overlay-surface px-3 py-1.5 text-xs font-medium text-overlay-fg"
          >
            Tap the image to place a pin
          </div>
        ) : null}
        {count > 1 ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={onPrev}
              className={`${ARROW_BUTTON} left-2`}
            >
              <IconChevronLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={onNext}
              className={`${ARROW_BUTTON} right-2`}
            >
              <IconChevronRight size={20} />
            </button>
          </>
        ) : null}

        {/* The image area, with the future-pins overlay layered on top of it. */}
        <div className="relative inline-flex max-h-full max-w-full items-center justify-center">
          {showInline && isImage(item) ? (
            <img
              src={mediaSrc}
              alt={item.filename}
              className={imageClass(zoomed, armed)}
              onClick={armed && onPlace !== undefined ? onPlace : onToggleZoom}
            />
          ) : showInline && isVideo(item) ? (
            <video src={mediaSrc} controls className="max-h-full max-w-full" />
          ) : !presignEnabled ? (
            <GracefulPanel
              title={item.filename}
              message="Image previews are unavailable in this environment."
            />
          ) : isInlineRenderable(item) && !mediaFailed ? (
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-overlay-line border-t-overlay-fg" />
          ) : (
            <GracefulPanel
              title={item.filename}
              message={mediaFailed ? 'This image could not be loaded.' : 'Preview unavailable.'}
              onDownload={onDownload}
              busy={busy}
            />
          )}
          {pinOverlay !== undefined ? (
            <div className="pointer-events-none absolute inset-0">{pinOverlay(item, index)}</div>
          ) : null}
        </div>
      </div>

      {/* Bottom dot indicators, one per image; tap to jump. */}
      {count > 1 ? (
        <div className="flex shrink-0 items-center justify-center gap-2 py-3">
          {Array.from({ length: count }).map((_, dot) => (
            <button
              key={dot}
              type="button"
              aria-label={`Go to image ${dot + 1}`}
              aria-current={dot === index}
              onClick={() => onJump(dot)}
              className="inline-flex h-11 w-11 items-center justify-center"
            >
              <span
                className={`h-2 w-2 rounded-full ${dot === index ? 'bg-overlay-fg' : 'bg-overlay-dot'}`}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GracefulPanel({
  title,
  message,
  onDownload,
  busy,
}: {
  title: string;
  message: string;
  onDownload?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="m-4 flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-panel p-8 text-center text-fg shadow-xl">
      <p className="min-w-0 truncate text-sm font-medium">{title}</p>
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
  /** The ordered gallery; navigation wraps over it. */
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
  /** F5 seam: the [pin] button calls this; the button is inert when omitted. */
  onRequestPin?: ((index: number) => void) | undefined;
  /** F5: a valid tap while armed reports the slide index + normalised point. */
  onPlacePin?: ((index: number, x: number, y: number) => void) | undefined;
}

/**
 * Fullscreen, view-only post-gallery lightbox replicating the locked PCS
 * prototype: a dark backdrop, a top bar (filename + counter, and a 44x44
 * [pin][zoom][download][close] toolbar), the inline image/video, on-screen
 * arrows + swipe + ArrowLeft/Right (wrapping) + Esc, and bottom dot indicators.
 * The pin button and a pin overlay are real F5 seams wired to optional props with
 * safe defaults. No add/reorder/remove and no annotations live here.
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
  onRequestPin,
  onPlacePin,
}: PostLightboxProps) {
  const item = items[index];
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const touchStartX = useRef<number | null>(null);

  const go = useCallback(
    (delta: number): void => {
      onIndexChange(wrapIndex(index, delta, items.length));
    },
    [index, items.length, onIndexChange],
  );

  // Resolve the inline URL for the viewed item only, through the shared cache.
  useEffect(() => {
    setMediaSrc(null);
    setMediaFailed(false);
    setZoomed(false);
    setArmed(false);
    if (item === undefined || !presignEnabled || !isInlineRenderable(item)) return;
    let live = true;
    cache
      .resolve(item.assetVersionId)
      .then((presigned) => {
        if (live) setMediaSrc(presigned.url);
      })
      .catch(() => {
        if (live) setMediaFailed(true);
      });
    return () => {
      live = false;
    };
  }, [item, presignEnabled, cache]);

  // Esc closes; arrows navigate. Lock body scroll while open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [go, onClose]);

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

  // The [pin] button: exit zoom first if zoomed (coords are only meaningful at
  // object-contain scale), otherwise toggle the placement-armed state. Arming
  // also fires the optional onRequestPin seam with the current index.
  const handleRequestPin = (i: number): void => {
    const action = pinButtonAction(zoomed, armed);
    if (action === 'exit-zoom') {
      setZoomed(false);
      return;
    }
    if (action === 'arm') {
      setArmed(true);
      onRequestPin?.(i);
      return;
    }
    setArmed(false);
  };

  // A tap on the image while armed: capture the normalised point and disarm.
  // Outside-rect taps are ignored (placePinFromEvent returns null).
  const handlePlace = (event: React.MouseEvent<HTMLImageElement>): void => {
    const point = placePinFromEvent(event.currentTarget, event.clientX, event.clientY);
    setArmed(false);
    if (point !== null) onPlacePin?.(index, point.x, point.y);
  };

  const onScrimTouchStart = (event: React.TouchEvent): void => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };
  const onScrimTouchEnd = (event: React.TouchEvent): void => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(delta) > SWIPE_THRESHOLD) go(delta < 0 ? 1 : -1);
  };

  return lightboxView({
    item: current,
    index,
    count: items.length,
    presignEnabled,
    mediaSrc,
    mediaFailed,
    zoomed,
    busy,
    onPrev: () => go(-1),
    onNext: () => go(1),
    onJump: onIndexChange,
    onClose,
    onToggleZoom: () => setZoomed((z) => !z),
    onDownload: handleDownload,
    onScrimTouchStart,
    onScrimTouchEnd,
    pinOverlay,
    onRequestPin: onRequestPin !== undefined ? handleRequestPin : undefined,
    armed,
    onPlace: handlePlace,
  });
}
