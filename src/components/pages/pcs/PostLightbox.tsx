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
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { requestPresignedUrl, type PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { wrapIndex, lightboxCounter, dragAxis, shouldDismiss } from '@/components/ui/ImageLightbox';
import {
  FileViewer,
  remoteFileSource,
  VIEWER_ERROR,
  type FileViewerSource,
} from '@/components/ui/FileViewer';
import { classifyFileKind, type FileKind } from '@/lib/chat/attachments';
import { useOptionalToast } from '@/components/ui/toast';
import { useEscapeLayer } from '@/lib/escape-stack';
import { fileKindLabel } from '@/lib/files/display-name';
import type { GalleryItem } from '@srtdio/posts';

// wrapIndex / lightboxCounter live in the shared ImageLightbox now; re-exported
// here so existing importers (and the gallery's own looping navigation) resolve
// them from one definition.
export { wrapIndex, lightboxCounter };

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

/** Whether the item can be shown in place at all (vs opening in the FileViewer). */
function isInlineRenderable(item: GalleryItem): boolean {
  return isImage(item) || isVideo(item);
}

/**
 * The FileViewer kind a slide opens in: pdf, office or any other file, from the
 * version's mime (never the file name); null for images and video, which stay
 * inline. Pure.
 */
export function slideViewerKind(item: GalleryItem): FileKind | null {
  if (isInlineRenderable(item)) return null;
  return classifyFileKind(item.mimeType ?? '');
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

/** One pointer sample for the swipe-down gesture. */
export interface DismissPoint {
  x: number;
  y: number;
  /** Milliseconds (Date.now()). */
  t: number;
}

/** The swipe-down controller the stage gestures drive. */
export interface SwipeDismiss {
  /** A pointer went down; `eligible` is false while zoomed or multi-touch. */
  down: (point: DismissPoint, eligible: boolean) => void;
  /** Follow the pointer; returns the drag's axis once past the tap slop. */
  move: (point: DismissPoint) => 'x' | 'y' | null;
  /** Release: close past the distance or on a downward flick, else spring back. */
  up: (point: DismissPoint) => void;
  /** Abandon the drag and spring back. */
  cancel: () => void;
  /** Whether a downward (Y) dismiss drag is in progress. */
  dragging: () => boolean;
}

/**
 * Swipe-down dismiss, mirroring ImageLightbox: a single-pointer drag at 1x that
 * leaves the tap slop dominantly downward follows the finger on Y only, and on
 * release closes past DISMISS_DISTANCE (120px) or on a flick faster than
 * DISMISS_FLICK_VELOCITY; anything shorter springs back. A horizontal drag stays
 * the native carousel's. React-free so it is unit tested with plain points.
 */
export function createSwipeDismiss(opts: {
  onDrag: (dy: number) => void;
  onClose: () => void;
}): SwipeDismiss {
  let start: (DismissPoint & { axis: 'x' | 'y' | null }) | null = null;
  const reset = (): void => {
    const wasY = start?.axis === 'y';
    start = null;
    if (wasY) opts.onDrag(0);
  };
  return {
    down: (point, eligible) => {
      if (!eligible) {
        reset();
        return;
      }
      start = { ...point, axis: null };
    },
    move: (point) => {
      if (start === null) return null;
      if (start.axis === null) start.axis = dragAxis(point.x - start.x, point.y - start.y);
      if (start.axis === 'y') opts.onDrag(Math.max(point.y - start.y, 0));
      return start.axis;
    },
    up: (point) => {
      if (start === null) return;
      const drag = start;
      start = null;
      if (drag.axis !== 'y') return;
      const dy = Math.max(point.y - drag.y, 0);
      const velocity = dy / Math.max(point.t - drag.t, 1);
      opts.onDrag(0);
      if (shouldDismiss(dy, velocity)) opts.onClose();
    },
    cancel: reset,
    dragging: () => start?.axis === 'y',
  };
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

// Overlay colour skins for the shared IconButton / Button (geometry comes from
// the design system). Icon buttons overlaid on the image (close/prev/next): a
// translucent chip keeps them legible over any photo, dark in both app themes.
const OVERLAY_SKIN =
  'bg-overlay-surface text-overlay-fg hover:bg-overlay-line hover:text-overlay-fg ' +
  'disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

// Icon buttons in the action bar below the image, which sits on the viewer's own
// dark backdrop, so they need no chip of their own.
const TOOLBAR_SKIN =
  'text-overlay-fg hover:bg-overlay-surface disabled:opacity-40 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

/**
 * The remove-image confirm copy, shared by this viewer's inline confirm and the
 * slide actions sheet so both ask the same question. A gallery may be emptied:
 * deleting the sole image leaves the post with no artwork, so the wording
 * shifts and a consequence line is added.
 */
export function removeImageConfirmCopy(count: number): {
  title: string;
  message: string | null;
} {
  return count <= 1
    ? {
        title: 'Delete the only image?',
        message: 'The post goes back to having no artwork, for everyone. The file stays in Assets.',
      }
    : { title: 'Remove this image?', message: null };
}

/** Lightbox download toasts. */
export const DOWNLOAD_DONE = 'Downloaded';
export const DOWNLOAD_FAILED = "Couldn't download. Try again.";

/**
 * The agency manage actions, prewired to the current slide. #26: no per-tap
 * reorder here (each tap saved a version); reordering happens only in the
 * gallery's Reorder mode, one save.
 */
export interface LightboxManage {
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
  /** Step the carousel back one slide (overlay arrow; loops to the last). */
  onPrev: () => void;
  /** Step the carousel forward one slide (overlay arrow; loops to the first). */
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
  /**
   * A gallery write is in flight: delete is blocked and the bar
   * says "Saving…", so two full-list writes never overlap.
   */
  saving?: boolean;
  /** Delete tapped: swap the bottom bar for the inline confirm row. */
  onRequestRemove?: (() => void) | undefined;
  /** Cancel in the confirm row: restore the bottom-bar controls. */
  onCancelRemove?: (() => void) | undefined;
  /** Remove in the confirm row: run the existing remove handler, then dismiss. */
  onConfirmRemove?: (() => void) | undefined;
  /** F5 seam: overlay rendered over the sharp image; nothing when omitted. */
  pinOverlay?: ((item: GalleryItem, index: number) => ReactNode) | undefined;
  /** Swipe-down offset in px (translateY only); 0 or omitted at rest. */
  dragY?: number | undefined;
  /** Open a pdf, office or other file slide in the FileViewer. */
  onOpenFile?: ((item: GalleryItem) => void) | undefined;
  /** The last FileViewer open of this slide failed: the card says so. */
  openFailedFor?: ((item: GalleryItem) => boolean) | undefined;
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
  const viewerKind = slideViewerKind(item);

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
      ) : viewerKind !== null ? (
        <FileSlideCard
          label={fileKindLabel(item.mimeType ?? '')}
          failed={props.openFailedFor?.(item) === true}
          onOpen={() => props.onOpenFile?.(item)}
        />
      ) : isInlineRenderable(item) && !failed ? (
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-overlay-line border-t-overlay-fg" />
      ) : (
        <GracefulPanel
          message="This image could not be loaded."
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
  const dragY = props.dragY ?? 0;
  const count = items.length;
  const chromeVisible = chrome;
  const removeConfirming = props.removeConfirming === true;
  const saving = props.saving === true;
  const removeCopy = removeImageConfirmCopy(count);

  // The image region is a full-width aspect-ratio box following the CURRENT
  // item's ratio (stored dims or measured fallback), so the whole image shows
  // with no letterbox and no viewport clamp. Unknown dims fall back to 4/5 until
  // the image decodes and reports its true ratio.
  const current = items[index];
  const dims = current !== undefined ? props.dimsFor(current) : null;
  const ratioStyle: CSSProperties = {
    aspectRatio: dims !== null ? `${dims.width} / ${dims.height}` : '4 / 5',
  };
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
    // A swipe down moves the whole viewer on Y only; it springs back when released
    // short of the dismiss distance.
    <div
      aria-label="Image viewer"
      className={cn(
        'relative w-full overflow-hidden bg-overlay',
        dragY > 0 ? undefined : 'transition-transform duration-base',
      )}
      style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
    >
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
            'pointer-events-none absolute left-2 top-2 rounded-md bg-overlay-surface px-2 py-1 font-mono text-base tabular-nums text-overlay-fg',
            chromeMotion(chromeVisible),
          )}
        >
          {lightboxCounter(index, count)}
        </span>
        <IconButton
          type="button"
          label="Close viewer"
          onClick={props.onClose}
          className={cn(OVERLAY_SKIN, 'absolute right-2 top-2', chromeMotion(chromeVisible))}
        >
          <IconX size={20} />
        </IconButton>

        {/* Prev / next overlay arrows for click; swipe still drives the track.
            Centred by flex (no translate), edge-disabled. */}
        {count > 1 ? (
          <div
            className={cn(
              'pointer-events-none absolute inset-0 flex items-center justify-between px-2',
              chromeMotion(chromeVisible),
            )}
          >
            <IconButton
              type="button"
              label="Previous image"
              onClick={props.onPrev}
              className={cn(OVERLAY_SKIN, 'pointer-events-auto')}
            >
              <IconChevronLeft size={20} />
            </IconButton>
            <IconButton
              type="button"
              label="Next image"
              onClick={props.onNext}
              className={cn(OVERLAY_SKIN, 'pointer-events-auto')}
            >
              <IconChevronRight size={20} />
            </IconButton>
          </div>
        ) : null}
      </div>

      {/* Action bar: a slim full-width bar directly below the image (not
          overlapping it) with the agency controls (download/add/delete; #26:
          reordering lives in the gallery's Reorder mode), or download only for
          clients and read-only.
          Delete swaps the whole bar for an inline confirm row. */}
      <div
        className={cn('flex h-12 w-full items-center justify-center', chromeMotion(chromeVisible))}
      >
        {manage === undefined ? (
          <IconButton
            type="button"
            label="Download"
            disabled={busy}
            onClick={props.onDownload}
            className={cn(TOOLBAR_SKIN, 'hover:text-overlay-fg')}
          >
            <IconDownload size={20} />
          </IconButton>
        ) : removeConfirming ? (
          <div className="flex items-center gap-2 px-3">
            <span className="flex min-w-0 flex-col text-left">
              <span className="text-base text-overlay-fg">{removeCopy.title}</span>
              {removeCopy.message !== null ? (
                <span className="text-sm text-overlay-fg-dim">{removeCopy.message}</span>
              ) : null}
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={props.onCancelRemove}
              className="text-overlay-fg-dim hover:bg-overlay-surface hover:text-overlay-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg/70"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={saving || undefined}
              onClick={props.onConfirmRemove}
              className="text-bad focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bad"
            >
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex items-center">
            <IconButton
              type="button"
              label="Download"
              disabled={busy}
              onClick={props.onDownload}
              className={cn(TOOLBAR_SKIN, 'hover:text-overlay-fg')}
            >
              <IconDownload size={20} />
            </IconButton>
            <IconButton
              type="button"
              label="Add image"
              onClick={manage.onAddAfter}
              className={cn(TOOLBAR_SKIN, 'text-accent hover:text-overlay-fg')}
            >
              <IconPlus size={20} />
            </IconButton>
            <IconButton
              type="button"
              label="Delete image"
              disabled={saving || undefined}
              onClick={props.onRequestRemove}
              className={cn(TOOLBAR_SKIN, 'hover:text-bad')}
            >
              <IconTrash size={20} />
            </IconButton>
            {saving ? (
              <span aria-live="polite" className="ml-2 text-sm text-overlay-fg-dim">
                Saving…
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A pdf, office or other file slide: its kind and Open, which shows the file in
 * the FileViewer (a fresh read every open). No filename on this surface. The
 * tap never reaches the stage, so it does not toggle the chrome.
 */
function FileSlideCard({
  label,
  failed,
  onOpen,
}: {
  label: string;
  failed: boolean;
  onOpen: () => void;
}): ReactElement {
  return (
    <div data-file-slide="" className="flex flex-col items-center gap-3 px-6 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-overlay-surface text-base font-medium text-overlay-fg">
        {label}
      </span>
      <Button
        type="button"
        variant="ghost"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        className="bg-overlay-surface text-overlay-fg hover:bg-overlay-line hover:text-overlay-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg"
      >
        Open
      </Button>
      {failed ? (
        <p role="status" className="text-base text-overlay-fg-dim">
          {VIEWER_ERROR}
        </p>
      ) : null}
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
      <p className="text-sm text-fg-3">{message}</p>
      {onDownload !== undefined ? (
        <Button
          type="button"
          variant="primary"
          onClick={onDownload}
          disabled={busy}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconDownload size={16} />
          Download
        </Button>
      ) : null}
    </div>
  );
}

/** A slide open in the FileViewer, with the source made for this open. */
interface Viewing {
  item: GalleryItem;
  kind: FileKind;
  source: FileViewerSource;
}

/**
 * Mark a slide's open as failed (keyed by attachment). Returns the same object when it already is,
 * so a repeated report never re-renders (the FileViewer reports again whenever
 * its callback changes, and a new object every time would loop). Pure.
 */
export function markOpenFailed(
  prev: Record<string, boolean>,
  key: string,
): Record<string, boolean> {
  return prev[key] === true ? prev : { ...prev, [key]: true };
}

/** The FileViewer open for a pdf, office or other slide; null for images and video. */
function viewingFor(item: GalleryItem, cache: PresignCache): Viewing | null {
  const kind = slideViewerKind(item);
  if (kind === null) return null;
  return { item, kind, source: remoteFileSource(cache, item.assetVersionId) };
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
        onAddAfter: (index: number) => void;
        onRemove: (index: number) => void;
      }
    | undefined;
  /** A gallery write is in flight: delete taps do nothing. */
  saving?: boolean | undefined;
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
  saving = false,
}: PostLightboxProps) {
  const toast = useOptionalToast();
  const [srcs, setSrcs] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [chrome, setChrome] = useState(true);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  // The delete confirm row replaces the bottom-bar controls until resolved.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [dragY, setDragY] = useState(0);
  // The pdf, office or other file open in the FileViewer. The one tapped in the
  // gallery opens straight away; its source is made once per open, so a
  // re-render never re-reads the file.
  const [viewing, setViewing] = useState<Viewing | null>(() => {
    const first = items[index];
    return first !== undefined && presignEnabled ? viewingFor(first, cache) : null;
  });
  const [openFailed, setOpenFailed] = useState<Record<string, boolean>>({});
  const viewingRef = useRef(false);
  viewingRef.current = viewing !== null;
  // Stable callbacks, so the viewer never re-attaches its listeners or re-reports.
  const viewedId = viewing?.item.assetAttachmentId ?? null;
  const closeViewer = useCallback(() => setViewing(null), []);
  const onViewerError = useCallback(() => {
    if (viewedId !== null) setOpenFailed((prev) => markOpenFailed(prev, viewedId));
  }, [viewedId]);

  const trackRef = useRef<HTMLDivElement>(null);

  // A slide removed while its file is open (another tab, or the gallery
  // emptied) closes the viewer: it never shows, or reopens on, a stale item.
  useEffect(() => {
    if (viewing === null) return;
    const id = viewing.item.assetAttachmentId;
    if (!items.some((it) => it.assetAttachmentId === id)) setViewing(null);
  }, [items, viewing]);

  // The tile that opened the viewer is gone (this viewer replaced the ribbon),
  // so on close focus lands on the slide's Open instead of the page body.
  const wasViewing = useRef(viewing !== null);
  useEffect(() => {
    if (viewing === null && wasViewing.current) {
      const slide = trackRef.current?.children.item(index);
      slide?.querySelector<HTMLElement>('[data-file-slide] button')?.focus();
    }
    wasViewing.current = viewing !== null;
  }, [viewing, index]);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismiss = useMemo(
    () => createSwipeDismiss({ onDrag: setDragY, onClose: () => onCloseRef.current() }),
    [],
  );

  // A downward dismiss drag owns the touch: stop the browser from scrolling the
  // page (or cancelling the pointer) under it. Any other drag stays native.
  useEffect(() => {
    const el = trackRef.current;
    if (el === null) return;
    const onTouchMove = (event: TouchEvent): void => {
      if (dismiss.dragging() && event.cancelable) event.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, [dismiss, items.length]);
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

  // Escape goes through the shared escape stack (FT16), so it reaches the
  // viewer only while it is the top layer: a sheet or dialog opened above it
  // takes the key, and the FileViewer owns every key while it is open.
  useEscapeLayer(true, () => {
    if (!viewingRef.current) onClose();
  });

  // Arrows nudge the native scroller. The viewer is in-flow now, so it never
  // locks body scroll.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // The FileViewer owns the keys while it is open.
      if (viewingRef.current) return;
      if (event.key === 'ArrowLeft') {
        onIndexChange(wrapIndex(indexRef.current, -1, items.length));
      } else if (event.key === 'ArrowRight') {
        onIndexChange(wrapIndex(indexRef.current, 1, items.length));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onIndexChange, items.length]);

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

  // Only an image slide zooms: a file or video slide has nothing to zoom, and
  // a phantom zoom there would capture the pointer and swallow Open.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const applyZoomAt = useCallback(
    (nextScale: number, clientX: number, clientY: number, rect: RectLike): void => {
      const slide = itemsRef.current[indexRef.current];
      if (slide === undefined || !isImage(slide)) return;
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
          dismiss.cancel();
          event.currentTarget.setPointerCapture(event.pointerId);
        } else if (pts.length === 1 && zoom.scale > 1) {
          panStart.current = { px: event.clientX, py: event.clientY, x: zoom.x, y: zoom.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        dismiss.down(
          { x: event.clientX, y: event.clientY, t: Date.now() },
          pts.length === 1 && zoom.scale <= 1,
        );
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
        } else if (pts.length === 1) {
          const axis = dismiss.move({ x: event.clientX, y: event.clientY, t: Date.now() });
          if (axis === 'y') {
            // A dismiss drag is never a tap, and keeps its pointer if it leaves the stage.
            movedRef.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
        }
      },
      onPointerUp: (event) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size === 0) {
          dismiss.up({ x: event.clientX, y: event.clientY, t: Date.now() });
        }
        if (pointers.current.size < 2) pinchStart.current = null;
        if (pointers.current.size === 0) {
          panStart.current = null;
          // A pinch released near 1x snaps fully out.
          setZoom((z) => (z.scale <= 1.05 ? { scale: 1, x: 0, y: 0 } : z));
        }
      },
      onPointerCancel: (event) => {
        pointers.current.delete(event.pointerId);
        dismiss.cancel();
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
    [zoom, applyZoomAt, clampPan, dismiss],
  );

  const item = items[index];
  if (item === undefined) return null;
  const current: GalleryItem = item;

  const openFile = (it: GalleryItem): void => {
    const next = presignEnabled ? viewingFor(it, cache) : null;
    if (next === null) return;
    setOpenFailed((prev) =>
      prev[it.assetAttachmentId] === true ? { ...prev, [it.assetAttachmentId]: false } : prev,
    );
    setViewing(next);
  };

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
        toast?.show({ title: DOWNLOAD_DONE });
      })
      .catch(() => {
        toast?.show({ title: DOWNLOAD_FAILED });
      })
      .finally(() => setBusy(false));
  };

  // After a manage action a valid slide stays in view; the scroll effect above
  // brings the track along.
  const manageView: LightboxManage | undefined =
    manage !== undefined
      ? {
          onAddAfter: () => {
            manage.onAddAfter(index);
          },
          // Remove the viewed slide via the existing gallery_set commit, then
          // keep a valid slide in view (the last one shrinks to its predecessor).
          // Removing the sole image empties the gallery; the parent clears the
          // open index when items becomes empty, so the viewer closes on its own.
          onRemove: () => {
            if (saving) return;
            manage.onRemove(index);
            onIndexChange(Math.max(0, Math.min(index, items.length - 2)));
          },
        }
      : undefined;

  const view = lightboxView({
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
    onPrev: () => onIndexChange(wrapIndex(index, -1, items.length)),
    onNext: () => onIndexChange(wrapIndex(index, 1, items.length)),
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
    saving,
    onRequestRemove: () => setConfirmingRemove(true),
    onCancelRemove: () => setConfirmingRemove(false),
    onConfirmRemove: () => {
      manageView?.onRemove();
      setConfirmingRemove(false);
    },
    pinOverlay,
    dragY,
    onOpenFile: openFile,
    openFailedFor: (it) => openFailed[it.assetAttachmentId] === true,
  });

  if (viewing === null) return view;
  const viewed = viewing.item;
  return (
    <>
      {view}
      {/* The FileViewer carries its own ErrorBoundary (fallback: close +
          Download), so a broken file never blanks the post or brief. */}
      <FileViewer
        key={viewed.assetAttachmentId}
        name={viewed.filename}
        kind={viewing.kind}
        source={viewing.source}
        onClose={closeViewer}
        onLoadError={onViewerError}
      />
    </>
  );
}
