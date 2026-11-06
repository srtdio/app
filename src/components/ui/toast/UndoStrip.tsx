import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Toast as ToastModel } from '@/components/ui/toast/types';
import { BOTTOM_ANCHOR_ATTR, measureBottomInset } from '@/lib/bottom-inset';
import { cn } from '@/lib/cn';
import { riseIn, stripIn, stripOut, useMotionOff } from '@/lib/motion';
import { holdHandlers } from '@/lib/pausable-timer';
import type { HoldReason } from '@/lib/pausable-timer';
import { isLaptopNow } from '@/lib/use-is-laptop';

/** Gap between the strip and the surface it sits on (tab bar or composer). */
export const STRIP_ANCHOR_GAP_PX = 8;
/** A swipe down past this share of the strip's height dismisses it (accept). */
export const STRIP_SWIPE_ACCEPT_RATIO = 0.4;
/** Marks a bottom surface the strip floats above on phone: the shared bottom-bar anchor. */
export const UNDO_ANCHOR_ATTR = BOTTOM_ANCHOR_ATTR;

/**
 * Distance in px from the viewport's bottom edge to the strip's bottom edge on
 * phone: STRIP_ANCHOR_GAP_PX above the highest visible anchor, or null when
 * there is none (the CSS falls back to 16px above the safe-area inset). Pure.
 */
export function stripBottomPx(
  anchorTops: readonly number[],
  viewportHeight: number,
): number | null {
  if (anchorTops.length === 0) return null;
  const top = Math.min(...anchorTops);
  return Math.max(0, viewportHeight - top) + STRIP_ANCHOR_GAP_PX;
}

/** True when a release at this drag offset accepts the strip. Pure. */
export function swipeAccepts(dragPx: number, heightPx: number): boolean {
  return heightPx > 0 && dragPx >= heightPx * STRIP_SWIPE_ACCEPT_RATIO;
}

interface UndoStripProps {
  toast: ToastModel;
  /** True while the strip plays its exit before the provider unmounts it. */
  leaving?: boolean;
  /** Swipe down: accept (the provider runs onExpire, so the action commits now). */
  onAccept: (id: string) => void;
  /** The Undo button. */
  onAction: (id: string) => void;
  /**
   * Holds the strip's UNDO_MS countdown (the provider's pausable timer) while
   * it is hovered, focused or touched; it resumes with the time left.
   */
  onHold?: (id: string, reason: HoldReason, held: boolean) => void;
}

/**
 * The bottom Undo strip (Instagram style). Phone: 16px side margins, 8px above
 * the bottom tab bar or the chat composer, else 16px above the safe-area inset.
 * Laptop (md+): bottom centre, 480px wide, 24px up. Label left, "Undo" right;
 * no X, no countdown, no icon. Its UNDO_MS window pauses while it is hovered,
 * focused or touched and resumes with the time left (onHold). Motion
 * (docs/motion.md, edgeStrip): rendered at rest, it rises from the bottom edge on the first frame and leaves the same
 * way (from wherever a swipe left it). Swipe down follows the finger
 * (translateY only) and accepts past 40% of its height, else springs back.
 * Never a fade; with motion off it simply goes.
 */
export function UndoStrip({ toast, leaving = false, onAccept, onAction, onHold }: UndoStripProps) {
  const { id, title, action } = toast;
  const holds = holdHandlers((reason, held) => onHold?.(id, reason, held));
  const ref = useRef<HTMLDivElement | null>(null);
  const startY = useRef<number | null>(null);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [bottom, setBottom] = useState<number | null>(null);
  const off = useMotionOff();
  // The last drag offset, so the exit starts where the finger let go.
  const dragRef = useRef(0);
  dragRef.current = drag;

  // Enter: rises from the bottom edge on the first frame (already painted at rest).
  useLayoutEffect(() => {
    stripIn(ref.current, 'bottom');
  }, []);

  // Leave: back down the same way, from the drag offset. The store unmounts it.
  useLayoutEffect(() => {
    if (leaving) stripOut(ref.current, 'bottom', undefined, dragRef.current);
  }, [leaving]);

  const place = useCallback((): void => {
    if (isLaptopNow()) {
      setBottom(null);
      return;
    }
    // The shared inset (top of the highest bottom bar); none leaves the CSS fallback.
    const inset = measureBottomInset(ref.current);
    setBottom(inset > 0 ? inset + STRIP_ANCHOR_GAP_PX : null);
  }, []);

  useLayoutEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (observer !== null) {
      for (const el of document.querySelectorAll(`[${BOTTOM_ANCHOR_ATTR}]`)) observer.observe(el);
    }
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [place]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (leaving) return;
    // Touch anywhere on the strip (the Undo button too) holds the countdown.
    holds.onPointerDown();
    if ((event.target as Element).closest('button') !== null) return;
    startY.current = event.clientY;
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (startY.current === null) return;
    setDrag(Math.max(0, event.clientY - startY.current));
  }

  function onPointerEnd(): void {
    if (startY.current === null) return;
    startY.current = null;
    setDragging(false);
    if (swipeAccepts(drag, ref.current?.offsetHeight ?? 0)) {
      onAccept(id);
      return;
    }
    // Short: spring back to rest from where the finger left it.
    setDrag(0);
    if (drag > 0) riseIn(ref.current, drag);
  }

  const style = {
    ...(bottom !== null ? { '--strip-bottom': `${bottom}px` } : {}),
    // Follows the finger while dragging (and holds there until the exit takes over).
    ...((dragging || leaving) && drag > 0 ? { transform: `translateY(${drag}px)` } : {}),
  } as CSSProperties;

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      data-undo-strip=""
      {...(leaving ? { 'data-leaving': '' } : {})}
      style={style}
      onPointerEnter={holds.onPointerEnter}
      onPointerLeave={holds.onPointerLeave}
      onFocus={holds.onFocus}
      onBlur={holds.onBlur}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      className={cn(
        'pointer-events-auto fixed inset-x-4 bottom-[var(--strip-bottom,calc(env(safe-area-inset-bottom)_+_16px))] z-[70] flex min-h-12 touch-none select-none items-center gap-3 rounded-xl border border-strip bg-strip py-0 pl-4 pr-1 lit-strip md:inset-x-0 md:bottom-6 md:mx-auto md:w-full md:max-w-lg',
        // Motion off: a leaving strip goes at once (no exit to wait for).
        leaving && off && 'invisible',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-lg font-medium text-strip">{title}</span>
      {action !== undefined ? (
        <button
          type="button"
          data-toast-action=""
          onClick={() => onAction(id)}
          className="flex h-11 min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg px-4 text-base font-medium text-strip-action focus-visible:lit-focus focus-visible:outline-overlay-fg"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
