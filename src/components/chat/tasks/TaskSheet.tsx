// The chat's Tasks: one sheet, everything in place. A header line (the accent
// tile, "2 open for creators · 2 for approvers" and Share), then Creators,
// Approvers and Done today (collapsed by default), each with its rows;
// Creators and Approvers end with an add row (a title, then optional priority
// and Today/Tomorrow chips; Enter adds with one create and keeps focus, so a
// list types in one go; the next number shows only in the row being typed in).
// One row at a time expands in place in edit mode; the others dim (opacity
// only) and the order holds until it collapses. Leaving an edit with changes
// (Cancel, another row, a tap outside, closing) asks "Discard your changes?"
// first. Delete hides the row at once behind an Undo toast. Opened for a task
// that is not in the list (closed before today), the sheet reads it and shows
// it expanded under Done today. The footer names the last change. The shared bottom
// Sheet opens and closes it (translateY only). Share opens the forward picker
// and runs through the thread's send and forward (useTaskShare); a confirmed
// share closes both sheets. Tokens only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Sheet } from '@/components/ui/Sheet';
import { glowTarget } from '@/components/ui/SearchHighlight';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { IconCheck, IconForward } from '@/components/ui/icons';
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
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  type ChatTask,
  type TaskPriority,
  type TaskSide,
} from '@/lib/chat/tasks';

export const TASK_SHEET_TITLE = 'Tasks';
export const SHARE_TASKS_LABEL = 'Share tasks';
export const ADD_PLACEHOLDER = 'Type, then Enter for the next';
export const DISCARD_TITLE = 'Discard your changes?';
export const DISCARD_MESSAGE = 'Your edits to this task are not saved.';

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
    if (text.trim() === '') return;
    const civil = day === 'today' ? today : day === 'tomorrow' ? addCivilDays(today, 1) : null;
    props.onAdd(text, {
      priority,
      dueAt: civil !== null ? civilHourToUtcIso(civil, DEFAULT_DUE_HOUR, props.timeZone) : null,
    });
    // The field keeps focus: the next task types straight in.
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
            maxLength={TASK_TITLE_MAX}
            placeholder={ADD_PLACEHOLDER}
            onChange={(e) => setText(e.target.value)}
            className="min-h-[44px] min-w-0 flex-1 bg-transparent text-[16px] text-fg placeholder:text-fg-3 focus:outline-none"
          />
          {text.trim() !== '' ? (
            <button
              type="submit"
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
  // A leave that waits on "Discard your changes?".
  const [confirm, setConfirm] = useState<{ then: () => void } | null>(null);
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
  const focusTaskId = props.focusTaskId;
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

  const preview = nextNumberPreview([...tasks.tasks, ...tasks.pending]);
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
        <AddRow
          side={group}
          preview={preview}
          nowMs={nowMs}
          timeZone={timeZone}
          onAdd={(title, options) => tasks.create(group, title, preview, options)}
        />
      </ul>
    </section>
  );

  const onClose = props.onClose;
  return (
    <>
      <Sheet
        open={props.open}
        onClose={() => guard(onClose)}
        title={TASK_SHEET_TITLE}
        footer={
          <p
            data-task-footer=""
            className="-my-0.5 h-4 min-w-0 flex-1 truncate text-[13px] leading-4 text-fg-2"
          >
            {footer ?? 'No changes yet'}
          </p>
        }
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
            <p data-task-counts="" className="min-w-0 flex-1 truncate text-[13px] text-fg-2">
              <span className="font-mono text-accent">{groups.agency.length}</span> open for
              creators · <span className="font-mono text-accent">{groups.client.length}</span> for
              approvers
            </p>
            {props.share !== undefined ? (
              <button
                type="button"
                aria-label={SHARE_TASKS_LABEL}
                data-task-share=""
                onClick={() => {
                  resetShare();
                  setShareOpen(true);
                }}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  NO_TOUCH_SELECT,
                )}
              >
                <IconForward size={20} />
              </button>
            ) : null}
          </div>
          {section('agency')}
          {section('client')}
          <section data-task-group="done" className="flex flex-col">
            <button
              type="button"
              aria-expanded={showDone}
              data-task-done-toggle=""
              onClick={() => setShowDone((v) => !v)}
              onContextMenu={(e) => e.preventDefault()}
              className={cn('flex min-h-[44px] items-center justify-between px-4', NO_TOUCH_SELECT)}
            >
              <GroupTitle group="done" label="Done today" count={groups.done.length} />
              <span className="text-[13px] text-accent">{showDone ? 'Hide' : 'Show'}</span>
            </button>
            {showDone ? <ul className="flex flex-col">{renderRows('done')}</ul> : null}
          </section>
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
          title={DISCARD_TITLE}
          message={DISCARD_MESSAGE}
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
