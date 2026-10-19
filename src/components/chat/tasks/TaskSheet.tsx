// The chat's Tasks: one shared, flat, numbered list. Every member has the same
// powers (tick, inline edit, priority, delete, add, Save, Share). Nothing
// writes until Save: the sheet holds a local draft (edits, new tasks, queued
// deletes, each touched task's base updated_at), and Save sends it as ONE
// chat_task_save_batch. A change that is reverted is no change.
//
// Header: X, "Tasks" (with "<Name> is editing…" under it while another member
// holds unsaved changes), Share, Save (disabled until something changed).
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
// seen time then). Motion: the panel moves on translateY only. Tokens only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { LoadError } from '@/components/ui/LoadError';
import { glowTarget } from '@/components/ui/SearchHighlight';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { IconForward, IconX } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { PriorityChip, TaskRow, type RowNotice } from '@/components/chat/tasks/TaskRow';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { useTaskShare, type TaskShareWiring } from '@/components/chat/tasks/useTaskShare';
import { useBackGuard } from '@/lib/back-guard';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import { DUR_BASE_MS } from '@/lib/motion';
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

export const TASK_SHEET_TITLE = 'Tasks';
export const SHARE_LABEL = 'Share to chat';
export const ADD_PLACEHOLDER = 'Add a task';
export const DISCARD_TITLE = 'Discard unsaved changes?';
export const SAVE_FAILED = "Couldn't save. Try again.";
/** LoadError's "Couldn't load tasks." */
export const TASKS_LOAD_THING = 'tasks';
export const SAVING_LABEL = 'Saving…';

/** "<Name> just saved" (a Save by someone else while this sheet is open). Pure. */
export function justSavedLabel(name: string): string {
  return `${name} just saved`;
}

let newSeq = 0;

/** A conflict or live-merge notice on one row: their version, and the task as it was. */
interface Notice {
  conflict: TaskConflict;
  task: ChatTask;
}

/** The newest batch id by someone else, or null. Pure. */
export function latestOtherBatch(events: readonly TaskEvent[], me: string): TaskEvent | null {
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
    <li>
      <form
        data-task-add=""
        onSubmit={submit}
        className="flex min-h-[44px] items-center gap-1 pl-1 pr-1"
      >
        <span aria-hidden="true" className="w-11 shrink-0" />
        <span className="w-6 shrink-0 font-mono text-[12.5px] text-fg-3">{props.preview}</span>
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
          className="min-h-[44px] min-w-0 flex-1 bg-transparent text-[16px] text-fg placeholder:text-fg-3 focus:outline-none"
        />
        <PriorityChip
          priority={priority}
          onPick={setPriority}
          label={`New task priority P${priority}`}
          disabled={props.disabled}
        />
        <button
          type="submit"
          data-task-add-submit=""
          disabled={props.disabled || text.trim() === ''}
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            'h-11 min-w-11 shrink-0 rounded-[8px] px-3 text-[13px] font-semibold text-accent hover:bg-panel-2 disabled:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            NO_TOUCH_SELECT,
          )}
        >
          Add
        </button>
      </form>
    </li>
  );
}

function TasksSkeleton(): ReactElement {
  return (
    <div data-task-skeleton="" aria-hidden="true" className="flex flex-col gap-3 px-4 py-4">
      {[0, 1, 2, 3].map((k) => (
        <div key={k} className="flex items-center gap-3">
          <span className="h-4 w-4 shrink-0 animate-pulse rounded-[4px] bg-panel-3" />
          <span className="h-4 flex-1 animate-pulse rounded-[4px] bg-panel-3" />
          <span className="h-4 w-8 shrink-0 animate-pulse rounded-[4px] bg-panel-3" />
        </div>
      ))}
    </div>
  );
}

export interface TaskSheetProps {
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
}

export function TaskSheet(props: TaskSheetProps): ReactElement | null {
  const { tasks, currentUserId } = props;
  const [draft, setDraft] = useState<SheetDraft>(EMPTY_DRAFT);
  const [notices, setNotices] = useState<Map<string, Notice>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [rendered, setRendered] = useState(props.open);
  const [entered, setEntered] = useState(false);
  // What the marks are measured from (frozen at open) and the latest other Save then.
  const [openedSeen, setOpenedSeen] = useState<number | null>(props.seenMs);
  const [openedBatch, setOpenedBatch] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const taskShare = useTaskShare(props.share ?? null);
  const resetShare = taskShare.reset;

  const byId = useMemo(() => new Map(tasks.tasks.map((t) => [t.id, t] as const)), [tasks.tasks]);
  const dirty = isDraftDirty(draft, byId) || notices.size > 0;

  // Enter / exit (translateY only); each open starts fresh.
  useEffect(() => {
    if (props.open) {
      setRendered(true);
      setDraft(EMPTY_DRAFT);
      setNotices(new Map());
      setSaveFailed(false);
      setConfirming(false);
      setOpenedSeen(props.seenMs);
      setOpenedBatch(latestOtherBatch(tasks.events, currentUserId)?.batchId ?? null);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    setShareOpen(false);
    const timer = setTimeout(() => setRendered(false), DUR_BASE_MS);
    return () => clearTimeout(timer);
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
    props.open && latest !== null && latest.batchId !== openedBatch && latest.actorId !== null
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
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
    if (!props.open || !entered || focusTaskId === null || !focusShown) return;
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
  }, [props.open, entered, focusTaskId, focusShown]);

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

  const renderNew = (c: DraftNew, k: number): ReactElement => (
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
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-end bg-black/45 transition-opacity duration-base sm:items-center sm:justify-center',
        entered ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={TASK_SHEET_TITLE}
        className={cn(
          'flex w-full max-h-[90vh] supports-[height:1dvh]:max-h-[90dvh] flex-col overflow-hidden rounded-t-2xl border border-border-strong bg-panel shadow-2xl transition-[opacity,transform] will-change-transform focus:outline-none sm:w-[560px] sm:max-w-[92%] sm:max-h-[84vh] sm:rounded-xl',
          entered
            ? 'translate-y-0 opacity-100 duration-slow ease-enter sm:duration-base'
            : 'translate-y-full opacity-100 duration-base ease-exit sm:translate-y-2 sm:opacity-0',
        )}
      >
        <div className="flex items-center gap-1 border-b border-border py-1.5 pl-1.5 pr-3">
          <IconButton
            label="Close"
            onClick={requestClose}
            {...(saving ? { 'aria-disabled': 'true' as const } : {})}
          >
            <IconX />
          </IconButton>
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="text-[15px] font-semibold text-fg">{TASK_SHEET_TITLE}</h2>
            {editingLine !== null ? (
              <p data-task-editing="" className="truncate text-[12px] text-fg-2">
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
            size="lg"
            variant="primary"
            data-task-save=""
            disabled={!dirty || saving}
            aria-busy={saving}
            onClick={save}
          >
            {saving ? SAVING_LABEL : saveFailed ? 'Retry' : 'Save'}
          </Button>
        </div>
        <div
          ref={bodyRef}
          data-task-sheet=""
          className="min-h-0 flex-1 overflow-y-auto pb-[max(12px,env(safe-area-inset-bottom))]"
        >
          {saveFailed ? (
            <p role="alert" data-task-save-failed="" className="px-4 pt-3 text-[13px] text-bad">
              {SAVE_FAILED}
            </p>
          ) : null}
          {strip !== null && ready ? (
            <p
              data-task-strip=""
              className="mx-3 mt-3 flex items-center gap-2 rounded-[8px] bg-accent-soft px-3 py-2 text-[13px] text-fg"
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
            <ul data-task-list="" className="flex flex-col py-1">
              {rows.map(renderRow)}
              {draft.creates.map(renderNew)}
              <AddRow
                preview={preview}
                disabled={saving || side === null || draft.creates.length >= 50}
                onAdd={(title, priority) => {
                  if (side === null) return;
                  setSaveFailed(false);
                  setDraft((d) => ({
                    ...d,
                    creates: [
                      ...d.creates,
                      { key: `new-${(newSeq += 1)}`, title: title.trim(), priority, side },
                    ],
                  }));
                }}
              />
            </ul>
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
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/45 px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={DISCARD_TITLE}
        tabIndex={-1}
        data-task-discard=""
        className="w-full max-w-sm rounded-2xl border border-border bg-panel p-5 shadow-lg outline-none"
      >
        <h2 className="text-sm font-semibold text-fg">{DISCARD_TITLE}</h2>
        <div className="mt-5 flex justify-end gap-2">
          <Button size="lg" variant="danger" disabled={props.saving} onClick={props.onDiscard}>
            Discard
          </Button>
          <Button size="lg" variant="primary" disabled={props.saving} onClick={props.onSave}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
