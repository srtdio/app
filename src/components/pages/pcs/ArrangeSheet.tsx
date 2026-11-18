// The post's Arrange sheet (18 Nov 2026): every picture in one numbered grid.
// Drag a picture to change the order; drop it on Remove to take it off the
// post. Nothing is saved until Done: one gallery write for the whole change
// (the order and the removals), so one new version. The sheet owns no write
// path; Done hands the remaining order to the page's one gallery commit.
//
// Phone: opened by holding a picture or the Arrange tool. Laptop: right-click
// a picture or the Arrange tool; the mouse drags the same way. The keyboard
// moves a focused picture with the arrow keys and removes it with Delete.
//
// Motion: the lifted picture follows the pointer directly (translate only, no
// rotation, no scale); nothing else animates, so Reduce Motion needs no case.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { ICON_SIZE, IconTrash } from '@/components/ui/icons';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet, SheetActions } from '@/components/ui/Sheet';
import { textRole } from '@/components/ui/Text';
import { cn } from '@/lib/cn';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { moveTo } from '@/components/pages/pcs/gallery-transforms';
import type { GalleryItem } from '@srtdio/posts';

export const ARRANGE_TITLE = 'Arrange';
export const ARRANGE_HELPER = 'Drag to change the order. Drop on Remove to delete.';
export const ARRANGE_DISCARD = {
  title: 'Discard changes?',
  message: 'The order and removed pictures will go back to how they were.',
};

/** Grid columns: three on a phone, four from the laptop width. */
export const ARRANGE_COLUMNS_PHONE = 3;
export const ARRANGE_COLUMNS_LAPTOP = 4;
/** The grid's gap-2, in px (one spacing step). */
export const ARRANGE_GAP_PX = 8;

/** One cell's box and the grid it sits in, for the drag's hit test. */
export interface ArrangeGrid {
  columns: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
  count: number;
}

/**
 * The slot under a point inside the grid (x, y from the grid's top-left),
 * clamped to the grid's cells. Pure.
 */
export function arrangeIndexAt(x: number, y: number, grid: ArrangeGrid): number {
  if (grid.count <= 0) return 0;
  const column = Math.min(
    Math.max(Math.floor(x / (grid.cellWidth + grid.gap)), 0),
    grid.columns - 1,
  );
  const row = Math.max(Math.floor(y / (grid.cellHeight + grid.gap)), 0);
  return Math.min(Math.max(row * grid.columns + column, 0), grid.count - 1);
}

/** A slot's top-left inside the grid. Pure. */
export function arrangeSlotOrigin(index: number, grid: ArrangeGrid): { x: number; y: number } {
  return {
    x: (index % grid.columns) * (grid.cellWidth + grid.gap),
    y: Math.floor(index / grid.columns) * (grid.cellHeight + grid.gap),
  };
}

/** True when the kept order differs from the saved one (moved or removed). Pure. */
export function arrangeChanged(saved: readonly string[], kept: readonly string[]): boolean {
  return saved.length !== kept.length || saved.some((id, index) => kept[index] !== id);
}

interface ArrangeSheetProps {
  open: boolean;
  onClose: () => void;
  /** The post's pictures in their saved order. */
  items: readonly GalleryItem[];
  /** One tile's picture (the gallery's own thumbnail, cropped to the cell). */
  renderThumb: (item: GalleryItem) => ReactNode;
  /**
   * Done with a change: the kept pictures' version ids in their new order.
   * Resolves true when the one gallery write succeeded.
   */
  onSave: (assetVersionIds: string[]) => Promise<boolean>;
  /** The inline line from a refused save, or null. */
  error: string | null;
}

interface DragState {
  id: string;
  /** Where inside the tile the pointer took hold. */
  offsetX: number;
  offsetY: number;
  /** The pointer, from the grid's top-left. */
  x: number;
  y: number;
  /** The pointer is over Remove. */
  overBin: boolean;
}

export function ArrangeSheet({
  open,
  onClose,
  items,
  renderThumb,
  onSave,
  error,
}: ArrangeSheetProps) {
  const isLaptop = useIsLaptop();
  const columns = isLaptop ? ARRANGE_COLUMNS_LAPTOP : ARRANGE_COLUMNS_PHONE;
  // The order on show (attachment ids) and the last removal, for Undo.
  const [order, setOrder] = useState<string[]>([]);
  const [lastRemoved, setLastRemoved] = useState<{ id: string; index: number } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // While a picture is lifted the others make room through CSS order only: the
  // tiles keep their place in the DOM, so the lifted one never loses the pointer.
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const binRef = useRef<HTMLDivElement>(null);
  const tileEls = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);

  // Each opening starts from the saved order.
  const savedKey = items.map((item) => item.assetAttachmentId).join('|');
  useEffect(() => {
    if (!open) return;
    setOrder(savedKey === '' ? [] : savedKey.split('|'));
    setLastRemoved(null);
    setDrag(null);
    setLiveOrder(null);
  }, [open, savedKey]);

  useEffect(() => {
    const id = focusAfterMove.current;
    if (id === null) return;
    focusAfterMove.current = null;
    tileEls.current.get(id)?.focus();
  }, [order]);

  // While a picture is lifted the sheet's own touch scroll is held, so the
  // finger drags the picture (a non-passive listener; React's are passive).
  const dragging = drag !== null;
  useEffect(() => {
    const el = gridRef.current;
    if (!dragging || el === null) return;
    const hold = (event: TouchEvent): void => {
      if (event.cancelable) event.preventDefault();
    };
    el.addEventListener('touchmove', hold, { passive: false });
    return () => el.removeEventListener('touchmove', hold);
  }, [dragging]);

  const byId = new Map(items.map((item) => [item.assetAttachmentId, item]));
  const shown = order
    .map((id) => byId.get(id))
    .filter((item): item is GalleryItem => item !== undefined);
  const saved = items.map((item) => item.assetAttachmentId);
  const changed = arrangeChanged(
    saved,
    shown.map((item) => item.assetAttachmentId),
  );

  const measure = (): { grid: ArrangeGrid; left: number; top: number } | null => {
    const el = gridRef.current;
    if (el === null) return null;
    const box = el.getBoundingClientRect();
    const cellWidth = (box.width - ARRANGE_GAP_PX * (columns - 1)) / columns;
    return {
      grid: {
        columns,
        cellWidth,
        // Cells are 4:5, the post picture's own default shape.
        cellHeight: cellWidth * 1.25,
        gap: ARRANGE_GAP_PX,
        count: shown.length,
      },
      left: box.left,
      top: box.top,
    };
  };

  const overBin = (clientX: number, clientY: number): boolean => {
    const box = binRef.current?.getBoundingClientRect();
    if (box === undefined) return false;
    return (
      clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom
    );
  };

  const remove = (id: string): void => {
    const index = order.indexOf(id);
    if (index < 0) return;
    setLastRemoved({ id, index });
    setOrder(order.filter((entry) => entry !== id));
  };

  const onTileDown = (id: string, event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (saving || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const metrics = measure();
    if (metrics === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer already ended; the release below still runs.
    }
    setLiveOrder(order);
    setDrag({
      id,
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
      x: event.clientX - metrics.left,
      y: event.clientY - metrics.top,
      overBin: false,
    });
  };

  const onTileMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (drag === null) return;
    const metrics = measure();
    if (metrics === null) return;
    const x = event.clientX - metrics.left;
    const y = event.clientY - metrics.top;
    const bin = overBin(event.clientX, event.clientY);
    setDrag({ ...drag, x, y, overBin: bin });
    if (bin) return;
    const live = liveOrder ?? order;
    const from = live.indexOf(drag.id);
    const to = arrangeIndexAt(x, y, metrics.grid);
    if (from >= 0 && to !== from) setLiveOrder(moveTo(live, from, to));
  };

  const onTileUp = (): void => {
    if (drag === null) return;
    const { id, overBin: dropOnBin } = drag;
    const live = liveOrder;
    setDrag(null);
    setLiveOrder(null);
    if (dropOnBin) remove(id);
    else if (live !== null) setOrder(live);
  };
  const onTileCancel = (): void => {
    setDrag(null);
    setLiveOrder(null);
  };

  const onTileKey = (id: string, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (saving) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(id);
      return;
    }
    const delta =
      event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp'
            ? -columns
            : event.key === 'ArrowDown'
              ? columns
              : 0;
    if (delta === 0) return;
    event.preventDefault();
    const from = order.indexOf(id);
    const to = Math.min(Math.max(from + delta, 0), order.length - 1);
    if (from < 0 || to === from) return;
    focusAfterMove.current = id;
    setOrder(moveTo(order, from, to));
  };

  const done = (): void => {
    if (!changed) {
      onClose();
      return;
    }
    setSaving(true);
    void onSave(shown.map((item) => item.assetVersionId))
      .then((ok) => {
        if (ok) onClose();
      })
      .finally(() => setSaving(false));
  };

  const metrics = drag !== null ? measure() : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={ARRANGE_TITLE}
      dirty={changed}
      discard={ARRANGE_DISCARD}
      busy={saving}
      footer={
        <SheetActions
          primary={
            <Button
              type="button"
              variant="primary"
              busy={saving}
              onClick={done}
              data-arrange-done=""
            >
              Done
            </Button>
          }
        />
      }
    >
      <div data-arrange="" className="flex flex-col gap-4">
        <div className="flex min-h-11 items-start gap-2">
          <p data-arrange-helper="" className={textRole('body', 'min-w-0 flex-1 text-fg-2')}>
            {ARRANGE_HELPER}
          </p>
          {lastRemoved !== null ? (
            <Button
              type="button"
              variant="ghost"
              data-arrange-undo=""
              disabled={saving}
              onClick={() => {
                const at = Math.min(lastRemoved.index, order.length);
                setOrder([...order.slice(0, at), lastRemoved.id, ...order.slice(at)]);
                setLastRemoved(null);
              }}
            >
              Undo
            </Button>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <p data-arrange-none="" className={textRole('secondary', 'text-fg-3')}>
            Pictures show up here.
          </p>
        ) : (
          <div
            ref={gridRef}
            role="list"
            data-arrange-grid=""
            className={cn(
              'grid select-none gap-2 [-webkit-touch-callout:none]',
              isLaptop ? 'grid-cols-4' : 'grid-cols-3',
            )}
          >
            {shown.map((item, domIndex) => {
              const id = item.assetAttachmentId;
              const liveIndex = liveOrder !== null ? liveOrder.indexOf(id) : -1;
              const index = liveIndex >= 0 ? liveIndex : domIndex;
              const lifted = drag !== null && drag.id === id;
              const origin =
                lifted && metrics !== null ? arrangeSlotOrigin(index, metrics.grid) : null;
              return (
                <div
                  key={id}
                  role="listitem"
                  style={liveOrder !== null ? { order: index } : undefined}
                  className={cn('relative', lifted && 'z-raised')}
                >
                  <PressableRow
                    type="button"
                    buttonRef={(el) => {
                      if (el === null) tileEls.current.delete(id);
                      else tileEls.current.set(id, el);
                    }}
                    data-arrange-tile=""
                    {...(lifted ? { 'data-arrange-lifted': '' } : {})}
                    aria-label={`Picture ${index + 1} of ${shown.length}. Arrow keys move it. Delete removes it.`}
                    onKeyDown={(event) => onTileKey(id, event)}
                    onPointerDown={(event) => onTileDown(id, event)}
                    onPointerMove={onTileMove}
                    onPointerUp={onTileUp}
                    onPointerCancel={onTileCancel}
                    onContextMenu={(event) => event.preventDefault()}
                    // The picture inside must never start the browser's own image
                    // drag: that cancels the pointer and drops the lift.
                    onDragStart={(event) => event.preventDefault()}
                    style={
                      lifted && origin !== null && drag !== null
                        ? {
                            transform: `translate(${drag.x - drag.offsetX - origin.x}px, ${
                              drag.y - drag.offsetY - origin.y
                            }px)`,
                          }
                        : undefined
                    }
                    className={cn(
                      'relative flex aspect-[4/5] w-full cursor-grab touch-none items-center justify-center overflow-hidden rounded-lg border bg-panel-2 [&_img]:pointer-events-none',
                      lifted ? 'cursor-grabbing lit-float' : 'border-border',
                      lifted && (drag?.overBin === true ? 'lit-bad' : 'lit-selected'),
                    )}
                  >
                    {renderThumb(item)}
                    <span className="pointer-events-none absolute left-1 top-1 rounded bg-overlay px-1 text-xs font-medium tabular-nums text-overlay-fg lit-media">
                      {index + 1}
                    </span>
                  </PressableRow>
                </div>
              );
            })}
          </div>
        )}
        <div
          ref={binRef}
          data-arrange-bin=""
          {...(drag?.overBin === true ? { 'data-arrange-bin-hot': '' } : {})}
          aria-hidden="true"
          className={cn(
            'flex h-11 items-center justify-center gap-2 rounded-lg border',
            textRole('label'),
            drag === null
              ? 'border-border text-fg-3'
              : drag.overBin
                ? 'text-bad lit-bad'
                : 'border-border-strong text-fg',
          )}
        >
          <IconTrash size={ICON_SIZE.inline} />
          Remove
        </div>
        {error !== null ? (
          <p role="alert" data-arrange-error="" className={textRole('body', 'text-bad')}>
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
