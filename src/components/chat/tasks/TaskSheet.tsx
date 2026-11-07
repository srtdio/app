// The chat's Tasks: one shared list in a sheet. Every member has the same
// powers (tick, inline edit, priority, date, delete, add, Share).
// Every change saves itself: the sheet holds a local draft (edits, new tasks,
// queued deletes, each touched task's base updated_at) and sends it as ONE
// chat_task_save_batch TASK_AUTOSAVE_MS after the last change (a queued delete
// waits out its Undo, UNDO_MS), and at once on close. A change that is
// reverted is no change. The server folds one person's saves within half an
// hour into one chat line and one alert.
//
// The sheet rises from the bottom at the height of what it holds (a short
// list, a short sheet; the one sheet frame, up to 90% of the screen, then the
// list scrolls inside), with a grabber; one height, swipe down on the header
// closes it. Laptop: a centre box.
// Header: Back, "Tasks" (with "<Name> is editing…" under it while another
// member holds unsaved changes), "Saving…" / "Saved" (Retry after a failure) and
// one Share to chat button (when the chat can share). Under it the chips Past, Today, This week, Later, No date
// (src/lib/chat/task-when.ts; due days on the workspace calendar), sized to
// their text so the picked one is always in view; their counts drop only when
// the row is too narrow for them. The sheet opens on Today (else the first chip
// that holds tasks). Past lists Not done above Done. A row is tick, title,
// priority; the day sits under the title only when the chip does not say it. A
// tick here strikes the row where it is; the save moves it. A long-press
// (right-click on laptop) on a title opens the row's menu: Today, Tomorrow,
// Pick a date (the shared calendar in a sheet; never before today), No date,
// Delete. The add row takes a day (Today, Tomorrow, No date, or a picked
// day) and the sheet moves to the chip the new task lands on.
// Back, swipe down, a tap outside, Esc or System Back save what is left first,
// then close; a failed save keeps the sheet open with Retry. Laptop: Cmd/Ctrl+S
// saves at once.
//
// Marks: on open, tasks other people changed since this device last looked
// (or, never looked, the latest Save by someone else) carry an accent dot,
// their changed chip ringed and a sub-line ("was <s>old</s>", "priority was
// <s>P2</s>", "marked done", "reopened", "New task"), under the strip "<Name>
// changed N tasks · marked below". Someone saving while this sheet is open
// updates rows this person has not touched at once (marked, "<Name> just
// saved"); a touched row keeps this person's edit and shows "<Name> changed
// this to …" with Keep mine / Keep theirs. A Save whose edits hit a task
// changed since comes back with conflicts: everything else is saved, and each
// conflicting row asks the same (a deleted one: "<Name> deleted this" with
// Restore mine / OK). Marks clear when the sheet closes (the caller writes the
// seen time then). Motion (docs/motion.md, rise): on a phone the panel rises
// 100% to 0 (320 ms) and drops back (240 ms), the scrim's dim tracking its
// position; laptop: the dialog grows 95% to 100%. A row that arrives rises 8px
// into place (itemIn). Never a fade. Boxes (Bone) while the list loads. Tokens only.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Backdrop } from '@/components/ui/Backdrop';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { DatePicker } from '@/components/ui/DatePicker';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { IconButton } from '@/components/ui/IconButton';
import { LoadError } from '@/components/ui/LoadError';
import { glowTarget } from '@/components/ui/SearchHighlight';
import { SHEET_FRAME, Sheet } from '@/components/ui/Sheet';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { ICON_SIZE, IconCalendar, IconForward, IconPlus } from '@/components/ui/icons';
import {
  PICK_DATE_LABEL,
  PriorityChip,
  TaskRow,
  type RowMenu,
  type RowNotice,
} from '@/components/chat/tasks/TaskRow';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { useTaskShare, type TaskShareWiring } from '@/components/chat/tasks/useTaskShare';
import { useBackGuard } from '@/lib/back-guard';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import {
  Bone,
  BoxSkeleton,
  SHEET_CLOSE_PX,
  dialogIn,
  dialogOut,
  itemIn,
  riseIn,
  riseOut,
  trackDim,
  useDragDismiss,
  useFreshKeys,
  usePresence,
} from '@/lib/motion';
import {
  TASK_WHEN_CHIPS,
  calendarDays,
  countByWhen,
  dayChoices,
  isPickableDay,
  openingChip,
  rowDateLine,
  taskWhen,
  type TaskCalendar,
  type TaskWhen,
} from '@/lib/chat/task-when';
import { formatDueDate } from '@/lib/time';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { useIsLaptop } from '@/lib/use-is-laptop';
import {
  DEFAULT_PRIORITY,
  EMPTY_DRAFT,
  TASK_TITLE_MAX,
  TASKS_SHEET_ONLY,
  applyChanges,
  batchPayload,
  conflictLine,
  dropTask,
  editField,
  editingLabel,
  effectiveChanges,
  hasChanges,
  isDraftDirty,
  isEmptyPayload,
  keepMine,
  liveMerge,
  marksSince,
  marksStrip,
  nextNumberPreview,
  queueDelete,
  taskFromConflict,
  type BatchPayload,
  type ChatTask,
  type DraftNew,
  type SheetDraft,
  type TaskConflict,
  type TaskEvent,
  type TaskMark,
  type TaskPriority,
  type TaskSide,
} from '@/lib/chat/tasks';
import { errorText } from '@/lib/error-copy';
import { createPausableTimer } from '@/lib/pausable-timer';
import { UNDO_MS } from '@/lib/undo';
import { TEXT_ROLE } from '@/components/ui/Text';

export const TASK_SHEET_TITLE = 'Tasks';
const SHARE_LABEL = 'Share to chat';
export const ADD_PLACEHOLDER = 'Add a task';
export const ADD_TASK_LABEL = 'Add task';
const SAVE_FAILED = errorText('save', null);
/** LoadError's "Couldn't load tasks." */
const TASKS_LOAD_THING = 'tasks';
const SAVING_LABEL = 'Saving…';
const SAVED_LABEL = 'Saved';
const RETRY_LABEL = 'Retry';
/** A change saves itself this long after the last one (typing settles first). */
export const TASK_AUTOSAVE_MS = 800;
const BACK_LABEL = 'Close tasks';
const PAST_OPEN_LABEL = 'Not done';
const PAST_DONE_LABEL = 'Done';
const SECTION_LABEL = `px-4 pb-1 pt-3 ${TEXT_ROLE.section}`;

/** One positive line per chip when it holds nothing. */
const CHIP_ZERO: Readonly<Record<TaskWhen, string>> = {
  past: 'Tasks from past days show up here.',
  today: 'Tasks due today show up here.',
  week: 'Tasks due later this week show up here.',
  later: 'Tasks due after this week show up here.',
  none: 'Tasks without a date show up here.',
};

/** "<Name> just saved" (a Save by someone else while this page is open). Pure. */
function justSavedLabel(name: string): string {
  return `${name} just saved`;
}

let newSeq = 0;

/** A conflict or live-merge notice on one row: their version, and the task as it was. */
interface Notice {
  conflict: TaskConflict;
  task: ChatTask;
}

/** The newest batch id by someone else, or null. Pure. */
function latestOtherBatch(events: readonly TaskEvent[], me: string): TaskEvent | null {
  for (let k = events.length - 1; k >= 0; k -= 1) {
    const e = events[k];
    if (e !== undefined && e.batchId !== null && e.actorId !== null && e.actorId !== me) return e;
  }
  return null;
}

/** Who last changed a task (someone else), for a notice. Pure. */
function lastActorOf(events: readonly TaskEvent[], taskId: string, me: string): string | null {
  for (let k = events.length - 1; k >= 0; k -= 1) {
    const e = events[k];
    if (e !== undefined && e.taskId === taskId && e.actorId !== null && e.actorId !== me) {
      return e.actorId;
    }
  }
  return null;
}

/** The draft narrowed to one task (Keep mine re-sends just that edit). Pure. */
function onlyTask(draft: SheetDraft, taskId: string): SheetDraft {
  const edit = draft.edits[taskId];
  const base = draft.bases[taskId];
  return {
    edits: edit !== undefined ? { [taskId]: edit } : {},
    creates: [],
    deletes: draft.deletes.filter((id) => id === taskId),
    bases: base !== undefined ? { [taskId]: base } : {},
  };
}

/** One row of the page: a saved task (as it looks with this draft) or a new one. */
type Entry =
  | { kind: 'task'; key: string; task: ChatTask; shown: ChatTask }
  | { kind: 'new'; key: string; c: DraftNew; number: number };

/** What the calendar sheet sets: the day it opens on, and where the pick goes. */
interface PickTarget {
  current: string | null;
  set: (dueOn: string) => void;
}

/** The day an entry sits on, as this draft shows it. Pure. */
function dueOf(e: Entry): string | null {
  return e.kind === 'task' ? e.shown.dueOn : e.c.dueOn;
}

/**
 * The add row: a field with a priority chip, and under it the day the new
 * task takes: Today (the default), Tomorrow, No date, or a day from the shared
 * calendar (the calendar button; never before today).
 */
function AddRow(props: {
  disabled: boolean;
  calendar: TaskCalendar;
  onAdd: (title: string, priority: TaskPriority, dueOn: string | null) => void;
  onPickDate: (current: string | null, set: (dueOn: string) => void) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_PRIORITY);
  const choices = dayChoices(props.calendar);
  const today = choices[0]?.dueOn ?? null;
  const [dueOn, setDueOn] = useState<string | null>(today);
  const inputRef = useRef<HTMLInputElement>(null);
  const quick = choices.find((c) => c.dueOn === dueOn);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (props.disabled || text.trim() === '') return;
    props.onAdd(text, priority, dueOn);
    setText('');
    setPriority(DEFAULT_PRIORITY);
    setDueOn(today);
    inputRef.current?.focus();
  };
  const blank = text.trim() === '';
  return (
    <li className="flex flex-col px-3 pt-3">
      {/* The well and, like the chat composer's send, a round add button beside it: Enter adds too. */}
      <form data-task-add="" onSubmit={submit} className="flex items-center gap-2">
        <div className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-lg border border-field bg-panel-2 pl-3 pr-1 lit-well focus-within:lit-focus">
          <input
            ref={inputRef}
            type="text"
            aria-label={ADD_PLACEHOLDER}
            enterKeyHint="enter"
            autoComplete="off"
            value={text}
            disabled={props.disabled}
            maxLength={TASK_TITLE_MAX}
            placeholder={ADD_PLACEHOLDER}
            onChange={(e) => setText(e.target.value)}
            className="min-h-11 min-w-0 flex-1 bg-transparent text-input text-fg placeholder:text-fg-3 outline-none md:text-base"
          />
          <PriorityChip
            priority={priority}
            onPick={setPriority}
            label={`New task priority P${priority}`}
            disabled={props.disabled}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          shape="round"
          aria-label={ADD_TASK_LABEL}
          data-task-add-submit=""
          disabled={props.disabled || blank}
          className="shrink-0"
        >
          <IconPlus size={ICON_SIZE.control} />
        </Button>
      </form>
      <div
        data-task-days="add"
        role="group"
        aria-label="Due date"
        className="flex items-center gap-2 py-2"
      >
        {choices.map((c) => (
          <Chip
            key={c.key}
            label={c.label}
            selected={quick?.key === c.key}
            data-task-day={c.key}
            disabled={props.disabled}
            onClick={() => setDueOn(c.dueOn)}
          />
        ))}
        {quick === undefined && dueOn !== null ? (
          <Chip
            // The picked day itself (a chosen date stays absolute): "12 Nov".
            label={formatDueDate(dueOn, props.calendar.timeZone, props.calendar.now)}
            selected
            data-task-day="picked"
            className="font-mono tabular-nums"
            onClick={() => props.onPickDate(dueOn, setDueOn)}
          />
        ) : null}
        <IconButton
          type="button"
          label={PICK_DATE_LABEL}
          data-task-day="pick"
          disabled={props.disabled}
          onClick={() => props.onPickDate(dueOn, setDueOn)}
          className="ml-auto"
        >
          <IconCalendar size={ICON_SIZE.control} />
        </IconButton>
      </div>
    </li>
  );
}

/**
 * The chip line: five chips sized to their text (the picked one is always in
 * view); when the row is too narrow for the counts, the counts go and the
 * names stay. Measured before paint, again on resize.
 */
function ChipLine(props: {
  chip: TaskWhen;
  counts: Record<TaskWhen, number>;
  onChip: (chip: TaskWhen) => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [withCounts, setWithCounts] = useState(true);
  const total = TASK_WHEN_CHIPS.map((c) => props.counts[c.key]).join(',');
  // Any change to the counts tries them again; a resize too.
  useLayoutEffect(() => {
    setWithCounts(true);
  }, [total]);
  useLayoutEffect(() => {
    const row = ref.current;
    if (row === null || !withCounts) return;
    const cut = [...row.children].some((c) => c.scrollWidth > c.clientWidth + 1);
    if (cut) setWithCounts(false);
  }, [withCounts, total]);
  useEffect(() => {
    const row = ref.current;
    if (row === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWithCounts(true));
    ro.observe(row);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      data-task-chips=""
      data-task-chip-counts={withCounts ? '' : undefined}
      role="tablist"
      aria-label="When"
      className="flex shrink-0 gap-1 px-3 py-2"
    >
      {TASK_WHEN_CHIPS.map((c) => (
        <Chip
          key={c.key}
          label={c.label}
          {...(withCounts ? { count: props.counts[c.key] } : {})}
          tab
          selected={props.chip === c.key}
          data-task-when-chip={c.key}
          className="min-w-0 flex-auto justify-center truncate whitespace-nowrap px-2"
          onClick={() => props.onChip(c.key)}
        />
      ))}
    </div>
  );
}

function TasksSkeleton(): ReactElement {
  return (
    <BoxSkeleton
      lit="flat"
      data-task-skeleton=""
      label="Loading tasks"
      className="flex flex-col gap-3 px-4 py-4"
    >
      {[0, 1, 2, 3].map((k) => (
        <div key={k} className="flex items-center gap-3">
          <Bone lit="lit-well" className="h-4 w-4 shrink-0 rounded-lg" />
          <Bone lit="flat" className="h-4 flex-1 rounded-lg" />
          <Bone lit="flat" className="h-4 w-8 shrink-0 rounded-lg" />
        </div>
      ))}
    </BoxSkeleton>
  );
}

interface TaskSheetProps {
  open: boolean;
  onClose: () => void;
  tasks: UseChatTasks;
  /** The viewer's id (marks are changes by everyone else). */
  currentUserId: string;
  /** The side a new task is created on (the viewer's own; never shown). Null: not known yet. */
  side: TaskSide | null;
  /** When this device last looked at the list (marks are changes after it); null: never. */
  seenMs: number | null;
  /** Opened for one task (a bell row): that row is brought into view. */
  focusTaskId: string | null;
  /** Share through the thread's send and forward; absent hides Share. */
  share?: TaskShareWiring;
  /** The workspace zone the due days read on (IANA). */
  timeZone: string;
  /** The workspace week start, 0=Sun..6=Sat (This week's last day). */
  weekStartDay: number;
}

export function TaskSheet(props: TaskSheetProps): ReactElement | null {
  const { tasks, currentUserId } = props;
  // The one shared minute clock: due and done lines age with it.
  const nowMs = useMinuteClock();
  const [draft, setDraft] = useState<SheetDraft>(EMPTY_DRAFT);
  const [notices, setNotices] = useState<Map<string, Notice>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // Close asked for: it waits for the last save, then closes (a failure keeps it open).
  const [wantClose, setWantClose] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // What the marks are measured from (frozen at open) and the latest other Save then.
  const [openedSeen, setOpenedSeen] = useState<number | null>(props.seenMs);
  const [openedAt, setOpenedAt] = useState<number>(() => Date.now());
  // The chip the person picked (null: follow the opening rule). Each open
  // starts on the opening chip.
  const [pickedChip, setPickedChip] = useState<TaskWhen | null>(null);
  // The calendar sheet's target: a row (task id or new task key), or the add row's setter.
  const [pick, setPick] = useState<PickTarget | null>(null);
  const laptop = useIsLaptop();
  const dimRef = useRef<HTMLButtonElement>(null);
  // Rise (phone) / grow (laptop): the panel is painted at rest on its first
  // frame and the move is laid over it; the scrim's dim follows the panel.
  const { rendered, ref: panelRef } = usePresence<HTMLDivElement>(props.open, {
    enter: (el) => {
      if (laptop) return dialogIn(el);
      const played = riseIn(el);
      trackDim(el, dimRef.current, played);
      return played;
    },
    exit: (el) => {
      if (laptop) return dialogOut(el);
      const played = riseOut(el);
      trackDim(el, dimRef.current, played);
      return played;
    },
  });
  const bodyRef = useRef<HTMLDivElement>(null);
  const taskShare = useTaskShare(props.share ?? null);
  const resetShare = taskShare.reset;

  const byId = useMemo(() => new Map(tasks.tasks.map((t) => [t.id, t] as const)), [tasks.tasks]);
  const dirty = isDraftDirty(draft, byId) || notices.size > 0;

  // Each open starts fresh; a close drops the share picker.
  useEffect(() => {
    if (props.open) {
      setDraft(EMPTY_DRAFT);
      setNotices(new Map());
      setSaveFailed(false);
      setWantClose(false);
      setSavedOnce(false);
      setOpenedSeen(props.seenMs);
      setOpenedAt(Date.now());
      setPickedChip(null);
      setPick(null);
      return;
    }
    setShareOpen(false);
    // Only an open resets the page, never a data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  // The live "is editing" signal follows unsaved changes while open.
  const setEditing = tasks.setEditing;
  useEffect(() => {
    setEditing(props.open && dirty);
  }, [props.open, dirty, setEditing]);
  useEffect(() => () => setEditing(false), [setEditing]);

  // Someone else saved while this is open: untouched rows already show the
  // fresh list; touched rows get a notice. Skipped around this page's own Save.
  const prevById = useRef(byId);
  const savingRef = useRef(false);
  useEffect(() => {
    const before = prevById.current;
    prevById.current = byId;
    if (!props.open || savingRef.current || before === byId) return;
    // A change whose newest event is this person's own (their Save landing) is no notice.
    const found = liveMerge({ draft, before, after: byId }).notices.filter(
      (c) => lastActorOf(tasks.events, c.taskId, '') !== currentUserId,
    );
    if (found.length === 0) return;
    setNotices((prev) => {
      const next = new Map(prev);
      for (const c of found) {
        const task = before.get(c.taskId);
        if (task !== undefined && !next.has(c.taskId)) next.set(c.taskId, { conflict: c, task });
      }
      return next;
    });
    // The draft is read at the change, never re-run on draft edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, props.open]);

  const marks = useMemo(
    () => marksSince(tasks.events, currentUserId, openedSeen),
    [tasks.events, currentUserId, openedSeen],
  );
  const latest = latestOtherBatch(tasks.events, currentUserId);
  const justSaved =
    props.open &&
    latest !== null &&
    latest.actorId !== null &&
    Date.parse(latest.createdAt) > openedAt
      ? justSavedLabel(tasks.nameOf(latest.actorId))
      : null;
  const markedCount = [...marks.byTask.keys()].filter((id) => byId.has(id)).length;
  const strip =
    justSaved ??
    (markedCount > 0 ? marksStrip(marks.actorIds.map(tasks.nameOf), markedCount) : null);

  const runSave = useCallback(
    async (next: SheetDraft, payload: BatchPayload): Promise<void> => {
      if (savingRef.current || isEmptyPayload(payload)) return;
      setSaving(true);
      savingRef.current = true;
      setSaveFailed(false);
      const outcome = await tasks.saveBatch(payload);
      savingRef.current = false;
      setSaving(false);
      if (!outcome.ok) {
        setSaveFailed(true);
        return;
      }
      setSavedOnce(true);
      const conflicted = new Set(outcome.conflicts.map((c) => c.taskId));
      // Everything sent is saved, except the conflicts: those keep the edit. A
      // task edited again while this save was in flight keeps the newer edit,
      // based on the fresh row (the save re-read the list before returning).
      setDraft((cur) => {
        let out: SheetDraft = {
          ...cur,
          creates: cur.creates.filter((c) => !next.creates.includes(c)),
        };
        for (const e of payload.edits) {
          if (conflicted.has(e.task_id)) continue;
          if (cur.edits[e.task_id] === next.edits[e.task_id]) {
            out = dropTask(out, e.task_id);
          } else {
            const bases = Object.fromEntries(
              Object.entries(out.bases).filter(([id]) => id !== e.task_id),
            );
            out = { ...out, bases };
          }
        }
        for (const d of payload.deletes)
          if (!conflicted.has(d.task_id)) out = dropTask(out, d.task_id);
        return out;
      });
      setNotices((prev) => {
        const map = new Map(prev);
        for (const e of payload.edits) map.delete(e.task_id);
        for (const c of outcome.conflicts) {
          map.set(c.taskId, { conflict: c, task: byId.get(c.taskId) ?? taskFromConflictStub(c) });
        }
        return map;
      });
    },
    [tasks, byId],
  );

  // What a save would send now: a row waiting on Keep mine / Keep theirs is
  // held back until the person picks.
  const sendable = useMemo(() => {
    const payload = batchPayload(draft, byId);
    if (notices.size === 0) return payload;
    return {
      creates: payload.creates,
      edits: payload.edits.filter((e) => !notices.has(e.task_id)),
      deletes: payload.deletes.filter((d) => !notices.has(d.task_id)),
    };
  }, [draft, byId, notices]);
  const pending = !isEmptyPayload(sendable);
  const save = useCallback((): void => {
    void runSave(draft, sendable);
  }, [runSave, draft, sendable]);

  // Autosave: the draft goes out once changes settle; a queued delete waits out
  // its row's Undo (UNDO_MS) first. After a failure it waits for Retry or the
  // next change (an edit clears the failure). Closing sends at once.
  const holdsDelete = sendable.deletes.length > 0;
  useEffect(() => {
    if (!props.open || !pending || saving || saveFailed || wantClose) return;
    const timer = createPausableTimer(save, holdsDelete ? UNDO_MS : TASK_AUTOSAVE_MS);
    return () => timer.cancel();
  }, [props.open, pending, holdsDelete, saving, saveFailed, wantClose, save]);

  const close = props.onClose;
  const requestClose = useCallback((): void => setWantClose(true), []);

  useEscapeLayer(props.open && !shareOpen && pick === null, requestClose);

  // Phone: swipe down on the header closes the sheet (it saves what is left
  // first, like Back). Released short, nothing changes.
  const swipeDown = useDragDismiss({
    axis: 'y',
    direction: 1,
    closeAt: SHEET_CLOSE_PX,
    enabled: !laptop && props.open,
    onMove: () => {},
    onDismiss: requestClose,
    onCancel: () => {},
  });
  useModalFocus(panelRef, props.open && rendered);
  const guard = useBackGuard({
    active: props.open && (pending || saving),
    onBack: requestClose,
  });
  // A close waits for the save in flight, sends what is left, then closes; a
  // failed save keeps the sheet open (Retry shows).
  useEffect(() => {
    if (!wantClose || saving) return;
    if (saveFailed) {
      setWantClose(false);
      return;
    }
    if (pending) {
      save();
      return;
    }
    setWantClose(false);
    guard.release();
    close();
  }, [wantClose, saving, saveFailed, pending, save, guard, close]);

  // Laptop: Cmd/Ctrl+S saves.
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && typeof e.key === 'string' && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (pending && !saving) save();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.open, pending, saving, save]);

  // A bell row's task comes into view with the arrival tint (its chip is opened).
  const focusTaskId = props.focusTaskId === TASKS_SHEET_ONLY ? null : props.focusTaskId;
  const focusTask = focusTaskId !== null ? byId.get(focusTaskId) : undefined;
  const focusShown = focusTask !== undefined;
  useEffect(() => {
    if (!props.open || !rendered || focusTaskId === null || !focusShown) return;
    let clear: (() => void) | null = null;
    const raf = requestAnimationFrame(() => {
      const row = bodyRef.current?.querySelector<HTMLElement>(
        `[data-task-row-id="${focusTaskId}"]`,
      );
      if (row != null) clear = glowTarget(row);
    });
    return () => {
      cancelAnimationFrame(raf);
      clear?.();
    };
  }, [props.open, rendered, focusTaskId, focusShown]);

  // When each row falls, on the workspace calendar, as it looks with this
  // draft's changes; new tasks by the day they were given.
  const calendar: TaskCalendar = {
    now: new Date(nowMs),
    timeZone: props.timeZone,
    weekStartDay: props.weekStartDay,
  };
  const days = calendarDays(calendar);
  // The rows: the live list, plus rows a notice keeps (deleted by someone else).
  const ghosts = [...notices.values()]
    .filter((n) => !byId.has(n.conflict.taskId))
    .map((n) => taskFromConflict(n.task, n.conflict));
  const rows = [...tasks.tasks, ...ghosts].sort((a, b) => a.number - b.number);
  const entries: Entry[] = [
    ...rows.map(
      (task): Entry => ({
        kind: 'task',
        key: task.id,
        task,
        shown: applyChanges(task, effectiveChanges(task, draft.edits[task.id])),
      }),
    ),
    ...draft.creates.map(
      (c, k): Entry => ({ kind: 'new', key: c.key, c, number: nextNumberPreview(tasks.tasks) + k }),
    ),
  ];
  const counts = countByWhen(
    entries.map((e) => ({ dueOn: dueOf(e) })),
    days,
  );
  const chip: TaskWhen =
    pickedChip ?? (focusTask !== undefined ? taskWhen(focusTask, days) : openingChip(counts));

  // itemIn: a task that arrives while the list is on screen (added here, or
  // saved by someone else) rises 8px into place; the list's first paint, a
  // load and a reopen never move.
  const freshRows = useFreshKeys(entries.map((e) => e.key));
  const listShown = rendered && props.open && tasks.loadState === 'ready';
  const wasListShown = useRef(false);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (wasListShown.current && body !== null) {
      for (const key of freshRows) {
        itemIn(body.querySelector(`[data-task-row-id="${key}"]`));
      }
    }
    wasListShown.current = listShown;
  });
  if (!rendered) return null;

  const edit = (task: ChatTask, change: Parameters<typeof editField>[2]): void => {
    setSaveFailed(false);
    setDraft((d) => editField(d, task, change));
  };
  const editNew = (key: string, change: Partial<DraftNew>): void =>
    setDraft((d) => ({
      ...d,
      creates: d.creates.map((c) => (c.key === key ? { ...c, ...change } : c)),
    }));
  const nameOfNotice = (taskId: string): string => {
    const actor = lastActorOf(tasks.events, taskId, currentUserId);
    return actor !== null ? tasks.nameOf(actor) : 'Someone';
  };
  const resolveMine = (n: Notice): void => {
    const id = n.conflict.taskId;
    setNotices((prev) => {
      const map = new Map(prev);
      map.delete(id);
      return map;
    });
    if (n.conflict.deleted) {
      // Restore mine: the task again, as a new task with my values.
      const mine = applyChanges(n.task, draft.edits[id] ?? {});
      const restore: DraftNew = {
        key: `new-${(newSeq += 1)}`,
        title: mine.title,
        priority: mine.priority,
        side: n.task.side,
        dueOn: mine.dueOn,
      };
      const next = dropTask(draft, id);
      setDraft(next);
      void runSave(next, { creates: [restore], edits: [], deletes: [] });
      return;
    }
    const rebased = keepMine(draft, n.conflict);
    setDraft(rebased);
    const fresh = byId.get(id);
    const map = fresh !== undefined ? new Map(byId).set(id, fresh) : byId;
    void runSave(rebased, batchPayload(onlyTask(rebased, id), map));
  };
  const resolveTheirs = (n: Notice): void => {
    const id = n.conflict.taskId;
    setDraft((d) => dropTask(d, id));
    setNotices((prev) => {
      const map = new Map(prev);
      map.delete(id);
      return map;
    });
  };

  const rowNotice = (id: string): RowNotice | null => {
    const n = notices.get(id);
    if (n === undefined) return null;
    return {
      text: conflictLine(nameOfNotice(id), n.conflict, draft.edits[id]),
      deleted: n.conflict.deleted,
      onMine: () => resolveMine(n),
      onTheirs: () => resolveTheirs(n),
    };
  };

  const ready = tasks.loadState === 'ready';
  const editors = tasks.editors.map(tasks.nameOf);
  const editingLine = editingLabel(editors);
  const choices = dayChoices(calendar);
  // A day for a row: a saved task's edit, or a new task's own day.
  const setDay = (key: string, dueOn: string | null): void => {
    const task = byId.get(key);
    if (task !== undefined) edit(task, { dueOn });
    else editNew(key, { dueOn });
    // The sheet follows the row to the chip it now sits under.
    setPickedChip(taskWhen({ dueOn }, days));
  };
  const rowMenu = (key: string, dueOn: string | null): RowMenu => ({
    choices,
    hasDate: dueOn !== null,
    onDay: (day) => setDay(key, day),
    onPickDate: () => setPick({ current: dueOn, set: (day) => setDay(key, day) }),
  });

  const renderEntry = (e: Entry): ReactElement => {
    if (e.kind === 'new') {
      const { c } = e;
      return (
        <TaskRow
          key={c.key}
          id={c.key}
          title={c.title}
          done={false}
          priority={c.priority}
          dot
          marks={[]}
          queuedDelete={false}
          canTick={false}
          notice={null}
          dateLine={rowDateLine({ dueOn: c.dueOn, status: 'todo', doneAt: null }, calendar)}
          menu={rowMenu(c.key, c.dueOn)}
          onToggle={() => {}}
          onTitle={(title) => editNew(c.key, { title })}
          onPriority={(priority) => editNew(c.key, { priority })}
          onDelete={() =>
            setDraft((d) => ({ ...d, creates: d.creates.filter((x) => x.key !== c.key) }))
          }
          onUndoDelete={() => {}}
        />
      );
    }
    const { task, shown } = e;
    const mine = effectiveChanges(task, draft.edits[task.id]);
    const queued = draft.deletes.includes(task.id);
    const theirMarks: readonly TaskMark[] = marks.byTask.get(task.id) ?? [];
    const own = hasChanges(mine) || queued;
    return (
      <TaskRow
        key={task.id}
        id={task.id}
        title={shown.title}
        done={shown.status === 'done'}
        priority={shown.priority}
        dot={own || theirMarks.length > 0 || notices.has(task.id)}
        marks={own ? [] : theirMarks}
        queuedDelete={queued}
        notice={rowNotice(task.id)}
        dateLine={rowDateLine(shown, calendar)}
        menu={rowMenu(task.id, shown.dueOn)}
        onToggle={() => edit(task, { status: shown.status === 'done' ? 'todo' : 'done' })}
        onTitle={(title) => edit(task, { title })}
        onPriority={(priority) => edit(task, { priority })}
        onDelete={() => setDraft((d) => queueDelete(d, task))}
        onUndoDelete={() =>
          setDraft((d) => ({ ...d, deletes: d.deletes.filter((x) => x !== task.id) }))
        }
      />
    );
  };

  const byChip = (e: Entry): boolean => taskWhen({ dueOn: dueOf(e) }, days) === chip;
  const listed = entries.filter(byChip);
  const isDone = (e: Entry): boolean => e.kind === 'task' && e.shown.status === 'done';
  const pastSplit = chip === 'past';
  const zero = listed.length === 0;

  const openShare = (): void => {
    if (saving || !ready) return;
    resetShare();
    setShareOpen(true);
  };

  const side = props.side;
  const sheet = createPortal(
    <div className="fixed inset-0 z-sheet flex items-end sm:items-center sm:justify-center">
      <Backdrop ref={dimRef} aria-label="Close tasks" position="absolute" onClick={requestClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={TASK_SHEET_TITLE}
        // At the height of what it holds: the one sheet frame (ui/Sheet SHEET_FRAME).
        className={cn('relative flex flex-col overflow-hidden focus:outline-none', SHEET_FRAME)}
      >
        <div
          data-task-head=""
          className="flex shrink-0 flex-col border-b border-border touch-none md:touch-auto"
          {...swipeDown}
        >
          {laptop ? null : (
            <div
              aria-hidden="true"
              className="mx-auto mt-1.5 h-1 w-9 rounded-sm bg-border-strong"
            />
          )}
          {/* ui/HeaderBar (56): Back, Tasks (and the editing line), the save
              state, Share to chat. The last 44 box takes the trailing rule
              (HeaderBar), so its glyph ends on the 16 edge like Back's starts. */}
          <HeaderBar
            compact
            // A sheet keeps the 16 edge on laptop too (ui/Sheet); the head's
            // wrapper draws the one divider.
            className="border-b-0 md:px-4"
            title={TASK_SHEET_TITLE}
            {...(editingLine !== null
              ? { subtitle: <span data-task-editing="">{editingLine}</span> }
              : {})}
            onBack={requestClose}
            backProps={{ label: BACK_LABEL, 'data-task-back': '' }}
            actions={
              <>
                {/* The save state's slot always holds the width of "Saving…", so
                    Saved / Retry / nothing never shift the title or Share (B1). */}
                <span
                  data-task-save-slot=""
                  className="grid shrink-0 items-center justify-items-end"
                >
                  <span
                    aria-hidden="true"
                    className="invisible col-start-1 row-start-1 px-2 text-sm"
                  >
                    {SAVING_LABEL}
                  </span>
                  {/* Retry's width is held too (ghost Button: 16 each side,
                      base/500), so a failed save never widens the slot. */}
                  <span
                    aria-hidden="true"
                    data-task-save-reserve="retry"
                    className="invisible col-start-1 row-start-1 px-4 text-base font-medium"
                  >
                    {RETRY_LABEL}
                  </span>
                  <span className="col-start-1 row-start-1 flex items-center">
                    {saveFailed ? (
                      <Button
                        variant="ghost"
                        data-task-retry=""
                        onClick={() => {
                          setSaveFailed(false);
                          save();
                        }}
                      >
                        {RETRY_LABEL}
                      </Button>
                    ) : saving || pending || savedOnce ? (
                      <span
                        data-task-save-state={saving || pending ? 'saving' : 'saved'}
                        aria-live="polite"
                        className="shrink-0 px-2 text-sm text-fg-3"
                      >
                        {saving || pending ? SAVING_LABEL : SAVED_LABEL}
                      </span>
                    ) : null}
                  </span>
                </span>
                {props.share !== undefined ? (
                  <IconButton
                    type="button"
                    label={SHARE_LABEL}
                    data-task-share=""
                    disabled={!ready}
                    onClick={openShare}
                  >
                    <IconForward size={ICON_SIZE.control} />
                  </IconButton>
                ) : null}
              </>
            }
          />
        </div>
        {ready ? <ChipLine chip={chip} counts={counts} onChip={setPickedChip} /> : null}
        <div
          ref={bodyRef}
          data-task-sheet=""
          className="min-h-0 flex-1 overflow-y-auto pb-[max(12px,env(safe-area-inset-bottom))]"
        >
          {saveFailed ? (
            <p role="alert" data-task-save-failed="" className="px-4 pt-3 text-md text-bad">
              {SAVE_FAILED}
            </p>
          ) : null}
          {strip !== null && ready ? (
            <p
              data-task-strip=""
              className="mx-3 mt-3 flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-md text-fg lit-tint"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              {strip}
            </p>
          ) : null}
          {tasks.loadState === 'loading' ? <TasksSkeleton /> : null}
          {tasks.loadState === 'failed' ? (
            <LoadError
              title={TASKS_LOAD_THING}
              onRetry={tasks.refetch}
              retrying={tasks.retrying}
              className="mx-4 my-4"
            />
          ) : null}
          {ready ? (
            <ul data-task-list="" data-task-chip={chip} className="flex flex-col pb-1">
              {pastSplit ? (
                <>
                  {listed.some((e) => !isDone(e)) ? (
                    <li data-task-section="open" className={SECTION_LABEL}>
                      {PAST_OPEN_LABEL}
                    </li>
                  ) : null}
                  {listed.filter((e) => !isDone(e)).map(renderEntry)}
                  {listed.some(isDone) ? (
                    <li data-task-section="done" className={SECTION_LABEL}>
                      {PAST_DONE_LABEL}
                    </li>
                  ) : null}
                  {listed.filter(isDone).map(renderEntry)}
                </>
              ) : (
                listed.map(renderEntry)
              )}
              {zero ? (
                <li data-task-zero="" className="px-4 py-4 text-base text-fg-3">
                  {CHIP_ZERO[chip]}
                </li>
              ) : null}
              <AddRow
                calendar={calendar}
                disabled={side === null || draft.creates.length >= 50}
                onPickDate={(current, set) => setPick({ current, set })}
                onAdd={(title, priority, dueOn) => {
                  if (side === null) return;
                  setSaveFailed(false);
                  setDraft((d) => ({
                    ...d,
                    creates: [
                      ...d.creates,
                      {
                        key: `new-${(newSeq += 1)}`,
                        title: title.trim(),
                        priority,
                        side,
                        dueOn,
                      },
                    ],
                  }));
                  // The sheet moves to the chip the new task lands on.
                  setPickedChip(taskWhen({ dueOn }, days));
                }}
              />
            </ul>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
  return (
    <>
      {sheet}
      <Sheet open={pick !== null} onClose={() => setPick(null)} title={PICK_DATE_LABEL}>
        <div data-task-pick="" className="px-4 pb-4 pt-2">
          <DatePicker
            value={pick?.current ?? ''}
            label="Due date"
            placeholder={PICK_DATE_LABEL}
            disablePast
            onChange={(iso) => {
              if (pick !== null && iso !== '' && isPickableDay(iso, calendar)) pick.set(iso);
              setPick(null);
            }}
          />
        </div>
      </Sheet>
      {props.share !== undefined ? (
        <ForwardPicker
          open={props.open && shareOpen}
          onClose={() => setShareOpen(false)}
          channels={props.share.channels}
          onSend={taskShare.share}
          onSent={() => {
            setShareOpen(false);
            requestClose();
          }}
        />
      ) : null}
    </>
  );
}

/** A conflict on a task this page never held (read later): their version alone. */
function taskFromConflictStub(c: TaskConflict): ChatTask {
  return {
    id: c.taskId,
    channelId: '',
    number: 0,
    title: c.title,
    side: 'agency',
    status: c.status,
    priority: c.priority,
    createdBy: null,
    createdAt: c.updatedAt,
    updatedAt: c.updatedAt,
    deletedAt: null,
    dueOn: c.dueOn,
    doneAt: null,
  };
}
