// The Plan list's day popover (laptop, agency): the calendar button's
// "Move to" list (each plan day and No date with its item count, the row's
// day marked) anchored under the button, and the right-click menu (the same
// list plus "Remove from plan" in the danger colour) at the pointer. Placed
// before paint (no jump), clamped inside the viewport, fixed width; no motion.
// Escape, Tab or a press outside closes it; Up/Down move between its items.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { IconTrash } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { MOVE_TO_HEADING, REMOVE_LABEL } from '@/lib/chat/plan-keyboard-move';
import { cn } from '@/lib/cn';

/** Where the popover opens: under a button (right-aligned to it) or at a point. */
export type PopoverAnchor =
  | { kind: 'rect'; left: number; right: number; top: number; bottom: number }
  | { kind: 'point'; x: number; y: number };

/** One day the popover offers. */
export interface PopoverDay {
  day: string | null;
  label: string;
  count: number;
}

/** The popover's fixed width (px) and its gap to the viewport edge. */
export const POPOVER_WIDTH = 240;
const EDGE = 8;

/** The popover's top-left for its size and anchor, kept inside the viewport. Pure. */
export function placePopover(
  anchor: PopoverAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const clampX = (x: number): number =>
    Math.max(EDGE, Math.min(x, viewport.width - size.width - EDGE));
  const clampY = (y: number): number =>
    Math.max(EDGE, Math.min(y, viewport.height - size.height - EDGE));
  if (anchor.kind === 'point') return { left: clampX(anchor.x), top: clampY(anchor.y) };
  const below = anchor.bottom + 4;
  const top = below + size.height <= viewport.height - EDGE ? below : anchor.top - 4 - size.height;
  return { left: clampX(anchor.right - size.width), top: clampY(top) };
}

export function PlanDayPopover(props: {
  anchor: PopoverAnchor;
  days: readonly PopoverDay[];
  current: string | null;
  /** The right-click menu: adds "Remove from plan". */
  withRemove: boolean;
  onPick: (day: string | null) => void;
  onRemove: () => void;
  onClose: () => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  const { anchor } = props;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const box = el.getBoundingClientRect();
    setPos(
      placePopover(
        anchor,
        { width: box.width, height: box.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);
  useEffect(() => {
    // Escape hands focus back to where it was (the calendar button, the row).
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    const current = el?.querySelector<HTMLElement>('[aria-current="true"]');
    (current ?? el?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus({
      preventScroll: true,
    });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      onClose.current();
      if (returnTo?.isConnected === true) returnTo.focus({ preventScroll: true });
    };
    const onDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target) === true) return;
      if (target instanceof Element && target.closest('[data-plan-row-calendar]') !== null) return;
      onClose.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
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
    'flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
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
      style={{ width: POPOVER_WIDTH, left: pos?.left ?? 0, top: pos?.top ?? 0 }}
    >
      <p className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[.06em] text-fg-3">
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
              current ? 'font-semibold text-accent' : 'font-medium text-fg',
            )}
          >
            <span className="truncate">{d.label}</span>
            <span className="shrink-0 font-mono text-[11px] text-fg-3">
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
            <IconTrash size={18} />
            {REMOVE_LABEL}
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
