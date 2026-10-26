// The create sheet's file row: one small tile per photo or video, each showing
// its own picture. A tile still uploading carries a thin progress bar; a failed
// one is outlined in the bad colour. Finished tiles reorder by drag on laptop
// and hold-and-drag on phone (pointer events): the dragged tile moves on the X
// axis only, inside the row, with no rotation, and the others shift with
// transform. Tapping a tile shows it in the frame.

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import type { AttachmentItem } from '@/components/pages/create/AttachmentsField';
import { RemoveButton } from '@/components/pages/create/RemoveButton';
import { clampDrag, dropIndex, shiftFor } from '@/components/pages/create/reorder';
import { PressableRow } from '@/components/ui/PressableRow';
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
}: {
  /** Finished photos and videos, in saved order. */
  items: readonly AttachmentItem[];
  pending: readonly PendingTile[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onRemove: (index: number) => void;
  onReorder: (from: number, to: number) => void;
}): ReactElement {
  const [drag, setDrag] = useState<{ from: number; dx: number } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  // A drag that just ended must not also count as a tap on the tile.
  const justDragged = useRef(false);
  const rowRef = useRef<HTMLUListElement>(null);
  const count = items.length;

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
            data-tile-index={index}
            onPointerDown={(event) => onPointerDown(event, index)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={reset}
            onContextMenu={(event) => event.preventDefault()}
            style={dx !== 0 ? { transform: `translateX(${dx}px)` } : undefined}
            className={cn(
              'relative h-16 w-16 shrink-0 touch-pan-x select-none [-webkit-touch-callout:none]',
              dragging
                ? 'z-20 cursor-grabbing shadow-lg'
                : 'transition-transform duration-fast motion-reduce:transition-none',
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
                index === activeIndex ? 'border-accent ring-2 ring-accent-soft' : 'border-border',
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
          data-pending-tile=""
          {...(tile.failed ? { 'data-failed': '' } : {})}
          aria-label={tile.failed ? `${tile.name} didn't upload` : `Uploading ${tile.name}`}
          className={cn(
            'relative h-16 w-16 shrink-0 overflow-hidden rounded-md border bg-panel-3',
            tile.failed ? 'border-bad' : 'border-border',
          )}
        >
          <span className={cn('block h-full w-full', tile.failed ? 'opacity-40' : 'opacity-70')}>
            <TilePicture src={tile.previewUrl} video={tile.video} />
          </span>
          {tile.failed ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 flex items-center justify-center text-lg font-semibold text-bad"
            >
              !
            </span>
          ) : (
            <span
              role="progressbar"
              aria-label={`Uploading ${tile.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(tile.progress * 100)}
              className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full bg-panel"
            >
              <span
                className="block h-full rounded-full bg-accent transition-[width] duration-fast ease-enter motion-reduce:transition-none"
                style={{ width: `${Math.max(tile.progress, 0.04) * 100}%` }}
              />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
