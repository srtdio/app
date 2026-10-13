// Task changes as thread lines: a centred pill like the day pill, merged into
// the thread by time (an event line ends a message run). The actor's name is
// semibold ("You" for self), numbers are mono and a move to P0 reads in bad.
// A missed due time has its own pill (bad border, alarm clock). A burst of 4+
// changes by one person within 2 minutes is one pill that expands in place.
// Tapping a single pill opens the task sheet with that item expanded. Pills
// are pressable: no iOS selection callout. No motion.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { IconAlarmClock } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { cn } from '@/lib/cn';
import {
  burstLabel,
  eventSegments,
  taskRefOf,
  type ChatTask,
  type TaskEvent,
  type TaskLine,
  type TaskSegment,
} from '@/lib/chat/tasks';

export interface TaskLineContext {
  tasksById: ReadonlyMap<string, ChatTask>;
  nameOf: (userId: string) => string;
  nowMs: number;
  timeZone: string;
  onOpenTask: (taskId: string) => void;
}

const PILL =
  'rounded-full border bg-panel-2 px-2.5 py-0.5 text-[12.5px] font-medium leading-4 text-fg-3';
const PRESS = cn(
  'flex min-h-[44px] max-w-full items-center justify-center px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  NO_TOUCH_SELECT,
);

function Segments(props: { segments: readonly TaskSegment[] }): ReactElement {
  return (
    <>
      {props.segments.map((s, k) =>
        s.tone === 'mono' ? (
          <span key={k} className="font-mono">
            {s.text}
          </span>
        ) : s.tone === 'bad' ? (
          <span key={k} className="font-mono text-bad">
            {s.text}
          </span>
        ) : (
          <span key={k}>{s.text}</span>
        ),
      )}
    </>
  );
}

/** One change's pill. */
export function TaskEventPill(props: { event: TaskEvent; ctx: TaskLineContext }): ReactElement {
  const { event, ctx } = props;
  const task = ctx.tasksById.get(event.taskId);
  const ref = taskRefOf(task);
  const open = (): void => ctx.onOpenTask(event.taskId);
  if (event.kind === 'due_passed') {
    const segments = eventSegments(event, ref, ctx.nowMs, ctx.timeZone);
    const [passed, ...rest] = segments;
    const setBy = task?.dueSetBy != null ? ` · set by ${ctx.nameOf(task.dueSetBy)}` : '';
    return (
      <button
        type="button"
        data-task-line="due_passed"
        data-task-id={event.taskId}
        onClick={open}
        onContextMenu={(e) => e.preventDefault()}
        className={PRESS}
      >
        <span className={cn(PILL, 'inline-flex min-w-0 items-center gap-1 border-bad')}>
          <IconAlarmClock size={13} className="shrink-0 text-bad" />
          <span className="truncate">
            <span className="font-semibold text-bad">
              {(passed?.text ?? '').replace(/ · $/, '')}
            </span>
            <span> · </span>
            <Segments segments={rest} />
            {setBy}
          </span>
        </span>
      </button>
    );
  }
  const actor = event.actorId !== null ? ctx.nameOf(event.actorId) : null;
  return (
    <button
      type="button"
      data-task-line={event.kind}
      data-task-id={event.taskId}
      onClick={open}
      onContextMenu={(e) => e.preventDefault()}
      className={PRESS}
    >
      <span className={cn(PILL, 'block min-w-0 truncate border-border')}>
        {actor !== null ? <span className="font-semibold text-fg-2">{actor} </span> : null}
        <Segments segments={eventSegments(event, ref, ctx.nowMs, ctx.timeZone)} />
      </span>
    </button>
  );
}

/** A burst: one pill naming the count; a tap shows each change in place. */
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
          // Each pill keeps its own 44px target; neighbours never overlap.
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
      <span className={cn(PILL, 'block truncate border-border')}>
        <span className="font-semibold text-fg-2">{ctx.nameOf(line.actorId)}</span>
        {burstLabel('', line.events.length)}
      </span>
    </button>
  );
}

/** One thread row of task changes (a list item, like the day pill). */
export function TaskEventLine(props: { line: TaskLine; ctx: TaskLineContext }): ReactElement {
  return (
    <li data-task-row="" className="flex justify-center">
      {props.line.kind === 'one' ? (
        <TaskEventPill event={props.line.event} ctx={props.ctx} />
      ) : (
        <TaskBurst line={props.line} ctx={props.ctx} />
      )}
    </li>
  );
}
