// One task row and its in-place editor. Collapsed: glyph, number, title (and
// note), P tag and due label. Tapping it expands it in place (height and
// opacity only, Y axis; nothing moves sideways) in edit mode: the commitment
// line, title and note inputs, the status grid, priority and side, the due
// picker, then Delete, Cancel and Save. Every edit is local (a draft) until
// Save, which sends only the changed fields in one write. Picking a day
// without a time sets 9 pm ("Due 9 pm", the hour strip edits it); tapping the
// day already picked keeps it, and "Clear date" removes the due. After 9 pm
// workspace time Today is disabled, as in the add row. A refused
// Save reverts the row and shows "Not saved · Retry" on it only.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconAlarmClock, IconCalendar, IconX } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { TaskGlyph } from '@/components/chat/tasks/TaskGlyph';
import { Highlight } from '@/components/ui/SearchHighlight';
import { cn } from '@/lib/cn';
import { DUR_BASE_MS } from '@/lib/motion';
import { civilDay } from '@/lib/chat/time-format';
import {
  addCivilDays,
  civilHourToUtcIso,
  commitmentLine,
  dateStripDays,
  DEFAULT_DUE_HOUR,
  diffDraft,
  draftOf,
  dueForDay,
  dueHourLine,
  dueLabel,
  DUE_HOURS,
  dueSelection,
  hasChanges,
  hourLabel,
  isPastHour,
  isOpenStatus,
  STATUS_LABEL,
  TASK_NOTE_MAX,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  type ChatTask,
  type TaskChanges,
  type TaskDraft,
  type TaskPriority,
} from '@/lib/chat/tasks';

export const NOT_SAVED = 'Not saved';
export const CLEAR_DATE = 'Clear date';

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

/** The inline failure line: "Not saved · Retry" (44px Retry), and a 44px x when it can be dropped. */
export function NotSaved(props: { onRetry: () => void; onRemove?: () => void }): ReactElement {
  return (
    <div data-task-not-saved="" className="flex items-center gap-1 pl-[42px] pr-3 text-[13px]">
      <span className="text-bad">{NOT_SAVED} ·</span>
      <button
        type="button"
        onClick={props.onRetry}
        onContextMenu={(e) => e.preventDefault()}
        className={cn('h-11 min-w-11 px-1 font-semibold text-bad', NO_TOUCH_SELECT)}
      >
        Retry
      </button>
      {props.onRemove !== undefined ? (
        <button
          type="button"
          aria-label="Remove"
          data-task-remove=""
          onClick={props.onRemove}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            'ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-2 hover:bg-panel-2',
            NO_TOUCH_SELECT,
          )}
        >
          <IconX size={16} />
        </button>
      ) : null}
    </div>
  );
}

export function DueCell(props: {
  task: Pick<ChatTask, 'dueAt' | 'duePassedAt'>;
  nowMs: number;
  timeZone: string;
}): ReactElement {
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

export function Segment(props: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
  data?: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      {...(props.label !== undefined ? { 'aria-label': props.label } : {})}
      {...(props.data !== undefined ? { 'data-task-opt': props.data } : {})}
      {...(props.disabled === true ? { 'aria-disabled': true } : {})}
      onClick={() => {
        if (props.disabled !== true) props.onClick();
      }}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        SEG,
        props.selected ? SEG_ON : SEG_OFF,
        props.disabled === true && 'cursor-default text-fg-3',
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

/** A bare text input bound to the draft. */
function DraftInput(props: {
  value: string;
  placeholder?: string;
  maxLength: number;
  className: string;
  label: string;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <input
      type="text"
      aria-label={props.label}
      value={props.value}
      maxLength={props.maxLength}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      className={cn(
        'w-full min-h-[44px] bg-transparent text-fg placeholder:text-fg-3 focus:outline-none',
        props.className,
      )}
    />
  );
}

/**
 * The due picker over a draft value. A day without a time gets 9 pm (or the
 * hour already set); the day already picked stays picked; Clear date clears.
 */
export function DuePicker(props: {
  value: string | null;
  nowMs: number;
  timeZone: string;
  onChange: (value: string | null) => void;
}): ReactElement {
  const { value, nowMs, timeZone } = props;
  const today = civilDay(nowMs, timeZone);
  const tomorrow = addCivilDays(today, 1);
  const set = dueSelection(value, nowMs, timeZone);
  const day = set?.civil ?? null;
  const [strip, setStrip] = useState(set !== null && set.which === 'other');
  const pick = (civil: string): void => {
    // The day already picked: nothing changes (Clear date clears).
    if (day === civil) return;
    props.onChange(dueForDay(civil, value, nowMs, timeZone));
  };
  const days = dateStripDays(nowMs, timeZone);
  // After 9 pm workspace time today is over: Today is shown, not tappable
  // (the add row's rule).
  const todayOver = isPastHour(today, DEFAULT_DUE_HOUR, nowMs, timeZone);
  const which =
    day === null ? null : day === today ? 'today' : day === tomorrow ? 'tomorrow' : 'date';
  return (
    <div className="flex flex-col gap-2" data-task-due-picker="">
      <div className="flex gap-2">
        <Segment
          selected={which === 'today'}
          data="today"
          disabled={todayOver}
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
                  'flex h-[60px] w-11 shrink-0 flex-col items-center justify-center rounded-[8px] border',
                  on ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-panel text-fg',
                )}
              >
                <span
                  data-task-month={d.month ?? undefined}
                  className={cn(
                    'h-[13px] text-[10px] font-semibold uppercase leading-[13px]',
                    on ? 'text-accent-fg' : 'text-accent',
                  )}
                >
                  {d.month ?? ''}
                </span>
                <span className={cn('text-[11px]', on ? 'text-accent-fg' : 'text-fg-2')}>
                  {d.weekday}
                </span>
                <span className="font-mono text-[15px]">{d.day}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {set !== null && day !== null ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <p data-task-due-line="" className="text-[13px] text-fg-2">
              {dueHourLine(set.hour)}
            </p>
            <button
              type="button"
              data-task-clear-date=""
              onClick={() => {
                setStrip(false);
                props.onChange(null);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onContextMenu={(e) => e.preventDefault()}
              className={cn(
                'h-11 min-w-11 shrink-0 rounded-[8px] px-3 text-[13px] text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                NO_TOUCH_SELECT,
              )}
            >
              {CLEAR_DATE}
            </button>
          </div>
          <div
            data-task-time-strip=""
            className={cn('-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1', NO_TOUCH_SELECT)}
          >
            {DUE_HOURS.map((hour) => {
              const on = set.hour === hour;
              // Today's hours up to the current one are over: shown, not tappable.
              const past = !on && isPastHour(day, hour, nowMs, timeZone);
              return (
                <button
                  key={hour}
                  type="button"
                  aria-pressed={on}
                  aria-disabled={past || undefined}
                  data-task-hour={hour}
                  onClick={() => {
                    if (!past && !on) props.onChange(civilHourToUtcIso(day, hour, timeZone));
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn(
                    'h-11 min-w-[56px] shrink-0 rounded-[8px] border px-2 font-mono text-[13px]',
                    on
                      ? 'border-accent bg-accent text-accent-fg'
                      : past
                        ? 'cursor-default border-border bg-panel text-fg-3'
                        : 'border-border bg-panel text-fg',
                  )}
                >
                  {hourLabel(hour)}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

const ACTION = cn(
  'h-11 min-w-11 shrink-0 rounded-[8px] px-4 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  NO_TOUCH_SELECT,
);

export interface TaskRowProps {
  task: ChatTask;
  expanded: boolean;
  dimmed: boolean;
  nowMs: number;
  timeZone: string;
  nameOf: (userId: string) => string;
  failed: boolean;
  /** The row's header was tapped (expand, or collapse when expanded). */
  onToggle: () => void;
  /** Cancel was tapped; the sheet asks first when the draft has changes. */
  onCancel: () => void;
  /** Save: only the changed fields. */
  onSave: (changes: TaskChanges) => void;
  onDelete: () => void;
  onRetry: () => void;
  /** Whether the draft differs from the task (the sheet guards a collapse on it). */
  onDirtyChange?: (dirty: boolean) => void;
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
  // Edits stay local until Save; each expand starts from the stored task.
  const [draft, setDraft] = useState<TaskDraft>(() => draftOf(task));
  useEffect(() => {
    if (expanded) setDraft(draftOf(task));
    // Only an expand starts a new draft (a live change never wipes one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  const changes = diffDraft(task, draft);
  const dirty = expanded && hasChanges(changes);
  const onDirtyChange = props.onDirtyChange;
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (dirtyRef.current === dirty) return;
    dirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const edit = (change: Partial<TaskDraft>): void => setDraft((prev) => ({ ...prev, ...change }));
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
            <Highlight text={task.title} />
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
              <DraftInput
                label="Title"
                value={draft.title}
                maxLength={TASK_TITLE_MAX}
                className="text-[16px]"
                onChange={(title) => edit({ title })}
              />
              <DraftInput
                label="Note"
                value={draft.note}
                placeholder="Add a note"
                maxLength={TASK_NOTE_MAX}
                className="text-[13px] text-fg-2"
                onChange={(note) => edit({ note })}
              />
              <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Status">
                {TASK_STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={draft.status === status}
                    data-task-status={status}
                    onClick={() => edit({ status })}
                    onContextMenu={(e) => e.preventDefault()}
                    className={cn(
                      'flex h-11 flex-col items-center justify-center gap-0.5 rounded-[8px] border text-[11.5px] leading-[14px]',
                      NO_TOUCH_SELECT,
                      draft.status === status
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
                      selected={draft.priority === p}
                      data={`p${p}`}
                      className="font-mono"
                      onClick={() => edit({ priority: p })}
                    >
                      P{p}
                    </Segment>
                  ))}
                </div>
                <button
                  type="button"
                  data-task-move=""
                  aria-pressed={draft.side !== task.side}
                  onClick={() => edit({ side: draft.side === 'agency' ? 'client' : 'agency' })}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn(
                    'h-11 shrink-0 rounded-[8px] border px-3 text-[13px] text-accent hover:bg-panel-2',
                    draft.side !== task.side
                      ? 'border-accent bg-accent-soft'
                      : 'border-border bg-panel',
                    NO_TOUCH_SELECT,
                  )}
                >
                  {draft.side === 'agency' ? 'Move to Approvers →' : 'Move to Creators →'}
                </button>
              </div>
              <DuePicker
                key={expanded ? 'open' : 'closed'}
                value={draft.dueAt}
                nowMs={nowMs}
                timeZone={timeZone}
                onChange={(dueAt) => edit({ dueAt })}
              />
              <div data-task-actions="" className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  data-task-delete=""
                  onClick={props.onDelete}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn(ACTION, 'text-bad hover:bg-bad-soft')}
                >
                  Delete
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  data-task-cancel=""
                  onClick={props.onCancel}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn(ACTION, 'border border-border bg-panel text-fg hover:bg-panel-2')}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-task-save=""
                  disabled={!dirty}
                  onClick={() => {
                    if (dirty) props.onSave(changes);
                  }}
                  onContextMenu={(e) => e.preventDefault()}
                  className={cn(
                    ACTION,
                    'bg-accent text-accent-fg disabled:cursor-default disabled:bg-panel-3 disabled:text-fg-3',
                  )}
                >
                  Save
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
