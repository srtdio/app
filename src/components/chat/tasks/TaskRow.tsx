// One task row of the shared list, and the priority chip with its menu.
// Row: tick box (to do / done), number, title (tap to edit in place: Enter or
// blur keeps, Esc cancels, empty keeps the old title), priority chip, and a
// delete x. Every change is local to the sheet's draft until Save. A row may
// carry an accent dot (changed by someone else since you looked, or your own
// unsaved change), its changed chip ringed, and sub-lines: what it was ("was
// <s>old</s>", "priority was <s>P2</s>", "marked done", "reopened", "New
// task"), or a both-edited notice with Keep mine / Keep theirs (or "deleted
// this" with Restore mine / OK). 44px targets everywhere.
//
// The chip's menu (P0 Urgent, P1 High, P2 Normal, current ticked) renders in a
// portal layer above the sheet, never clipped by the scrolling list: below the
// chip, flipped above when space below is short, clamped on screen. A scroll
// of the list, a tap outside or Esc closes it. Motion: fade only.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconCheck, IconChevronDown, IconX } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { STATUS_LABEL, TaskGlyph } from '@/components/chat/tasks/TaskGlyph';
import { Highlight } from '@/components/ui/SearchHighlight';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import {
  PRIORITY_LABEL,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  markText,
  type TaskMark,
  type TaskPriority,
} from '@/lib/chat/tasks';

export const NOT_SAVED = 'Not saved';

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
export function placeMenu(
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
        'inline-flex h-[22px] items-center gap-0.5 rounded-[5px] px-1.5 font-mono text-sm',
        P_TAG[props.priority],
        props.ringed === true && 'ring-2 ring-accent ring-offset-1 ring-offset-panel',
      )}
    >
      P{props.priority}
      {pick !== undefined ? <IconChevronDown size={ICON_SIZE.inline} /> : null}
    </span>
  );
  if (pick === undefined) return chip;
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        data-task-chip=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label ?? `Priority P${props.priority} ${PRIORITY_LABEL[props.priority]}`}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'flex h-11 min-w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          NO_TOUCH_SELECT,
        )}
      >
        {chip}
      </button>
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
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    const el = anchor.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    setPos(placeMenu(r, window.innerWidth, window.innerHeight));
  }, [anchor]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  useEscapeLayer(true, onClose);
  // A scroll anywhere under the sheet (the list) or a resize closes it; a tap outside too.
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
      data-task-menu=""
      style={{ top: pos.top, left: pos.left, width: MENU_W }}
      className={cn(
        'fixed z-[60] rounded-[10px] border border-border-strong bg-panel p-1 shadow-lg transition-opacity duration-fast motion-reduce:transition-none',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      {TASK_PRIORITIES.map((p) => (
        <button
          key={p}
          type="button"
          role="menuitemradio"
          aria-checked={p === props.current}
          data-task-menu-p={p}
          onClick={() => props.onPick(p)}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            'flex h-11 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-base text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            NO_TOUCH_SELECT,
          )}
        >
          <span className={cn('rounded-[5px] px-1.5 font-mono text-sm', P_TAG[p])}>P{p}</span>
          <span className="flex-1">{PRIORITY_LABEL[p]}</span>
          {p === props.current ? (
            <IconCheck size={ICON_SIZE.inline} className="text-accent" />
          ) : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** The inline failure line: "Not saved · Retry" (44px Retry). */
export function NotSaved(props: { onRetry: () => void; message?: string }): ReactElement {
  return (
    <div data-task-not-saved="" className="flex items-center gap-1 pl-[60px] pr-3 text-md">
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

/** A title that turns into an input in the tap (so iOS opens the keyboard), cursor at the end. */
function TitleCell(props: {
  title: string;
  done: boolean;
  onCommit: (title: string) => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(props.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const begin = (): void => {
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
        className="min-h-[44px] min-w-0 flex-1 bg-transparent text-input font-medium text-fg focus:outline-none md:text-base"
      />
    );
  }
  return (
    <button
      type="button"
      data-task-title=""
      onClick={begin}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        'min-h-[44px] min-w-0 flex-1 py-3 text-left text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
        props.done ? 'text-fg-3 line-through' : 'text-fg',
      )}
    >
      <Highlight text={props.title} />
    </button>
  );
}

/** A both-edited notice and its two answers. */
export interface RowNotice {
  text: string;
  deleted: boolean;
  onMine: () => void;
  onTheirs: () => void;
}

export interface TaskRowProps {
  id: string;
  number: number | null;
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
  failed?: ReactNode;
  onToggle: () => void;
  onTitle: (title: string) => void;
  onPriority: (p: TaskPriority) => void;
  onDelete: () => void;
  onUndoDelete: () => void;
}

const ACTION = cn(
  'min-w-11 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  NO_TOUCH_SELECT,
);

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
  return <span>{markText(mark)}</span>;
}

export function TaskRow(props: TaskRowProps): ReactElement {
  const priorityMarked = props.marks.some((m) => m.kind === 'priority');
  return (
    <li
      data-task-row-id={props.id}
      data-task-number={props.number ?? ''}
      {...(props.dot ? { 'data-task-marked': '' } : {})}
      {...(props.queuedDelete ? { 'data-task-deleting': '' } : {})}
      className={cn('flex flex-col', props.dot && 'bg-accent-soft')}
    >
      <div className="flex min-h-[44px] items-start gap-1 pl-1 pr-1">
        <button
          type="button"
          role="checkbox"
          aria-checked={props.done}
          aria-label={`${props.done ? STATUS_LABEL.done : STATUS_LABEL.todo}: ${props.title}`}
          data-task-tick=""
          disabled={props.queuedDelete || props.canTick === false}
          onClick={props.onToggle}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            'relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            NO_TOUCH_SELECT,
          )}
        >
          <TaskGlyph status={props.done ? 'done' : 'todo'} />
        </button>
        <span className="flex h-11 w-6 shrink-0 items-center font-mono text-sm text-fg-2">
          {props.dot ? (
            <span
              aria-hidden="true"
              data-task-dot=""
              className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            />
          ) : null}
          {props.number ?? ''}
        </span>
        {props.queuedDelete ? (
          <span className="min-h-[44px] min-w-0 flex-1 py-3 text-base font-medium text-fg-3 line-through">
            {props.title}
          </span>
        ) : (
          <TitleCell title={props.title} done={props.done} onCommit={props.onTitle} />
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
          <>
            <PriorityChip
              priority={props.priority}
              ringed={priorityMarked}
              onPick={props.onPriority}
            />
            <IconButton
              type="button"
              label={`Delete ${props.title}`}
              data-task-delete=""
              onClick={props.onDelete}
              onContextMenu={(e) => e.preventDefault()}
              className={cn(
                'shrink-0 text-fg-3 hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                NO_TOUCH_SELECT,
              )}
            >
              <IconX size={ICON_SIZE.control} />
            </IconButton>
          </>
        )}
      </div>
      {props.marks.length > 0 ? (
        <p
          data-task-mark=""
          className="-mt-2 flex flex-wrap gap-x-2 pb-2 pl-[80px] pr-3 text-sm text-fg-3"
        >
          {props.marks.map((m, k) => (
            <MarkLine key={k} mark={m} />
          ))}
        </p>
      ) : null}
      {props.notice !== null ? (
        <div data-task-conflict="" className="-mt-1 flex flex-col gap-1 pb-2 pl-[80px] pr-3">
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
    </li>
  );
}
