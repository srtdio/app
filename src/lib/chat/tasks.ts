// The chat's Tasks: one shared, numbered list per chat (public.chat_tasks),
// its change log (public.chat_task_events) and the one write
// (chat_task_save_batch). The list belongs to the chat: every member has the
// same powers. The pure rules (order, the sheet's local draft and its diff,
// the batch payload, conflicts, the "changed since you looked" marks, batch
// thread lines, the editing signal's timing, the share snapshot) are
// framework-free and unit-tested; the reads are one query each and the write
// passes an explicit p_trace_id. Nothing here touches React.

import type { Client, Result } from '@srtdio/rpc';
import type { Database, Json } from '@srtdio/schemas';
import { abortable } from '@/lib/chat-reads';
import { civilDay, safeTimeZone } from '@/lib/chat/time-format';

type Functions = Database['public']['Functions'];
type TaskRow = Database['public']['Tables']['chat_tasks']['Row'];
type TaskEventRow = Database['public']['Tables']['chat_task_events']['Row'];

export type TaskStatus = 'todo' | 'done';
export type TaskSide = 'agency' | 'client';
export type TaskPriority = 0 | 1 | 2;
export type TaskEventKind =
  | 'created'
  | 'status'
  | 'priority'
  | 'due'
  | 'side'
  | 'title'
  | 'note'
  | 'edited'
  | 'deleted';

/** One task as the sheet renders it. */
export interface ChatTask {
  id: string;
  channelId: string;
  number: number;
  title: string;
  /** Kept on the row (new tasks get the creator's side); never shown. */
  side: TaskSide;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set once deleted (soft delete); a deleted task never shows in a list. */
  deletedAt?: string | null;
}

/** One change-log row. */
export interface TaskEvent {
  id: string;
  taskId: string;
  channelId: string;
  /** Null on rows with no actor. */
  actorId: string | null;
  kind: TaskEventKind;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
  /** The Save it belongs to (chat_task_save_batch); null on older rows. */
  batchId: string | null;
}

export const TASK_PRIORITIES: readonly TaskPriority[] = [0, 1, 2];

/** The priority menu's names. */
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  0: 'Urgent',
  1: 'High',
  2: 'Normal',
};

/** A new task's priority when none is picked. */
export const DEFAULT_PRIORITY: TaskPriority = 1;

/** Title limit (the table's CHECK). */
export const TASK_TITLE_MAX = 200;

const KIND_SET = new Set<string>([
  'created',
  'status',
  'priority',
  'due',
  'side',
  'title',
  'note',
  'edited',
  'deleted',
]);

/**
 * A stored status as the list reads it: 'done' is done; anything else (older
 * rows read before the status rewrite) is to do. Pure.
 */
export function asStatus(value: string | null | undefined): TaskStatus {
  return value === 'done' ? 'done' : 'todo';
}

function asSide(value: string | null | undefined): TaskSide | null {
  return value === 'agency' || value === 'client' ? value : null;
}

export function asPriority(value: unknown): TaskPriority | null {
  const n = typeof value === 'string' && value !== '' ? Number(value) : value;
  return n === 0 || n === 1 || n === 2 ? n : null;
}

/** Map a row; an impossible row (CHECKs forbid it) is skipped. Pure. */
export function rowToTask(row: TaskRow): ChatTask | null {
  const side = asSide(row.side);
  const priority = asPriority(row.priority);
  if (side === null || priority === null) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    number: row.number,
    title: row.title,
    side,
    status: asStatus(row.status),
    priority,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

/** Whether a task was deleted (soft delete). Pure. */
export function isDeleted(task: Pick<ChatTask, 'deletedAt'>): boolean {
  return task.deletedAt != null;
}

/** Map an event row; an unknown kind (and the retired due timer's rows) is skipped. Pure. */
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
    batchId: row.batch_id ?? null,
  };
}

function epoch(iso: string | null | undefined): number {
  if (iso == null) return Number.NaN;
  return Date.parse(iso);
}

// ---------------------------------------------------------------------------
// Workspace clock (the snapshot stamp, change times)
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function zonedHourMinute(ms: number, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone(timeZone),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { hour: read('hour') % 24, minute: read('minute') };
}

/** "16 Oct" for a civil date. Pure. */
export function civilDayLabel(civil: string): string {
  const [, m, d] = civil.split('-').map(Number);
  return `${d ?? ''} ${MONTHS[(m ?? 1) - 1] ?? ''}`;
}

/** An instant's clock on the workspace clock, always with minutes: "11:05 am". Pure. */
export function clockLabelFull(iso: string, timeZone: string): string {
  const ms = epoch(iso);
  if (Number.isNaN(ms)) return '';
  const p = zonedHourMinute(ms, timeZone);
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'am' : 'pm'}`;
}

/** An event or change time: "7:30 pm" today, else "12 Oct 7:30 pm". Pure. */
export function changeTimeLabel(iso: string, nowMs: number, timeZone: string): string {
  const ms = epoch(iso);
  if (Number.isNaN(ms)) return '';
  const clock = clockLabelFull(iso, timeZone);
  const day = civilDay(ms, timeZone);
  return day === civilDay(nowMs, timeZone) ? clock : `${civilDayLabel(day)} ${clock}`;
}

// ---------------------------------------------------------------------------
// Order and list helpers
// ---------------------------------------------------------------------------

/** The list order: by number (the order they were added). Pure. */
export function compareTasks(a: ChatTask, b: ChatTask): number {
  return a.number - b.number;
}

/** The live list, by number: never a deleted task. Pure. */
export function listTasks(tasks: readonly ChatTask[]): ChatTask[] {
  return tasks.filter((t) => !isDeleted(t)).sort(compareTasks);
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

// ---------------------------------------------------------------------------
// The sheet's local draft: nothing writes until Save
// ---------------------------------------------------------------------------

/** The fields one edit may change (chat_task_save_batch's changes keys). */
export interface TaskChanges {
  title?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
}

/** A task typed into the add row, not written until Save. */
export interface DraftNew {
  key: string;
  title: string;
  priority: TaskPriority;
  side: TaskSide;
}

/** The sheet's unsaved work. */
export interface SheetDraft {
  /** Edits by task id (only what the user touched; may equal the stored value). */
  edits: Readonly<Record<string, TaskChanges>>;
  /** New tasks in typed order. */
  creates: readonly DraftNew[];
  /** Task ids queued for delete. */
  deletes: readonly string[];
  /**
   * The updated_at each touched task had when this draft last synced it
   * (chat_task_save_batch's base_updated_at), by task id.
   */
  bases: Readonly<Record<string, string>>;
}

export const EMPTY_DRAFT: SheetDraft = { edits: {}, creates: [], deletes: [], bases: {} };

/** Only what an edit really changes against the stored task (titles trimmed; empty title is no change). Pure. */
export function effectiveChanges(task: ChatTask, edit: TaskChanges | undefined): TaskChanges {
  const out: TaskChanges = {};
  if (edit === undefined) return out;
  if (edit.title !== undefined) {
    const title = edit.title.trim();
    if (title !== '' && title !== task.title) out.title = title;
  }
  if (edit.priority !== undefined && edit.priority !== task.priority) out.priority = edit.priority;
  if (edit.status !== undefined && edit.status !== task.status) out.status = edit.status;
  return out;
}

/** Whether a change set is empty. Pure. */
export function hasChanges(changes: TaskChanges): boolean {
  return Object.keys(changes).length > 0;
}

/** A task as it looks with a change set applied (display and optimistic paint). Pure. */
export function applyChanges(task: ChatTask, changes: TaskChanges): ChatTask {
  return {
    ...task,
    ...(changes.title !== undefined ? { title: changes.title } : {}),
    ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
    ...(changes.status !== undefined ? { status: changes.status } : {}),
  };
}

/** The ids whose draft really differs (edits that change something, and deletes). Pure. */
export function touchedIds(draft: SheetDraft, byId: ReadonlyMap<string, ChatTask>): Set<string> {
  const out = new Set<string>();
  for (const [id, edit] of Object.entries(draft.edits)) {
    const task = byId.get(id);
    if (task !== undefined && hasChanges(effectiveChanges(task, edit))) out.add(id);
  }
  for (const id of draft.deletes) if (byId.has(id)) out.add(id);
  return out;
}

/**
 * Whether the draft would write anything: a change that does not revert to
 * the stored value, a delete, or a new task with a title. Pure.
 */
export function isDraftDirty(draft: SheetDraft, byId: ReadonlyMap<string, ChatTask>): boolean {
  if (draft.creates.some((c) => c.title.trim() !== '')) return true;
  return touchedIds(draft, byId).size > 0;
}

/** Set one field of a task's edit, remembering its base the first time it is touched. Pure. */
export function editField(draft: SheetDraft, task: ChatTask, change: TaskChanges): SheetDraft {
  const prev = draft.edits[task.id] ?? {};
  return {
    ...draft,
    edits: { ...draft.edits, [task.id]: { ...prev, ...change } },
    bases:
      draft.bases[task.id] !== undefined
        ? draft.bases
        : { ...draft.bases, [task.id]: task.updatedAt },
  };
}

/** Queue a delete (its base remembered). Pure. */
export function queueDelete(draft: SheetDraft, task: ChatTask): SheetDraft {
  if (draft.deletes.includes(task.id)) return draft;
  return {
    ...draft,
    deletes: [...draft.deletes, task.id],
    bases:
      draft.bases[task.id] !== undefined
        ? draft.bases
        : { ...draft.bases, [task.id]: task.updatedAt },
  };
}

/** Drop everything the draft holds for one task. Pure. */
export function dropTask(draft: SheetDraft, taskId: string): SheetDraft {
  const edits = { ...draft.edits };
  delete edits[taskId];
  const bases = { ...draft.bases };
  delete bases[taskId];
  return { ...draft, edits, bases, deletes: draft.deletes.filter((id) => id !== taskId) };
}

/** One edit as chat_task_save_batch takes it. */
export interface BatchEdit {
  task_id: string;
  base_updated_at: string;
  changes: { title?: string; priority?: TaskPriority; status?: TaskStatus };
}

/** One delete as chat_task_save_batch takes it. */
export interface BatchDelete {
  task_id: string;
  base_updated_at: string;
}

/** One create as chat_task_save_batch takes it. */
export interface BatchCreate {
  title: string;
  priority: TaskPriority;
  side: TaskSide;
}

export interface BatchPayload {
  creates: BatchCreate[];
  edits: BatchEdit[];
  deletes: BatchDelete[];
}

/**
 * The Save payload: creates with a title, edits with only their changed fields
 * (a deleted task sends no edit), deletes; each edit and delete with its base. Pure.
 */
export function batchPayload(draft: SheetDraft, byId: ReadonlyMap<string, ChatTask>): BatchPayload {
  const deleting = new Set(draft.deletes);
  const baseOf = (task: ChatTask): string => draft.bases[task.id] ?? task.updatedAt;
  const edits: BatchEdit[] = [];
  for (const [id, edit] of Object.entries(draft.edits)) {
    const task = byId.get(id);
    if (task === undefined || deleting.has(id)) continue;
    const changes = effectiveChanges(task, edit);
    if (hasChanges(changes)) edits.push({ task_id: id, base_updated_at: baseOf(task), changes });
  }
  const deletes: BatchDelete[] = draft.deletes.flatMap((id) => {
    const task = byId.get(id);
    return task === undefined ? [] : [{ task_id: id, base_updated_at: baseOf(task) }];
  });
  const creates = draft.creates
    .map((c) => ({ title: c.title.trim(), priority: c.priority, side: c.side }))
    .filter((c) => c.title !== '');
  return { creates, edits, deletes };
}

/** Whether a payload writes nothing. Pure. */
export function isEmptyPayload(p: BatchPayload): boolean {
  return p.creates.length === 0 && p.edits.length === 0 && p.deletes.length === 0;
}

// ---------------------------------------------------------------------------
// Conflicts (both edited) and the live merge
// ---------------------------------------------------------------------------

/** A task someone else changed (or deleted) after this draft last synced it. */
export interface TaskConflict {
  taskId: string;
  deleted: boolean;
  title: string;
  priority: TaskPriority;
  status: TaskStatus;
  updatedAt: string;
}

/** Map the RPC's conflicts array; malformed entries are skipped. Pure. */
export function parseConflicts(raw: unknown): TaskConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c: unknown) => {
    if (c === null || typeof c !== 'object') return [];
    const r = c as Record<string, unknown>;
    const priority = asPriority(r.priority);
    if (typeof r.task_id !== 'string' || typeof r.updated_at !== 'string' || priority === null) {
      return [];
    }
    return [
      {
        taskId: r.task_id,
        deleted: r.deleted === true,
        title: typeof r.title === 'string' ? r.title : '',
        priority,
        status: asStatus(typeof r.status === 'string' ? r.status : null),
        updatedAt: r.updated_at,
      },
    ];
  });
}

/**
 * What a conflict says under the row: "<Name> deleted this", or "<Name>
 * changed this to <their values>" naming the fields this draft also changed
 * (title in quotes, priority P0, done / to do). Pure.
 */
export function conflictLine(
  name: string,
  conflict: TaskConflict,
  mine: TaskChanges | undefined,
): string {
  if (conflict.deleted) return `${name} deleted this`;
  const parts: string[] = [];
  const all = mine === undefined || !hasChanges(mine);
  if (all || mine?.title !== undefined) parts.push(`"${conflict.title}"`);
  if (all || mine?.priority !== undefined) parts.push(`P${conflict.priority}`);
  if (mine?.status !== undefined) parts.push(conflict.status === 'done' ? 'done' : 'not done');
  return `${name} changed this to ${parts.join(' · ')}`;
}

/** "Keep mine": the draft re-bases the task on their version, so the next Save sends it again. Pure. */
export function keepMine(draft: SheetDraft, conflict: TaskConflict): SheetDraft {
  return { ...draft, bases: { ...draft.bases, [conflict.taskId]: conflict.updatedAt } };
}

/** The stored task as the conflict reports it (their version). Pure. */
export function taskFromConflict(task: ChatTask, conflict: TaskConflict): ChatTask {
  return {
    ...task,
    title: conflict.title,
    priority: conflict.priority,
    status: conflict.status,
    updatedAt: conflict.updatedAt,
    deletedAt: conflict.deleted ? (task.deletedAt ?? conflict.updatedAt) : null,
  };
}

/**
 * Someone else saved while the sheet is open: rows this draft has NOT touched
 * simply take the fresh list (their bases move with it); a touched row keeps
 * the draft and gets a notice "<Name> changed this to …" (or "deleted this"),
 * resolved later with Keep mine / Keep theirs. Pure.
 */
export function liveMerge(input: {
  draft: SheetDraft;
  before: ReadonlyMap<string, ChatTask>;
  after: ReadonlyMap<string, ChatTask>;
}): { notices: TaskConflict[] } {
  const touched = touchedIds(input.draft, input.before);
  const notices: TaskConflict[] = [];
  for (const id of touched) {
    const old = input.before.get(id);
    const fresh = input.after.get(id);
    if (old === undefined) continue;
    if (fresh === undefined || isDeleted(fresh)) {
      notices.push({
        taskId: id,
        deleted: true,
        title: old.title,
        priority: old.priority,
        status: old.status,
        updatedAt: fresh?.updatedAt ?? old.updatedAt,
      });
      continue;
    }
    if (epoch(fresh.updatedAt) > epoch(input.draft.bases[id] ?? old.updatedAt)) {
      notices.push({
        taskId: id,
        deleted: false,
        title: fresh.title,
        priority: fresh.priority,
        status: fresh.status,
        updatedAt: fresh.updatedAt,
      });
    }
  }
  return { notices };
}

// ---------------------------------------------------------------------------
// Edited events: what changed
// ---------------------------------------------------------------------------

/** One edit's before and after, read from an 'edited' event's JSON. */
export interface EditedValues {
  old: TaskChanges;
  next: TaskChanges;
}

function parseChangeJson(raw: string | null): TaskChanges {
  if (raw === null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const r = parsed as Record<string, unknown>;
    const out: TaskChanges = {};
    if (typeof r.title === 'string') out.title = r.title;
    const p = asPriority(r.priority);
    if (p !== null) out.priority = p;
    if (typeof r.status === 'string') out.status = asStatus(r.status);
    return out;
  } catch {
    return {};
  }
}

/** The before and after of an 'edited' event (unknown fields dropped). Pure. */
export function editedValues(event: Pick<TaskEvent, 'oldValue' | 'newValue'>): EditedValues {
  return { old: parseChangeJson(event.oldValue), next: parseChangeJson(event.newValue) };
}

/** One row of an expanded batch line. */
export type BatchRow =
  | { kind: 'added'; number: number | null; title: string; priority: TaskPriority | null }
  | { kind: 'renamed'; number: number | null; from: string; to: string }
  | { kind: 'priority'; number: number | null; from: TaskPriority; to: TaskPriority }
  | { kind: 'done'; number: number | null; title: string }
  | { kind: 'reopened'; number: number | null; title: string }
  | { kind: 'deleted'; number: number | null; title: string };

/** What a task reference names in a line. */
export interface TaskRef {
  number: number | null;
  title: string;
  priority: TaskPriority | null;
}

/** A task's reference for line text; an unknown task reads "?". Pure. */
export function taskRefOf(task: ChatTask | undefined): TaskRef {
  return task === undefined
    ? { number: null, title: 'Task', priority: null }
    : { number: task.number, title: task.title, priority: task.priority };
}

/**
 * The rows one event expands to: "Added #n Title · P1", "Edited #n old → new",
 * "Priority #n P2 → P0", "Done #n Title", "Reopened #n Title", "Deleted #n
 * Title". Pure.
 */
export function batchRows(event: TaskEvent, ref: TaskRef): BatchRow[] {
  const number = ref.number;
  switch (event.kind) {
    case 'created':
      return [
        { kind: 'added', number, title: event.newValue ?? ref.title, priority: ref.priority },
      ];
    case 'deleted':
      return [{ kind: 'deleted', number, title: event.oldValue ?? ref.title }];
    case 'edited': {
      const { old, next } = editedValues(event);
      const title = next.title ?? ref.title;
      const rows: BatchRow[] = [];
      if (next.title !== undefined) {
        rows.push({ kind: 'renamed', number, from: old.title ?? '', to: next.title });
      }
      if (next.priority !== undefined && old.priority !== undefined) {
        rows.push({ kind: 'priority', number, from: old.priority, to: next.priority });
      }
      if (next.status !== undefined) {
        rows.push({ kind: next.status === 'done' ? 'done' : 'reopened', number, title });
      }
      return rows;
    }
    default:
      return [];
  }
}

/** A task's number as shown in lines and the bell: "#12", or "#?" when unknown. Pure. */
export function taskNumberLabel(n: number | null): string {
  return `#${n ?? '?'}`;
}

/** A batch row as plain text (tests, the bell, screen readers). Pure. */
export function batchRowText(row: BatchRow): string {
  const n = taskNumberLabel(row.number);
  switch (row.kind) {
    case 'added':
      return `Added ${n} ${row.title}${row.priority !== null ? ` · P${row.priority}` : ''}`;
    case 'renamed':
      return `Edited ${n} ${row.from} → ${row.to}`;
    case 'priority':
      return `Priority ${n} P${row.from} → P${row.to}`;
    case 'done':
      return `Done ${n} ${row.title}`;
    case 'reopened':
      return `Reopened ${n} ${row.title}`;
    case 'deleted':
      return `Deleted ${n} ${row.title}`;
  }
}

/** A single older (non-batch) event as one line of text, after the actor's name. Pure. */
export function eventText(
  event: Pick<TaskEvent, 'kind' | 'oldValue' | 'newValue'>,
  ref: TaskRef,
): string {
  const n = taskNumberLabel(ref.number);
  switch (event.kind) {
    case 'created':
      return `added ${n} ${event.newValue ?? ref.title}`;
    case 'deleted':
      return `deleted ${n} ${event.oldValue ?? ref.title}`;
    case 'edited':
    case 'status':
    case 'priority':
    case 'title':
    case 'note':
    case 'side':
    case 'due':
      return `updated ${n} ${ref.title}`;
  }
}

/** "<You|Name> edited tasks" (one Save). Pure. */
export function editedTasksLabel(name: string): string {
  return `${name} edited tasks`;
}

// ---------------------------------------------------------------------------
// Thread lines
// ---------------------------------------------------------------------------

/**
 * The focus id that opens the Tasks sheet with no row picked (a batch line, a
 * batch bell alert). It rides the same paths as a task id.
 */
export const TASKS_SHEET_ONLY = 'list';

/** Older rows (no batch id): consecutive adds by one person this close to the first are one line. */
export const ADD_BATCH_WINDOW_MS = 10_000;
/** Older rows: consecutive changes by one person this close together collapse... */
export const COLLAPSE_WINDOW_MS = 2 * 60 * 1000;
/** ...when there are at least this many of them. */
export const COLLAPSE_MIN = 4;

/**
 * One thread line: one Save (events sharing a batch id), or, for older rows
 * without one, a single change, a quick run of adds, or a burst of changes.
 */
export type TaskLine =
  | { kind: 'batch'; batchId: string; actorId: string | null; events: TaskEvent[] }
  | { kind: 'one'; event: TaskEvent }
  | { kind: 'added'; actorId: string; events: TaskEvent[] }
  | { kind: 'many'; actorId: string; events: TaskEvent[] };

/** How many consecutive older 'created' events by `from`'s actor sit within the add window. Pure. */
function addRunLength(events: readonly TaskEvent[], from: number): number {
  const first = events[from];
  if (first === undefined || first.kind !== 'created' || first.actorId === null) return 0;
  const start = epoch(first.createdAt);
  let n = 1;
  while (from + n < events.length) {
    const next = events[from + n];
    if (next === undefined || next.kind !== 'created' || next.actorId !== first.actorId) break;
    if (epoch(next.createdAt) - start > ADD_BATCH_WINDOW_MS) break;
    n += 1;
  }
  return n;
}

/** Older rows (no batch id) as they always read: add runs, 4+ bursts, else one each. Pure. */
function legacyLines(events: readonly TaskEvent[]): TaskLine[] {
  const lines: TaskLine[] = [];
  let i = 0;
  while (i < events.length) {
    const first = events[i];
    if (first === undefined) break;
    const actor = first.actorId;
    const adds = addRunLength(events, i);
    if (actor !== null && adds >= 2) {
      lines.push({ kind: 'added', actorId: actor, events: events.slice(i, i + adds) });
      i += adds;
      continue;
    }
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

/**
 * A run of consecutive events (no message between them) as lines: events
 * sharing a batch id are ONE line wherever they sit in the run (at the first
 * one's place); stretches of older rows without one keep their old collapse. Pure.
 */
export function collapseTaskRun(events: readonly TaskEvent[]): TaskLine[] {
  const lines: TaskLine[] = [];
  const batches = new Map<string, Extract<TaskLine, { kind: 'batch' }>>();
  let legacy: TaskEvent[] = [];
  const flush = (): void => {
    if (legacy.length > 0) lines.push(...legacyLines(legacy));
    legacy = [];
  };
  for (const event of events) {
    if (event.batchId === null) {
      legacy.push(event);
      continue;
    }
    const held = batches.get(event.batchId);
    if (held !== undefined) {
      held.events.push(event);
      continue;
    }
    flush();
    const line = {
      kind: 'batch' as const,
      batchId: event.batchId,
      actorId: event.actorId,
      events: [event],
    };
    batches.set(event.batchId, line);
    lines.push(line);
  }
  flush();
  return lines;
}

/** "Name added 5 tasks" (an older run of adds). Pure. */
export function addedLabel(name: string, count: number): string {
  return `${name} added ${count} ${count === 1 ? 'task' : 'tasks'}`;
}

/** "Name made 5 task changes" (an older burst). Pure. */
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
 * The composer button's dot: the newest change by someone else is newer than
 * the last time this device opened the list. Pure.
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
// "Changed since you looked" marks
// ---------------------------------------------------------------------------

/** What one task's mark says under it. */
export type TaskMark =
  | { kind: 'new' }
  | { kind: 'renamed'; was: string }
  | { kind: 'priority'; was: TaskPriority }
  | { kind: 'done' }
  | { kind: 'reopened' };

export interface TaskMarks {
  /** Marks by task id (several per task when one Save changed several fields). */
  byTask: ReadonlyMap<string, TaskMark[]>;
  /** The people whose Saves the marks come from (latest first). */
  actorIds: string[];
}

/**
 * The marks the sheet opens with: every change by someone else in a batch
 * newer than this device's seen time; with no seen time, only the latest
 * batch by someone else. The oldest "was" per field wins (it is what this
 * person last saw). A task deleted since shows no mark. Pure.
 */
export function marksSince(
  events: readonly TaskEvent[],
  currentUserId: string,
  seenMs: number | null,
): TaskMarks {
  const others = events.filter(
    (e) => e.batchId !== null && e.actorId !== null && e.actorId !== currentUserId,
  );
  let picked: TaskEvent[];
  if (seenMs === null) {
    const last = others[others.length - 1];
    picked = last === undefined ? [] : others.filter((e) => e.batchId === last.batchId);
  } else {
    picked = others.filter((e) => epoch(e.createdAt) > seenMs);
  }
  const byTask = new Map<string, TaskMark[]>();
  const actors: string[] = [];
  for (const e of picked) {
    if (e.actorId !== null && !actors.includes(e.actorId)) actors.unshift(e.actorId);
    const list = byTask.get(e.taskId) ?? [];
    if (e.kind === 'deleted') {
      byTask.delete(e.taskId);
      continue;
    }
    if (e.kind === 'created') {
      byTask.set(e.taskId, [{ kind: 'new' }]);
      continue;
    }
    if (e.kind !== 'edited') continue;
    if (list.some((m) => m.kind === 'new')) continue;
    const { old, next } = editedValues(e);
    const add = (mark: TaskMark): void => {
      const at = list.findIndex((m) => sameMarkField(m, mark));
      if (at < 0) list.push(mark);
      else if (mark.kind === 'done' || mark.kind === 'reopened') list[at] = mark;
    };
    if (next.title !== undefined && old.title !== undefined)
      add({ kind: 'renamed', was: old.title });
    if (next.priority !== undefined && old.priority !== undefined) {
      add({ kind: 'priority', was: old.priority });
    }
    if (next.status !== undefined) add({ kind: next.status === 'done' ? 'done' : 'reopened' });
    byTask.set(e.taskId, list);
  }
  for (const [id, list] of byTask) if (list.length === 0) byTask.delete(id);
  return { byTask, actorIds: actors };
}

function sameMarkField(a: TaskMark, b: TaskMark): boolean {
  const field = (m: TaskMark): string =>
    m.kind === 'done' || m.kind === 'reopened' ? 'status' : m.kind;
  return field(a) === field(b);
}

/** The strip over the marks: "<Name> changed 3 tasks · marked below". Pure. */
export function marksStrip(names: readonly string[], count: number): string {
  const who =
    names.length === 0
      ? 'Someone'
      : names.length === 1
        ? (names[0] ?? 'Someone')
        : names.length === 2
          ? `${names[0] ?? ''} and ${names[1] ?? ''}`
          : `${names[0] ?? ''} and ${names.length - 1} others`;
  return `${who} changed ${count} ${count === 1 ? 'task' : 'tasks'} · marked below`;
}

/** A mark's sub-line text ("was" lines take the struck value from the row). Pure. */
export function markText(mark: TaskMark): string {
  switch (mark.kind) {
    case 'new':
      return 'New task';
    case 'renamed':
      return `was ${mark.was}`;
    case 'priority':
      return `priority was P${mark.was}`;
    case 'done':
      return 'marked done';
    case 'reopened':
      return 'reopened';
  }
}

// ---------------------------------------------------------------------------
// Live "is editing" signal timing
// ---------------------------------------------------------------------------

/** While dirty, the sender repeats "editing" this often. */
export const EDITING_REFRESH_MS = 5_000;
/** A receiver drops "editing" this long after the last refresh. */
export const EDITING_TTL_MS = 12_000;

/**
 * Whether the sender sends now: on becoming dirty, then every refresh while
 * still dirty; 'stop' when it stops being dirty after having sent. Pure.
 */
export function editingSignalStep(input: {
  dirty: boolean;
  lastSentMs: number | null;
  nowMs: number;
}): 'start' | 'refresh' | 'stop' | 'none' {
  if (!input.dirty) return input.lastSentMs !== null ? 'stop' : 'none';
  if (input.lastSentMs === null) return 'start';
  return input.nowMs - input.lastSentMs >= EDITING_REFRESH_MS ? 'refresh' : 'none';
}

/** The people still editing: their last signal is younger than the TTL. Pure. */
export function liveEditors(heard: ReadonlyMap<string, number>, nowMs: number): string[] {
  return [...heard.entries()]
    .filter(([, at]) => nowMs - at < EDITING_TTL_MS)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

/** "Name is editing…", "A and B are editing…". Pure. */
export function editingLabel(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0] ?? 'Someone'} is editing…`;
  if (names.length === 2) return `${names[0] ?? ''} and ${names[1] ?? ''} are editing…`;
  return `${names.length} people are editing…`;
}

// ---------------------------------------------------------------------------
// Share snapshot
// ---------------------------------------------------------------------------

/** A chat message's length limit (chat_message_send). */
export const SNAPSHOT_MAX = 5000;

function snapshotItem(task: ChatTask): string {
  return `${task.number}. ${task.title} · P${task.priority}`;
}

function clockLabel(ms: number, timeZone: string): string {
  const p = zonedHourMinute(ms, timeZone);
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const mm = p.minute === 0 ? '' : `:${String(p.minute).padStart(2, '0')}`;
  return `${h}${mm} ${p.hour < 12 ? 'am' : 'pm'}`;
}

/**
 * The plain-text snapshot Share sends, on the workspace clock:
 *   Tasks · Chat · 13 Oct, 7:30 pm
 *   1. Title · P1
 *   Done
 *   3. Title · P2
 * The Done section is left out when nothing is done. Past 5000 characters the
 * done items go first, then trailing open items, ending "+k more". Pure.
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
  const list = listTasks(input.tasks);
  const open = list.filter((t) => t.status !== 'done').map(snapshotItem);
  const done = list.filter((t) => t.status === 'done').map(snapshotItem);
  const stamp = `${civilDayLabel(civilDay(nowMs, timeZone))}, ${clockLabel(nowMs, timeZone)}`;
  const header = `Tasks · ${input.chatName} · ${stamp}`;
  const build = (kept: number, withDone: boolean): string => {
    const lines = [header, ...open.slice(0, kept)];
    if (kept < open.length) lines.push(`+${open.length - kept} more`);
    if (withDone && done.length > 0) lines.push('Done', ...done);
    return lines.join('\n');
  };
  const full = build(open.length, true);
  if (full.length <= max) return full;
  for (let kept = open.length; kept >= 0; kept -= 1) {
    const text = build(kept, false);
    if (text.length <= max) return text;
  }
  return header.slice(0, max);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const TASK_COLUMNS =
  'id, channel_id, workspace_id, number, title, side, status, priority, created_by, created_at, updated_at, deleted_at';
const EVENT_COLUMNS =
  'id, task_id, channel_id, workspace_id, actor_user_id, kind, old_value, new_value, created_at, batch_id';

/** How many events one read carries (newest first, then put oldest first). */
export const EVENT_PAGE = 200;

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** A channel's live items (RLS: members only), one query; deleted ones are left out. */
export async function readChannelTasks(
  client: Client,
  channelId: string,
  signal?: AbortSignal,
): Promise<Result<ChatTask[]>> {
  try {
    const res = await abortable(
      client
        .from('chat_tasks')
        .select(TASK_COLUMNS)
        .eq('channel_id', channelId)
        .is('deleted_at', null),
      signal,
    );
    if (res.error) return fail(`readChannelTasks: ${res.error.message}`);
    const rows = (res.data ?? []) as TaskRow[];
    return { ok: true, data: rows.flatMap((r) => rowToTask(r) ?? []) };
  } catch (error) {
    return fail(`readChannelTasks: ${String(error)}`);
  }
}

/** Tasks by id, one IN read (the thread lines of deleted items). */
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
// The write
// ---------------------------------------------------------------------------

/** A write outcome; the message is the raw error, for logging only. */
export type TaskWriteResult<T = null> = { ok: true; data: T } | { ok: false; message: string };

/** What one Save returns. */
export interface BatchResult {
  batchId: string | null;
  createdIds: string[];
  conflicts: TaskConflict[];
}

/** Map chat_task_save_batch's jsonb answer; null when it is not that shape. Pure. */
export function parseBatchResult(data: unknown): BatchResult | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const ids = r.created_ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return null;
  return {
    batchId: typeof r.batch_id === 'string' ? r.batch_id : null,
    createdIds: ids as string[],
    conflicts: parseConflicts(r.conflicts),
  };
}

/**
 * One Save (chat_task_save_batch): creates, edits (only changed fields, each
 * with its base_updated_at), deletes. Edits whose task changed since are
 * skipped and come back as conflicts; everything else is written.
 */
export async function saveTaskBatch(params: {
  client: Client;
  channelId: string;
  payload: BatchPayload;
  traceId: string;
}): Promise<TaskWriteResult<BatchResult>> {
  const args: Functions['chat_task_save_batch']['Args'] = {
    p_channel_id: params.channelId,
    p_batch: params.payload as unknown as Json,
    p_trace_id: params.traceId,
  };
  try {
    const { data, error } = await params.client.rpc('chat_task_save_batch', args);
    if (error) return { ok: false, message: error.message };
    const result = parseBatchResult(data);
    return result !== null
      ? { ok: true, data: result }
      : { ok: false, message: 'chat_task_save_batch returned no result' };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}
