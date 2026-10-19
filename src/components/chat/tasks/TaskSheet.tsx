// The chat's Tasks: one sheet, everything in place. A header line (the accent
// tile, "2 open for creators · 2 for approvers" and Share), then Creators,
// Approvers and Done today (collapsed by default), each with its rows;
// Creators and Approvers end with an add row ("Add a task", then optional
// priority and Today/Tomorrow chips). Enter (or Add) adds a draft row marked
// "new" and clears the field for the next; nothing is written yet. Drafts can
// be edited or removed (x); the footer then reads Cancel / "Save N tasks", and
// Save is one chat_task_create_many (one chat line, one bell alert per
// member). A refused Save keeps the drafts and offers Retry; while saving the
// sheet cannot close. Drafts or an unsaved row edit make the sheet dirty: X,
// backdrop, Escape, Cancel and system Back all ask "Discard these tasks?"
// (the shared Sheet's guard). While the list loads it shows a skeleton; a
// failed read shows the shared load error and Retry, never an empty list.
// One row at a time expands in place in edit mode; the others dim (opacity
// only) and the order holds until it collapses. Leaving an edit with changes
// (Cancel, another row, a tap outside, closing) asks "Discard your changes?"
// first. Delete hides the row at once behind an Undo toast. Opened for a task
// that is not in the list (closed before today), the sheet reads it and shows
// it expanded under Done today. The footer names the last change. The shared bottom
// Sheet opens and closes it (translateY only). "Send to chat" opens the forward
// picker and runs through the thread's send and forward (useTaskShare); a
// confirmed share closes both sheets. Tokens only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadError } from '@/components/ui/LoadError';
import { Sheet } from '@/components/ui/Sheet';
import { glowTarget } from '@/components/ui/SearchHighlight';
import { useOptionalToast } from '@/components/ui/toast';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { IconCheck, IconForward, IconPlus, IconX } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { DueCell, NotSaved, PriorityTag, Segment, TaskRow } from '@/components/chat/tasks/TaskRow';
import { TaskGlyph } from '@/components/chat/tasks/TaskGlyph';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { useTaskShare, type TaskShareWiring } from '@/components/chat/tasks/useTaskShare';
import { cn } from '@/lib/cn';
import { civilDay } from '@/lib/chat/time-format';
import {
  addCivilDays,
  civilHourToUtcIso,
  DEFAULT_DUE_HOUR,
  groupTasks,
  holdOrder,
  isDeleted,
  isPastHour,
  lastChangeLine,
  nextNumberPreview,
  SIDE_LABEL,
  TASK_BATCH_MAX,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  TASKS_SHEET_ONLY,
  type ChatTask,
  type TaskPriority,
  type TaskSide,
} from '@/lib/chat/tasks';

export const TASK_SHEET_TITLE = 'Tasks';
export const SEND_TO_CHAT_LABEL = 'Send to chat';
export const ADD_PLACEHOLDER = 'Add a task';
export const DISCARD_TITLE = 'Discard your changes?';
export const DISCARD_MESSAGE = 'Your edits to this task are not saved.';
/** Closing (X, backdrop, Escape, Cancel, Back) with drafts or an unsaved row edit. */
export const DISCARD_TASKS_TITLE = 'Discard these tasks?';
export const DISCARD_TASKS_MESSAGE = "Tasks you haven't saved will be lost.";
export const SAVE_TASKS_FAILED = "Couldn't save these tasks. Try again.";
/** LoadError's "Couldn't load tasks." */
export const TASKS_LOAD_THING = 'tasks';
export const SAVING_LABEL = 'Saving…';

/** The footer's Save: "Save 1 task", "Save 5 tasks". Pure. */
export function saveTasksLabel(count: number): string {
  return `Save ${count} ${count === 1 ? 'task' : 'tasks'}`;
}

/** The toast after a Save: "1 task added", "5 tasks added". Pure. */
export function tasksAddedLabel(count: number): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'} added`;
}

/** A task typed in the add row, not written until Save. */
export interface TaskDraftRow {
  key: string;
  side: TaskSide;
  title: string;
  priority: TaskPriority;
  dueAt: string | null;
}

let draftSeq = 0;

type GroupKey = 'agency' | 'client' | 'done';

const DOT: Record<GroupKey, string> = {
  agency: 'bg-accent',
  client: 'bg-stage-review',
  done: 'bg-stage-approved',
};

function GroupTitle(props: { group: GroupKey; label: string; count: number }): ReactElement {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', DOT[props.group])} />
      <span className="text-xs font-semibold uppercase tracking-[.06em] text-fg-2">
        {props.label}
      </span>
      <span className="font-mono text-xs text-fg-2">{props.count}</span>
    </span>
  );
}

type QuickDay = 'today' | 'tomorrow';

function AddRow(props: {
  side: TaskSide;
  preview: number;
  nowMs: number;
  timeZone: string;
  /** A Save is in flight, or the batch is full: typing waits. */
  disabled: boolean;
  onAdd: (title: string, options: { priority: TaskPriority; dueAt: string | null }) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [day, setDay] = useState<QuickDay | null>(null);
  const [focused, setFocused] = useState(false);
  // The row being typed in: the only one that shows the next number and chips.
  const typing = focused || text !== '';
  const today = civilDay(props.nowMs, props.timeZone);
  const todayOver = isPastHour(today, DEFAULT_DUE_HOUR, props.nowMs, props.timeZone);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (props.disabled || text.trim() === '') return;
    const civil = day === 'today' ? today : day === 'tomorrow' ? addCivilDays(today, 1) : null;
    props.onAdd(text, {
      priority,
      dueAt: civil !== null ? civilHourToUtcIso(civil, DEFAULT_DUE_HOUR, props.timeZone) : null,
    });
    // A draft, not a write; the field keeps focus for the next one.
    setText('');
    setPriority(2);
    setDay(null);
  };
  return (
    <li>
      <form
        data-task-add={props.side}
        onSubmit={submit}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          const next = e.relatedTarget;
          if (!(next instanceof Node) || !e.currentTarget.contains(next)) setFocused(false);
        }}
        className="flex flex-col"
      >
        <div className="flex min-h-[44px] items-center gap-[10px] px-4">
          <span aria-hidden="true" className="w-4 shrink-0" />
          <span
            {...(typing ? { 'data-task-preview': '' } : {})}
            className="w-5 shrink-0 font-mono text-[12.5px] text-accent"
          >
            {typing ? props.preview : ''}
          </span>
          <input
            type="text"
            aria-label={`Add to ${SIDE_LABEL[props.side]}`}
            enterKeyHint="next"
            autoComplete="off"
            value={text}
            disabled={props.disabled}
            maxLength={TASK_TITLE_MAX}
            placeholder={ADD_PLACEHOLDER}
            onChange={(e) => setText(e.target.value)}
            className="min-h-[44px] min-w-0 flex-1 bg-transparent text-[16px] text-fg placeholder:text-fg-3 focus:outline-none"
          />
          {text.trim() !== '' && !props.disabled ? (
            <button
              type="submit"
              data-task-add-submit=""
              onMouseDown={(e) => e.preventDefault()}
              className={cn(
                'h-11 min-w-11 shrink-0 rounded-[6px] bg-accent px-3 text-[13px] font-semibold text-accent-fg',
                NO_TOUCH_SELECT,
              )}
            >
              Add
            </button>
          ) : null}
        </div>
        {typing ? (
          <div data-task-add-chips="" className="flex gap-1.5 pb-2 pl-[42px] pr-3">
            {TASK_PRIORITIES.map((p) => (
              <Segment
                key={p}
                selected={priority === p}
                data={`add-p${p}`}
                className="flex-none min-w-11 px-2 font-mono"
                onClick={() => setPriority(p)}
              >
                P{p}
              </Segment>
            ))}
            <Segment
              selected={day === 'today'}
              data="add-today"
              disabled={todayOver}
              className="flex-none px-3"
              onClick={() => setDay((v) => (v === 'today' ? null : 'today'))}
            >
              Today
            </Segment>
            <Segment
              selected={day === 'tomorrow'}
              data="add-tomorrow"
              className="flex-none px-3"
              onClick={() => setDay((v) => (v === 'tomorrow' ? null : 'tomorrow'))}
            >
              Tomorrow
            </Segment>
          </div>
        ) : null}
      </form>
    </li>
  );
}

/** A draft: the accent "new" mark, its title (editable), P tag and due, and x. */
function DraftRow(props: {
  draft: TaskDraftRow;
  dimmed: boolean;
  disabled: boolean;
  nowMs: number;
  timeZone: string;
  onTitle: (title: string) => void;
  onRemove: () => void;
}): ReactElement {
  const { draft } = props;
  return (
    <li
      data-task-draft={draft.key}
      className={cn(
        'transition-opacity duration-fast',
        props.dimmed ? 'opacity-45' : 'opacity-100',
      )}
    >
      <div className="flex min-h-[44px] items-center gap-[10px] pl-4 pr-1">
        <span data-task-new="" className="flex w-[34px] shrink-0 items-center gap-0.5 text-accent">
          <IconPlus size={14} />
          <span className="text-[11px] font-semibold leading-4">new</span>
        </span>
        <input
          type="text"
          aria-label={`Task: ${draft.title}`}
          value={draft.title}
          disabled={props.disabled}
          maxLength={TASK_TITLE_MAX}
          onChange={(e) => props.onTitle(e.target.value)}
          className="min-h-[44px] min-w-0 flex-1 bg-transparent text-[16px] font-medium text-fg focus:outline-none"
        />
        <span className="flex items-center gap-2">
          <PriorityTag priority={draft.priority} />
          <DueCell
            task={{ dueAt: draft.dueAt, duePassedAt: null }}
            nowMs={props.nowMs}
            timeZone={props.timeZone}
          />
        </span>
        <button
          type="button"
          aria-label={`Remove ${draft.title.trim() !== '' ? draft.title : 'task'}`}
          data-task-draft-remove=""
          disabled={props.disabled}
          onClick={props.onRemove}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-panel-2 disabled:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            NO_TOUCH_SELECT,
          )}
        >
          <IconX size={16} />
        </button>
      </div>
    </li>
  );
}

/** The list loading: a few quiet rows, no counts. */
function TasksSkeleton(): ReactElement {
  return (
    <div data-task-skeleton="" aria-hidden="true" className="flex flex-col gap-3 px-4 py-4">
      {[0, 1, 2, 3].map((k) => (
        <div key={k} className="flex items-center gap-3">
          <span className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-panel-3" />
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
  timeZone: string;
  /** Opened for one task (a thread line, a task alert): that row starts expanded, read if needed. */
  focusTaskId: string | null;
  /** Share through the thread's send and forward; absent hides Share. */
  share?: TaskShareWiring;
}

export function TaskSheet(props: TaskSheetProps): ReactElement {
  const { tasks, timeZone } = props;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<Record<GroupKey, string[]> | null>(null);
  const [showDone, setShowDone] = useState(false);
  // The expanded row's draft differs from the task.
  const [dirty, setDirty] = useState(false);
  // A leave that waits on "Discard your changes?" (a row edit) or, from the
  // footer's Cancel, "Discard these tasks?".
  const [confirm, setConfirm] = useState<{ then: () => void; tasks?: boolean } | null>(null);
  // Typed, not written: one Save sends them all.
  const [drafts, setDrafts] = useState<TaskDraftRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const toast = useOptionalToast();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const taskShare = useTaskShare(props.share ?? null);
  const resetShare = taskShare.reset;

  const groups = useMemo(
    () => groupTasks(tasks.tasks, nowMs, timeZone),
    [tasks.tasks, nowMs, timeZone],
  );
  const tasksById = useMemo(
    () => new Map(tasks.tasks.map((t) => [t.id, t] as const)),
    [tasks.tasks],
  );
  // The task it opened for when the list does not hold it (closed before
  // today): shown under Done today. Never a deleted one, nor one waiting out
  // its Undo.
  // A batch line or alert opens the sheet with no row expanded.
  const focusTaskId = props.focusTaskId === TASKS_SHEET_ONLY ? null : props.focusTaskId;
  const focusLine = focusTaskId !== null ? tasks.lineTasks.get(focusTaskId) : undefined;
  const focusExtra =
    focusLine !== undefined &&
    !isDeleted(focusLine) &&
    !tasks.hiddenIds.has(focusLine.id) &&
    !tasksById.has(focusLine.id)
      ? focusLine
      : null;
  const doneGroup = useMemo(
    () => (focusExtra !== null ? [...groups.done, focusExtra] : groups.done),
    [groups.done, focusExtra],
  );
  const rowsById = useMemo(
    () => (focusExtra !== null ? new Map(tasksById).set(focusExtra.id, focusExtra) : tasksById),
    [tasksById, focusExtra],
  );
  const held = useMemo(
    () => (frozen === null ? null : new Set([...frozen.agency, ...frozen.client, ...frozen.done])),
    [frozen],
  );
  const shown: Record<GroupKey, ChatTask[]> =
    frozen === null || held === null
      ? { ...groups, done: doneGroup }
      : {
          agency: holdOrder(groups.agency, frozen.agency, rowsById, held),
          client: holdOrder(groups.client, frozen.client, rowsById, held),
          done: holdOrder(doneGroup, frozen.done, rowsById, held),
        };

  const expand = (taskId: string | null): void => {
    setExpanded(taskId);
    setDirty(false);
    setFrozen(
      taskId === null
        ? null
        : {
            agency: groups.agency.map((t) => t.id),
            client: groups.client.map((t) => t.id),
            done: groups.done.map((t) => t.id),
          },
    );
  };

  /** Run a leave of the expanded row now, or after "Discard your changes?". */
  const guard = (then: () => void): void => {
    if (expanded !== null && dirty) setConfirm({ then });
    else then();
  };

  // Each open starts fresh on the task it was opened for (if any).
  useEffect(() => {
    if (!props.open) return;
    const now = Date.now();
    setNowMs(now);
    const fresh = groupTasks(tasks.tasks, now, timeZone);
    // Not open: it is under Done today (closed today, or read below).
    const inOpen =
      focusTaskId !== null && [...fresh.agency, ...fresh.client].some((t) => t.id === focusTaskId);
    setShowDone(focusTaskId !== null && !inOpen);
    setExpanded(focusTaskId);
    setDirty(false);
    setConfirm(null);
    setDrafts([]);
    setSaveFailed(false);
    setFrozen(
      focusTaskId === null
        ? null
        : {
            agency: fresh.agency.map((t) => t.id),
            client: fresh.client.map((t) => t.id),
            done: fresh.done.map((t) => t.id),
          },
    );
    // Only an open (or a new focus) resets the sheet, never a data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, focusTaskId]);

  // Opened for a task the list does not hold: read it.
  const loadTask = tasks.loadTask;
  const focusMissing = focusTaskId !== null && focusLine === undefined;
  useEffect(() => {
    if (props.open && focusTaskId !== null && focusMissing) loadTask(focusTaskId);
  }, [props.open, focusTaskId, focusMissing, loadTask]);

  // The picker goes with the sheet.
  useEffect(() => {
    if (!props.open) setShareOpen(false);
  }, [props.open]);

  // The labels follow the clock while it stays open.
  useEffect(() => {
    if (!props.open) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [props.open]);

  // The row it opened for comes to the centre with the arrival tint (the shared
  // glow), once it is there (a task read on open arrives later).
  const focusShown = focusTaskId !== null && rowsById.has(focusTaskId);
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

  const preview = nextNumberPreview([...tasks.tasks, ...tasks.pending]) + drafts.length;
  const ready = drafts.filter((d) => d.title.trim() !== '');
  const unsaved = drafts.length > 0 || (expanded !== null && dirty);

  const addDraft = (
    side: TaskSide,
    title: string,
    options: { priority: TaskPriority; dueAt: string | null },
  ): void => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    draftSeq += 1;
    setSaveFailed(false);
    setDrafts((prev) =>
      prev.length >= TASK_BATCH_MAX
        ? prev
        : [
            ...prev,
            {
              key: `draft-${draftSeq}`,
              side,
              title: trimmed,
              priority: options.priority,
              dueAt: options.dueAt,
            },
          ],
    );
  };

  const createMany = tasks.createMany;
  const saveDrafts = (): void => {
    if (saving || ready.length === 0) return;
    const batch = ready;
    setSaving(true);
    setSaveFailed(false);
    void createMany(
      batch.map((d) => ({ title: d.title, side: d.side, priority: d.priority, dueAt: d.dueAt })),
    ).then((ok) => {
      setSaving(false);
      if (!ok) {
        setSaveFailed(true);
        return;
      }
      const sent = new Set(batch.map((d) => d.key));
      setDrafts((prev) => prev.filter((d) => !sent.has(d.key)));
      toast?.show({ title: tasksAddedLabel(batch.length) });
    });
  };
  const footer = lastChangeLine(tasks.events, tasks.lineTasks, tasks.nameOf, nowMs, timeZone);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  const renderRows = (group: GroupKey): ReactElement[] =>
    shown[group].map((task) => (
      <TaskRow
        key={task.id}
        task={task}
        expanded={expanded === task.id}
        dimmed={expanded !== null && expanded !== task.id}
        nowMs={nowMs}
        timeZone={timeZone}
        nameOf={tasks.nameOf}
        failed={tasks.failed.has(task.id)}
        onToggle={() => guard(() => expand(expanded === task.id ? null : task.id))}
        onCancel={() => guard(() => expand(null))}
        onSave={(changes) => {
          tasks.save(task, changes);
          expand(null);
        }}
        onDelete={() => {
          expand(null);
          tasks.remove(task);
        }}
        onRetry={() => tasks.retryField(task.id)}
        {...(expanded === task.id ? { onDirtyChange } : {})}
      />
    ));

  const renderDrafts = (side: TaskSide): ReactElement[] =>
    drafts
      .filter((d) => d.side === side)
      .map((d) => (
        <DraftRow
          key={d.key}
          draft={d}
          dimmed={expanded !== null}
          disabled={saving}
          nowMs={nowMs}
          timeZone={timeZone}
          onTitle={(title) =>
            setDrafts((prev) => prev.map((x) => (x.key === d.key ? { ...x, title } : x)))
          }
          onRemove={() => setDrafts((prev) => prev.filter((x) => x.key !== d.key))}
        />
      ));

  const renderPending = (side: TaskSide): ReactElement[] =>
    tasks.pending
      .filter((p) => p.side === side)
      .map((p) => (
        <li
          key={p.key}
          data-task-pending={p.state}
          className={cn(expanded !== null ? 'opacity-45' : 'opacity-100')}
        >
          <div className="flex min-h-[44px] items-start gap-[10px] px-4 py-[11px]">
            <span className="flex h-[21px] items-center">
              <TaskGlyph status="todo" />
            </span>
            <span className="w-5 shrink-0 pt-[2px] font-mono text-[12.5px] leading-[19px] text-fg-2">
              {p.number}
            </span>
            <span className="min-w-0 flex-1 text-[16px] font-medium leading-[21px] text-fg">
              {p.title}
            </span>
            <span className="flex h-[21px] items-center gap-2">
              <PriorityTag priority={p.priority ?? 2} />
              <DueCell
                task={{ dueAt: p.dueAt ?? null, duePassedAt: null }}
                nowMs={nowMs}
                timeZone={timeZone}
              />
            </span>
          </div>
          {p.state === 'failed' ? (
            <NotSaved
              onRetry={() => tasks.retryCreate(p.key)}
              onRemove={() => tasks.removeCreate(p.key)}
            />
          ) : null}
        </li>
      ));

  const section = (group: 'agency' | 'client'): ReactElement => (
    <section data-task-group={group} className="flex flex-col">
      <div className="flex h-9 items-center px-4">
        <GroupTitle group={group} label={SIDE_LABEL[group]} count={groups[group].length} />
      </div>
      <ul className="flex flex-col">
        {renderRows(group)}
        {renderPending(group)}
        {renderDrafts(group)}
        <AddRow
          side={group}
          preview={preview}
          nowMs={nowMs}
          timeZone={timeZone}
          disabled={saving || drafts.length >= TASK_BATCH_MAX}
          onAdd={(title, options) => addDraft(group, title, options)}
        />
      </ul>
    </section>
  );

  const onClose = props.onClose;
  const listReady = tasks.loadState === 'ready';
  const footerNode =
    drafts.length > 0 ? (
      <div data-task-save-bar="" className="flex min-w-0 flex-1 items-center gap-2.5">
        <p
          {...(saveFailed ? { role: 'alert' } : {})}
          className="min-w-0 flex-1 text-[13px] leading-4 text-bad"
        >
          {saveFailed ? SAVE_TASKS_FAILED : ''}
        </p>
        <Button
          size="lg"
          data-task-save-cancel=""
          disabled={saving}
          onClick={() =>
            setConfirm({
              tasks: true,
              then: () => {
                setDrafts([]);
                setSaveFailed(false);
                expand(null);
                onClose();
              },
            })
          }
        >
          Cancel
        </Button>
        <Button
          size="lg"
          variant="primary"
          data-task-save-all=""
          disabled={saving || ready.length === 0}
          aria-busy={saving}
          onClick={saveDrafts}
        >
          {saving ? SAVING_LABEL : saveFailed ? 'Retry' : saveTasksLabel(ready.length)}
        </Button>
      </div>
    ) : (
      <p
        data-task-footer=""
        className="-my-0.5 h-4 min-w-0 flex-1 truncate text-[13px] leading-4 text-fg-2"
      >
        {footer ?? 'No changes yet'}
      </p>
    );
  return (
    <>
      <Sheet
        open={props.open}
        onClose={onClose}
        title={TASK_SHEET_TITLE}
        dirty={unsaved}
        discard={{ title: DISCARD_TASKS_TITLE, message: DISCARD_TASKS_MESSAGE }}
        busy={saving}
        busyLabel={SAVING_LABEL}
        footer={footerNode}
      >
        <div
          ref={bodyRef}
          data-task-sheet=""
          className="-mx-[18px] -my-4 flex flex-col pb-2"
          onPointerDown={(event) => {
            if (expanded === null) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (target.closest(`[data-task-row-id="${expanded}"]`) !== null) return;
            guard(() => expand(null));
          }}
        >
          <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border pl-4 pr-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-accent text-accent-fg"
            >
              <IconCheck size={16} />
            </span>
            {listReady ? (
              <p data-task-counts="" className="min-w-0 flex-1 truncate text-[13px] text-fg-2">
                <span className="font-mono text-accent">{groups.agency.length}</span> open for
                creators · <span className="font-mono text-accent">{groups.client.length}</span> for
                approvers
              </p>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            {props.share !== undefined && listReady ? (
              <button
                type="button"
                data-task-share=""
                disabled={saving}
                onClick={() => {
                  resetShare();
                  setShareOpen(true);
                }}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  'flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-[8px] border border-border bg-panel-2 px-3 text-[13px] font-medium text-fg transition-colors duration-fast hover:bg-panel-3 disabled:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  NO_TOUCH_SELECT,
                )}
              >
                <IconForward size={16} />
                {SEND_TO_CHAT_LABEL}
              </button>
            ) : null}
          </div>
          {tasks.loadState === 'loading' ? <TasksSkeleton /> : null}
          {tasks.loadState === 'failed' ? (
            <LoadError
              title={TASKS_LOAD_THING}
              onRetry={tasks.refetch}
              retrying={tasks.retrying}
              className="mx-4 my-4"
            />
          ) : null}
          {listReady ? section('agency') : null}
          {listReady ? section('client') : null}
          {listReady ? (
            <section data-task-group="done" className="flex flex-col">
              <button
                type="button"
                aria-expanded={showDone}
                data-task-done-toggle=""
                onClick={() => setShowDone((v) => !v)}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  'flex min-h-[44px] items-center justify-between px-4',
                  NO_TOUCH_SELECT,
                )}
              >
                <GroupTitle group="done" label="Done today" count={groups.done.length} />
                <span className="text-[13px] text-accent">{showDone ? 'Hide' : 'Show'}</span>
              </button>
              {showDone ? <ul className="flex flex-col">{renderRows('done')}</ul> : null}
            </section>
          ) : null}
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
            onClose();
          }}
        />
      ) : null}
      {confirm !== null ? (
        <ConfirmDialog
          title={confirm.tasks === true ? DISCARD_TASKS_TITLE : DISCARD_TITLE}
          message={confirm.tasks === true ? DISCARD_TASKS_MESSAGE : DISCARD_MESSAGE}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            const then = confirm.then;
            setConfirm(null);
            then();
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}
