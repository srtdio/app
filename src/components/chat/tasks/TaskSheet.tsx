// The chat's Tasks: one shared list, a full page like Contact, Group info and
// Starred (ModalPanel: grey page, header with Back on the left). Every member
// has the same powers (tick, inline edit, priority, date, delete, add, Save,
// Share). Nothing writes until Save: the page holds a local draft (edits, new
// tasks, queued deletes, each touched task's base updated_at), and Save sends
// it as ONE chat_task_save_batch. A change that is reverted is no change.
//
// Header: Back, "Tasks" (with "<Name> is editing…" under it while another
// member holds unsaved changes), and a ⋯ menu (ui/ActionMenu): Save (only
// while something changed, with the count), Search, Share to chat. The list
// is one scroll in sections (src/lib/chat/task-when.ts; due days on the
// workspace calendar): Overdue, Today, This week, Later, No date, each shown
// only while it holds tasks, then Done folded at the end (tap to open). A row
// is tick, title, priority; the day sits under the title only when the section
// does not already say it. A long-press (right-click on laptop) on a title
// opens the row's menu: Today, Tomorrow, Pick a date (the shared calendar in
// a sheet; never before today), No date, Delete. The last line is "Add a task":
// type and Enter, and the task lands in No date until a day is given. Search
// (from the menu) opens a field under the header and lists matches across
// every section as one flat list.
// Back, Esc or System Back with unsaved changes asks in the page "Discard
// unsaved changes?" (Discard / Save); never window.confirm. Laptop: Cmd/Ctrl+S
// saves.
//
// Marks: on open, tasks other people changed since this device last looked
// (or, never looked, the latest Save by someone else) carry an accent dot,
// their changed chip ringed and a sub-line ("was <s>old</s>", "priority was
// <s>P2</s>", "marked done", "reopened", "New task"), under the strip "<Name>
// changed N tasks · marked below". Someone saving while this page is open
// updates rows this person has not touched at once (marked, "<Name> just
// saved"); a touched row keeps this person's edit and shows "<Name> changed
// this to …" with Keep mine / Keep theirs. A Save whose edits hit a task
// changed since comes back with conflicts: everything else is saved, and each
// conflicting row asks the same (a deleted one: "<Name> deleted this" with
// Restore mine / OK). Marks clear when the page closes (the caller writes the
// seen time then). Motion (docs/motion.md): the page rises on a phone
// (ModalPanel); a row that arrives, or moves to another section, rises 8px
// into place (itemIn); the Done fold opens instantly. Never a fade. Boxes
// (Bone) while the list loads. Tokens only.

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
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Backdrop } from '@/components/ui/Backdrop';
import { Button } from '@/components/ui/Button';
import { DatePicker } from '@/components/ui/DatePicker';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { LoadError } from '@/components/ui/LoadError';
import { NoResults } from '@/components/ui/NoResults';
import { PressableRow } from '@/components/ui/PressableRow';
import { SearchWordsContext, glowTarget } from '@/components/ui/SearchHighlight';
import { Sheet } from '@/components/ui/Sheet';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { MODAL_HEADER_SAFE, MODAL_PAGE_CLASS, ModalPanel } from '@/components/chat/ModalPanel';
import {
  ICON_SIZE,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconForward,
  IconPlus,
  IconSearch,
  IconX,
} from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
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
import { Bone, BoxSkeleton, itemIn, useFreshKeys } from '@/lib/motion';
import { queryWords } from '@/lib/chat/search';
import {
  DONE_SECTION_LABEL,
  TASK_SECTIONS,
  calendarDays,
  dayChoices,
  groupBySection,
  isPickableDay,
  rowDateLine,
  searchTasks,
  type TaskCalendar,
  type TaskSection,
} from '@/lib/chat/task-when';
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
const SEARCH_LABEL = 'Search tasks';
const BACK_LABEL = 'Close tasks';
const ZERO_LINE = 'Tasks show up here.';
const SECTION_LABEL = 'text-sm font-semibold uppercase tracking-[0.06em]';

/** "<Name> just saved" (a Save by someone else while this page is open). Pure. */
function justSavedLabel(name: string): string {
  return `${name} just saved`;
}

/** "3 changes" under the menu's Save. Pure. */
export function changesLabel(n: number): string {
  return `${n} change${n === 1 ? '' : 's'}`;
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

/** The fields a section is read from. Pure. */
function sectionable(e: Entry): Pick<ChatTask, 'dueOn' | 'status' | 'doneAt' | 'number'> {
  return e.kind === 'task'
    ? e.shown
    : { dueOn: e.c.dueOn, status: 'todo', doneAt: null, number: e.number };
}

/**
 * The last line: "Add a task". Type and Enter adds it (No date until a day is
 * given); a priority chip appears beside the text while there is any.
 */
function AddLine(props: {
  disabled: boolean;
  onAdd: (title: string, priority: TaskPriority) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_PRIORITY);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (props.disabled || text.trim() === '') return;
    props.onAdd(text, priority);
    setText('');
    setPriority(DEFAULT_PRIORITY);
    inputRef.current?.focus();
  };
  return (
    <form
      data-task-add=""
      onSubmit={submit}
      className="flex min-h-[44px] items-center gap-1 border-t border-border pl-1 pr-1"
    >
      <span
        aria-hidden="true"
        className="flex h-11 w-11 shrink-0 items-center justify-center text-fg-3"
      >
        <IconPlus size={ICON_SIZE.control} />
      </span>
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
      {text.trim() !== '' ? (
        <PriorityChip
          priority={priority}
          onPick={setPriority}
          label={`New task priority P${priority}`}
          disabled={props.disabled}
        />
      ) : null}
    </form>
  );
}

/** The search field under the header, with Cancel. */
function SearchLine(props: {
  query: string;
  onQuery: (q: string) => void;
  onClose: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div data-task-search="" className="flex items-center gap-2 px-3 py-2">
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
        onClick={props.onClose}
        className="shrink-0"
      >
        Cancel
      </Button>
    </div>
  );
}

/** A section's label line: the name and its count. */
function SectionHead(props: { label: string; count: number; bad?: boolean }): ReactElement {
  return (
    <h3 className="flex h-9 items-center gap-2 px-4">
      <span className={cn(SECTION_LABEL, props.bad === true ? 'text-bad' : 'text-fg-2')}>
        {props.label}
      </span>
      <span className="font-mono text-sm tabular-nums text-fg-3">{props.count}</span>
    </h3>
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Done unfolded; the row (a task id or a new task's key) whose calendar is open.
  const [doneOpen, setDoneOpen] = useState(false);
  const [pickFor, setPickFor] = useState<string | null>(null);
  // The thread's search words (a search jump opened the page); the page's own
  // search replaces them while it runs.
  const threadWords = useContext(SearchWordsContext);
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
      setSearchOpen(false);
      setQuery('');
      setDoneOpen(false);
      setPickFor(null);
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

  const payload = useMemo(() => batchPayload(draft, byId), [draft, byId]);
  const changeCount = payload.creates.length + payload.edits.length + payload.deletes.length;
  const save = useCallback((): void => {
    void runSave(draft, payload);
  }, [runSave, draft, payload]);

  const close = props.onClose;
  const requestClose = useCallback((): void => {
    if (saving) return;
    if (dirty) {
      setConfirming(true);
      return;
    }
    close();
  }, [saving, dirty, close]);

  useEscapeLayer(props.open && !confirming && !shareOpen && pickFor === null, requestClose);
  // Esc in an open search ends the search first (the top layer), never the page.
  const closeSearch = useCallback((): void => {
    setQuery('');
    setSearchOpen(false);
  }, []);
  useEscapeLayer(
    props.open && searchOpen && !confirming && !shareOpen && pickFor === null,
    closeSearch,
  );

  // The header (focus returns here after the discard prompt; ModalPanel owns the trap).
  const panelRef = useRef<HTMLDivElement>(null);
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

  // A bell row's task comes into view with the arrival tint (Done unfolds for a done one).
  const focusTaskId = props.focusTaskId === TASKS_SHEET_ONLY ? null : props.focusTaskId;
  const focusTask = focusTaskId !== null ? byId.get(focusTaskId) : undefined;
  const focusShown = focusTask !== undefined;
  const focusDone = focusTask?.status === 'done';
  useEffect(() => {
    if (props.open && focusDone) setDoneOpen(true);
  }, [props.open, focusDone]);
  useEffect(() => {
    if (!props.open || focusTaskId === null || !focusShown) return;
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
  }, [props.open, focusTaskId, focusShown]);

  // When each row falls, on the workspace calendar, as it looks with this
  // draft's changes; new tasks by the day they were given.
  const calendar: TaskCalendar = {
    now: new Date(),
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
  const sectioned = groupBySection(
    entries.map((e) => ({ ...sectionable(e), e })),
    days,
  );
  const sectionOf = new Map<string, TaskSection>();
  for (const key of Object.keys(sectioned) as TaskSection[]) {
    for (const row of sectioned[key]) sectionOf.set(row.e.key, key);
  }

  // itemIn: a task that arrives while the list is on screen (added here, or
  // saved by someone else), or moves to another section, rises 8px into
  // place; the list's first paint, a load and a reopen never move.
  const freshRows = useFreshKeys(entries.map((e) => e.key));
  const listShown = props.open && tasks.loadState === 'ready';
  const wasListShown = useRef(false);
  const prevSections = useRef<Map<string, TaskSection>>(new Map());
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (wasListShown.current && body !== null) {
      const moved = [...sectionOf].filter(([key, section]) => {
        const was = prevSections.current.get(key);
        return was !== undefined && was !== section;
      });
      for (const key of [...freshRows, ...moved.map(([key]) => key)]) {
        itemIn(body.querySelector(`[data-task-row-id="${key}"]`));
      }
    }
    wasListShown.current = listShown;
    prevSections.current = listShown ? sectionOf : new Map();
  });
  if (!props.open) return null;

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
  const words = searchOpen ? queryWords(query) : [];
  const searching = words.length > 0;
  const choices = dayChoices(calendar);
  // A day for a row: a saved task's edit, or a new task's own day.
  const setDay = (key: string, dueOn: string | null): void => {
    const task = byId.get(key);
    if (task !== undefined) edit(task, { dueOn });
    else editNew(key, { dueOn });
  };
  const pickEntry = pickFor !== null ? entries.find((e) => e.key === pickFor) : undefined;
  const pickValue =
    pickEntry === undefined
      ? null
      : pickEntry.kind === 'task'
        ? pickEntry.shown.dueOn
        : pickEntry.c.dueOn;
  const rowMenu = (key: string, dueOn: string | null): RowMenu => ({
    choices,
    hasDate: dueOn !== null,
    onDay: (day) => setDay(key, day),
    onPickDate: () => setPickFor(key),
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

  const pageOrder: TaskSection[] = [...TASK_SECTIONS.map((s) => s.key), 'done'];
  const inPageOrder = pageOrder.flatMap((key) => sectioned[key].map((r) => r.e));
  const matches = searching
    ? searchTasks(
        inPageOrder.map((e) => ({ e, title: e.kind === 'task' ? e.shown.title : e.c.title })),
        words,
      ).map((m) => m.e)
    : [];
  const doneRows = sectioned.done;
  const total = entries.length;

  const headerItems: ActionMenuItem[] = [];
  if (dirty && !saving) {
    headerItems.push({
      id: 'save',
      label: saveFailed ? 'Retry' : 'Save',
      icon: IconCheck,
      ...(changeCount > 0 ? { description: changesLabel(changeCount) } : {}),
      onSelect: save,
    });
  }
  if (ready) {
    headerItems.push({
      id: 'search',
      label: SEARCH_LABEL,
      icon: IconSearch,
      onSelect: () => setSearchOpen(true),
    });
  }
  if (props.share !== undefined && ready) {
    headerItems.push({
      id: 'share',
      label: SHARE_LABEL,
      icon: IconForward,
      onSelect: () => {
        if (saving) return;
        resetShare();
        setShareOpen(true);
      },
    });
  }

  const side = props.side;
  const page = createPortal(
    <ModalPanel aria-label={TASK_SHEET_TITLE} data-task-page="" className={MODAL_PAGE_CLASS}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'flex shrink-0 items-center gap-2.5 border-b bg-panel px-2 md:px-4 lit-header focus:outline-none',
          MODAL_HEADER_SAFE,
        )}
      >
        <IconButton
          label={BACK_LABEL}
          data-task-back=""
          onClick={requestClose}
          {...(saving ? { 'aria-disabled': 'true' as const } : {})}
        >
          <IconChevronLeft size={ICON_SIZE.control} />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-lg font-semibold text-fg">{TASK_SHEET_TITLE}</h2>
          {editingLine !== null ? (
            <p data-task-editing="" className="truncate text-sm text-fg-3">
              {editingLine}
            </p>
          ) : null}
        </div>
        {headerItems.length > 0 ? (
          <ActionMenu title={TASK_SHEET_TITLE} items={headerItems} />
        ) : null}
      </div>
      <div
        ref={bodyRef}
        data-task-sheet=""
        className="min-h-0 flex-1 overflow-y-auto pb-[max(12px,env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col">
          {searchOpen && ready ? (
            <SearchLine query={query} onQuery={setQuery} onClose={closeSearch} />
          ) : null}
          {saving ? (
            <p data-task-saving="" className="px-4 pt-3 text-md text-fg-3">
              {SAVING_LABEL}
            </p>
          ) : null}
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
              <div
                data-task-list=""
                data-task-chip={searching ? 'search' : 'all'}
                className="flex flex-col pb-1"
              >
                {searching ? (
                  matches.length > 0 ? (
                    <ul className="flex flex-col divide-y divide-border border-y border-border">
                      {matches.map(renderEntry)}
                    </ul>
                  ) : (
                    <NoResults query={query} filtersActive={false} onClear={() => setQuery('')} />
                  )
                ) : (
                  <>
                    {TASK_SECTIONS.map((s) =>
                      sectioned[s.key].length > 0 ? (
                        <section key={s.key} data-task-section={s.key} className="pt-2">
                          <SectionHead
                            label={s.label}
                            count={sectioned[s.key].length}
                            bad={s.key === 'overdue'}
                          />
                          <ul className="flex flex-col divide-y divide-border border-y border-border">
                            {sectioned[s.key].map((r) => renderEntry(r.e))}
                          </ul>
                        </section>
                      ) : null,
                    )}
                    {doneRows.length > 0 ? (
                      <section data-task-section="done" className="pt-2">
                        <PressableRow
                          type="button"
                          data-task-done-fold=""
                          aria-expanded={doneOpen}
                          onClick={() => setDoneOpen((was) => !was)}
                          onContextMenu={(e) => e.preventDefault()}
                          className={cn(
                            'flex h-9 min-h-9 items-center gap-2 px-4',
                            NO_TOUCH_SELECT,
                          )}
                        >
                          <span className={cn(SECTION_LABEL, 'text-fg-2')}>
                            {DONE_SECTION_LABEL}
                          </span>
                          <span className="font-mono text-sm tabular-nums text-fg-3">
                            {doneRows.length}
                          </span>
                          <span className={cn('ml-auto text-fg-3', doneOpen && 'rotate-180')}>
                            <IconChevronDown size={ICON_SIZE.inline} />
                          </span>
                        </PressableRow>
                        {doneOpen ? (
                          <ul className="flex flex-col divide-y divide-border border-y border-border">
                            {doneRows.map((r) => renderEntry(r.e))}
                          </ul>
                        ) : null}
                      </section>
                    ) : null}
                    {total === 0 ? (
                      <p data-task-zero="" className="px-4 py-6 text-base text-fg-3">
                        {ZERO_LINE}
                      </p>
                    ) : null}
                    <AddLine
                      disabled={saving || side === null || draft.creates.length >= 50}
                      onAdd={(title, priority) => {
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
                              dueOn: null,
                            },
                          ],
                        }));
                      }}
                    />
                  </>
                )}
              </div>
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
    </ModalPanel>,
    document.body,
  );
  return (
    <>
      {page}
      <Sheet open={pickFor !== null} onClose={() => setPickFor(null)} title={PICK_DATE_LABEL}>
        <div data-task-pick="" className="px-4 pb-4 pt-2">
          <DatePicker
            value={pickValue ?? ''}
            label="Due date"
            placeholder={PICK_DATE_LABEL}
            disablePast
            onChange={(iso) => {
              if (pickFor !== null && iso !== '' && isPickableDay(iso, calendar)) {
                setDay(pickFor, iso);
              }
              setPickFor(null);
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
            if (!dirty) close();
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
