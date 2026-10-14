// The Plan list's laptop row pieces (md and up, agency only): the grip handle
// on a row's left (a mouse or a finger lifts the row after 4px of travel, no
// long-press), the calendar and dustbin buttons right of the text, the 3px
// drop line with its dot, the "Drop here" target of an empty day and the slim
// keyboard hint line. Tokens only; the lifted card moves on translateY only.

import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { IconCalendar, IconGrip, IconTrash } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import {
  CHANGE_DAY_LABEL,
  DROP_HERE,
  GRIP_LABEL,
  KEY_HINTS,
  REMOVE_LABEL,
} from '@/lib/chat/plan-keyboard-move';
import { cn } from '@/lib/cn';

/** Pointer travel (px) on the grip before the row lifts. */
export const GRIP_LIFT_PX = 4;

/**
 * The 28x44 drag handle. Shown on row hover and on keyboard focus within the
 * row (the row wrapper is the `group`); where nothing hovers (a touch laptop,
 * an iPad in landscape) it always shows, muted. Always laid out, so nothing
 * shifts.
 * Not a tab stop: the keyboard moves a row with Space on the row itself.
 */
export function PlanGrip(props: { onLift: (clientY: number) => void }): ReactElement {
  const stop = useRef<(() => void) | null>(null);
  const onLift = useRef(props.onLift);
  onLift.current = props.onLift;
  useEffect(() => () => stop.current?.(), []);
  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // No text selection, no focus change, no scroll start.
    event.preventDefault();
    stop.current?.();
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId || Math.abs(e.clientY - startY) < GRIP_LIFT_PX) return;
      stop.current?.();
      onLift.current(e.clientY);
    };
    const onEnd = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) stop.current?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    stop.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      stop.current = null;
    };
  };
  return (
    <span
      aria-hidden="true"
      title={GRIP_LABEL}
      data-plan-grip=""
      onPointerDown={onPointerDown}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'flex h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center self-start rounded-md text-fg-3 opacity-0 transition-opacity duration-fast hover:bg-panel-2 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-60',
        NO_TOUCH_SELECT,
      )}
    >
      <IconGrip size={16} />
    </span>
  );
}

/** The grip's place on a row that cannot be dragged (an out-of-range day). */
export function PlanGripSpacer(): ReactElement {
  return <span aria-hidden="true" className="h-11 w-7 shrink-0" />;
}

const ACTION_BUTTON =
  'flex h-11 w-9 shrink-0 items-center justify-center self-start rounded-md text-fg-3 hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * The always-visible calendar (opens the day popover) and dustbin (removes
 * with Undo) buttons: 36x44 each, side by side, muted.
 */
export function PlanRowButtons(props: {
  title: string;
  /** The day popover is open for this row. */
  calendarOpen: boolean;
  onCalendar: (anchor: HTMLElement) => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <span className={cn('flex shrink-0 items-start', NO_TOUCH_SELECT)}>
      <button
        type="button"
        aria-label={`${CHANGE_DAY_LABEL}: ${props.title}`}
        aria-haspopup="menu"
        aria-expanded={props.calendarOpen}
        title={CHANGE_DAY_LABEL}
        data-plan-row-calendar=""
        onClick={(event) => props.onCalendar(event.currentTarget)}
        className={ACTION_BUTTON}
      >
        <IconCalendar size={18} />
      </button>
      <button
        type="button"
        aria-label={`${REMOVE_LABEL}: ${props.title}`}
        title={REMOVE_LABEL}
        data-plan-row-bin=""
        onClick={props.onRemove}
        className={ACTION_BUTTON}
      >
        <IconTrash size={18} />
      </button>
    </span>
  );
}

/**
 * The landing spot: a 3px accent line with a dot at its left. Its negative
 * margins cancel the list's 16px gap, so showing it never moves a row.
 */
export function PlanDropLine(): ReactElement {
  return (
    <div
      aria-hidden="true"
      data-plan-drop-slot=""
      data-plan-drop-line=""
      className="pointer-events-none relative -my-[9.5px] h-[3px] shrink-0 rounded-full bg-accent"
    >
      <span className="absolute -left-1 -top-[3px] h-[9px] w-[9px] rounded-full bg-accent" />
    </div>
  );
}

/** An empty day while a row is lifted: "Drop here", 44px, the Add row's box. */
export function PlanDropHere(props: { over: boolean }): ReactElement {
  return (
    <div
      data-plan-drop-here=""
      {...(props.over ? { 'data-plan-drop-slot': '' } : {})}
      className={cn(
        'flex min-h-[44px] items-center justify-center rounded-lg border-[1.5px] border-dashed text-[13px]',
        props.over ? 'border-accent text-accent' : 'border-border-strong text-fg-3',
      )}
    >
      {DROP_HERE}
    </div>
  );
}

/** The slim hint line in the laptop footer (agency only). */
export function PlanKeyHints(): ReactElement {
  return (
    <p data-plan-key-hints="" className="text-xs leading-4 text-fg-3">
      {KEY_HINTS}
    </p>
  );
}
