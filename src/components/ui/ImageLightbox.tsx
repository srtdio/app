// One shared, looping, fullscreen image viewer for every comment / brief / post
// surface that opens an image from a thread. It portals to document.body (so a
// sticky, overflow-clipped aside never traps it in a stacking context), sits
// strictly above the toast stack, ref-counts a body scroll lock, traps and
// restores focus, and navigates with an X-only dominant-axis gesture that loops
// at both ends. Media resolves through the SAME useAttachmentUrl hook and shared
// PresignCache the comment rows already presign through, so opening an image is a
// cache hit, and both neighbours are prefetched through that one path. Every
// surface is drawn from the theme-independent `overlay` tokens (the same dark
// backdrop in light and dark mode); no hex, no `dark:` literals.
//
// Gesture axes (each gesture owns exactly one transform, nothing else animates):
//  - paging: X axis only (dominantAxisSwipe on release), inert while zoomed;
//  - dismiss: Y axis only (swipe down at 1x, translateY + backdrop fade);
//  - zoom: scale plus pan (translate) on the current image only, pinch 1..4x
//    and double-tap 1x <-> 2.5x. The pane itself never moves while zoomed.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronLeft, IconChevronRight, IconDownload, IconX } from '@/components/ui/icons';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import { cn } from '@/lib/cn';
import { useModalFocus } from '@/lib/modal-focus';
import type { PresignCache } from '@/lib/asset-presign';
import { VIEWER_ERROR } from '@/components/ui/FileViewer';
import { attachmentLink, saveFromLink, type HeldLink } from '@/lib/files/download';

/** Minimum horizontal travel (px) for a swipe to count as navigation. */
const SWIPE_THRESHOLD = 48;
/** A swipe must be this much more horizontal than vertical to navigate. */
const DOMINANT_AXIS_RATIO = 1.5;

/**
 * The mono top-bar counter: "n / N". Pure. Shared with the post gallery, which
 * imports it from here (its former home) so there is one definition.
 */
export function lightboxCounter(index: number, count: number): string {
  return `${index + 1} / ${count}`;
}

/**
 * Wrap an index by `delta` over `n` items, cycling past either end (next from
 * last -> first, prev from first -> last). Zero or one item collapses to 0. Pure.
 */
export function wrapIndex(index: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return (((index + delta) % n) + n) % n;
}

/**
 * The navigation gesture gate: a pointer displacement drives a slide change only
 * when it clears the horizontal threshold AND is dominantly horizontal (X travel
 * more than 1.5x the Y travel). Every other displacement is ignored, so a mostly
 * vertical drag never steals a navigation. Pure.
 */
export function dominantAxisSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * DOMINANT_AXIS_RATIO;
}

/** Zoom bounds (pinch) and the double-tap target scale. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const DOUBLE_TAP_SCALE = 2.5;
/** Two taps within this window and radius are a double-tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_RADIUS_PX = 32;
/** Movement under this many px is still a tap (and picks no gesture axis yet). */
const TAP_SLOP_PX = 8;
/** Swipe-down past this many px dismisses on release. */
export const DISMISS_DISTANCE = 120;
/** ...or a downward flick faster than this (px per ms). */
export const DISMISS_FLICK_VELOCITY = 0.5;
/** The drag distance over which the backdrop fades to its floor. */
const DISMISS_FADE_PX = 400;

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export const ZOOM_RESET: ZoomState = { scale: 1, x: 0, y: 0 };

/** Clamp a pinch scale into [1, 4]. Pure. */
export function clampZoom(scale: number): number {
  return Math.min(Math.max(scale, ZOOM_MIN), ZOOM_MAX);
}

/** Double-tap toggles: any zoom goes back to 1x, 1x goes to 2.5x. Pure. */
export function doubleTapTarget(scale: number): number {
  return scale > 1 ? 1 : DOUBLE_TAP_SCALE;
}

/** The pane size pan is bounded by. */
export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Bound a pan so the scaled image never leaves the pane edges. Pure. */
export function clampPan(scale: number, x: number, y: number, rect: PaneRect): ZoomState {
  const maxX = ((scale - 1) * rect.width) / 2;
  const maxY = ((scale - 1) * rect.height) / 2;
  return {
    scale,
    x: Math.min(Math.max(x, -maxX), maxX),
    y: Math.min(Math.max(y, -maxY), maxY),
  };
}

/**
 * Zoom to `nextScale` keeping the focal point (client coords) stationary:
 * p' = p - (p - t) * (s'/s). At or below 1x it resets fully. Pure.
 */
export function zoomAt(
  zoom: ZoomState,
  nextScale: number,
  clientX: number,
  clientY: number,
  rect: PaneRect,
): ZoomState {
  const scale = clampZoom(nextScale);
  if (scale <= 1) return ZOOM_RESET;
  const px = clientX - rect.left - rect.width / 2;
  const py = clientY - rect.top - rect.height / 2;
  const k = scale / zoom.scale;
  return clampPan(scale, px - (px - zoom.x) * k, py - (py - zoom.y) * k, rect);
}

/** Paging (arrows, keys, swipe) runs only with more than one image and at 1x. Pure. */
export function canPage(count: number, scale: number): boolean {
  return count > 1 && scale <= 1;
}

/**
 * Which gesture a single-pointer drag at 1x belongs to, decided once it leaves
 * the tap slop: a downward, dominantly vertical drag is a dismiss (Y); anything
 * else is a paging candidate (X). Null while still inside the slop. Pure.
 */
export function dragAxis(dx: number, dy: number): 'x' | 'y' | null {
  if (Math.abs(dx) < TAP_SLOP_PX && Math.abs(dy) < TAP_SLOP_PX) return null;
  return dy > 0 && Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
}

/** Swipe-down release: close past 120px or on a fast downward flick. Pure. */
export function shouldDismiss(dy: number, velocity: number): boolean {
  return dy >= DISMISS_DISTANCE || (dy > 0 && velocity >= DISMISS_FLICK_VELOCITY);
}

/** Backdrop opacity while dragging down: 1 at rest, fading toward 0.2. Pure. */
export function dismissOpacity(dy: number): number {
  return 1 - Math.min(Math.max(dy, 0) / DISMISS_FADE_PX, 1) * 0.8;
}

/**
 * What the Download control saves: the image's local preview (own instant
 * send), else a fresh attachment-disposition link from asset-read minted on
 * the tap, with the file name. Null while presign is disabled or the image is
 * not stored yet (the control renders disabled). Pure: nothing is fetched until getLink() is called.
 */
export function imageDownload(args: {
  image: LightboxImage;
  cache: PresignCache;
  presignEnabled: boolean;
}): { name: string; getLink: () => Promise<HeldLink> } | null {
  const name = args.image.name.trim() !== '' ? args.image.name : 'image';
  const local = args.image.src;
  if (local !== undefined) {
    // The caller owns the preview's blob URL: it is never revoked here.
    return { name, getLink: () => Promise.resolve({ url: local, release: () => undefined }) };
  }
  // Not stored yet (no version id): nothing to save until it is.
  if (!args.presignEnabled || args.image.assetId === '') return null;
  return { name, getLink: attachmentLink(args.cache, args.image.assetId) };
}

/** The mutable style surface the scroll lock saves and restores. */
export interface LockableStyle {
  overflow: string;
  touchAction: string;
  paddingRight: string;
}

/** The minimal body shape the scroll lock reads (satisfied by document.body). */
export interface LockableBody {
  style: LockableStyle;
  clientWidth: number;
}

export interface ScrollLock {
  acquire: () => void;
  release: () => void;
}

/**
 * A ref-counted body scroll lock. The FIRST acquire saves the body's overflow,
 * touch-action, and padding-right, sets overflow/touch-action to their locked
 * values, and compensates the scrollbar gutter as padding-right so the page does
 * not shift. Nested acquires only bump the counter; the LAST release restores the
 * exact saved values. Injecting the body + viewport width keeps it unit-testable
 * without a DOM. Pure factory.
 */
export function createScrollLock(
  getBody: () => LockableBody,
  getViewportWidth: () => number,
): ScrollLock {
  let count = 0;
  let saved: LockableStyle | null = null;
  return {
    acquire(): void {
      count += 1;
      if (count > 1) return;
      const body = getBody();
      saved = {
        overflow: body.style.overflow,
        touchAction: body.style.touchAction,
        paddingRight: body.style.paddingRight,
      };
      const gutter = getViewportWidth() - body.clientWidth;
      body.style.overflow = 'hidden';
      body.style.touchAction = 'none';
      if (gutter > 0) body.style.paddingRight = `${gutter}px`;
    },
    release(): void {
      if (count === 0) return;
      count -= 1;
      if (count > 0 || saved === null) return;
      const body = getBody();
      body.style.overflow = saved.overflow;
      body.style.touchAction = saved.touchAction;
      body.style.paddingRight = saved.paddingRight;
      saved = null;
    },
  };
}

// The single module-level lock every viewer instance shares, so a viewer opened
// over another (nested modals) never releases the page early.
const bodyScrollLock = createScrollLock(
  () => document.body,
  () => window.innerWidth,
);

// Icon buttons on the viewer's own dark backdrop. 44x44 touch targets.
const TOOLBAR_BUTTON =
  'inline-flex h-11 w-11 items-center justify-center rounded-lg text-overlay-fg ' +
  'hover:bg-overlay-surface focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-overlay-fg/70';

// Prev/next arrows: a translucent chip keeps them legible over any photo. 44x44.
const ARROW_BUTTON =
  'absolute top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center ' +
  'rounded-full bg-overlay-surface text-overlay-fg hover:bg-overlay-line ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

// The Try again control on the failure state: auto width, same token palette.
const RETRY_BUTTON =
  'inline-flex h-11 min-h-[44px] items-center justify-center rounded-lg px-4 text-base font-medium text-overlay-fg ' +
  'hover:bg-overlay-surface focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-overlay-fg/70';

/** One image the viewer can show. Callers filter to image MIME before passing. */
export interface LightboxImage {
  assetId: string;
  name: string;
  caption?: string;
  /** A local preview (own instant send): shown and downloaded without presigning. */
  src?: string;
}

/** Optional bottom bar (chat): who sent the image and when, plus Download. */
export interface LightboxDetails {
  sender: string;
  /** Already formatted by the caller's time helper (HH:mm). */
  time: string;
}

/** The current image's display URL: its local preview, else the shared presign. */
function useImageUrl(
  image: LightboxImage,
  cache: PresignCache,
  presignEnabled: boolean,
): { url: string | null; failed: boolean } {
  const local = image.src !== undefined;
  const presigned = useAttachmentUrl(image.assetId, cache, presignEnabled && !local);
  return local ? { url: image.src ?? null, failed: false } : presigned;
}

/**
 * The media pane for the current image. It resolves the signed URL through the
 * shared PresignCache (a cache hit, since the comment row already presigned it),
 * showing the spinner while pending and, on rejection, a short message plus a
 * Try again control. The parent re-keys this component to re-run resolution, so
 * Try again is simply a remount, keeping a single presign path.
 */
function LightboxMedia({
  image,
  cache,
  presignEnabled,
  onRetry,
}: {
  image: LightboxImage;
  cache: PresignCache;
  presignEnabled: boolean;
  onRetry: () => void;
}): ReactElement {
  const { url, failed } = useImageUrl(image, cache, presignEnabled);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-base text-overlay-fg-dim">This image did not load.</p>
        <button type="button" onClick={onRetry} className={RETRY_BUTTON}>
          Try again
        </button>
      </div>
    );
  }
  if (url === null) {
    return (
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-overlay-line border-t-overlay-fg" />
    );
  }
  return (
    <img
      src={url}
      alt={image.name}
      draggable={false}
      className="max-h-full max-w-full select-none object-contain"
    />
  );
}

/**
 * The bottom bar's Download, the same mechanism as the FileViewer's: a fresh
 * attachment link saved through a same-window anchor (never a new tab or
 * window), styled as the 44px icon button. Disabled while a save is starting
 * or presign is disabled; a link that could not be minted says so in place.
 */
function DownloadControl({
  image,
  cache,
  presignEnabled,
}: {
  image: LightboxImage;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const target = imageDownload({ image, cache, presignEnabled });
  const onDownload = (): void => {
    if (target === null || busy) return;
    setBusy(true);
    setFailed(false);
    void saveFromLink(target.getLink, target.name).then((ok) => {
      if (!live.current) return;
      setBusy(false);
      if (!ok) setFailed(true);
    });
  };
  return (
    <>
      {failed ? (
        <span role="status" className="shrink-0 text-sm text-overlay-fg-dim">
          {VIEWER_ERROR}
        </span>
      ) : null}
      <button
        type="button"
        aria-label="Download"
        disabled={target === null || busy}
        onClick={onDownload}
        className={cn(TOOLBAR_BUTTON, 'disabled:opacity-40')}
      >
        <IconDownload size={20} />
      </button>
    </>
  );
}

export interface ImageLightboxProps {
  /** The IMAGE list, already filtered by the caller. */
  images: LightboxImage[];
  index: number;
  cache: PresignCache;
  presignEnabled: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Chat: sender + time and a Download control in a bottom bar. Comments omit it. */
  details?: LightboxDetails;
}

/**
 * Fullscreen, looping image viewer. Portals to document.body above the toast
 * stack; locks body scroll (ref-counted, restored on unmount including a route
 * change or back-button dismiss); traps Tab within the dialog and restores focus
 * to the opener on close; navigates with an X-only dominant-axis swipe plus the
 * arrows and Arrow keys, all wrapping at both ends. A single-image viewer hides
 * the arrows and counter and makes the gesture inert. Escape closes.
 */
export function ImageLightbox({
  images,
  index,
  cache,
  presignEnabled,
  onIndexChange,
  onClose,
  details,
}: ImageLightboxProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Bumped by Try again; part of the media key so a retry remounts and re-resolves.
  const [attempt, setAttempt] = useState(0);
  // Zoom: scale plus pan on the current image only.
  const [zoom, setZoom] = useState<ZoomState>(ZOOM_RESET);
  // Dismiss: Y-only offset while dragging down at 1x; `settling` springs it back.
  const [dragY, setDragY] = useState(0);
  const [settling, setSettling] = useState(false);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ d: number; zoom: ZoomState } | null>(null);
  const panStart = useRef<{ px: number; py: number; zoom: ZoomState } | null>(null);
  const dragStart = useRef<{ x: number; y: number; t: number; axis: 'x' | 'y' | null } | null>(
    null,
  );
  const moved = useRef(false);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const count = images.length;
  const multiple = count > 1;
  const current = images[index];
  const paging = canPage(count, zoom.scale);

  // Ref-counted body scroll lock. Released on every unmount path (route change,
  // back-button dismiss, close), restoring the exact prior body styles.
  useEffect(() => {
    bodyScrollLock.acquire();
    return () => bodyScrollLock.release();
  }, []);

  // Focus lands on Close, Tab cycles inside the dialog, and the opener gets
  // focus back on close (the shared modal focus; only the top layer traps).
  useModalFocus(dialogRef, true, { initial: () => closeRef.current });

  // A new image resets the retry counter and the zoom so its state is fresh.
  useEffect(() => {
    setAttempt(0);
    setZoom(ZOOM_RESET);
    setDragY(0);
  }, [index]);

  // Escape closes; Arrow keys navigate (wrapping; the new image starts at 1x).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key === 'ArrowLeft' && multiple) {
        onIndexChange(wrapIndex(index, -1, count));
        return;
      }
      if (event.key === 'ArrowRight' && multiple) {
        onIndexChange(wrapIndex(index, 1, count));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, count, multiple, onClose, onIndexChange]);

  // Prefetch both neighbours through the shared cache; their errors are swallowed
  // (a neighbour that fails to presign simply shows its own failure when reached).
  useEffect(() => {
    if (!presignEnabled || !multiple) return;
    for (const neighbour of [wrapIndex(index, -1, count), wrapIndex(index, 1, count)]) {
      const image = images[neighbour];
      if (image !== undefined && image.assetId !== '') {
        void cache.resolve(image.assetId).catch(() => {});
      }
    }
  }, [index, count, multiple, images, cache, presignEnabled]);

  const resetGesture = useCallback((): void => {
    pointers.current.clear();
    pinchStart.current = null;
    panStart.current = null;
    dragStart.current = null;
  }, []);

  if (current === undefined) return null;

  const go = (delta: number): void => {
    if (paging) onIndexChange(wrapIndex(index, delta, count));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // Controls (arrows, retry) keep their own clicks.
    if (event.target instanceof Element && event.target.closest('button, a') !== null) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length === 1) moved.current = false;
    if (pts.length === 2) {
      // Pinch: zoom scale plus pan. Any drag in progress is abandoned.
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      pinchStart.current = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      panStart.current = null;
      dragStart.current = null;
      setDragY(0);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } else if (pts.length === 1 && zoom.scale > 1) {
      panStart.current = { px: event.clientX, py: event.clientY, zoom };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } else if (pts.length === 1) {
      dragStart.current = { x: event.clientX, y: event.clientY, t: Date.now(), axis: null };
      setSettling(false);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = event.currentTarget.getBoundingClientRect();
    const pts = [...pointers.current.values()];
    const pinch = pinchStart.current;
    if (pts.length === 2 && pinch !== null) {
      const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d <= 0 || pinch.d <= 0) return;
      moved.current = true;
      setZoom(
        zoomAt(
          pinch.zoom,
          pinch.zoom.scale * (d / pinch.d),
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          rect,
        ),
      );
      return;
    }
    const pan = panStart.current;
    if (pts.length === 1 && pan !== null) {
      const dx = event.clientX - pan.px;
      const dy = event.clientY - pan.py;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true;
      setZoom(clampPan(pan.zoom.scale, pan.zoom.x + dx, pan.zoom.y + dy, rect));
      return;
    }
    const drag = dragStart.current;
    if (pts.length === 1 && drag !== null) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (drag.axis === null) drag.axis = dragAxis(dx, dy);
      if (drag.axis !== null) moved.current = true;
      // Dismiss follows the finger on Y only, downward.
      if (drag.axis === 'y') setDragY(Math.max(dy, 0));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size > 0) return;
    panStart.current = null;
    // A pinch released near 1x snaps fully out.
    setZoom((z) => (z.scale <= 1.05 ? ZOOM_RESET : z));
    const drag = dragStart.current;
    dragStart.current = null;
    if (drag !== null && drag.axis === 'y') {
      const dy = Math.max(event.clientY - drag.y, 0);
      const velocity = dy / Math.max(Date.now() - drag.t, 1);
      if (shouldDismiss(dy, velocity)) {
        // Instant close: no exit animation.
        onClose();
        return;
      }
      setSettling(true);
      setDragY(0);
      return;
    }
    if (drag !== null && drag.axis === 'x') {
      // Paging: X axis only, and never while zoomed.
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (paging && dominantAxisSwipe(dx, dy)) go(dx < 0 ? 1 : -1);
      return;
    }
    if (moved.current) return;
    // A still tap: two in quick succession toggle the zoom at the tap point.
    const now = Date.now();
    const tap = { t: now, x: event.clientX, y: event.clientY };
    const prev = lastTap.current;
    if (
      prev !== null &&
      now - prev.t < DOUBLE_TAP_MS &&
      Math.hypot(tap.x - prev.x, tap.y - prev.y) < DOUBLE_TAP_RADIUS_PX
    ) {
      lastTap.current = null;
      const rect = event.currentTarget.getBoundingClientRect();
      setZoom((z) => zoomAt(z, doubleTapTarget(z.scale), tap.x, tap.y, rect));
      return;
    }
    lastTap.current = tap;
  };

  const onPointerCancel = (): void => {
    resetGesture();
    setSettling(true);
    setDragY(0);
  };

  // Zoom: scale plus pan on the image only. Dismiss: translateY only.
  const zoomStyle: CSSProperties | undefined =
    zoom.scale > 1
      ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }
      : undefined;
  const dismissStyle: CSSProperties | undefined =
    dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined;

  const caption = current.caption;

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      data-motion-axis="x"
      className="fixed inset-0 z-[80] flex flex-col overflow-hidden"
    >
      {/* The backdrop fades while a swipe down is in progress. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-overlay"
        style={dragY > 0 ? { opacity: dismissOpacity(dragY) } : undefined}
      />
      <div className="relative flex h-14 shrink-0 items-center gap-2 px-3">
        {multiple ? (
          <span className="shrink-0 font-mono text-md tabular-nums text-overlay-fg">
            {lightboxCounter(index, count)}
          </span>
        ) : null}
        <button
          ref={closeRef}
          type="button"
          aria-label="Close viewer"
          onClick={onClose}
          className={cn(TOOLBAR_BUTTON, 'ml-auto')}
        >
          <IconX size={20} />
        </button>
      </div>

      <div
        data-lightbox-pane=""
        className="relative flex flex-1 touch-none items-center justify-center overflow-hidden overscroll-contain p-4"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {multiple && zoom.scale <= 1 ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => go(-1)}
              className={cn(ARROW_BUTTON, 'left-2 z-10')}
            >
              <IconChevronLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={() => go(1)}
              className={cn(ARROW_BUTTON, 'right-2 z-10')}
            >
              <IconChevronRight size={20} />
            </button>
          </>
        ) : null}

        <div
          data-motion-axis="y"
          className={cn(
            'flex h-full w-full items-center justify-center',
            settling && 'transition-transform duration-200 ease-out motion-reduce:transition-none',
          )}
          style={dismissStyle}
          onTransitionEnd={() => setSettling(false)}
        >
          <div
            data-motion-axis="zoom"
            className="flex h-full w-full items-center justify-center"
            style={zoomStyle}
          >
            <LightboxMedia
              key={`${current.assetId}:${current.src ?? ''}:${attempt}`}
              image={current}
              cache={cache}
              presignEnabled={presignEnabled}
              onRetry={() => setAttempt((value) => value + 1)}
            />
          </div>
        </div>
      </div>

      {caption !== undefined && caption !== '' ? (
        <div className="relative shrink-0 px-4 pb-4 text-center text-base text-overlay-fg-dim">
          {caption}
        </div>
      ) : null}

      {details !== undefined ? (
        <div className="relative flex h-16 shrink-0 items-center gap-3 px-4 pb-[env(safe-area-inset-bottom)]">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-base font-medium text-overlay-fg">
              {details.sender}
            </span>
            <span className="font-mono text-sm tabular-nums text-overlay-fg-dim">
              {details.time}
            </span>
          </span>
          <DownloadControl
            key={`${current.assetId}:${current.src ?? ''}`}
            image={current}
            cache={cache}
            presignEnabled={presignEnabled}
          />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
