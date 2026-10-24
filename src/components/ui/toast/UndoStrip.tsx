import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Toast as ToastModel } from '@/components/ui/toast/types';

/** Gap between the strip and the surface it sits on (tab bar or composer). */
export const STRIP_ANCHOR_GAP_PX = 8;
/** A swipe down past this share of the strip's height dismisses it (accept). */
export const STRIP_SWIPE_ACCEPT_RATIO = 0.4;
/** Marks a bottom surface the strip floats above on phone (BottomTabs, chat composer). */
export const UNDO_ANCHOR_ATTR = 'data-undo-anchor';

/**
 * Strip keyframes. translateY only; the exit starts from the drag offset
 * (--strip-drag) so a swipe hands straight into the slide down. Reduced
 * motion: fade only.
 */
export const UNDO_STRIP_KEYFRAMES =
  '@keyframes sorted-strip-in{from{opacity:0;transform:translateY(100%)}to{opacity:1;transform:translateY(0)}}' +
  '@keyframes sorted-strip-out{from{opacity:1;transform:translateY(var(--strip-drag,0px))}to{opacity:0;transform:translateY(calc(var(--strip-drag,0px) + 100%))}}' +
  '@keyframes sorted-strip-fade-in{from{opacity:0}to{opacity:1}}' +
  '@keyframes sorted-strip-fade-out{from{opacity:1}to{opacity:0}}' +
  '@media (prefers-reduced-motion: reduce){[data-undo-strip]{animation-name:sorted-strip-fade-in !important}[data-undo-strip][data-leaving]{animation-name:sorted-strip-fade-out !important}}';

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

function measureAnchorTops(): number[] {
  const tops: number[] = [];
  for (const el of document.querySelectorAll(`[${UNDO_ANCHOR_ATTR}]`)) {
    const rect = el.getBoundingClientRect();
    if (rect.height > 0 && rect.width > 0) tops.push(rect.top);
  }
  return tops;
}

function isPhone(): boolean {
  return (
    typeof window.matchMedia !== 'function' || !window.matchMedia('(min-width: 768px)').matches
  );
}

interface UndoStripProps {
  toast: ToastModel;
  /** True while the strip plays its exit before the provider unmounts it. */
  leaving?: boolean;
  /** Swipe down: accept (the provider runs onExpire, so the action commits now). */
  onAccept: (id: string) => void;
  /** The Undo button. */
  onAction: (id: string) => void;
}

/**
 * The bottom Undo strip (Instagram style). Phone: 16px side margins, 8px above
 * the bottom tab bar or the chat composer, else 16px above the safe-area inset.
 * Laptop (md+): bottom centre, 480px wide, 24px up. Label left, "Undo" right;
 * no X, no countdown, no icon. Swipe down follows the finger (translateY only)
 * and accepts past 40% of its height, else snaps back.
 */
export function UndoStrip({ toast, leaving = false, onAccept, onAction }: UndoStripProps) {
  const { id, title, action } = toast;
  const ref = useRef<HTMLDivElement | null>(null);
  const startY = useRef<number | null>(null);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [bottom, setBottom] = useState<number | null>(null);

  const place = useCallback((): void => {
    setBottom(isPhone() ? stripBottomPx(measureAnchorTops(), window.innerHeight) : null);
  }, []);

  useLayoutEffect(() => {
    place();
  }, [place]);

  useEffect(() => {
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (observer !== null) {
      for (const el of document.querySelectorAll(`[${UNDO_ANCHOR_ATTR}]`)) observer.observe(el);
    }
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [place]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (leaving) return;
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
    setDrag(0);
  }

  const animation = leaving
    ? 'sorted-strip-out var(--dur-base) var(--ease-exit) forwards'
    : 'sorted-strip-in var(--dur-slow) var(--ease-enter)';

  const style = {
    animation,
    '--strip-drag': `${drag}px`,
    ...(bottom !== null ? { '--strip-bottom': `${bottom}px` } : {}),
    ...(leaving
      ? {}
      : {
          transform: `translateY(${drag}px)`,
          transition: dragging ? 'none' : 'transform var(--dur-base) var(--ease-enter)',
        }),
  } as CSSProperties;

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      data-undo-strip=""
      {...(leaving ? { 'data-leaving': '' } : {})}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      className="pointer-events-auto fixed inset-x-4 bottom-[var(--strip-bottom,calc(env(safe-area-inset-bottom)_+_16px))] z-[70] flex min-h-[50px] touch-none select-none items-center gap-3 rounded-[14px] border border-[var(--strip-border)] bg-[var(--strip-bg)] py-0 pl-[18px] pr-[5px] shadow-[var(--strip-shadow)] md:inset-x-0 md:bottom-6 md:mx-auto md:w-[480px]"
    >
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--strip-fg)]">
        {title}
      </span>
      {action !== undefined ? (
        <button
          type="button"
          data-toast-action=""
          onClick={() => onAction(id)}
          className="flex h-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg px-4 text-legacy-sm font-medium text-[var(--strip-action)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--strip-action)]"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
