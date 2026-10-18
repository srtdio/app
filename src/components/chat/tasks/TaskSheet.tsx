// The chat's Tasks: one sheet, everything in place. A header line (the accent
// tile, the counts and Share), then Agency, Client and Done today (collapsed by
// default), each with its rows; Agency and Client end with an add row (a title,
// optional priority and Today / Tomorrow chips; Enter adds and keeps focus, so
// a list types in one go; the next number shows only in the row being typed
// in). One row at a time expands in place in edit mode; the others dim (opacity
// only) and the order holds until it collapses. Leaving an edit with changes
// asks "Discard your changes?" first. Delete hides the row at once behind an
// Undo toast. Opened for a closed item the list does not hold (a thread line,
// an alert), that item shows on top, read first if needed. The footer names
// the last change. The shared bottom
// Sheet opens and closes it (translateY only). Share opens the forward picker
// and runs through the thread's send and forward (useTaskShare); a confirmed
// share closes both sheets. Tokens only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Sheet } from '@/components/ui/Sheet';
import { glowTarget } from '@/components/ui/SearchHighlight';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { IconCheck, IconForward } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { NotSaved, PriorityTag, TaskRow } from '@/components/chat/tasks/TaskRow';
import { TaskGlyph } from '@/components/chat/tasks/TaskGlyph';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { useTaskShare, type TaskShareWiring } from '@/components/chat/tasks/useTaskShare';
import { cn } from '@/lib/cn';
import { civilDay } from '@/lib/chat/time-format';
import {
  addCivilDays,
  dueForDay,
  dueLabel,
  groupTasks,
  holdOrder,
  isDeleted,
  lastChangeLine,
  nextNumberPreview,
  SIDE_LABEL,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  type ChatTask,
  type TaskPriority,
  type TaskSide,
} from '@/lib/chat/tasks';
import type { NewTaskOptions } from '@/components/chat/tasks/useChatTasks';

export const TASK_SHEET_TITLE = 'Tasks';
export const SHARE_TASKS_LABEL = 'Share tasks';
export const ADD_PLACEHOLDER = 'Type, then Enter for the next';
export const DISCARD_TITLE = 'Discard your changes?';
export const DISCARD_MESSAGE = 'The edits to this task are not saved yet.';
export const CLOSED_GROUP_LABEL = 'Closed';

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

const CHIP = cn(
  'flex h-11 min-w-11 shrink-0 items-center justify-center rounded-[8px] border px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  NO_TOUCH_SELECT,
);
const CHIP_ON = 'border-accent bg-accent-soft text-accent';
const CHIP_OFF = 'border-border bg-panel text-fg-2 hover:bg-panel-2';

type AddDay = 'today' | 'tomorrow' | null;

function AddRow(props: {
  side: TaskSide;
  preview: number;
  timeZone: string;
  onAdd: (title: string, options: NewTaskOptions) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<TaskPriority>(2);
  const [day, setDay] = useState<AddDay>(null);
  const typing = text.trim() !== '';
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!typing) return;
    const today = civilDay(Date.now(), props.timeZone);
    const civil = day === 'today' ? today : day === 'tomorrow' ? addCivilDays(today, 1) : null;
    props.onAdd(text, {
      priority,
      dueAt: civil !== null ? dueForDay(civil, null, Date.now(), props.timeZone) : null,
    });
    // The field keeps focus: the next item types straight in.
    setText('');
    setPriority(2);
    setDay(null);
  };
  // Chips never take focus from the field.
  const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();
  return (
    <li>
      <form data-task-add={props.side} onSubmit={submit} className="flex flex-col">
        <div className="flex min-h-[44px] items-center gap-[10px] px-4">
          <span aria-hidden="true" className="w-4 shrink-0" />
          <span data-task-preview="" className="w-5 shrink-0 font-mono text-[12.5px] text-accent">
            {/* Only the row being typed in shows the next number. */}
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
          {typing ? (
            <button
              type="submit"
              onMouseDown={keepFocus}
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
          <div
            data-task-add-options=""
            className="flex items-center gap-1.5 overflow-x-auto pb-2 pl-[58px] pr-4"
          >
            {TASK_PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={priority === p}
                data-task-add-p={p}
                onMouseDown={keepFocus}
                onClick={() => setPriority(p)}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(CHIP, 'font-mono', priority === p ? CHIP_ON : CHIP_OFF)}
              >
                P{p}
              </button>
            ))}
            <span aria-hidden="true" className="w-1 shrink-0" />
            {(['today', 'tomorrow'] as const).map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={day === d}
                data-task-add-day={d}
                onMouseDown={keepFocus}
                // Tapping the picked chip again leaves the item without a due.
                onClick={() => setDay((v) => (v === d ? null : d))}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(CHIP, day === d ? CHIP_ON : CHIP_OFF)}
              >
                {d === 'today' ? 'Today' : 'Tomorrow'}
              </button>
            ))}
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
  /** Opened for one item (a thread line, a bell row): that row starts expanded. */
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
  // The expanded row's draft holds changes; leaving it asks first.
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<{ next: string | null; close: boolean } | null>(null);
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
  const held = useMemo(
    () => (frozen === null ? null : new Set([...frozen.agency, ...frozen.client, ...frozen.done])),
    [frozen],
  );
  const shown: Record<GroupKey, ChatTask[]> =
    frozen === null || held === null
      ? groups
      : {
          agency: holdOrder(groups.agency, frozen.agency, tasksById, held),
          client: holdOrder(groups.client, frozen.client, tasksById, held),
          done: holdOrder(groups.done, frozen.done, tasksById, held),
        };

  const expand = (taskId: string | null): void => {
    setConfirm(null);
    if (taskId !== expanded) setDirty(false);
    setExpanded(taskId);
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

  /** Collapse or switch rows; with unsaved changes, ask first. */
  const requestExpand = (taskId: string | null): void => {
    if (dirty && expanded !== null && taskId !== expanded) {
      setConfirm({ next: taskId, close: false });
      return;
    }
    expand(taskId);
  };

  const requestClose = (): void => {
    if (dirty && expanded !== null) {
      setConfirm({ next: null, close: true });
      return;
    }
    props.onClose();
  };

  // Each open starts fresh on the item it was opened for (if any).
  const focusTaskId = props.focusTaskId;
  // Opened for an item no group holds (closed before today): it shows on top,
  // read first when no line brought it.
  const lineHasFocus = focusTaskId !== null && tasks.lineTasks.has(focusTaskId);
  const ensureTask = tasks.ensureTask;
  useEffect(() => {
    if (props.open && focusTaskId !== null && !lineHasFocus) ensureTask(focusTaskId);
  }, [props.open, focusTaskId, lineHasFocus, ensureTask]);
  const focusTask = focusTaskId !== null ? tasks.lineTasks.get(focusTaskId) : undefined;
  const inGroups =
    focusTaskId !== null &&
    (groups.agency.some((t) => t.id === focusTaskId) ||
      groups.client.some((t) => t.id === focusTaskId) ||
      groups.done.some((t) => t.id === focusTaskId));
  const closedFocus =
    focusTask !== undefined && !inGroups && !isDeleted(focusTask) ? focusTask : null;
  const closedFocusShown = closedFocus !== null;
  useEffect(() => {
    if (!props.open) return;
    const now = Date.now();
    setNowMs(now);
    const fresh = groupTasks(tasks.tasks, now, timeZone);
    const inDone = focusTaskId !== null && fresh.done.some((t) => t.id === focusTaskId);
    setShowDone(inDone);
    setConfirm(null);
    setDirty(false);
    setExpanded(focusTaskId);
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

  // The row it opened for comes to the centre with the arrival tint (the shared glow).
  useEffect(() => {
    if (!props.open || focusTaskId === null) return;
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
    // A closed item read after the open glows once it is in.
  }, [props.open, focusTaskId, closedFocusShown]);

  const preview = nextNumberPreview([...tasks.tasks, ...tasks.pending]);
  const footer = lastChangeLine(tasks.events, tasksById, tasks.nameOf, nowMs, timeZone);

  const renderRow = (task: ChatTask): ReactElement => (
    <TaskRow
      key={task.id}
      task={task}
      expanded={expanded === task.id}
      dimmed={expanded !== null && expanded !== task.id}
      nowMs={nowMs}
      timeZone={timeZone}
      nameOf={tasks.nameOf}
      failed={tasks.failed.has(task.id)}
      onToggle={() => requestExpand(expanded === task.id ? null : task.id)}
      onSave={(changes) => {
        tasks.save(task, changes);
        expand(null);
      }}
      onCancel={(changed) => {
        if (changed) setConfirm({ next: null, close: false });
        else expand(null);
      }}
      onDelete={() => {
        expand(null);
        tasks.remove(task);
      }}
      onDirtyChange={(d) => {
        if (expanded === task.id) setDirty(d);
      }}
      onRetry={() => tasks.retryField(task.id)}
    />
  );

  const renderRows = (group: GroupKey): ReactElement[] => shown[group].map(renderRow);

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
              <span className="font-mono text-[12.5px] text-fg-3">
                {dueLabel({ dueAt: p.dueAt ?? null, duePassedAt: null }, nowMs, timeZone).text}
              </span>
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
        onClose={requestClose}
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
            requestExpand(null);
          }}
        >
          <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border pl-4 pr-2">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-accent text-accent-fg"
            >
              <IconCheck size={16} />
            </span>
            {/* Reads as taskCountsText: "2 open for creators · 2 for approvers". */}
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
          {closedFocus !== null ? (
            <section data-task-group="closed" className="flex flex-col">
              <div className="flex h-9 items-center px-4">
                <GroupTitle group="done" label={CLOSED_GROUP_LABEL} count={1} />
              </div>
              <ul className="flex flex-col">{renderRow(closedFocus)}</ul>
            </section>
          ) : null}
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
      {confirm !== null ? (
        // Outside the sheet body: its taps never reach the collapse-on-tap handler.
        <ConfirmDialog
          title={DISCARD_TITLE}
          message={DISCARD_MESSAGE}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            const { next, close } = confirm;
            expand(next);
            if (close) onClose();
          }}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
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
    </>
  );
}
