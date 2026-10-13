// One task row and its in-place editor. Collapsed: glyph, number, title (and
// note), P tag and due label. Tapping it expands it in place (height and
// opacity only, Y axis; nothing moves sideways): the commitment line, title
// and note inputs, the status grid, priority and side, and the due picker.
// The due time is required: picking a day shows the hourly strip and only a
// time tap saves (one write); tapping the day already set clears the due.
// A refused write reverts the row and shows "Not saved · Retry" on it only.

import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconAlarmClock, IconCalendar } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { TaskGlyph } from '@/components/chat/tasks/TaskGlyph';
import { cn } from '@/lib/cn';
import { DUR_BASE_MS } from '@/lib/motion';
import { civilDay } from '@/lib/chat/time-format';
import {
  addCivilDays,
  civilHourToUtcIso,
  commitmentLine,
  dateStripDays,
  dueLabel,
  DUE_HOURS,
  dueSelection,
  hourLabel,
  isOpenStatus,
  STATUS_LABEL,
  TASK_NOTE_MAX,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  type ChatTask,
  type TaskField,
  type TaskPriority,
} from '@/lib/chat/tasks';

export const NOT_SAVED = 'Not saved';

const P_TAG: Record<TaskPriority, string> = {
  0: 'bg-bad-soft text-bad',
  1: 'bg-warn-soft text-stage-review',
  2: 'bg-panel-3 text-fg-2',
};

export function PriorityTag(props: { priority: TaskPriority }): ReactElement {
  return (
    <span
      data-task-p={props.priority}
      className={cn(
        'shrink-0 rounded-[4px] px-1.5 font-mono text-[11.5px] leading-[18px]',
        P_TAG[props.priority],
      )}
    >
      P{props.priority}
    </span>
  );
}

/** The inline failure line: "Not saved · Retry" (44px Retry). */
export function NotSaved(props: { onRetry: () => void }): ReactElement {
  return (
    <div data-task-not-saved="" className="flex items-center gap-1 pl-[42px] pr-3 text-[13px]">
      <span className="text-bad">{NOT_SAVED} ·</span>
      <button
        type="button"
        onClick={props.onRetry}
        className={cn('h-11 px-1 font-semibold text-bad', NO_TOUCH_SELECT)}
      >
        Retry
      </button>
    </div>
  );
}

function DueCell(props: { task: ChatTask; nowMs: number; timeZone: string }): ReactElement {
  const label = dueLabel(props.task, props.nowMs, props.timeZone);
  if (label.tone === 'none') {
    return <span className="shrink-0 font-mono text-[12.5px] text-fg-3">{label.text}</span>;
  }
  return (
    <span
      data-task-due={label.tone}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[12.5px]',
        label.tone === 'missed'
          ? 'font-semibold text-bad'
          : label.tone === 'today'
            ? 'text-bad'
            : 'text-fg-2',
      )}
    >
      {label.tone === 'missed' ? <IconAlarmClock size={13} /> : null}
      {label.text}
    </span>
  );
}

const SEG = cn(
  'flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[8px] border text-[13px] transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  NO_TOUCH_SELECT,
);
const SEG_ON = 'border-accent bg-accent-soft text-accent';
const SEG_OFF = 'border-border bg-panel text-fg-2 hover:bg-panel-2';

function Segment(props: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
  data?: string;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      {...(props.label !== undefined ? { 'aria-label': props.label } : {})}
      {...(props.data !== undefined ? { 'data-task-opt': props.data } : {})}
      onClick={props.onClick}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(SEG, props.selected ? SEG_ON : SEG_OFF, props.className)}
    >
      {props.children}
    </button>
  );
}

/** A bare text input that saves on blur or Enter when changed. */
function InlineInput(props: {
  value: string;
  placeholder?: string;
  maxLength: number;
  className: string;
  label: string;
  onSave: (value: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = (): void => {
    if (draft.trim() !== props.value.trim()) props.onSave(draft);
  };
  return (
    <input
      type="text"
      aria-label={props.label}
      value={draft}
      maxLength={props.maxLength}
      placeholder={props.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit();
        }
      }}
      className={cn(
        'w-full min-h-[44px] bg-transparent text-fg placeholder:text-fg-3 focus:outline-none',
        props.className,
      )}
    />
  );
}

function DuePicker(props: {
  task: ChatTask;
  nowMs: number;
  timeZone: string;
  onSave: (value: string) => void;
}): ReactElement {
  const { task, nowMs, timeZone } = props;
  const today = civilDay(nowMs, timeZone);
  const tomorrow = addCivilDays(today, 1);
  const set = dueSelection(task.dueAt, nowMs, timeZone);
  const [day, setDay] = useState<string | null>(set?.civil ?? null);
  const [strip, setStrip] = useState(set !== null && set.which === 'other');
  useEffect(() => {
    setDay(set?.civil ?? null);
    // Only a new stored due moves the picker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.dueAt]);
  const pick = (civil: string): void => {
    // The day already set: clear the due.
    if (set !== null && set.civil === civil) {
      setDay(null);
      props.onSave('');
      return;
    }
    setDay(civil);
  };
  const days = dateStripDays(nowMs, timeZone);
  const which =
    day === null ? null : day === today ? 'today' : day === tomorrow ? 'tomorrow' : 'date';
  return (
    <div className="flex flex-col gap-2" data-task-due-picker="">
      <div className="flex gap-2">
        <Segment
          selected={which === 'today'}
          data="today"
          onClick={() => {
            setStrip(false);
            pick(today);
          }}
        >
          Today
        </Segment>
        <Segment
          selected={which === 'tomorrow'}
          data="tomorrow"
          onClick={() => {
            setStrip(false);
            pick(tomorrow);
          }}
        >
          Tomorrow
        </Segment>
        <Segment
          selected={which === 'date' || strip}
          data="date"
          onClick={() => setStrip((v) => !v)}
        >
          <IconCalendar size={16} />
          Date
        </Segment>
      </div>
      {strip ? (
        <div
          data-task-date-strip=""
          className={cn('-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1', NO_TOUCH_SELECT)}
        >
          {days.map((d) => {
            const on = day === d.civil;
            return (
              <button
                key={d.civil}
                type="button"
                aria-pressed={on}
                data-task-day={d.civil}
                onClick={() => pick(d.civil)}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  'flex h-[52px] w-11 shrink-0 flex-col items-center justify-center rounded-[8px] border',
                  on ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-panel text-fg',
                )}
              >
                <span className={cn('text-[11px]', on ? 'text-accent-fg' : 'text-fg-2')}>
                  {d.weekday}
                </span>
                <span className="font-mono text-[15px]">{d.day}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {day !== null ? (
        <div
          data-task-time-strip=""
          className={cn('-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1', NO_TOUCH_SELECT)}
        >
          {DUE_HOURS.map((hour) => {
            const on = set !== null && set.civil === day && set.hour === hour;
            return (
              <button
                key={hour}
                type="button"
                aria-pressed={on}
                data-task-hour={hour}
                onClick={() => props.onSave(civilHourToUtcIso(day, hour, timeZone))}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  'h-11 min-w-[56px] shrink-0 rounded-[8px] border px-2 font-mono text-[13px]',
                  on ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-panel text-fg',
                )}
              >
                {hourLabel(hour)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export interface TaskRowProps {
  task: ChatTask;
  expanded: boolean;
  dimmed: boolean;
  nowMs: number;
  timeZone: string;
  nameOf: (userId: string) => string;
  failed: boolean;
  onToggle: () => void;
  onSave: (field: TaskField, value: string) => void;
  onRetry: () => void;
}

export function TaskRow(props: TaskRowProps): ReactElement {
  const { task, expanded, nowMs, timeZone } = props;
  const closed = !isOpenStatus(task.status);
  const commitment = commitmentLine(task, props.nameOf, nowMs, timeZone);
  // The editor stays mounted through its collapse so it closes, not snaps.
  const [mounted, setMounted] = useState(expanded);
  useEffect(() => {
    if (expanded) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), DUR_BASE_MS);
    return () => clearTimeout(timer);
  }, [expanded]);
  return (
    <li
      data-task-row-id={task.id}
      data-task-number={task.number}
      {...(expanded ? { 'data-task-expanded': '' } : {})}
      className={cn(
        'transition-opacity duration-base ease-enter motion-reduce:transition-none',
        expanded && 'bg-accent-soft',
        props.dimmed ? 'opacity-45' : 'opacity-100',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={props.onToggle}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'flex min-h-[44px] w-full items-start gap-[10px] px-4 py-[11px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
          NO_TOUCH_SELECT,
        )}
      >
        <span className="flex h-[21px] items-center">
          <TaskGlyph status={task.status} />
        </span>
        <span className="w-5 shrink-0 pt-[2px] font-mono text-[12.5px] leading-[19px] text-fg-2">
          {task.number}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            data-task-title=""
            className={cn(
              'text-[16px] font-medium leading-[21px]',
              closed ? 'text-fg-2' : 'text-fg',
              task.status === 'rejected' && 'line-through',
            )}
          >
            {task.title}
          </span>
          {task.note !== null && task.note !== '' ? (
            <span className="text-[13px] leading-[17px] text-fg-2">{task.note}</span>
          ) : null}
        </span>
        <span className="flex h-[21px] items-center gap-2">
          <PriorityTag priority={task.priority} />
          {closed ? null : <DueCell task={task} nowMs={nowMs} timeZone={timeZone} />}
        </span>
      </button>
      {props.failed ? <NotSaved onRetry={props.onRetry} /> : null}
      <div
        data-task-editor=""
        aria-hidden={!expanded}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-base motion-reduce:transition-none',
          expanded
            ? 'grid-rows-[1fr] opacity-100 ease-enter'
            : 'grid-rows-[0fr] opacity-0 ease-exit',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {expanded || mounted ? (
            <div className="flex flex-col gap-2 pb-3 pl-[42px] pr-3">
              <p
                data-task-commitment=""
                className={cn('text-[12.5px]', commitment.missed ? 'text-bad' : 'text-fg-2')}
              >
                {commitment.text}
              </p>
              <InlineInput
                label="Title"
                value={task.title}
                maxLength={TASK_TITLE_MAX}
                className="text-[16px]"
                onSave={(v) => {
                  if (v.trim() !== '') props.onSave('title', v);
                }}
              />
              <InlineInput
                label="Note"
                value={task.note ?? ''}
                placeholder="Add a note"
                maxLength={TASK_NOTE_MAX}
                className="text-[13px] text-fg-2"
                onSave={(v) => props.onSave('note', v)}
              />
              <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Status">
                {TASK_STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={task.status === status}
                    data-task-status={status}
                    onClick={() => {
                      if (task.status !== status) props.onSave('status', status);
                    }}
                    onContextMenu={(e) => e.preventDefault()}
                    className={cn(
                      'flex h-11 flex-col items-center justify-center gap-0.5 rounded-[8px] border text-[11.5px] leading-[14px]',
                      NO_TOUCH_SELECT,
                      task.status === status
                        ? 'border-accent bg-accent-soft text-fg'
                        : 'border-border bg-panel text-fg-2',
                    )}
                  >
                    <TaskGlyph status={status} size={14} labelled />
                    {STATUS_LABEL[status]}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <div className="flex flex-1 gap-1.5" role="group" aria-label="Priority">
                  {TASK_PRIORITIES.map((p) => (
                    <Segment
                      key={p}
                      selected={task.priority === p}
                      data={`p${p}`}
                      className="font-mono"
                      onClick={() => {
                        if (task.priority !== p) props.onSave('priority', String(p));
                      }}
                    >
                      P{p}
                    </Segment>
                  ))}
                </div>
                <button
                  type="button"
                  data-task-move=""
                  onClick={() => props.onSave('side', task.side === 'agency' ? 'client' : 'agency')}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn(
                    'h-11 shrink-0 rounded-[8px] border border-border bg-panel px-3 text-[13px] text-accent hover:bg-panel-2',
                    NO_TOUCH_SELECT,
                  )}
                >
                  {task.side === 'agency' ? 'Move to Client →' : 'Move to Agency →'}
                </button>
              </div>
              <DuePicker
                task={task}
                nowMs={nowMs}
                timeZone={timeZone}
                onSave={(value) => props.onSave('due', value)}
              />
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
