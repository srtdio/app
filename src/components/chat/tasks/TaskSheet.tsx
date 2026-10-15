// The chat's task list: one sheet, everything in place. A header line (the
// accent tile, the counts and Share), then Agency, Client and Done today
// (collapsed by default), each with its rows; Agency and Client end with an add
// row (Enter adds and keeps focus, so a list types in one go). One row at a
// time expands in place; the others dim (opacity only) and the order holds
// until it collapses. The footer names the last change. The shared bottom
// Sheet opens and closes it (translateY only). Share opens the forward picker
// and runs through the thread's send and forward (useTaskShare); a confirmed
// share closes both sheets. Tokens only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { IconCheck, IconForward } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { NotSaved, PriorityTag, TaskRow } from '@/components/chat/tasks/TaskRow';
import { TaskGlyph } from '@/components/chat/tasks/TaskGlyph';
import type { UseChatTasks } from '@/components/chat/tasks/useChatTasks';
import { useTaskShare, type TaskShareWiring } from '@/components/chat/tasks/useTaskShare';
import { cn } from '@/lib/cn';
import {
  groupTasks,
  holdOrder,
  lastChangeLine,
  nextNumberPreview,
  SIDE_LABEL,
  TASK_TITLE_MAX,
  type ChatTask,
  type TaskSide,
} from '@/lib/chat/tasks';

export const TASK_SHEET_TITLE = 'Tasks';
export const SHARE_TASKS_LABEL = 'Share task list';
export const ADD_PLACEHOLDER = 'Type, then Enter for the next';

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

function AddRow(props: {
  side: TaskSide;
  preview: number;
  onAdd: (title: string) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (text.trim() === '') return;
    props.onAdd(text);
    // The field keeps focus: the next item types straight in.
    setText('');
  };
  return (
    <li>
      <form
        data-task-add={props.side}
        onSubmit={submit}
        className="flex min-h-[44px] items-center gap-[10px] px-4"
      >
        <span aria-hidden="true" className="w-4 shrink-0" />
        <span data-task-preview="" className="w-5 shrink-0 font-mono text-[12.5px] text-accent">
          {props.preview}
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

  // Each open starts fresh on the item it was opened for (if any).
  const focusTaskId = props.focusTaskId;
  useEffect(() => {
    if (!props.open) return;
    const now = Date.now();
    setNowMs(now);
    const fresh = groupTasks(tasks.tasks, now, timeZone);
    const inDone = focusTaskId !== null && fresh.done.some((t) => t.id === focusTaskId);
    setShowDone(inDone);
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

  // The row it opened for comes into view.
  useEffect(() => {
    if (!props.open || focusTaskId === null) return;
    const raf = requestAnimationFrame(() => {
      bodyRef.current
        ?.querySelector(`[data-task-row-id="${focusTaskId}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [props.open, focusTaskId]);

  const preview = nextNumberPreview([...tasks.tasks, ...tasks.pending]);
  const footer = lastChangeLine(tasks.events, tasksById, tasks.nameOf, nowMs, timeZone);

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
        onToggle={() => expand(expanded === task.id ? null : task.id)}
        onSave={(field, value) => tasks.setField(task, field, value)}
        onRetry={() => tasks.retryField(task.id)}
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
              <PriorityTag priority={2} />
              <span className="font-mono text-[12.5px] text-fg-3">–</span>
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
          onAdd={(title) => tasks.create(group, title, preview)}
        />
      </ul>
    </section>
  );

  const onClose = props.onClose;
  return (
    <>
      <Sheet
        open={props.open}
        onClose={props.onClose}
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
            expand(null);
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
              <span className="font-mono text-accent">{groups.agency.length}</span> creators ·{' '}
              <span className="font-mono text-accent">{groups.client.length}</span> approvers ·{' '}
              <span className="font-mono">{groups.done.length}</span> done
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
    </>
  );
}
