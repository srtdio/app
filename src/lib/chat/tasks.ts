// The chat task list: per-chat numbered items (public.chat_tasks), their change
// log (public.chat_task_events) and the two writes (chat_task_create,
// chat_task_set). The pure rules (sort, groups, due labels on the workspace
// clock, event text, thread-line collapse, the share snapshot, the civil
// date + hour to UTC conversion) are framework-free and unit-tested; the reads
// are one query each (tasks of a channel, events of a window, one task by id)
// and the writes pass an explicit p_trace_id. Nothing here touches React.

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable } from '@/lib/chat-reads';
import { civilDay, safeTimeZone } from '@/lib/chat/time-format';

type Functions = Database['public']['Functions'];
type TaskRow = Database['public']['Tables']['chat_tasks']['Row'];
type TaskEventRow = Database['public']['Tables']['chat_task_events']['Row'];

export type TaskStatus = 'todo' | 'waiting' | 'shared' | 'approved' | 'rejected';
export type TaskSide = 'agency' | 'client';
export type TaskPriority = 0 | 1 | 2;
export type TaskField = 'status' | 'priority' | 'side' | 'title' | 'note' | 'due';
export type TaskEventKind =
  | 'created'
  | 'status'
  | 'priority'
  | 'due'
  | 'side'
  | 'title'
  | 'note'
  | 'due_passed';

/** One task as the sheet renders it. */
export interface ChatTask {
  id: string;
  channelId: string;
  number: number;
  title: string;
  note: string | null;
  side: TaskSide;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  dueSetBy: string | null;
  dueSetAt: string | null;
  duePassedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One change-log row. */
export interface TaskEvent {
  id: string;
  taskId: string;
  channelId: string;
  /** Null for the due timer (due_passed). */
  actorId: string | null;
  kind: TaskEventKind;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

/** The statuses in grid order. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'waiting',
  'shared',
  'approved',
  'rejected',
];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  waiting: 'Waiting',
  shared: 'Shared',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const SIDE_LABEL: Record<TaskSide, string> = { agency: 'Creators', client: 'Approvers' };

export const TASK_PRIORITIES: readonly TaskPriority[] = [0, 1, 2];

/** Title and note limits (the table's CHECKs). */
export const TASK_TITLE_MAX = 200;
export const TASK_NOTE_MAX = 200;

const STATUS_SET = new Set<string>(TASK_STATUSES);
const KIND_SET = new Set<string>([
  'created',
  'status',
  'priority',
  'due',
  'side',
  'title',
  'note',
  'due_passed',
]);

function asStatus(value: string | null | undefined): TaskStatus | null {
  return value != null && STATUS_SET.has(value) ? (value as TaskStatus) : null;
}

function asSide(value: string | null | undefined): TaskSide | null {
  return value === 'agency' || value === 'client' ? value : null;
}

function asPriority(value: number | string | null | undefined): TaskPriority | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return n === 0 || n === 1 || n === 2 ? n : null;
}

/** Map a row; an impossible row (CHECKs forbid it) is skipped. Pure. */
export function rowToTask(row: TaskRow): ChatTask | null {
  const status = asStatus(row.status);
  const side = asSide(row.side);
  const priority = asPriority(row.priority);
  if (status === null || side === null || priority === null) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    number: row.number,
    title: row.title,
    note: row.note,
    side,
    status,
    priority,
    dueAt: row.due_at,
    dueSetBy: row.due_set_by,
    dueSetAt: row.due_set_at,
    duePassedAt: row.due_passed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map an event row; an unknown kind is skipped. Pure. */
export function rowToTaskEvent(row: TaskEventRow): TaskEvent | null {
  if (!KIND_SET.has(row.kind)) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    channelId: row.channel_id,
    actorId: row.actor_user_id,
    kind: row.kind as TaskEventKind,
    oldValue: row.old_value,
    newValue: row.new_value,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Workspace clock
// ---------------------------------------------------------------------------

function epoch(iso: string | null | undefined): number {
  if (iso == null) return Number.NaN;
  return Date.parse(iso);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some engines report midnight as 24 under hour12: false.
    hour: read('hour') % 24,
    minute: read('minute'),
  };
}

function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  // Offsets are whole minutes: compare against the instant's own minute.
  return wall - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The UTC instant (ISO) that is `hour`:00 on civil date `civil` (YYYY-MM-DD)
 * in the zone. The offset is probed at the guess and re-probed at the
 * corrected instant, so a guess across a DST change heals. Pure.
 */
export function civilHourToUtcIso(civil: string, hour: number, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civil);
  if (match === null) return new Date(0).toISOString();
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour, 0, 0);
  const first = wall - zoneOffsetMs(wall, timeZone);
  return new Date(wall - zoneOffsetMs(first, timeZone)).toISOString();
}

/** The civil date `days` after `civil`, by calendar. Pure. */
export function addCivilDays(civil: string, days: number): string {
  const [y, m, d] = civil.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "8 pm", "8:30 pm", "12 am" for an hour and minute. Pure. */
export function hourLabel(hour: number, minute = 0): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const mm = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`;
  return `${h}${mm} ${hour < 12 ? 'am' : 'pm'}`;
}

/** "16 Oct" for a civil date. Pure. */
export function civilDayLabel(civil: string): string {
  const [, m, d] = civil.split('-').map(Number);
  return `${d ?? ''} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
}

/** An instant's clock on the workspace clock: "8 pm", "11:05 am". Pure. */
export function clockLabel(iso: string, timeZone: string): string {
  const ms = epoch(iso);
  if (Number.isNaN(ms)) return '';
  const p = zonedParts(ms, timeZone);
  return hourLabel(p.hour, p.minute);
}

/** An instant's clock, always with minutes: "11:05 am", "8:00 pm". Pure. */
export function clockLabelFull(iso: string, timeZone: string): string {
  const ms = epoch(iso);
  if (Number.isNaN(ms)) return '';
  const p = zonedParts(ms, timeZone);
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'am' : 'pm'}`;
}

/** Where a due instant sits against today on the workspace clock. */
export type DueDay = 'today' | 'tomorrow' | 'other';

function dueDayOf(dueMs: number, nowMs: number, timeZone: string): DueDay {
  const today = civilDay(nowMs, timeZone);
  const day = civilDay(dueMs, timeZone);
  if (day === today) return 'today';
  if (day === addCivilDays(today, 1)) return 'tomorrow';
  return 'other';
}

/**
 * The due phrase used in sentences: "today 8 pm", "tomorrow 12 pm",
 * "16 Oct 5 pm"; '' when the instant is unusable. Pure.
 */
export function duePhrase(dueAt: string, nowMs: number, timeZone: string): string {
  const ms = epoch(dueAt);
  if (Number.isNaN(ms)) return '';
  const clock = clockLabel(dueAt, timeZone);
  const which = dueDayOf(ms, nowMs, timeZone);
  if (which === 'today') return `today ${clock}`;
  if (which === 'tomorrow') return `tomorrow ${clock}`;
  return `${civilDayLabel(civilDay(ms, timeZone))} ${clock}`;
}

/** Whether a task's due time has passed (the timer fired, or the clock is past it). Pure. */
export function isMissed(task: Pick<ChatTask, 'dueAt' | 'duePassedAt'>, nowMs: number): boolean {
  if (task.dueAt === null) return false;
  if (task.duePassedAt !== null) return true;
  const ms = epoch(task.dueAt);
  return !Number.isNaN(ms) && ms < nowMs;
}

export type DueTone = 'none' | 'later' | 'today' | 'missed';

/**
 * A row's due cell: "8 pm" (today), "Tmrw 12 pm", "16 Oct 5 pm", "–" when
 * none. Tone: today is urgent, missed wins over everything. Pure.
 */
export function dueLabel(
  task: Pick<ChatTask, 'dueAt' | 'duePassedAt'>,
  nowMs: number,
  timeZone: string,
): { text: string; tone: DueTone } {
  if (task.dueAt === null) return { text: '–', tone: 'none' };
  const ms = epoch(task.dueAt);
  if (Number.isNaN(ms)) return { text: '–', tone: 'none' };
  const clock = clockLabel(task.dueAt, timeZone);
  const which = dueDayOf(ms, nowMs, timeZone);
  const text =
    which === 'today'
      ? clock
      : which === 'tomorrow'
        ? `Tmrw ${clock}`
        : `${civilDayLabel(civilDay(ms, timeZone))} ${clock}`;
  if (isMissed(task, nowMs)) return { text, tone: 'missed' };
  return { text, tone: which === 'today' ? 'today' : 'later' };
}

/** An event or change time: "7:30 pm" today, else "12 Oct 7:30 pm". Pure. */
export function changeTimeLabel(iso: string, nowMs: number, timeZone: string): string {
  const ms = epoch(iso);
  if (Number.isNaN(ms)) return '';
  const clock = clockLabelFull(iso, timeZone);
  const day = civilDay(ms, timeZone);
  return day === civilDay(nowMs, timeZone) ? clock : `${civilDayLabel(day)} ${clock}`;
}

/**
 * The expanded row's commitment line: "Due today 8 pm · set by Chitra at
 * 11:05 am", "Missed: due today 3 pm · set by ...", "No due time yet". Pure.
 */
export function commitmentLine(
  task: Pick<ChatTask, 'dueAt' | 'duePassedAt' | 'dueSetBy' | 'dueSetAt'>,
  nameOf: (userId: string) => string,
  nowMs: number,
  timeZone: string,
): { text: string; missed: boolean } {
  if (task.dueAt === null) return { text: 'No due time yet', missed: false };
  const missed = isMissed(task, nowMs);
  const who = task.dueSetBy !== null ? nameOf(task.dueSetBy) : 'Member';
  const at = task.dueSetAt !== null ? ` at ${changeTimeLabel(task.dueSetAt, nowMs, timeZone)}` : '';
  const phrase = duePhrase(task.dueAt, nowMs, timeZone);
  return {
    text: `${missed ? 'Missed: due' : 'Due'} ${phrase} · set by ${who}${at}`,
    missed,
  };
}

/** The due picker's state for a task: which day button and hour are set. Pure. */
export function dueSelection(
  dueAt: string | null,
  nowMs: number,
  timeZone: string,
): { civil: string; hour: number; which: DueDay } | null {
  if (dueAt === null) return null;
  const ms = epoch(dueAt);
  if (Number.isNaN(ms)) return null;
  const p = zonedParts(ms, timeZone);
  const civil = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { civil, hour: p.hour, which: dueDayOf(ms, nowMs, timeZone) };
}

/** The hours the time strip offers: 10 am to 9 pm. */
export const DUE_HOURS: readonly number[] = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

/**
 * Whether an hour on a civil day is already over for picking a due time: on
 * today (workspace clock) every hour up to and including the current one. Pure.
 */
export function isPastHour(civil: string, hour: number, nowMs: number, timeZone: string): boolean {
  if (civil !== civilDay(nowMs, timeZone)) return civil < civilDay(nowMs, timeZone);
  return hour <= zonedParts(nowMs, timeZone).hour;
}

/** The Date strip: the 14 days after tomorrow on the workspace clock. Pure. */
export function dateStripDays(
  nowMs: number,
  timeZone: string,
): { civil: string; weekday: string; day: number }[] {
  const today = civilDay(nowMs, timeZone);
  return Array.from({ length: 14 }, (_, k) => {
    const civil = addCivilDays(today, k + 2);
    const [y, m, d] = civil.split('-').map(Number);
    const weekday = WEEKDAYS[new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()] ?? '';
    return { civil, weekday, day: d ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Groups and order
// ---------------------------------------------------------------------------

/** Open statuses (the Agency and Client groups); the rest are closed. */
export function isOpenStatus(status: TaskStatus): boolean {
  return status === 'todo' || status === 'waiting';
}

/** Priority (P0 first), then number. Pure. */
export function compareTasks(a: ChatTask, b: ChatTask): number {
  return a.priority - b.priority || a.number - b.number;
}

/** A closed task last changed today on the workspace clock. Pure. */
export function isDoneToday(task: ChatTask, nowMs: number, timeZone: string): boolean {
  if (isOpenStatus(task.status)) return false;
  const ms = epoch(task.updatedAt);
  return !Number.isNaN(ms) && civilDay(ms, timeZone) === civilDay(nowMs, timeZone);
}

export interface TaskGroups {
  agency: ChatTask[];
  client: ChatTask[];
  done: ChatTask[];
}

/**
 * The sheet's groups: open items per side (priority, then number) and the
 * items closed today (by number). Older closed items are not shown. Pure.
 */
export function groupTasks(
  tasks: readonly ChatTask[],
  nowMs: number,
  timeZone: string,
): TaskGroups {
  const open = tasks.filter((t) => isOpenStatus(t.status)).sort(compareTasks);
  return {
    agency: open.filter((t) => t.side === 'agency'),
    client: open.filter((t) => t.side === 'client'),
    done: tasks.filter((t) => isDoneToday(t, nowMs, timeZone)).sort((a, b) => a.number - b.number),
  };
}

/**
 * The display order while a row is expanded: the group's order frozen at
 * expand time, each row with its latest data (a row whose change would move
 * it to another group stays put), then rows that are new to every frozen
 * group. Pure.
 */
export function holdOrder(
  fresh: readonly ChatTask[],
  frozen: readonly string[],
  all: ReadonlyMap<string, ChatTask> = new Map(fresh.map((t) => [t.id, t] as const)),
  held: ReadonlySet<string> = new Set(frozen),
): ChatTask[] {
  const kept = frozen.flatMap((id) => {
    const task = all.get(id);
    return task !== undefined ? [task] : [];
  });
  return [...kept, ...fresh.filter((t) => !held.has(t.id))];
}

/** The number the next item will most likely get (the server assigns it). Pure. */
export function nextNumberPreview(tasks: readonly Pick<ChatTask, 'number'>[]): number {
  let max = 0;
  for (const t of tasks) if (t.number > max) max = t.number;
  return max + 1;
}

/** Upsert by id (new array, input untouched). Pure. */
export function upsertTask(tasks: readonly ChatTask[], task: ChatTask): ChatTask[] {
  const at = tasks.findIndex((t) => t.id === task.id);
  if (at < 0) return [...tasks, task];
  const next = [...tasks];
  next[at] = task;
  return next;
}

/** Merge events by id, oldest first (new array). Pure. */
export function mergeEvents(
  events: readonly TaskEvent[],
  incoming: readonly TaskEvent[],
): TaskEvent[] {
  const byId = new Map(events.map((e) => [e.id, e] as const));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort(
    (a, b) => epoch(a.createdAt) - epoch(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** A task as it looks after one field write by `actorId` at `nowIso`. Pure. */
export function applyTaskField(
  task: ChatTask,
  field: TaskField,
  value: string,
  actorId: string,
  nowIso: string,
): ChatTask {
  const touched = { ...task, updatedAt: nowIso };
  switch (field) {
    case 'status':
      return { ...touched, status: asStatus(value) ?? task.status };
    case 'priority':
      return { ...touched, priority: asPriority(value) ?? task.priority };
    case 'side':
      return { ...touched, side: asSide(value) ?? task.side };
    case 'title':
      return { ...touched, title: value.trim() === '' ? task.title : value.trim() };
    case 'note':
      return { ...touched, note: value.trim() === '' ? null : value.trim() };
    case 'due':
      return {
        ...touched,
        dueAt: value === '' ? null : value,
        dueSetBy: actorId,
        dueSetAt: nowIso,
        duePassedAt: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Event text
// ---------------------------------------------------------------------------

/** One piece of a change line; `mono` numbers, `bad` the P-to-P0 segment. */
export interface TaskSegment {
  text: string;
  tone?: 'mono' | 'bad';
}

/** What an event line names about its task (current values; side only for created). */
export interface TaskRef {
  number: number | null;
  title: string;
  side: TaskSide | null;
}

function priorityText(value: string | null): string {
  const p = asPriority(value);
  return p === null ? 'P?' : `P${p}`;
}

/**
 * A change as segments: created "added 12 Title · Agency", status "12 Title →
 * Shared", priority "12 P1 → P0", due "12 due today 8 pm" / "12 due cleared",
 * side "12 moved to Client", title "renamed 12 to New", note "12 note updated",
 * due_passed "3 pm passed · 12 Title". Pure.
 */
export function eventSegments(
  event: Pick<TaskEvent, 'kind' | 'oldValue' | 'newValue'>,
  task: TaskRef,
  nowMs: number,
  timeZone: string,
): TaskSegment[] {
  const n: TaskSegment = { text: task.number !== null ? String(task.number) : '?', tone: 'mono' };
  switch (event.kind) {
    case 'created': {
      const out: TaskSegment[] = [
        { text: 'added ' },
        n,
        { text: ` ${event.newValue ?? task.title}` },
      ];
      if (task.side !== null) out.push({ text: ` · ${SIDE_LABEL[task.side]}` });
      return out;
    }
    case 'status': {
      const status = asStatus(event.newValue);
      return [
        n,
        { text: ` ${task.title} → ${status !== null ? STATUS_LABEL[status] : 'Unknown'}` },
      ];
    }
    case 'priority': {
      const to = asPriority(event.newValue);
      return [
        n,
        { text: ' ' },
        {
          text: `${priorityText(event.oldValue)} → ${priorityText(event.newValue)}`,
          tone: to === 0 ? 'bad' : 'mono',
        },
      ];
    }
    case 'due':
      if (event.newValue === null || event.newValue === '') return [n, { text: ' due cleared' }];
      return [n, { text: ` due ${duePhrase(event.newValue, nowMs, timeZone)}` }];
    case 'side': {
      const side = asSide(event.newValue);
      return [n, { text: ` moved to ${side !== null ? SIDE_LABEL[side] : 'the other side'}` }];
    }
    case 'title':
      return [{ text: 'renamed ' }, n, { text: ` to ${event.newValue ?? task.title}` }];
    case 'note':
      return [n, { text: ' note updated' }];
    case 'due_passed': {
      const at = event.oldValue !== null ? clockLabel(event.oldValue, timeZone) : 'Due time';
      return [{ text: `${at} passed · ` }, n, { text: ` ${task.title}` }];
    }
  }
}

/** The change as one line of text. Pure. */
export function eventText(
  event: Pick<TaskEvent, 'kind' | 'oldValue' | 'newValue'>,
  task: TaskRef,
  nowMs: number,
  timeZone: string,
): string {
  return eventSegments(event, task, nowMs, timeZone)
    .map((s) => s.text)
    .join('');
}

/** A task's reference for event text; an unknown task reads "?". Pure. */
export function taskRefOf(task: ChatTask | undefined): TaskRef {
  return task === undefined
    ? { number: null, title: 'Item', side: null }
    : { number: task.number, title: task.title, side: task.side };
}

/** The footer: "Last change: Name · text · time"; null with no events. Pure. */
export function lastChangeLine(
  events: readonly TaskEvent[],
  tasksById: ReadonlyMap<string, ChatTask>,
  nameOf: (userId: string) => string,
  nowMs: number,
  timeZone: string,
): string | null {
  const last = events[events.length - 1];
  if (last === undefined) return null;
  const text = eventText(last, taskRefOf(tasksById.get(last.taskId)), nowMs, timeZone);
  const time = changeTimeLabel(last.createdAt, nowMs, timeZone);
  const who = last.actorId !== null ? `${nameOf(last.actorId)} · ` : '';
  return `Last change: ${who}${text} · ${time}`;
}

// ---------------------------------------------------------------------------
// Thread lines
// ---------------------------------------------------------------------------

/** Consecutive changes by one person this close together collapse... */
export const COLLAPSE_WINDOW_MS = 2 * 60 * 1000;
/** ...when there are at least this many of them. */
export const COLLAPSE_MIN = 4;

/** One thread line: a single change, or one person's burst of changes. */
export type TaskLine =
  | { kind: 'one'; event: TaskEvent }
  | { kind: 'many'; actorId: string; events: TaskEvent[] };

/**
 * Collapse a run of consecutive events (no message between them): 4+ by one
 * actor within 2 minutes of the first become one line. The due timer's events
 * (no actor) never collapse. Pure.
 */
export function collapseTaskRun(events: readonly TaskEvent[]): TaskLine[] {
  const lines: TaskLine[] = [];
  let i = 0;
  while (i < events.length) {
    const first = events[i];
    if (first === undefined) break;
    const actor = first.actorId;
    let j = i;
    if (actor !== null) {
      const start = epoch(first.createdAt);
      while (j + 1 < events.length) {
        const next = events[j + 1];
        if (next === undefined || next.actorId !== actor) break;
        if (epoch(next.createdAt) - start > COLLAPSE_WINDOW_MS) break;
        j += 1;
      }
    }
    if (actor !== null && j - i + 1 >= COLLAPSE_MIN) {
      lines.push({ kind: 'many', actorId: actor, events: events.slice(i, j + 1) });
      i = j + 1;
    } else {
      lines.push({ kind: 'one', event: first });
      i += 1;
    }
  }
  return lines;
}

/** "Name made 5 task changes". Pure. */
export function burstLabel(name: string, count: number): string {
  return `${name} made ${count} task changes`;
}

/**
 * The events the thread shows for its loaded window: everything when the
 * oldest page is loaded, else only events at or after the oldest loaded
 * message. Pure.
 */
export function eventsInWindow(
  events: readonly TaskEvent[],
  oldestMessageMs: number | null,
  hasMore: boolean,
): TaskEvent[] {
  if (!hasMore || oldestMessageMs === null) return [...events];
  return events.filter((e) => epoch(e.createdAt) >= oldestMessageMs);
}

/**
 * The composer button's dot: the newest change by someone else (the due timer
 * counts) is newer than the last time this device opened the list. Pure.
 */
export function hasUnseenChanges(
  events: readonly TaskEvent[],
  currentUserId: string,
  seenMs: number | null,
): boolean {
  for (let k = events.length - 1; k >= 0; k -= 1) {
    const e = events[k];
    if (e === undefined || e.actorId === currentUserId) continue;
    if (seenMs === null) return true;
    return epoch(e.createdAt) > seenMs;
  }
  return false;
}

/** The localStorage key for when this device last opened a chat's list. */
export function tasksSeenKey(channelId: string): string {
  return `sorted:tasks-seen:${channelId}`;
}

// ---------------------------------------------------------------------------
// Share snapshot
// ---------------------------------------------------------------------------

/** A chat message's length limit (chat_message_send). */
export const SNAPSHOT_MAX = 5000;

function snapshotItem(task: ChatTask, nowMs: number, timeZone: string): string {
  const due = task.dueAt !== null ? duePhrase(task.dueAt, nowMs, timeZone) : '';
  const dueText = due !== '' ? ` · ${due}` : '';
  const missed = isMissed(task, nowMs) ? ' (missed)' : '';
  return `${task.number}. ${task.title} · P${task.priority}${dueText}${missed}`;
}

/**
 * The plain-text snapshot Share sends, on the workspace clock:
 *   Task list · Chat · 13 Oct, 7:30 pm
 *   Agency / items / Client / items / Done today: 3, 5
 * An empty side is left out, as is the done line when nothing closed today.
 * Past 5000 characters the done line goes first, then trailing items, ending
 * "+k more". Pure.
 */
export function shareSnapshot(input: {
  chatName: string;
  tasks: readonly ChatTask[];
  nowMs: number;
  timeZone: string;
  max?: number;
}): string {
  const { nowMs, timeZone } = input;
  const max = input.max ?? SNAPSHOT_MAX;
  const groups = groupTasks(input.tasks, nowMs, timeZone);
  const nowIso = new Date(nowMs).toISOString();
  const stamp = `${civilDayLabel(civilDay(nowMs, timeZone))}, ${clockLabel(nowIso, timeZone)}`;
  const header = `Task list · ${input.chatName} · ${stamp}`;
  const items: { side: TaskSide; line: string }[] = [
    ...groups.agency.map((t) => ({
      side: 'agency' as const,
      line: snapshotItem(t, nowMs, timeZone),
    })),
    ...groups.client.map((t) => ({
      side: 'client' as const,
      line: snapshotItem(t, nowMs, timeZone),
    })),
  ];
  const doneLine =
    groups.done.length > 0 ? `Done today: ${groups.done.map((t) => t.number).join(', ')}` : null;
  const build = (kept: number, withDone: boolean): string => {
    const lines = [header];
    for (const side of ['agency', 'client'] as const) {
      const sideItems = items.slice(0, kept).filter((i) => i.side === side);
      if (sideItems.length === 0) continue;
      lines.push(SIDE_LABEL[side], ...sideItems.map((i) => i.line));
    }
    if (kept < items.length) lines.push(`+${items.length - kept} more`);
    if (withDone && doneLine !== null) lines.push(doneLine);
    return lines.join('\n');
  };
  const full = build(items.length, true);
  if (full.length <= max) return full;
  for (let kept = items.length; kept >= 0; kept -= 1) {
    const text = build(kept, false);
    if (text.length <= max) return text;
  }
  return header.slice(0, max);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const TASK_COLUMNS =
  'id, channel_id, workspace_id, number, title, note, side, status, priority, due_at, due_set_by, due_set_at, due_passed_at, created_by, created_at, updated_at';
const EVENT_COLUMNS =
  'id, task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value, created_at';

/** How many events one read carries (newest first, then put oldest first). */
export const EVENT_PAGE = 200;

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** The instant today starts on the workspace clock (00:00 there), as ISO. Pure. */
export function startOfTodayIso(nowMs: number, timeZone: string): string {
  return civilHourToUtcIso(civilDay(nowMs, timeZone), 0, timeZone);
}

/**
 * The PostgREST `or` the list read uses: open items, plus anything changed
 * since today began (the Done today group and the share snapshot). Pure.
 */
export function openOrTodayFilter(nowMs: number, timeZone: string): string {
  return `status.in.(todo,waiting),updated_at.gte.${startOfTodayIso(nowMs, timeZone)}`;
}

/**
 * A channel's open items and the items changed today (RLS: members only), one
 * query; older closed items are never read.
 */
export async function readChannelTasks(
  client: Client,
  channelId: string,
  clock: { nowMs: number; timeZone: string },
  signal?: AbortSignal,
): Promise<Result<ChatTask[]>> {
  try {
    const res = await abortable(
      client
        .from('chat_tasks')
        .select(TASK_COLUMNS)
        .eq('channel_id', channelId)
        .or(openOrTodayFilter(clock.nowMs, clock.timeZone)),
      signal,
    );
    if (res.error) return fail(`readChannelTasks: ${res.error.message}`);
    const rows = (res.data ?? []) as TaskRow[];
    return { ok: true, data: rows.flatMap((r) => rowToTask(r) ?? []) };
  } catch (error) {
    return fail(`readChannelTasks: ${String(error)}`);
  }
}

/** Tasks by id, one IN read (the thread lines of items no longer in the list). */
export async function readTasksByIds(
  client: Client,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Result<ChatTask[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  try {
    const res = await abortable(
      client
        .from('chat_tasks')
        .select(TASK_COLUMNS)
        .in('id', [...ids]),
      signal,
    );
    if (res.error) return fail(`readTasksByIds: ${res.error.message}`);
    const rows = (res.data ?? []) as TaskRow[];
    return { ok: true, data: rows.flatMap((r) => rowToTask(r) ?? []) };
  } catch (error) {
    return fail(`readTasksByIds: ${String(error)}`);
  }
}

/** One task by id (after a live signal). */
export async function readTask(
  client: Client,
  taskId: string,
  signal?: AbortSignal,
): Promise<Result<ChatTask | null>> {
  try {
    const res = await abortable(
      client.from('chat_tasks').select(TASK_COLUMNS).eq('id', taskId),
      signal,
    );
    if (res.error) return fail(`readTask: ${res.error.message}`);
    const row = ((res.data ?? []) as TaskRow[])[0];
    return { ok: true, data: row !== undefined ? rowToTask(row) : null };
  } catch (error) {
    return fail(`readTask: ${String(error)}`);
  }
}

/**
 * A channel's events in (sinceIso, untilIso), newest EVENT_PAGE of them, put
 * oldest first. `full` says the page was full (older events may exist).
 */
export async function readTaskEvents(
  client: Client,
  channelId: string,
  window: { sinceIso?: string | null; untilIso?: string | null; signal?: AbortSignal } = {},
): Promise<Result<{ events: TaskEvent[]; full: boolean }>> {
  try {
    let query = client.from('chat_task_events').select(EVENT_COLUMNS).eq('channel_id', channelId);
    if (window.sinceIso != null) query = query.gt('created_at', window.sinceIso);
    if (window.untilIso != null) query = query.lt('created_at', window.untilIso);
    const res = await abortable(
      query.order('created_at', { ascending: false }).limit(EVENT_PAGE),
      window.signal,
    );
    if (res.error) return fail(`readTaskEvents: ${res.error.message}`);
    const rows = (res.data ?? []) as TaskEventRow[];
    const events = rows.flatMap((r) => rowToTaskEvent(r) ?? []).reverse();
    return { ok: true, data: { events, full: rows.length >= EVENT_PAGE } };
  } catch (error) {
    return fail(`readTaskEvents: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** A write outcome; the message is the raw error, for logging only. */
export type TaskWriteResult<T = null> = { ok: true; data: T } | { ok: false; message: string };

/**
 * Add an item (chat_task_create): the server assigns the number. The
 * generated Args type declares p_note and p_due_at as plain strings; SQL NULL
 * is valid there, so the args are built nullable and narrowed once.
 */
export async function createTask(params: {
  client: Client;
  channelId: string;
  title: string;
  side: TaskSide;
  priority?: TaskPriority;
  traceId: string;
}): Promise<TaskWriteResult<string>> {
  const args: Omit<Functions['chat_task_create']['Args'], 'p_note' | 'p_due_at'> & {
    p_note: string | null;
    p_due_at: string | null;
  } = {
    p_channel_id: params.channelId,
    p_title: params.title.trim(),
    p_note: null,
    p_side: params.side,
    p_priority: params.priority ?? 2,
    p_due_at: null,
    p_trace_id: params.traceId,
  };
  try {
    const { data, error } = await params.client.rpc(
      'chat_task_create',
      args as Functions['chat_task_create']['Args'],
    );
    if (error) return { ok: false, message: error.message };
    return typeof data === 'string' && data !== ''
      ? { ok: true, data }
      : { ok: false, message: 'chat_task_create returned no id' };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

/** Change one field (chat_task_set); due takes an ISO instant, or '' to clear. */
export async function setTaskField(params: {
  client: Client;
  taskId: string;
  field: TaskField;
  value: string;
  traceId: string;
}): Promise<TaskWriteResult> {
  const args: Functions['chat_task_set']['Args'] = {
    p_task_id: params.taskId,
    p_field: params.field,
    p_value: params.value,
    p_trace_id: params.traceId,
  };
  try {
    const { error } = await params.client.rpc('chat_task_set', args);
    if (error) return { ok: false, message: error.message };
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}
