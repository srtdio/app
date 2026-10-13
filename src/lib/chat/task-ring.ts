// The task due-time ring, the reminders pattern applied to chat_tasks: one
// timeout for the next open item's due time on this device, the "Due now"
// copy, the session's rung keys (one ring per task and due time), the missed
// count from unread 'task_due' inbox rows behind its own per-device last-seen
// mark, and the reads behind them. RLS limits every read to the caller's chats
// (and own inbox rows). Pure helpers take `now`; reads never throw.

import type { Client, Result } from '@srtdio/rpc';
import { abortable } from '@/lib/chat-reads';
import { RING_GRACE_MS, ringDelayMs } from '@/lib/chat/reminders';

/** One open item with a due time, as the ring reads it. */
export interface TaskDueRow {
  id: string;
  channel_id: string;
  number: number;
  title: string;
  due_at: string | null;
}

/** The row re-read just before ringing. */
export interface TaskDueCheck extends TaskDueRow {
  status: string;
}

/** Fired on this device after a due write is recorded (BellRing re-arms). */
export const TASK_DUE_CHANGED_EVENT = 'sorted:task-due-changed';

/** Announce a recorded due change on this device. */
export function announceTaskDueChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TASK_DUE_CHANGED_EVENT));
}

/** The statuses that still ring (done and shared items never do). */
export const RINGING_STATUSES = ['todo', 'waiting'] as const;

/** At most this many upcoming dues per read. */
export const UPCOMING_LIMIT = 50;

/** "Due now: 12 Caption for the reel". Pure. */
export function dueNowTitle(row: Pick<TaskDueRow, 'number' | 'title'>): string {
  return `Due now: ${row.number} ${row.title}`;
}

/** "You missed 1 due time" / "You missed N due times". Pure. */
export function missedDueCopy(count: number): string {
  return `You missed ${count} due time${count === 1 ? '' : 's'}`;
}

/** One ring per task and due time: the key a ring is remembered by, or null for a bad time. Pure. */
export function taskRungKey(taskId: string, dueAt: string | null): string | null {
  if (dueAt === null) return null;
  const ms = Date.parse(dueAt);
  return Number.isNaN(ms) ? null : `${taskId}|${ms}`;
}

/**
 * The next item to ring: the soonest due time not yet rung and no earlier
 * than RING_GRACE_MS ago (a tie that just rang its twin still rings). Ties go
 * by number, then id. Null when none. Pure.
 */
export function nextDue(
  rows: readonly TaskDueRow[],
  nowMs: number,
  rung: ReadonlySet<string> = new Set(),
): TaskDueRow | null {
  let best: { row: TaskDueRow; at: number } | null = null;
  for (const row of rows) {
    const key = taskRungKey(row.id, row.due_at);
    if (key === null || rung.has(key)) continue;
    const at = Date.parse(row.due_at ?? '');
    if (at < nowMs - RING_GRACE_MS) continue;
    if (
      best === null ||
      at < best.at ||
      (at === best.at &&
        (row.number < best.row.number || (row.number === best.row.number && row.id < best.row.id)))
    ) {
      best = { row, at };
    }
  }
  return best?.row ?? null;
}

/**
 * Whether the re-read row still rings for what was armed: open, and the same
 * due time. A changed due, a closed item or a missing row never rings. Pure.
 */
export function stillDue(armed: TaskDueRow, current: TaskDueCheck | null): boolean {
  if (current === null || current.id !== armed.id) return false;
  if (!(RINGING_STATUSES as readonly string[]).includes(current.status)) return false;
  return taskRungKey(current.id, current.due_at) === taskRungKey(armed.id, armed.due_at);
}

/**
 * Arm one timeout for the next due item. On time it calls `onRing`; a capped
 * wait calls `onRearm` instead. Returns the cancel, which the
 * caller runs before arming again and on unmount.
 */
export function armTaskRing(input: {
  rows: readonly TaskDueRow[];
  now: () => number;
  rung: ReadonlySet<string>;
  onRing: (row: TaskDueRow) => void;
  onRearm: () => void;
}): () => void {
  const nowMs = input.now();
  const row = nextDue(input.rows, nowMs, input.rung);
  if (row === null) return () => {};
  const at = Date.parse(row.due_at ?? '');
  // ringDelayMs caps the wait at MAX_TIMER_MS; a capped wait re-arms.
  const handle = setTimeout(
    () => {
      if (input.now() >= at) input.onRing(row);
      else input.onRearm();
    },
    ringDelayMs(at, nowMs),
  );
  return () => clearTimeout(handle);
}

/** A 'task_due' inbox row as the missed count reads it. */
export interface MissedDue {
  createdAt: string;
  readAt: string | null;
  taskId: string | null;
  /** The due time that passed (payload.old). */
  dueAt: string | null;
}

/**
 * How many due times passed while the app was closed: unread task_due rows
 * created after the device's last-seen moment, minus any rung this session.
 * No last-seen (first run on this device) counts none. Pure.
 */
export function missedDueCount(
  rows: readonly MissedDue[],
  lastSeenMs: number | null,
  rung: ReadonlySet<string>,
): number {
  if (lastSeenMs === null) return 0;
  return rows.filter((row) => {
    const at = Date.parse(row.createdAt);
    if (Number.isNaN(at) || at <= lastSeenMs || row.readAt !== null) return false;
    const key = row.taskId !== null ? taskRungKey(row.taskId, row.dueAt) : null;
    return key === null || !rung.has(key);
  }).length;
}

// ---------------------------------------------------------------------------
// The session's rung keys (memory only: a reload starts fresh, and the missed
// count covers what passed while closed)
// ---------------------------------------------------------------------------

const sessionRung = new Set<string>();

/** The keys rung this session (shared by every BellRing mount). */
export function sessionRungKeys(): Set<string> {
  return sessionRung;
}

// ---------------------------------------------------------------------------
// Per-device last-seen mark (localStorage, wrapped like the reminders' mark)
// ---------------------------------------------------------------------------

export function taskDueLastSeenKey(userId: string): string {
  return `sorted:bell:task-due-last-seen:${userId}`;
}

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): KeyValueStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The stored last-seen moment (ms), or null when none or unreadable. */
export function readTaskDueLastSeen(
  userId: string,
  store: KeyValueStore | null = storage(),
): number | null {
  try {
    const raw = store?.getItem(taskDueLastSeenKey(userId)) ?? null;
    if (raw === null) return null;
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Store the last-seen moment; a storage failure leaves the old value. */
export function writeTaskDueLastSeen(
  userId: string,
  ms: number,
  store: KeyValueStore | null = storage(),
): void {
  try {
    store?.setItem(taskDueLastSeenKey(userId), String(ms));
  } catch {
    // Storage blocked: the next open counts from the older mark (or none).
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const DUE_COLUMNS = 'id, channel_id, number, title, due_at';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** The open items due after now in a workspace, soonest first. */
export async function readUpcomingTaskDues(
  client: Client,
  params: { workspaceId: string; nowMs: number; signal?: AbortSignal },
): Promise<Result<TaskDueRow[]>> {
  try {
    const query = client
      .from('chat_tasks')
      .select(DUE_COLUMNS)
      .eq('workspace_id', params.workspaceId)
      .in('status', [...RINGING_STATUSES])
      .is('due_passed_at', null)
      .gt('due_at', new Date(params.nowMs).toISOString())
      .order('due_at', { ascending: true })
      .limit(UPCOMING_LIMIT);
    const { data, error } = await abortable(query, params.signal);
    if (error) return fail(`readUpcomingTaskDues: ${error.message}`);
    return { ok: true, data: (data ?? []) as TaskDueRow[] };
  } catch (error) {
    return fail(`readUpcomingTaskDues: ${String(error)}`);
  }
}

/** One item as it stands now (null when gone or hidden). */
export async function readTaskDueCheck(
  client: Client,
  taskId: string,
): Promise<Result<TaskDueCheck | null>> {
  try {
    const { data, error } = await client
      .from('chat_tasks')
      .select(`${DUE_COLUMNS}, status`)
      .eq('id', taskId)
      .maybeSingle();
    if (error) return fail(`readTaskDueCheck: ${error.message}`);
    return { ok: true, data: (data ?? null) as TaskDueCheck | null };
  } catch (error) {
    return fail(`readTaskDueCheck: ${String(error)}`);
  }
}

/** The caller's unread task_due rows created after `sinceIso`, newest first. */
export async function readUnreadTaskDuesSince(
  client: Client,
  params: { workspaceId: string; userId: string; sinceIso: string },
): Promise<Result<MissedDue[]>> {
  try {
    const { data, error } = await client
      .from('inbox_entries')
      .select('id, created_at, read_at, payload')
      .eq('workspace_id', params.workspaceId)
      .eq('user_id', params.userId)
      .eq('event_type', 'task_due')
      .is('read_at', null)
      .is('deleted_at', null)
      .gt('created_at', params.sinceIso)
      .order('created_at', { ascending: false })
      .limit(UPCOMING_LIMIT);
    if (error) return fail(`readUnreadTaskDuesSince: ${error.message}`);
    const rows = (data ?? []) as { created_at: string; read_at: string | null; payload: unknown }[];
    return {
      ok: true,
      data: rows.map((row) => {
        const payload =
          row.payload !== null && typeof row.payload === 'object'
            ? (row.payload as Record<string, unknown>)
            : {};
        return {
          createdAt: row.created_at,
          readAt: row.read_at,
          taskId: typeof payload.task_id === 'string' ? payload.task_id : null,
          dueAt: typeof payload.old === 'string' ? payload.old : null,
        };
      }),
    };
  } catch (error) {
    return fail(`readUnreadTaskDuesSince: ${String(error)}`);
  }
}
