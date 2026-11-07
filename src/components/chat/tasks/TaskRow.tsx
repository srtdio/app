// One task row of the shared list, and the priority chip with its menu.
// Row: tick box (to do / done), title (tap to edit in place: Enter or blur
// keeps, Esc cancels, empty keeps the old title), priority chip. Under the
// title, only when there is something to say, a date line ("Overdue 2 days" in
// the bad tone, "Due in 3 days", "Due 31 Oct · done 6 days ago"). Every change is
// local to the page's draft until Save. A row may carry an accent dot (changed
// by someone else since you looked, or your own unsaved change), its changed
// chip ringed, and sub-lines: what it was ("was <s>old</s>", "priority was
// <s>P2</s>", "marked done", "reopened", "New task", "date was <s>3 Nov</s>"),
// or a both-edited notice with Keep mine / Keep theirs (or "deleted this" with
// Restore mine / OK). 44px targets everywhere.
//
// The row's menu (ui/ActionMenu: a sheet on a phone, a popover on laptop)
// opens on a long-press of the title on touch, a right-click or Shift+F10 on
// laptop (useMenuGesture): Today, Tomorrow, Pick a date, No date (when it has
// one), Delete last. The trailing click of a long-press is swallowed so it
// never also starts an edit.
//
// Delete is also one gesture away: on touch the row swipes left (the
// swipe-to-reply core mirrored, src/lib/chat/swipe-reply.ts) and a bin shows
// behind its right edge, bad at rest, ink-filled once armed; released past the
// trigger (or flicked) the row is queued for Save, struck, with Undo. On
// laptop (useIsLaptop) a bin button sits at the end of every row instead. The
// row follows the finger on X and springs home (lib/motion paintSwipe).
//
// The chip's menu (P0 Urgent, P1 High, P2 Normal, current ticked) renders in a
// portal layer above the page, never clipped by the scrolling list: below the
// chip, flipped above when space below is short, clamped on screen. A scroll
// of the list, a tap outside or Esc closes it. Motion (docs/motion.md): the
// menu grows from its chip; the row glides when rows above it come or go;
// Mark checked draws the tick (drawTick). Never a fade.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import {
  ICON_SIZE,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconMinus,
  IconTrash,
} from '@/components/ui/icons';
import { cancelPendingLongPressesWithin, useMenuGesture } from '@/components/ui/useLongPress';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { STATUS_LABEL, TaskGlyph } from '@/components/chat/tasks/TaskGlyph';
import { Highlight } from '@/components/ui/SearchHighlight';
import { cn } from '@/lib/cn';
import { useDismissLayer } from '@/lib/modal-focus';
import { useIsLaptop, usePrefersReducedMotion, viewportSize } from '@/lib/use-is-laptop';
import { centreOf, menuOrigin } from '@/components/ui/popover-classes';
import { drawTick, GlideItem, growFromTrigger, paintSwipe } from '@/lib/motion';
import { createSwipeReplyController, type SwipeReplyController } from '@/lib/chat/swipe-reply';
import {
  PRIORITY_LABEL,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  dueDayValue,
  markText,
  type TaskMark,
  type TaskPriority,
} from '@/lib/chat/tasks';
import type { DayChoice, TaskDateLine } from '@/lib/chat/task-when';

const NOT_SAVED = 'Not saved';
export const PICK_DATE_LABEL = 'Pick a date';
export const DELETE_LABEL = 'Delete';

const P_TAG: Record<TaskPriority, string> = {
  0: 'bg-bad-soft text-bad',
  1: 'bg-warn-soft text-stage-review',
  2: 'bg-panel-3 text-fg-2',
};

/** The menu's width (px) and one item's height, for placing it before it paints. */
const MENU_W = 168;
const MENU_ITEM_H = 44;
const MENU_PAD = 4;
const EDGE = 8;

/** Where the menu goes for a chip at `rect` in a viewport of `vw` x `vh`. Pure. */
function placeMenu(
  rect: { top: number; bottom: number; left: number; right: number },
  vw: number,
  vh: number,
): { top: number; left: number; above: boolean } {
  const height = TASK_PRIORITIES.length * MENU_ITEM_H + MENU_PAD * 2;
  const below = vh - rect.bottom - EDGE;
  const above = below < height + 4 && rect.top - EDGE > below;
  const top = above
    ? Math.max(EDGE, rect.top - 4 - height)
    : Math.min(rect.bottom + 4, Math.max(EDGE, vh - EDGE - height));
  const left = Math.min(Math.max(EDGE, rect.right - MENU_W), Math.max(EDGE, vw - EDGE - MENU_W));
  return { top, left, above };
}

/** Shift+F10 or the ContextMenu key opens a focused row's menu. Pure. */
export function rowMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

/** The P0..P2 chip; with onPick it opens the priority menu. */
export function PriorityChip(props: {
  priority: TaskPriority;
  /** Ringed: someone changed it, or it is your unsaved change. */
  ringed?: boolean;
  onPick?: (p: TaskPriority) => void;
  label?: string;
  disabled?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const pick = props.onPick;
  const chip = (
    <span
      data-task-p={props.priority}
      className={cn(
        // B1: the picker is a 44 control; the read-only tag stays 24.
        pick !== undefined
          ? 'inline-flex min-h-11 items-center gap-1 rounded-lg px-3 font-mono text-sm lit-pill'
          : 'inline-flex h-6 items-center gap-0.5 rounded-sm px-2 font-mono text-sm lit-badge',
        P_TAG[props.priority],
        props.ringed === true && 'lit-today',
      )}
    >
      P{props.priority}
      {pick !== undefined ? <IconChevronDown size={ICON_SIZE.inline} /> : null}
    </span>
  );
  if (pick === undefined) return chip;
  return (
    <>
      <PressableRow
        inline
        align="center"
        buttonRef={chipRef}
        type="button"
        data-task-chip=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label ?? `Priority P${props.priority} ${PRIORITY_LABEL[props.priority]}`}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => e.preventDefault()}
        className={cn('flex min-w-11 shrink-0 items-center justify-center', NO_TOUCH_SELECT)}
      >
        {chip}
      </PressableRow>
      {open ? (
        <PriorityMenu
          anchor={chipRef}
          current={props.priority}
          onPick={(p) => {
            setOpen(false);
            pick(p);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function PriorityMenu(props: {
  anchor: RefObject<HTMLButtonElement | null>;
  current: TaskPriority;
  onPick: (p: TaskPriority) => void;
  onClose: () => void;
}): ReactElement | null {
  const { anchor, onClose } = props;
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = anchor.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const viewport = viewportSize();
    setPos(placeMenu(r, viewport.width, viewport.height));
  }, [anchor]);
  // Placed: grow from the chip on the first painted frame (never a fade).
  const placed = pos !== null;
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!placed || menu === null) return;
    growFromTrigger(menu, menuOrigin(menu, centreOf(anchor.current)));
  }, [placed, anchor]);
  // Escape closes it (top layer only) and focus goes back to the chip that opened it.
  useDismissLayer(true, onClose, menuRef);
  // A scroll anywhere under the page (the list) or a resize closes it; a tap outside too.
  useEffect(() => {
    const onScroll = (e: Event): void => {
      if (
        menuRef.current !== null &&
        e.target instanceof Node &&
        menuRef.current.contains(e.target)
      ) {
        return;
      }
      onClose();
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (menuRef.current?.contains(t) === true || anchor.current?.contains(t) === true) return;
      onClose();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [anchor, onClose]);
  if (pos === null) return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Priority"
      data-task-menu=""
      style={{ top: pos.top, left: pos.left, width: MENU_W }}
      className="fixed z-dialog rounded-xl border bg-panel p-1 lit-overlay"
    >
      {TASK_PRIORITIES.map((p) => (
        <PressableRow
          insetFocus
          key={p}
          type="button"
          role="menuitemradio"
          aria-checked={p === props.current}
          data-task-menu-p={p}
          onClick={() => props.onPick(p)}
          onContextMenu={(e) => e.preventDefault()}
          className={cn('flex h-11 items-center gap-2 px-3 text-base text-fg', NO_TOUCH_SELECT)}
        >
          <span className={cn('rounded-lg px-1.5 font-mono text-sm', P_TAG[p])}>P{p}</span>
          <span className="flex-1">{PRIORITY_LABEL[p]}</span>
          {p === props.current ? (
            <IconCheck size={ICON_SIZE.inline} className="text-accent" />
          ) : null}
        </PressableRow>
      ))}
    </div>,
    document.body,
  );
}

/** The inline failure line: "Not saved · Retry" (44px Retry). */
export function NotSaved(props: { onRetry: () => void; message?: string }): ReactElement {
  return (
    <div data-task-not-saved="" className="flex items-center gap-1 pl-13 pr-3 text-md">
      <span className="text-bad">{props.message ?? NOT_SAVED} ·</span>
      <Button
        type="button"
        variant="ghost"
        onClick={props.onRetry}
        onContextMenu={(e) => e.preventDefault()}
        className={cn('min-w-11 text-bad hover:text-bad', NO_TOUCH_SELECT)}
      >
        Retry
      </Button>
    </div>
  );
}

/**
 * A title that turns into an input in the tap (so iOS opens the keyboard),
 * cursor at the end. Holding it (or a right-click, or Shift+F10) opens the
 * row's menu instead, and the click that trails the hold never starts an edit.
 */
function TitleCell(props: {
  title: string;
  done: boolean;
  dateLine: TaskDateLine | null;
  dot: boolean;
  onCommit: (title: string) => void;
  onMenu: (() => void) | null;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const onMenu = props.onMenu;
  const gesture = useMenuGesture(() => onMenu?.());
  const begin = (): void => {
    if (gesture.consumeClickSuppression()) return;
    cancelled.current = false;
    setValue(props.title);
    setEditing(true);
  };
  // Focus inside the same tap: the input mounts synchronously on this render.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!editing || el === null) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [editing]);
  const commit = (): void => {
    setEditing(false);
    if (cancelled.current) return;
    const next = value.trim();
    if (next !== '' && next !== props.title) props.onCommit(next);
  };
  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        aria-label="Task title"
        data-task-title-input=""
        value={value}
        maxLength={TASK_TITLE_MAX}
        enterKeyHint="done"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancelled.current = true;
            inputRef.current?.blur();
          }
        }}
        className="min-h-11 min-w-0 flex-1 bg-transparent text-input font-medium text-fg focus:outline-none md:text-base"
      />
    );
  }
  return (
    <PressableRow
      insetFocus
      type="button"
      data-task-title=""
      onClick={begin}
      {...(onMenu !== null
        ? gesture.handlers
        : { onContextMenu: (e: MouseEvent<HTMLButtonElement>) => e.preventDefault() })}
      onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
        if (onMenu === null || !rowMenuKey(e)) return;
        e.preventDefault();
        onMenu();
      }}
      className={cn('flex min-w-0 flex-1 flex-col items-start py-3', NO_TOUCH_SELECT)}
    >
      <span
        className={cn('text-base font-medium', props.done ? 'text-fg-3 line-through' : 'text-fg')}
      >
        {props.dot ? (
          <span
            aria-hidden="true"
            data-task-dot=""
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle"
          />
        ) : null}
        <Highlight text={props.title} />
      </span>
      {props.dateLine !== null ? (
        <span
          data-task-when=""
          className={cn(
            'mt-0.5 font-mono text-sm tabular-nums',
            props.dateLine.bad ? 'text-bad' : 'text-fg-3',
          )}
        >
          {props.dateLine.text}
        </span>
      ) : null}
    </PressableRow>
  );
}

/** A both-edited notice and its two answers. */
export interface RowNotice {
  text: string;
  deleted: boolean;
  onMine: () => void;
  onTheirs: () => void;
}

/** The row's menu: the quick days, Pick a date, No date when dated, Delete. */
export interface RowMenu {
  choices: readonly DayChoice[];
  hasDate: boolean;
  onDay: (dueOn: string | null) => void;
  onPickDate: () => void;
}

export interface TaskRowProps {
  id: string;
  title: string;
  done: boolean;
  priority: TaskPriority;
  /** The accent dot: changed by someone else since you looked, or your own unsaved change. */
  dot: boolean;
  /** What changed (someone else's Save); empty for none. */
  marks: readonly TaskMark[];
  /** Queued for delete by this Save: struck, with Undo. */
  queuedDelete: boolean;
  /** A new task not saved yet has no tick (it is created to do). */
  canTick?: boolean;
  notice: RowNotice | null;
  /** The date line under the title (src/lib/chat/task-when.ts rowDateLine); null: none. */
  dateLine?: TaskDateLine | null;
  /** The row's long-press / right-click menu; absent for a row that has none. */
  menu?: RowMenu;
  failed?: ReactNode;
  onToggle: () => void;
  onTitle: (title: string) => void;
  onPriority: (p: TaskPriority) => void;
  onDelete: () => void;
  onUndoDelete: () => void;
}

const ACTION = cn('min-w-11 shrink-0', NO_TOUCH_SELECT);

function MarkLine(props: { mark: TaskMark }): ReactElement {
  const { mark } = props;
  if (mark.kind === 'renamed') {
    return (
      <span>
        was <s>{mark.was}</s>
      </span>
    );
  }
  if (mark.kind === 'priority') {
    return (
      <span>
        priority was <s className="font-mono">P{mark.was}</s>
      </span>
    );
  }
  if (mark.kind === 'due' && mark.was !== null) {
    return (
      <span>
        date was <s className="font-mono tabular-nums">{dueDayValue(mark.was)}</s>
      </span>
    );
  }
  return <span>{markText(mark)}</span>;
}

/** The row menu's items in ActionMenu order (Delete sorts last). Pure. */
export function rowMenuItems(menu: RowMenu, onDelete: () => void): ActionMenuItem[] {
  const days: ActionMenuItem[] = menu.choices
    .filter((c) => c.dueOn !== null)
    .map((c) => ({
      id: `day-${c.key}`,
      label: c.label,
      icon: IconCalendar,
      onSelect: () => menu.onDay(c.dueOn),
    }));
  const items: ActionMenuItem[] = [
    ...days,
    { id: 'pick-date', label: PICK_DATE_LABEL, icon: IconCalendar, onSelect: menu.onPickDate },
  ];
  if (menu.hasDate) {
    items.push({
      id: 'no-date',
      label: 'No date',
      icon: IconMinus,
      onSelect: () => menu.onDay(null),
    });
  }
  items.push({
    id: 'delete',
    label: DELETE_LABEL,
    icon: IconTrash,
    tone: 'danger',
    onSelect: onDelete,
  });
  return items;
}

/**
 * The bin behind a row's right edge, revealed as the row slides left. 32px
 * circle, bad ink on the panel at rest, ink-filled when armed (data-armed).
 * Scale and opacity are painted per frame by paintSwipe; at rest the classes
 * hold it at scale 0, opacity 0.
 */
function SwipeDeleteIcon(props: { iconRef: RefObject<HTMLSpanElement> }): ReactElement {
  return (
    <span
      ref={props.iconRef}
      aria-hidden="true"
      data-task-swipe-icon=""
      className="pointer-events-none absolute inset-y-0 right-2 my-auto flex h-8 w-8 scale-0 items-center justify-center rounded-full bg-panel-3 text-bad opacity-0 data-[armed]:bg-accent data-[armed]:text-accent-fg"
    >
      <IconTrash size={ICON_SIZE.nav} />
    </span>
  );
}

/**
 * The row's swipe to delete: touch and pen only (the core ignores a mouse),
 * off while the row is already queued. The trailing click is swallowed so a
 * swipe never also ticks, edits or opens the chip.
 */
function useSwipeDelete(args: {
  sliderRef: RefObject<HTMLDivElement>;
  iconRef: RefObject<HTMLSpanElement>;
  enabled: boolean;
  onDelete: () => void;
}): {
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: () => void;
  };
  onClickCapture: (e: MouseEvent<HTMLDivElement>) => void;
} {
  const latest = useRef(args);
  latest.current = args;
  const reducedMotion = usePrefersReducedMotion();
  const reduced = useRef(reducedMotion);
  reduced.current = reducedMotion;
  const ref = useRef<SwipeReplyController | null>(null);
  const { sliderRef, iconRef } = args;
  if (ref.current === null) {
    ref.current = createSwipeReplyController({
      direction: 'left',
      onReply: () => latest.current.onDelete(),
      onFrame: (frame) => paintSwipe(sliderRef.current, iconRef.current, frame, 'left'),
      onStart: (pointerId) => {
        // A swipe never opens the menu: end the title's hold (it would fire at
        // 10px; the swipe locks at 8px) and keep the pointer on the row.
        if (sliderRef.current !== null) cancelPendingLongPressesWithin(sliderRef.current);
        if (pointerId === undefined) return;
        try {
          sliderRef.current?.setPointerCapture(pointerId);
        } catch {
          // The pointer is already gone; the gesture ends on its own.
        }
      },
      enabled: () => latest.current.enabled,
      reducedMotion: () => reduced.current,
    });
  }
  const swipe = ref.current;
  useEffect(() => () => swipe.dispose(), [swipe]);
  return {
    handlers: {
      onPointerDown: (e) => swipe.handlers.onPointerDown(e),
      onPointerMove: (e) => swipe.handlers.onPointerMove(e),
      onPointerUp: (e) => swipe.handlers.onPointerUp(e),
      onPointerCancel: () => swipe.handlers.onPointerCancel(),
    },
    onClickCapture: (e) => {
      if (!swipe.consumeClickSuppression()) return;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

export function TaskRow(props: TaskRowProps): ReactElement {
  const priorityMarked = props.marks.some((m) => m.kind === 'priority');
  const [menuOpen, setMenuOpen] = useState(false);
  const laptop = useIsLaptop();
  const sliderRef = useRef<HTMLDivElement>(null);
  const swipeIconRef = useRef<HTMLSpanElement>(null);
  const swipe = useSwipeDelete({
    sliderRef,
    iconRef: swipeIconRef,
    enabled: !props.queuedDelete,
    onDelete: props.onDelete,
  });
  // Mark checked: the tick draws (220 ms) when the box turns done, never on a
  // row that paints done.
  const tickRef = useRef<HTMLButtonElement>(null);
  const wasDone = useRef(props.done);
  useLayoutEffect(() => {
    if (props.done && !wasDone.current) {
      drawTick(tickRef.current?.querySelector('[data-task-glyph="done"] path') ?? null);
    }
    wasDone.current = props.done;
  }, [props.done]);
  const menu = props.menu;
  return (
    // Glide: rows move to their new place when rows above come or go (Y only).
    <GlideItem
      as="li"
      data-task-row-id={props.id}
      {...(props.dot ? { 'data-task-marked': '' } : {})}
      {...(props.queuedDelete ? { 'data-task-deleting': '' } : {})}
      {...(menuOpen ? { 'data-task-menu-open': '' } : {})}
      className={cn('relative flex flex-col', (props.dot || menuOpen) && 'bg-hover-fill')}
    >
      {props.queuedDelete ? null : <SwipeDeleteIcon iconRef={swipeIconRef} />}
      <div
        ref={sliderRef}
        data-task-swipe=""
        {...swipe.handlers}
        onClickCapture={swipe.onClickCapture}
        // Vertical scroll stays the list's; a horizontal move is the swipe's.
        className="relative flex min-h-11 touch-pan-y touch-pinch-zoom items-start gap-1 pl-1 pr-1"
      >
        <IconButton
          buttonRef={tickRef}
          type="button"
          role="checkbox"
          aria-checked={props.done}
          label={`${props.done ? STATUS_LABEL.done : STATUS_LABEL.todo}: ${props.title}`}
          data-task-tick=""
          disabled={props.queuedDelete || props.canTick === false}
          onClick={props.onToggle}
          onContextMenu={(e) => e.preventDefault()}
          className={cn('relative shrink-0', NO_TOUCH_SELECT)}
        >
          <TaskGlyph status={props.done ? 'done' : 'todo'} />
        </IconButton>
        {props.queuedDelete ? (
          <span className="min-h-11 min-w-0 flex-1 py-3 text-base font-medium text-fg-3 line-through">
            {props.title}
          </span>
        ) : (
          <TitleCell
            title={props.title}
            done={props.done}
            dateLine={props.dateLine ?? null}
            dot={props.dot}
            onCommit={props.onTitle}
            onMenu={menu !== undefined ? () => setMenuOpen(true) : null}
          />
        )}
        {props.queuedDelete ? (
          <Button
            type="button"
            variant="link"
            data-task-undo-delete=""
            onClick={props.onUndoDelete}
            onContextMenu={(e) => e.preventDefault()}
            className={ACTION}
          >
            Undo
          </Button>
        ) : (
          <PriorityChip
            priority={props.priority}
            ringed={priorityMarked}
            onPick={props.onPriority}
          />
        )}
        {laptop && !props.queuedDelete ? (
          <IconButton
            type="button"
            label={`${DELETE_LABEL}: ${props.title}`}
            data-task-delete=""
            onClick={props.onDelete}
            onContextMenu={(e) => e.preventDefault()}
            className={cn('shrink-0 text-fg-3 hover:text-bad', NO_TOUCH_SELECT)}
          >
            <IconTrash size={ICON_SIZE.inline} />
          </IconButton>
        ) : null}
      </div>
      {menu !== undefined ? (
        <ActionMenu
          title={props.title}
          items={rowMenuItems(menu, props.onDelete)}
          trigger={null}
          open={menuOpen}
          onOpenChange={setMenuOpen}
        />
      ) : null}
      {props.marks.length > 0 ? (
        <p
          data-task-mark=""
          className="-mt-2 flex flex-wrap gap-x-2 pb-2 pl-13 pr-3 text-sm text-fg-3"
        >
          {props.marks.map((m, k) => (
            <MarkLine key={k} mark={m} />
          ))}
        </p>
      ) : null}
      {props.notice !== null ? (
        <div data-task-conflict="" className="-mt-1 flex flex-col gap-1 pb-2 pl-13 pr-3">
          <p className="text-sm text-stage-review">{props.notice.text}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              data-task-keep-mine=""
              onClick={props.notice.onMine}
              className={ACTION}
            >
              {props.notice.deleted ? 'Restore mine' : 'Keep mine'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              data-task-keep-theirs=""
              onClick={props.notice.onTheirs}
              className={ACTION}
            >
              {props.notice.deleted ? 'OK' : 'Keep theirs'}
            </Button>
          </div>
        </div>
      ) : null}
      {props.failed}
    </GlideItem>
  );
}
