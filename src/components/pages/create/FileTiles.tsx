// The create sheet's file row: one small tile per photo or video, each showing
// its own picture. A tile still uploading carries ui/UploadRing (its X cancels
// the upload); a failed one is outlined in the bad colour with Retry
// (UploadRetry) in the ring's own spot. Finished tiles reorder by drag on laptop
// and hold-and-drag on phone (pointer events): the dragged tile moves on the X
// axis only, inside the row, with no rotation, and the others shift with
// transform. Tapping a tile shows it in the frame.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { itemIn, uploadSettle, useFreshKeys } from '@/lib/motion';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import type { AttachmentItem } from '@/components/pages/create/AttachmentsField';
import { RemoveButton } from '@/components/pages/create/RemoveButton';
import { clampDrag, dropIndex, shiftFor } from '@/components/pages/create/reorder';
import { PressableRow } from '@/components/ui/PressableRow';
import { UploadRetry, UploadRing } from '@/components/ui/UploadRing';
import { LONG_PRESS_MS } from '@/components/ui/useLongPress';
import { cn } from '@/lib/cn';

/** A tile for a file still uploading (or failed): its own local picture. */
export interface PendingTile {
  id: string;
  name: string;
  previewUrl: string;
  video: boolean;
  /** 0..1 while the request runs. */
  progress: number;
  failed: boolean;
}

/** Tile size (h-16) plus the row gap (gap-2): one slot in the reorder math. */
const TILE_SLOT = 64 + 8;
/** A mouse drag starts after this many pixels; a finger moving this far first scrolls instead. */
const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;

interface Gesture {
  pointerId: number;
  from: number;
  startX: number;
  startY: number;
  touch: boolean;
  active: boolean;
  timer: number | null;
  el: HTMLElement;
}

/**
 * A tile's edge: at rest the hairline, picked the one selected look, failed the
 * error line. One per tile, so an outline class never shares an element with
 * border-border (guard: outline-rules.test.ts).
 */
function tileEdge(state: 'rest' | 'picked' | 'failed'): string {
  if (state === 'picked') return 'lit-selected';
  if (state === 'failed') return 'border-bad lit-bad';
  return 'border-border';
}

function TilePicture({ src, video }: { src: string | undefined; video: boolean }): ReactElement {
  if (src === undefined) return <span className="block h-full w-full bg-panel-3" />;
  return video ? (
    <video
      src={src}
      muted
      playsInline
      preload="metadata"
      aria-hidden="true"
      className="pointer-events-none h-full w-full object-cover"
    />
  ) : (
    <img
      src={src}
      alt=""
      draggable={false}
      className="pointer-events-none h-full w-full object-cover"
    />
  );
}

export function FileTiles({
  items,
  pending,
  activeIndex,
  onSelect,
  onRemove,
  onReorder,
  onCancelPending,
  onRetryPending,
}: {
  /** Finished photos and videos, in saved order. */
  items: readonly AttachmentItem[];
  pending: readonly PendingTile[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
  onReorder: (from: number, to: number) => void;
  /** The ring's X on an uploading tile: stops the upload and drops the tile. */
  onCancelPending: (id: string) => void;
  /** Retry on a failed tile: runs its upload again. */
  onRetryPending: (id: string) => void;
}): ReactElement {
  const [drag, setDrag] = useState<{ from: number; dx: number } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // A drag that just ended must not also count as a tap on the tile.
  const justDragged = useRef(false);
  const rowRef = useRef<HTMLUListElement>(null);
  const count = items.length;
  // A new upload tile rises into place (itemIn); a finished upload's tile
  // settles (ease-pop). The first paint never moves. Laid over final states.
  const freshPending = useFreshKeys(pending.map((tile) => tile.id));
  const freshItems = useFreshKeys(items.map((item) => item.versionId));
  const tileEls = useRef(new Map<string, HTMLLIElement>());
  useLayoutEffect(() => {
    for (const id of freshPending) itemIn(tileEls.current.get(id) ?? null);
    for (const id of freshItems) uploadSettle(tileEls.current.get(id) ?? null);
  });
  const tileRef =
    (id: string) =>
    (el: HTMLLIElement | null): void => {
      if (el === null) tileEls.current.delete(id);
      else tileEls.current.set(id, el);
    };

  // Once a held tile lifts, the finger drags it instead of scrolling the page.
  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return undefined;
    function block(event: TouchEvent): void {
      if (gesture.current?.active === true && event.cancelable) event.preventDefault();
    }
    row.addEventListener('touchmove', block, { passive: false });
    return () => row.removeEventListener('touchmove', block);
  }, []);

  useEffect(
    () => () => {
      const timer = gesture.current?.timer;
      if (timer !== null && timer !== undefined) window.clearTimeout(timer);
    },
    [],
  );

  function lift(g: Gesture): void {
    g.active = true;
    try {
      g.el.setPointerCapture(g.pointerId);
    } catch {
      // The pointer may already be gone; the drag simply ends on the next up.
    }
    setDrag({ from: g.from, dx: 0 });
  }

  function reset(): void {
    const g = gesture.current;
    if (g?.timer !== null && g?.timer !== undefined) window.clearTimeout(g.timer);
    gesture.current = null;
    setDrag(null);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLLIElement>, index: number): void {
    if (count < 2) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const touch = event.pointerType !== 'mouse';
    const g: Gesture = {
      pointerId: event.pointerId,
      from: index,
      startX: event.clientX,
      startY: event.clientY,
      touch,
      active: false,
      timer: null,
      el: event.currentTarget,
    };
    // Phone: a finger rests the one long-press duration before the tile lifts.
    if (touch) g.timer = window.setTimeout(() => lift(g), LONG_PRESS_MS);
    gesture.current = g;
  }

  function onPointerMove(event: ReactPointerEvent<HTMLLIElement>): void {
    const g = gesture.current;
    if (g === null || event.pointerId !== g.pointerId) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (!g.active) {
      if (g.touch) {
        // Moved before the hold landed: this is a scroll, not a drag.
        if (Math.hypot(dx, dy) > TOUCH_SLOP) reset();
        return;
      }
      if (Math.abs(dx) <= MOUSE_SLOP) return;
      lift(g);
    }
    event.preventDefault();
    setDrag({ from: g.from, dx: clampDrag(g.from, dx, TILE_SLOT, count) });
  }

  function onPointerUp(event: ReactPointerEvent<HTMLLIElement>): void {
    const g = gesture.current;
    if (g === null || event.pointerId !== g.pointerId) return;
    if (g.active && drag !== null) {
      justDragged.current = true;
      const to = dropIndex(g.from, drag.dx, TILE_SLOT, count);
      if (to !== g.from) onReorder(g.from, to);
    }
    reset();
  }

  function tap(index: number): void {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    onSelect(index);
  }

  const to = drag !== null ? dropIndex(drag.from, drag.dx, TILE_SLOT, count) : null;

  return (
    <ul
      ref={rowRef}
      data-file-tiles=""
      aria-label="Files"
      className="relative flex gap-2 overflow-x-auto overscroll-x-contain py-0.5"
    >
      {items.map((item, index) => {
        const dragging = drag !== null && drag.from === index;
        const dx =
          drag === null || to === null
            ? 0
            : dragging
              ? drag.dx
              : shiftFor(index, drag.from, to, TILE_SLOT);
        return (
          <li
            key={item.versionId}
            ref={tileRef(item.versionId)}
            data-tile-index={index}
            onPointerDown={(event) => onPointerDown(event, index)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={reset}
            onContextMenu={(event) => event.preventDefault()}
            style={dx !== 0 ? { transform: `translateX(${dx}px)` } : undefined}
            className={cn(
              'relative h-16 w-16 shrink-0 touch-pan-x select-none [-webkit-touch-callout:none]',
              dragging ? 'z-sticky cursor-grabbing lit-float' : 'mv-slide',
              count > 1 && !dragging && 'cursor-grab',
            )}
          >
            <PressableRow
              type="button"
              aria-label={`Show ${item.name}`}
              aria-current={index === activeIndex ? 'true' : undefined}
              onClick={() => tap(index)}
              className={cn(
                'block h-full overflow-hidden border bg-panel-3',
                tileEdge(index === activeIndex ? 'picked' : 'rest'),
              )}
            >
              <TilePicture src={item.previewUrl} video={item.mime?.startsWith('video/') === true} />
            </PressableRow>
            <RemoveButton label={`Remove ${item.name}`} onRemove={() => onRemove(index)} />
          </li>
        );
      })}
      {pending.map((tile) => (
        <li
          key={tile.id}
          ref={tileRef(tile.id)}
          data-pending-tile=""
          {...(tile.failed ? { 'data-failed': '' } : {})}
          aria-label={tile.failed ? `${tile.name} didn't upload` : `Uploading ${tile.name}`}
          className={cn(
            'relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border bg-panel-3 lit-media',
            tileEdge(tile.failed ? 'failed' : 'rest'),
          )}
        >
          {/* The dim is on the picture only (media); the state reads from the ring or Retry. */}
          <span className={cn('block h-full w-full', tile.failed ? 'opacity-40' : 'opacity-70')}>
            <TilePicture src={tile.previewUrl} video={tile.video} />
          </span>
          {/* Ring and Retry sit in one centred spot, so the tile never shifts. */}
          {tile.failed ? (
            <UploadRetry
              variant="file"
              onRetry={() => onRetryPending(tile.id)}
              className="absolute inset-0 m-auto"
            />
          ) : (
            <UploadRing
              variant="file"
              label="Cancel upload"
              progress={tile.progress}
              onCancel={() => onCancelPending(tile.id)}
              className="absolute inset-0 m-auto"
            />
          )}
        </li>
      ))}
    </ul>
  );
}
