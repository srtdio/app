// Task changes as thread lines: a centred pill like the day pill, merged into
// the thread by time (an event line ends a message run). One Save (events
// sharing a batch id) is ONE line "<You|Name> edited tasks" with a chevron; a
// tap expands its rows in place (Added, Edited with the old title struck,
// Priority with the old level struck, Done, Reopened, Deleted, each with the
// task number and title), then an "Open tasks" button. Older rows without a batch
// id read as before (a single change, a quick run of adds, a burst). The
// actor's name is semibold; numbers are mono. Pills are pressable: no iOS
// selection callout. No motion.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { IconChevronDown, IconChevronRight } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { cn } from '@/lib/cn';
import {
  addedLabel,
  batchRows,
  burstLabel,
  editedTasksLabel,
  eventText,
  taskNumberLabel,
  taskRefOf,
  TASKS_SHEET_ONLY,
  type BatchRow,
  type ChatTask,
  type TaskEvent,
  type TaskLine,
} from '@/lib/chat/tasks';

export interface TaskLineContext {
  tasksById: ReadonlyMap<string, ChatTask>;
  nameOf: (userId: string) => string;
  onOpenTask: (taskId: string) => void;
}

export const OPEN_TASKS_LABEL = 'Open tasks';

const PILL =
  'rounded-full border border-border bg-panel-2 px-2.5 py-0.5 text-[12.5px] font-medium leading-4 text-fg-3';
const PRESS = cn(
  'flex min-h-[44px] max-w-full items-center justify-center px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  NO_TOUCH_SELECT,
);

/** One older change's pill (no batch id). */
export function TaskEventPill(props: { event: TaskEvent; ctx: TaskLineContext }): ReactElement {
  const { event, ctx } = props;
  const ref = taskRefOf(ctx.tasksById.get(event.taskId));
  const actor = event.actorId !== null ? ctx.nameOf(event.actorId) : null;
  return (
    <button
      type="button"
      data-task-line={event.kind}
      data-task-id={event.taskId}
      onClick={() => ctx.onOpenTask(event.taskId)}
      onContextMenu={(e) => e.preventDefault()}
      className={PRESS}
    >
      <span className={cn(PILL, 'block min-w-0 truncate')}>
        {actor !== null ? <span className="font-semibold text-fg-2">{actor} </span> : null}
        {eventText(event, ref)}
      </span>
    </button>
  );
}

function N(props: { n: number | null }): ReactElement {
  return <span className="font-mono">{taskNumberLabel(props.n)}</span>;
}

function BatchRowView(props: { row: BatchRow }): ReactElement {
  const { row } = props;
  switch (row.kind) {
    case 'added':
      return (
        <>
          Added <N n={row.number} /> {row.title}
          {row.priority !== null ? <span className="font-mono"> · P{row.priority}</span> : null}
        </>
      );
    case 'renamed':
      return (
        <>
          Edited <N n={row.number} /> <s>{row.from}</s> → {row.to}
        </>
      );
    case 'priority':
      return (
        <>
          Priority <N n={row.number} /> <s className="font-mono">P{row.from}</s> →{' '}
          <span className={cn('font-mono', row.to === 0 && 'text-bad')}>P{row.to}</span>
        </>
      );
    case 'done':
      return (
        <>
          Done <N n={row.number} /> {row.title}
        </>
      );
    case 'reopened':
      return (
        <>
          Reopened <N n={row.number} /> {row.title}
        </>
      );
    case 'deleted':
      return (
        <>
          Deleted <N n={row.number} /> {row.title}
        </>
      );
  }
}

/** One Save: "<Name> edited tasks" with a chevron; a tap shows its rows and "Open tasks". */
function TaskBatch(props: {
  line: Extract<TaskLine, { kind: 'batch' }>;
  ctx: TaskLineContext;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { line, ctx } = props;
  const name = line.actorId !== null ? ctx.nameOf(line.actorId) : 'Someone';
  const rows = line.events.flatMap((e) => batchRows(e, taskRefOf(ctx.tasksById.get(e.taskId))));
  return (
    <div data-task-batch={line.batchId} className="flex w-full flex-col items-center">
      <button
        type="button"
        aria-expanded={open}
        data-task-batch-toggle=""
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => e.preventDefault()}
        className={PRESS}
      >
        <span className={cn(PILL, 'inline-flex min-w-0 items-center gap-1')}>
          <span className="truncate">
            <span className="font-semibold text-fg-2">{name}</span>
            {editedTasksLabel('')}
          </span>
          {open ? (
            <IconChevronDown size={13} className="shrink-0" />
          ) : (
            <IconChevronRight size={13} className="shrink-0" />
          )}
        </span>
      </button>
      {open ? (
        <div
          data-task-batch-rows=""
          className="mx-4 mb-1 flex w-[min(100%-2rem,420px)] flex-col gap-1 rounded-[10px] border border-border bg-panel-2 px-3 py-2 text-[13px] text-fg-2"
        >
          {rows.map((row, k) => (
            <p key={k} data-task-batch-row={row.kind} className="leading-5">
              <BatchRowView row={row} />
            </p>
          ))}
          <button
            type="button"
            data-task-open=""
            onClick={() => ctx.onOpenTask(TASKS_SHEET_ONLY)}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
              'mt-1 h-11 self-start rounded-[8px] px-2 text-[13px] font-semibold text-accent hover:bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              NO_TOUCH_SELECT,
            )}
          >
            {OPEN_TASKS_LABEL}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** An older burst: one pill naming the count; a tap shows each change in place. */
function TaskBurst(props: {
  line: Extract<TaskLine, { kind: 'many' }>;
  ctx: TaskLineContext;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { line, ctx } = props;
  if (open) {
    return (
      <div data-task-burst="open" className="flex flex-col items-center">
        {line.events.map((event) => (
          <div key={event.id} className="flex max-w-full justify-center">
            <TaskEventPill event={event} ctx={ctx} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-task-burst=""
      aria-expanded={false}
      onClick={() => setOpen(true)}
      onContextMenu={(e) => e.preventDefault()}
      className={PRESS}
    >
      <span className={cn(PILL, 'block truncate')}>
        <span className="font-semibold text-fg-2">{ctx.nameOf(line.actorId)}</span>
        {burstLabel('', line.events.length)}
      </span>
    </button>
  );
}

/** An older run of adds: one pill; a tap opens the Tasks sheet. */
function TaskAdded(props: {
  line: Extract<TaskLine, { kind: 'added' }>;
  ctx: TaskLineContext;
}): ReactElement {
  const { line, ctx } = props;
  return (
    <button
      type="button"
      data-task-added={line.events.length}
      onClick={() => ctx.onOpenTask(TASKS_SHEET_ONLY)}
      onContextMenu={(e) => e.preventDefault()}
      className={PRESS}
    >
      <span className={cn(PILL, 'block min-w-0 truncate')}>
        <span className="font-semibold text-fg-2">{ctx.nameOf(line.actorId)}</span>
        {addedLabel('', line.events.length)}
      </span>
    </button>
  );
}

/** One thread row of task changes (a list item, like the day pill). */
export function TaskEventLine(props: { line: TaskLine; ctx: TaskLineContext }): ReactElement {
  const { line, ctx } = props;
  return (
    <li data-task-row="" className="flex justify-center">
      {line.kind === 'batch' ? (
        <TaskBatch line={line} ctx={ctx} />
      ) : line.kind === 'one' ? (
        <TaskEventPill event={line.event} ctx={ctx} />
      ) : line.kind === 'added' ? (
        <TaskAdded line={line} ctx={ctx} />
      ) : (
        <TaskBurst line={line} ctx={ctx} />
      )}
    </li>
  );
}
