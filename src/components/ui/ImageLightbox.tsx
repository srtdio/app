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

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronLeft, IconChevronRight, IconX } from '@/components/ui/icons';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import { cn } from '@/lib/cn';
import type { PresignCache } from '@/lib/asset-presign';

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
  'inline-flex min-h-[44px] items-center rounded-lg px-4 text-sm text-overlay-fg ' +
  'hover:bg-overlay-surface focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-overlay-fg/70';

/** One image the viewer can show. Callers filter to image MIME before passing. */
export interface LightboxImage {
  assetId: string;
  name: string;
  caption?: string;
}

/** Every enabled (non-disabled) button inside the dialog, in DOM order. */
function focusableControls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'));
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
  const { url, failed } = useAttachmentUrl(image.assetId, cache, presignEnabled);

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-overlay-fg-dim">This image did not load.</p>
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
  return <img src={url} alt={image.name} className="max-h-full max-w-full object-contain" />;
}

export interface ImageLightboxProps {
  /** The IMAGE list, already filtered by the caller. */
  images: LightboxImage[];
  index: number;
  cache: PresignCache;
  presignEnabled: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
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
}: ImageLightboxProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  // Bumped by Try again; part of the media key so a retry remounts and re-resolves.
  const [attempt, setAttempt] = useState(0);

  const count = images.length;
  const multiple = count > 1;
  const current = images[index];

  // Ref-counted body scroll lock. Released on every unmount path (route change,
  // back-button dismiss, close), restoring the exact prior body styles.
  useEffect(() => {
    bodyScrollLock.acquire();
    return () => bodyScrollLock.release();
  }, []);

  // Save the opener, focus the first control on open, restore focus on close.
  useEffect(() => {
    openerRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, []);

  // A new image resets the retry counter so its own failure state is fresh.
  useEffect(() => {
    setAttempt(0);
  }, [index]);

  // Escape closes; Arrow keys navigate (wrapping); Tab is trapped and cycles.
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
        return;
      }
      if (event.key === 'Tab') {
        const root = dialogRef.current;
        if (root === null) return;
        const controls = focusableControls(root);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (first === undefined || last === undefined) return;
        const active = document.activeElement;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
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

  if (current === undefined) return null;

  const go = (delta: number): void => {
    if (multiple) onIndexChange(wrapIndex(index, delta, count));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (start === null || !multiple) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!dominantAxisSwipe(dx, dy)) return;
    go(dx < 0 ? 1 : -1);
  };

  const caption = current.caption;

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      data-motion-axis="x"
      className="fixed inset-0 z-[80] flex flex-col overflow-hidden bg-overlay"
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        {multiple ? (
          <span className="shrink-0 tabular-nums text-sm text-overlay-fg-dim">
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
        className="relative flex flex-1 touch-none items-center justify-center overflow-hidden overscroll-contain p-4"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        {multiple ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => go(-1)}
              className={cn(ARROW_BUTTON, 'left-2')}
            >
              <IconChevronLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={() => go(1)}
              className={cn(ARROW_BUTTON, 'right-2')}
            >
              <IconChevronRight size={20} />
            </button>
          </>
        ) : null}

        <LightboxMedia
          key={`${current.assetId}:${attempt}`}
          image={current}
          cache={cache}
          presignEnabled={presignEnabled}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      </div>

      {caption !== undefined && caption !== '' ? (
        <div className="shrink-0 px-4 pb-4 text-center text-sm text-overlay-fg-dim">{caption}</div>
      ) : null}
    </div>,
    document.body,
  );
}
