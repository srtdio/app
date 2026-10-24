// The Plan list's day popover (laptop, agency, edit mode): the right-click
// menu at the pointer: the "Move to" list (each plan day and No date with its
// item count, the row's day marked) plus "Remove from plan" in the danger
// colour. A pick or Remove only queues an op (Save changes writes). Placed
// before paint (no jump), clamped inside the viewport, fixed width; no motion.
// It follows its row on list scroll and window resize, and closes once the row
// leaves the list's view. Escape (kept from the chat), Tab or a press outside
// closes it; Up/Down move between its items.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { IconTrash } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { MOVE_TO_HEADING, REMOVE_LABEL } from '@/lib/chat/plan-keyboard-move';
import { cn } from '@/lib/cn';

/** Where the popover opens, as placed: under a button (right-aligned to it) or at a point. */
export type PopoverPlace =
  | { kind: 'rect'; left: number; right: number; top: number; bottom: number }
  | { kind: 'point'; x: number; y: number };

/** What it follows: under `el`, or at `point` (offset from el's top-left, the right-click). */
export interface PopoverAnchor {
  el: HTMLElement;
  point: { dx: number; dy: number } | null;
}

/** The anchor's place now. */
function placeOf(anchor: PopoverAnchor): PopoverPlace {
  const r = anchor.el.getBoundingClientRect();
  return anchor.point === null
    ? { kind: 'rect', left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    : { kind: 'point', x: r.left + anchor.point.dx, y: r.top + anchor.point.dy };
}

/** Whether a row's box has left the list's visible box (either edge). Pure. */
export function outOfView(
  row: { top: number; bottom: number },
  view: { top: number; bottom: number },
): boolean {
  return row.bottom <= view.top || row.top >= view.bottom;
}

/** One day the popover offers. */
export interface PopoverDay {
  day: string | null;
  label: string;
  count: number;
}

/** The popover's fixed width (px) and its gap to the viewport edge. */
export const POPOVER_WIDTH = 240;
const EDGE = 8;

/**
 * The popover's top-left for its size and anchor, kept inside the viewport.
 * Under a button it never covers the button: below when it fits, else above,
 * else on the roomier side with its height capped there (it scrolls). Pure.
 */
export function placePopover(
  anchor: PopoverPlace,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; maxHeight: number | null } {
  const clampX = (x: number): number =>
    Math.max(EDGE, Math.min(x, viewport.width - size.width - EDGE));
  const clampY = (y: number): number =>
    Math.max(EDGE, Math.min(y, viewport.height - size.height - EDGE));
  if (anchor.kind === 'point') {
    return { left: clampX(anchor.x), top: clampY(anchor.y), maxHeight: null };
  }
  const left = clampX(anchor.right - size.width);
  const below = viewport.height - EDGE - (anchor.bottom + 4);
  const above = anchor.top - 4 - EDGE;
  if (size.height <= below) return { left, top: anchor.bottom + 4, maxHeight: null };
  if (size.height <= above) return { left, top: anchor.top - 4 - size.height, maxHeight: null };
  return below >= above
    ? { left, top: anchor.bottom + 4, maxHeight: below }
    : { left, top: EDGE, maxHeight: above };
}

export function PlanDayPopover(props: {
  anchor: PopoverAnchor;
  /** The list's scroll box: the row leaving it closes the popover. */
  bounds: HTMLElement | null;
  days: readonly PopoverDay[];
  current: string | null;
  /** The right-click menu: adds "Remove from plan". */
  withRemove: boolean;
  onPick: (day: string | null) => void;
  onRemove: () => void;
  onClose: () => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number | null } | null>(
    null,
  );
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const { anchor, bounds } = props;
  useLayoutEffect(() => {
    const place = (): void => {
      const el = ref.current;
      if (el === null) return;
      const row = anchor.el.closest<HTMLElement>('[data-plan-row-wrap]') ?? anchor.el;
      if (
        !anchor.el.isConnected ||
        (bounds !== null && outOfView(row.getBoundingClientRect(), bounds.getBoundingClientRect()))
      ) {
        onClose.current();
        return;
      }
      // The full content height (a cap set before must not hide it).
      setPos(
        placePopover(
          placeOf(anchor),
          { width: el.offsetWidth, height: el.scrollHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor, bounds]);
  useEffect(() => {
    // Escape hands focus back to where it was (the calendar button, the row),
    // and stops at the popover's edge so no chat surface also closes.
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    const current = el?.querySelector<HTMLElement>('[aria-current="true"]');
    (current ?? el?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus({
      preventScroll: true,
    });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      onClose.current();
      if (returnTo?.isConnected === true) returnTo.focus({ preventScroll: true });
    };
    const onDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target) === true) return;
      if (target instanceof Element && target.closest('[data-plan-row-day-chip]') !== null) return;
      onClose.current();
    };
    el?.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      el?.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Tab') {
      props.onClose();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };
  const item =
    'flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={MOVE_TO_HEADING}
      data-plan-day-popover={props.withRemove ? 'menu' : 'days'}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'fixed z-[45] flex max-h-[calc(100vh-16px)] flex-col gap-0.5 overflow-y-auto rounded-xl border border-border-strong bg-panel p-1.5 font-sans shadow-xl',
        pos === null && 'invisible',
        NO_TOUCH_SELECT,
      )}
      style={{
        width: POPOVER_WIDTH,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        ...(pos?.maxHeight != null ? { maxHeight: pos.maxHeight } : {}),
      }}
    >
      <p className="px-2.5 pb-1 pt-1.5 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
        {MOVE_TO_HEADING}
      </p>
      {props.days.map((d) => {
        const current = d.day === props.current;
        return (
          <button
            key={d.day ?? 'none'}
            type="button"
            role="menuitem"
            data-plan-popover-day={d.day ?? 'none'}
            {...(current ? { 'aria-current': 'true' as const } : {})}
            onClick={() => props.onPick(d.day)}
            className={cn(
              item,
              'hover:bg-panel-2',
              current ? 'font-medium text-accent' : 'font-medium text-fg',
            )}
          >
            <span className="truncate">{d.label}</span>
            <span className="shrink-0 font-mono text-xs text-fg-3">
              {d.count > 0 ? d.count : ''}
            </span>
          </button>
        );
      })}
      {props.withRemove ? (
        <>
          <hr className="mx-1.5 my-1 border-0 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            data-plan-popover-remove=""
            onClick={props.onRemove}
            className={cn(item, 'justify-start gap-2.5 font-medium text-bad hover:bg-bad-soft')}
          >
            <IconTrash size={16} />
            {REMOVE_LABEL}
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
