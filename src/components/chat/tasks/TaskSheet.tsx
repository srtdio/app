// The chat's Tasks: one shared, flat, numbered list. Every member has the same
// powers (tick, inline edit, priority, delete, add, Save, Share). Nothing
// writes until Save: the sheet holds a local draft (edits, new tasks, queued
// deletes, each touched task's base updated_at), and Save sends it as ONE
// chat_task_save_batch. A change that is reverted is no change.
//
// Header: "Tasks" (with "<Name> is editing…" under it while another member
// holds unsaved changes), Share, Save (disabled until something changed),
// Full screen / Half screen, X. Under it one line: the chips Past, Today, This
// week, Later, No date (src/lib/chat/task-when.ts; due days on the workspace
// calendar), and a search button at its end. Search opens a field in that
// line (the chips glide aside on a phone, Cancel brings them back) and finds
// tasks across every chip. The sheet opens half height on Today (else the
// first chip that holds tasks); swipe up on the header, or the Full screen
// button, fills the screen (laptop: a larger centre box); swipe down or Half
// screen returns. The resize itself is instant (no move in src/lib/motion
// fits it). Past lists Not done above Done. A new task takes a day (Today,
// Tomorrow, No date, or a picked day; never before today), and the sheet
// moves to the chip it lands on.
// Closing with unsaved changes asks in the page "Discard unsaved changes?"
// (Discard / Save); never window.confirm. Laptop: Cmd/Ctrl+S saves, Esc
// closes. System Back with unsaved changes asks the same.
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
// position; laptop: the dialog grows 95% to 100%. Never a fade. Boxes (Bone)
// while the list loads. Tokens only.

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FormEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Backdrop } from '@/components/ui/Backdrop';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { DatePicker } from '@/components/ui/DatePicker';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { LoadError } from '@/components/ui/LoadError';
import { NoResults } from '@/components/ui/NoResults';
import { SearchWordsContext, glowTarget } from '@/components/ui/SearchHighlight';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import {
  ICON_SIZE,
  IconCollapse,
  IconExpand,
  IconForward,
  IconSearch,
  IconX,
} from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { PriorityChip, TaskRow, type RowNotice } from '@/components/chat/tasks/TaskRow';
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
  glideAside,
  itemIn,
  riseIn,
  riseOut,
  trackDim,
  useDragDismiss,
  useFreshKeys,
  usePresence,
} from '@/lib/motion';
import { queryWords } from '@/lib/chat/search';
import {
  TASK_WHEN_CHIPS,
  calendarDays,
  countByWhen,
  dayChoices,
  isPickableDay,
  openingChip,
  searchTasks,
  taskDateLine,
  taskWhen,
  type TaskCalendar,
  type TaskWhen,
} from '@/lib/chat/task-when';
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

export const TASK_SHEET_TITLE = 'Tasks';
const SHARE_LABEL = 'Share to chat';
export const ADD_PLACEHOLDER = 'Add a task';
export const DISCARD_TITLE = 'Discard unsaved changes?';
const SAVE_FAILED = errorText('save', null);
/** LoadError's "Couldn't load tasks." */
const TASKS_LOAD_THING = 'tasks';
const SAVING_LABEL = 'Saving…';
const FULL_LABEL = 'Full screen';
const HALF_LABEL = 'Half screen';
const SEARCH_LABEL = 'Search tasks';
const PAST_OPEN_LABEL = 'Not done';
const PAST_DONE_LABEL = 'Done';
const PICK_DATE_LABEL = 'Pick date';
const SECTION_LABEL = 'px-4 pb-1 pt-3 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2';

/** One positive line per chip when it holds nothing. */
const CHIP_ZERO: Readonly<Record<TaskWhen, string>> = {
  past: 'Tasks from past days show up here.',
  today: 'Tasks due today show up here.',
  week: 'Tasks due later this week show up here.',
  later: 'Tasks due after this week show up here.',
  none: 'Tasks without a date show up here.',
};

/** "<Name> just saved" (a Save by someone else while this sheet is open). Pure. */
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

function AddRow(props: {
  preview: number;
  disabled: boolean;
  calendar: TaskCalendar;
  onAdd: (title: string, priority: TaskPriority, dueOn: string | null) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_PRIORITY);
  const choices = dayChoices(props.calendar);
  const today = choices[0]?.dueOn ?? null;
  // The day a new task takes: Today until another is picked.
  const [dueOn, setDueOn] = useState<string | null>(today);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (props.disabled || text.trim() === '') return;
    props.onAdd(text, priority, dueOn);
    setText('');
    setPriority(DEFAULT_PRIORITY);
    setDueOn(today);
    inputRef.current?.focus();
  };
  return (
    <li className="flex flex-col gap-2 px-3 pt-1">
      <form
        data-task-add=""
        onSubmit={submit}
        className="flex min-h-[44px] items-center gap-1 rounded-lg border border-field bg-panel-2 pl-1 pr-1 lit-well focus-within:lit-focus"
      >
        <span aria-hidden="true" className="w-11 shrink-0" />
        <span className="w-6 shrink-0 font-mono text-sm text-fg-3">{props.preview}</span>
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
          className="min-h-[44px] min-w-0 flex-1 bg-transparent text-input text-fg placeholder:text-fg-3 outline-none md:text-base"
        />
        <PriorityChip
          priority={priority}
          onPick={setPriority}
          label={`New task priority P${priority}`}
          disabled={props.disabled}
        />
        <Button
          type="submit"
          variant="link"
          data-task-add-submit=""
          disabled={props.disabled || text.trim() === ''}
          onMouseDown={(e) => e.preventDefault()}
          className={cn('min-w-11 shrink-0', NO_TOUCH_SELECT)}
        >
          Add
        </Button>
      </form>
      <DayChoices
        calendar={props.calendar}
        value={dueOn}
        disabled={props.disabled}
        onPick={setDueOn}
        name="add"
      />
    </li>
  );
}

/**
 * The day choices: Today, Tomorrow, No date, and Pick date (the shared
 * calendar; never a day before today). Under the add row they set a new
 * task's day; under a task (its date line tapped) they change its day.
 */
function DayChoices(props: {
  calendar: TaskCalendar;
  value: string | null;
  disabled?: boolean;
  onPick: (dueOn: string | null) => void;
  /** Which control this is ("add", or a task id), for its hooks. */
  name: string;
}): ReactElement {
  const choices = dayChoices(props.calendar);
  const quick = choices.find((c) => c.dueOn === props.value);
  return (
    <div
      data-task-days={props.name}
      role="group"
      aria-label="Due date"
      className="flex flex-wrap items-center gap-2"
    >
      {choices.map((c) => (
        <Chip
          key={c.key}
          label={c.label}
          selected={quick?.key === c.key}
          data-task-day={c.key}
          disabled={props.disabled}
          onClick={() => props.onPick(c.dueOn)}
        />
      ))}
      <div className="w-40 min-w-0">
        <DatePicker
          value={quick === undefined && props.value !== null ? props.value : ''}
          label={PICK_DATE_LABEL}
          placeholder={PICK_DATE_LABEL}
          disablePast
          onChange={(iso) => {
            if (iso !== '' && isPickableDay(iso, props.calendar)) props.onPick(iso);
          }}
        />
      </div>
    </div>
  );
}

/** A task's day choices under its row; they rise into place as they open (itemIn). */
function RowDayEditor(props: {
  calendar: TaskCalendar;
  value: string | null;
  onPick: (dueOn: string | null) => void;
  name: string;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    itemIn(ref.current);
  }, []);
  return (
    <div ref={ref} data-task-day-editor="" className="pb-3 pl-[80px] pr-3">
      <DayChoices
        calendar={props.calendar}
        value={props.value}
        onPick={props.onPick}
        name={props.name}
      />
    </div>
  );
}

/**
 * The chip line under the header: the five chips and a search button at the
 * end; search open, the field takes the line (the chips rest past the right
 * edge, gliding there on a phone) and Cancel ends it.
 */
function ChipLine(props: {
  chip: TaskWhen;
  counts: Record<TaskWhen, number>;
  onChip: (chip: TaskWhen) => void;
  searchOpen: boolean;
  query: string;
  onQuery: (query: string) => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  laptop: boolean;
}): ReactElement {
  const chipsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(props.searchOpen);
  // The chips' end pose is set by class; the glide is laid over it (phone only).
  useLayoutEffect(() => {
    if (wasOpen.current === props.searchOpen) return;
    wasOpen.current = props.searchOpen;
    if (!props.laptop) glideAside(chipsRef.current, props.searchOpen);
    if (props.searchOpen) inputRef.current?.focus();
  }, [props.searchOpen, props.laptop]);
  return (
    <div
      data-task-chip-line=""
      className="relative flex h-14 shrink-0 items-center gap-2 overflow-x-clip px-3"
    >
      <div
        ref={chipsRef}
        data-task-chips=""
        role="tablist"
        aria-label="When"
        className={cn(
          'flex min-w-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          props.searchOpen &&
            'absolute inset-y-0 right-3 items-center translate-x-[calc(100%+1rem)]',
        )}
      >
        {TASK_WHEN_CHIPS.map((c) => (
          <Chip
            key={c.key}
            label={c.label}
            count={props.counts[c.key]}
            tab
            selected={props.chip === c.key}
            data-task-when-chip={c.key}
            className="shrink-0"
            onClick={() => props.onChip(c.key)}
          />
        ))}
      </div>
      {props.searchOpen ? (
        <div data-task-search="" className="flex min-w-0 flex-1 items-center gap-2">
          <div className="group/sfield relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-3 group-focus-within/sfield:text-fg">
              <IconSearch size={ICON_SIZE.inline} />
            </span>
            <Input
              ref={inputRef}
              tone="search"
              type="search"
              value={props.query}
              onChange={(e) => props.onQuery(e.target.value)}
              aria-label={SEARCH_LABEL}
              placeholder={SEARCH_LABEL}
              className={cn('min-w-0 pl-7', props.query !== '' ? 'pr-11' : 'pr-2')}
            />
            {props.query !== '' ? (
              <IconButton
                type="button"
                label="Clear search"
                onClick={() => {
                  props.onQuery('');
                  inputRef.current?.focus();
                }}
                className="absolute right-0 top-1/2 -translate-y-1/2"
              >
                <IconX size={ICON_SIZE.inline} />
              </IconButton>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            data-task-search-cancel=""
            onPointerDown={(e) => e.preventDefault()}
            onClick={props.onCloseSearch}
            className="shrink-0"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <IconButton
          type="button"
          label={SEARCH_LABEL}
          data-task-search-open=""
          onClick={props.onOpenSearch}
          className="shrink-0"
        >
          <IconSearch size={ICON_SIZE.control} />
        </IconButton>
      )}
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
  const [draft, setDraft] = useState<SheetDraft>(EMPTY_DRAFT);
  const [notices, setNotices] = useState<Map<string, Notice>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // What the marks are measured from (frozen at open) and the latest other Save then.
  const [openedSeen, setOpenedSeen] = useState<number | null>(props.seenMs);
  const [openedAt, setOpenedAt] = useState<number>(() => Date.now());
  // The chip the person picked (null: follow the opening rule), the search,
  // and full screen. Each open starts at half height on the opening chip.
  const [pickedChip, setPickedChip] = useState<TaskWhen | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [full, setFull] = useState(false);
  // The row whose day choices are open (a task id or a new task's key).
  const [dateFor, setDateFor] = useState<string | null>(null);
  // The thread's search words (a search jump opened the sheet); the sheet's own
  // search replaces them while it runs.
  const threadWords = useContext(SearchWordsContext);
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
      setConfirming(false);
      setOpenedSeen(props.seenMs);
      setOpenedAt(Date.now());
      setPickedChip(null);
      setSearchOpen(false);
      setQuery('');
      setFull(false);
      setDateFor(null);
      return;
    }
    setShareOpen(false);
    // Only an open resets the sheet, never a data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  // The live "is editing" signal follows unsaved changes while open.
  const setEditing = tasks.setEditing;
  useEffect(() => {
    setEditing(props.open && dirty);
  }, [props.open, dirty, setEditing]);
  useEffect(() => () => setEditing(false), [setEditing]);

  // Someone else saved while this is open: untouched rows already show the
  // fresh list; touched rows get a notice. Skipped around this sheet's own Save.
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
      if (saving || isEmptyPayload(payload)) return;
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
      const conflicted = new Set(outcome.conflicts.map((c) => c.taskId));
      // Everything sent is saved, except the conflicts: those keep the edit.
      setDraft((cur) => {
        let out: SheetDraft = {
          ...cur,
          creates: cur.creates.filter((c) => !next.creates.includes(c)),
        };
        for (const e of payload.edits)
          if (!conflicted.has(e.task_id)) out = dropTask(out, e.task_id);
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
    [saving, tasks, byId],
  );

  const save = useCallback((): void => {
    void runSave(draft, batchPayload(draft, byId));
  }, [runSave, draft, byId]);

  const close = props.onClose;
  const requestClose = useCallback((): void => {
    if (saving) return;
    if (dirty) {
      setConfirming(true);
      return;
    }
    close();
  }, [saving, dirty, close]);

  useEscapeLayer(props.open && !confirming && !shareOpen, requestClose);
  // Esc in an open search ends the search first (the top layer), never the sheet.
  const closeSearch = useCallback((): void => {
    setQuery('');
    setSearchOpen(false);
  }, []);
  useEscapeLayer(props.open && searchOpen && !confirming && !shareOpen, closeSearch);

  // Phone: swipe up on the header fills the screen; swipe down there returns
  // to half height. The size change is instant at release (no move fits it).
  const resize = useDragDismiss({
    axis: 'y',
    direction: full ? 1 : -1,
    closeAt: SHEET_CLOSE_PX,
    enabled: !laptop && props.open,
    onMove: () => {},
    onDismiss: () => setFull((was) => !was),
    onCancel: () => {},
  });
  useModalFocus(panelRef, props.open && rendered);
  const guard = useBackGuard({
    active: props.open && (dirty || saving),
    onBack: () => {
      if (!saving) setConfirming(true);
    },
  });

  // Laptop: Cmd/Ctrl+S saves.
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && typeof e.key === 'string' && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.open, dirty, saving, save]);

  // A bell row's task comes into view with the arrival tint.
  const focusTaskId = props.focusTaskId === TASKS_SHEET_ONLY ? null : props.focusTaskId;
  const focusShown = focusTaskId !== null && byId.has(focusTaskId);
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

  // itemIn: a task that arrives while the list is on screen (added here, or
  // saved by someone else) rises 8px into place; the list's first paint, a
  // load and a reopen never move.
  const rowKeys = [...tasks.tasks.map((t) => t.id), ...draft.creates.map((c) => c.key)];
  const freshRows = useFreshKeys(rowKeys);
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

  // The rows: the live list, plus rows a notice keeps (deleted by someone else).
  const ghosts = [...notices.values()]
    .filter((n) => !byId.has(n.conflict.taskId))
    .map((n) => taskFromConflict(n.task, n.conflict));
  const rows = [...tasks.tasks, ...ghosts].sort((a, b) => a.number - b.number);
  const preview = nextNumberPreview(tasks.tasks) + draft.creates.length;
  const ready = tasks.loadState === 'ready';
  const editors = tasks.editors.map(tasks.nameOf);
  const editingLine = editingLabel(editors);

  // When each row falls, on the workspace calendar, as it looks with this
  // draft's changes; new tasks by the day they were given.
  const calendar: TaskCalendar = {
    now: new Date(),
    timeZone: props.timeZone,
    weekStartDay: props.weekStartDay,
  };
  const days = calendarDays(calendar);
  const shownOf = (task: ChatTask): ChatTask =>
    applyChanges(task, effectiveChanges(task, draft.edits[task.id]));
  const shownRows = rows.map(shownOf);
  const counts = countByWhen([...shownRows, ...draft.creates], days);
  const focusTask = focusTaskId !== null ? byId.get(focusTaskId) : undefined;
  const chip: TaskWhen =
    pickedChip ?? (focusTask !== undefined ? taskWhen(focusTask, days) : openingChip(counts));
  const words = searchOpen ? queryWords(query) : [];
  const searching = words.length > 0;
  const creates = draft.creates.map((c, k) => ({ c, k }));
  const listRows = searching
    ? searchTasks(shownRows, words)
    : shownRows.filter((t) => taskWhen(t, days) === chip);
  const listIds = new Set(listRows.map((t) => t.id));
  const visibleRows = rows.filter((t) => listIds.has(t.id));
  const visibleCreates = searching
    ? creates.filter(({ c }) => searchTasks([c], words).length > 0)
    : creates.filter(({ c }) => taskWhen(c, days) === chip);
  const doneIds = new Set(listRows.filter((t) => t.status === 'done').map((t) => t.id));
  const pastSplit = !searching && chip === 'past';
  const zero = visibleRows.length === 0 && visibleCreates.length === 0;
  // A day picked under a row: the choices close and, outside a search, the
  // sheet moves to the chip the task now sits under so it stays in view.
  const pickDay = (dueOn: string | null): void => {
    setDateFor(null);
    if (!searching) setPickedChip(taskWhen({ dueOn }, days));
  };

  const renderRow = (task: ChatTask): ReactElement => {
    const mine = effectiveChanges(task, draft.edits[task.id]);
    const shown = applyChanges(task, mine);
    const queued = draft.deletes.includes(task.id);
    const theirMarks: readonly TaskMark[] = marks.byTask.get(task.id) ?? [];
    const own = hasChanges(mine) || queued;
    return (
      <TaskRow
        key={task.id}
        id={task.id}
        number={task.number}
        title={shown.title}
        done={shown.status === 'done'}
        priority={shown.priority}
        dot={own || theirMarks.length > 0 || notices.has(task.id)}
        marks={own ? [] : theirMarks}
        queuedDelete={queued}
        notice={rowNotice(task.id)}
        dateLine={taskDateLine(shown, calendar)}
        onDate={() => setDateFor((open) => (open === task.id ? null : task.id))}
        dateOpen={dateFor === task.id && !queued}
        dateEditor={
          <RowDayEditor
            calendar={calendar}
            value={shown.dueOn}
            name={task.id}
            onPick={(dueOn) => {
              edit(task, { dueOn });
              pickDay(dueOn);
            }}
          />
        }
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

  const renderNew = ({ c, k }: { c: DraftNew; k: number }): ReactElement => (
    <TaskRow
      key={c.key}
      id={c.key}
      number={nextNumberPreview(tasks.tasks) + k}
      title={c.title}
      done={false}
      priority={c.priority}
      dot
      marks={[]}
      queuedDelete={false}
      canTick={false}
      notice={null}
      dateLine={taskDateLine({ dueOn: c.dueOn, status: 'todo', doneAt: null }, calendar)}
      onDate={() => setDateFor((open) => (open === c.key ? null : c.key))}
      dateOpen={dateFor === c.key}
      dateEditor={
        <RowDayEditor
          calendar={calendar}
          value={c.dueOn}
          name={c.key}
          onPick={(dueOn) => {
            editNew(c.key, { dueOn });
            pickDay(dueOn);
          }}
        />
      }
      onToggle={() => {}}
      onTitle={(title) => editNew(c.key, { title })}
      onPriority={(priority) => editNew(c.key, { priority })}
      onDelete={() =>
        setDraft((d) => ({ ...d, creates: d.creates.filter((x) => x.key !== c.key) }))
      }
      onUndoDelete={() => {}}
    />
  );

  const side = props.side;
  const sheet = createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
      <Backdrop ref={dimRef} aria-label="Close tasks" position="absolute" onClick={requestClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={TASK_SHEET_TITLE}
        data-task-full={full ? '' : undefined}
        className={cn(
          'relative flex w-full flex-col overflow-hidden bg-panel lit-overlay focus:outline-none sm:max-w-[92%] sm:rounded-xl sm:border',
          full
            ? 'h-[100svh] supports-[height:1dvh]:h-[100dvh] sm:h-[84svh] sm:w-[960px]'
            : 'max-h-[90svh] supports-[height:1dvh]:max-h-[90dvh] rounded-t-2xl border sm:w-[560px] sm:max-h-[84svh]',
        )}
      >
        <div
          data-task-head=""
          className={cn(
            'flex shrink-0 flex-col border-b border-border touch-none md:touch-auto',
            full && 'pt-[env(safe-area-inset-top)] sm:pt-0',
          )}
          {...resize}
        >
          {laptop ? null : (
            <div
              aria-hidden="true"
              className="mx-auto mt-1.5 h-1 w-9 rounded-sm bg-border-strong"
            />
          )}
          <div className="flex items-center gap-1 py-1.5 pl-4 pr-1.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="text-lg font-semibold text-fg">{TASK_SHEET_TITLE}</h2>
              {editingLine !== null ? (
                <p data-task-editing="" className="truncate text-sm text-fg-3">
                  {editingLine}
                </p>
              ) : null}
            </div>
            {props.share !== undefined && ready ? (
              <IconButton
                label={SHARE_LABEL}
                data-task-share=""
                onClick={() => {
                  if (saving) return;
                  resetShare();
                  setShareOpen(true);
                }}
              >
                <IconForward />
              </IconButton>
            ) : null}
            <Button
              variant="primary"
              data-task-save=""
              disabled={!dirty || saving}
              aria-busy={saving}
              onClick={save}
            >
              {saving ? SAVING_LABEL : saveFailed ? 'Retry' : 'Save'}
            </Button>
            <IconButton
              label={full ? HALF_LABEL : FULL_LABEL}
              data-task-resize=""
              onClick={() => setFull((was) => !was)}
            >
              {full ? (
                <IconCollapse size={ICON_SIZE.control} />
              ) : (
                <IconExpand size={ICON_SIZE.control} />
              )}
            </IconButton>
            <IconButton
              label="Close"
              onClick={requestClose}
              {...(saving ? { 'aria-disabled': 'true' as const } : {})}
            >
              <IconX size={ICON_SIZE.control} />
            </IconButton>
          </div>
        </div>
        {ready ? (
          <ChipLine
            chip={chip}
            counts={counts}
            onChip={setPickedChip}
            searchOpen={searchOpen}
            query={query}
            onQuery={setQuery}
            onOpenSearch={() => setSearchOpen(true)}
            onCloseSearch={closeSearch}
            laptop={laptop}
          />
        ) : null}
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
            <SearchWordsContext.Provider value={searching ? words : threadWords}>
              <ul
                data-task-list=""
                data-task-chip={searching ? 'search' : chip}
                className="flex flex-col py-1"
              >
                {pastSplit ? (
                  <>
                    {visibleRows.some((t) => !doneIds.has(t.id)) || visibleCreates.length > 0 ? (
                      <li data-task-section="open" className={SECTION_LABEL}>
                        {PAST_OPEN_LABEL}
                      </li>
                    ) : null}
                    {visibleRows.filter((t) => !doneIds.has(t.id)).map(renderRow)}
                    {visibleCreates.map(renderNew)}
                    {doneIds.size > 0 ? (
                      <li data-task-section="done" className={SECTION_LABEL}>
                        {PAST_DONE_LABEL}
                      </li>
                    ) : null}
                    {visibleRows.filter((t) => doneIds.has(t.id)).map(renderRow)}
                  </>
                ) : (
                  <>
                    {visibleRows.map(renderRow)}
                    {visibleCreates.map(renderNew)}
                  </>
                )}
                {zero && searching ? (
                  <li>
                    <NoResults query={query} filtersActive={false} onClear={() => setQuery('')} />
                  </li>
                ) : null}
                {zero && !searching ? (
                  <li data-task-zero="" className="px-4 py-4 text-base text-fg-3">
                    {CHIP_ZERO[chip]}
                  </li>
                ) : null}
                {searching ? null : (
                  <AddRow
                    preview={preview}
                    calendar={calendar}
                    disabled={saving || side === null || draft.creates.length >= 50}
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
                )}
              </ul>
            </SearchWordsContext.Provider>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <DiscardConfirm
          saving={saving}
          onDiscard={() => {
            setConfirming(false);
            setDraft(EMPTY_DRAFT);
            setNotices(new Map());
            guard.release();
            close();
          }}
          onSave={() => {
            setConfirming(false);
            save();
          }}
          onCancel={() => {
            setConfirming(false);
            panelRef.current?.focus();
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
  return (
    <>
      {sheet}
      {props.share !== undefined ? (
        <ForwardPicker
          open={props.open && shareOpen}
          onClose={() => setShareOpen(false)}
          channels={props.share.channels}
          onSend={taskShare.share}
          onSent={() => {
            setShareOpen(false);
            if (!dirty) close();
          }}
        />
      ) : null}
    </>
  );
}

/** A conflict on a task this sheet never held (read later): their version alone. */
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

/** The in-page "Discard unsaved changes?" with Discard / Save (Esc or outside: keep editing). */
function DiscardConfirm(props: {
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
  onCancel: () => void;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, props.onCancel);
  useModalFocus(panelRef, true);
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center">
      <Backdrop aria-label="Keep editing" position="absolute" onClick={props.onCancel} />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={DISCARD_TITLE}
        tabIndex={-1}
        data-task-discard=""
        className="relative w-full max-w-sm rounded-2xl border bg-panel p-5 lit-overlay outline-none"
      >
        <h2 className="text-lg font-semibold text-fg">{DISCARD_TITLE}</h2>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="danger" disabled={props.saving} onClick={props.onDiscard}>
            Discard
          </Button>
          <Button variant="primary" disabled={props.saving} onClick={props.onSave}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
