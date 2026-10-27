// Private message reminders: the caller's own rows in chat_message_reminders
// (RLS returns own rows only) and the two SECURITY DEFINER procs that are the
// only write paths, chat_reminder_set and chat_reminder_cancel. Same
// conventions as record.ts and scheduled.ts: the Supabase client is injected,
// the args object is typed against the generated proc signature and built
// ahead of the `.rpc()` call, the trace id is the explicit p_trace_id, every
// write is aborted after SEND_TIMEOUT_MS, and nothing throws.
//
// chat_reminder_set is a no-op for an id it already holds, and replaces the
// caller's pending reminder on the same message. "Change time" therefore sends
// a NEW id for the same message (the earlier row is cancelled by the proc).
//
// Also here: the ring's pure scheduling (one timer for the next due reminder),
// the per-device "last seen" mark and the read behind "You missed N
// reminders", and the window event that asks every reminder reader to reload.
// Every time is the device's local zone. Pure helpers take `now`.

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable } from '@/lib/chat-reads';
import { SEND_TIMEOUT_MS, type RecordFailed } from '@/lib/chat/record';
import {
  formatSendLabel,
  inSentence,
  isWithinScheduleWindow,
  presetTimes,
  UPCOMING_PAGE,
} from '@/lib/chat/scheduled';

type Functions = Database['public']['Functions'];

/** One of the caller's reminders. */
export type ReminderRow = Database['public']['Tables']['chat_message_reminders']['Row'];

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type ReminderPresetId = '20m' | '1h' | '3h' | 'tomorrow' | 'next_week';

export interface ReminderPreset {
  id: ReminderPresetId;
  label: string;
  at: Date;
}

/** `ms` from now, rounded up to the next whole minute (the ring fires on the minute). Pure. */
export function minutesAhead(now: Date, ms: number): Date {
  const at = now.getTime() + ms;
  return new Date(Math.ceil(at / MINUTE_MS) * MINUTE_MS);
}

/**
 * The preset rows in display order: 20 minutes, 1 hour, 3 hours, Tomorrow
 * 9:00 AM and Next week (the next Monday strictly after today, 9:00 AM). Pure.
 */
export function reminderPresets(now: Date): ReminderPreset[] {
  const { tomorrow, monday } = presetTimes(now);
  return [
    { id: '20m', label: '20 minutes', at: minutesAhead(now, 20 * MINUTE_MS) },
    { id: '1h', label: '1 hour', at: minutesAhead(now, 60 * MINUTE_MS) },
    { id: '3h', label: '3 hours', at: minutesAhead(now, 180 * MINUTE_MS) },
    { id: 'tomorrow', label: 'Tomorrow', at: tomorrow },
    { id: 'next_week', label: 'Next week', at: monday },
  ];
}

/** Whether a reminder time is at least 1 minute and at most 365 days ahead (the proc's window). Pure. */
export function isWithinReminderWindow(date: Date, now: Date): boolean {
  return isWithinScheduleWindow(date, now);
}

/** "Reminder set for tomorrow 9:00 AM". Pure. */
export function reminderSetCopy(at: Date, now: Date): string {
  return `Reminder set for ${inSentence(formatSendLabel(at, now))}`;
}

/** The Custom step's live summary: "Reminds you Wed 7 Oct at 11:30 AM". Pure. */
export function reminderSummary(at: Date, now: Date): string {
  return `Reminds you ${inSentence(formatSendLabel(at, now)).replace(/, /, ' at ')}`;
}

const REMINDER_RANGE_COPY = 'Pick a time at least 1 minute from now';
export const ACTION_FAILED_COPY = "Couldn't do that. Try again.";

/**
 * User copy for a failed reminder write, from the proc's exception text. Null
 * for "message not found" (deleted meanwhile): the caller refetches silently.
 * Raw text never reaches a toast. Pure.
 */
export function mapReminderError(message: string): string | null {
  if (/message not found/i.test(message)) return null;
  if (/between 1 minute and 1 year/i.test(message)) return REMINDER_RANGE_COPY;
  return ACTION_FAILED_COPY;
}

// ---------------------------------------------------------------------------
// The ring: one timer for the next due reminder
// ---------------------------------------------------------------------------

/** A reminder due this long ago still rings when the app loads it (the cron may lag a minute). */
export const RING_GRACE_MS = 60_000;
/** The longest single timeout; a later reminder re-arms from there (setTimeout caps near 24.8 days). */
export const MAX_TIMER_MS = 60 * MINUTE_MS;

/**
 * What the ring and the chat's Remind me read of a reminder: the row's id, its
 * message and chat (the toast's link, the menu's lookup, a cancel), its time
 * and the two stamps that say it is still pending.
 */
export type PendingReminder = Pick<
  ReminderRow,
  'id' | 'message_id' | 'channel_id' | 'remind_at' | 'fired_at' | 'cancelled_at'
>;

/** The select list behind PendingReminder (and nothing more). */
export const PENDING_REMINDER_COLUMNS =
  'id, message_id, channel_id, remind_at, fired_at, cancelled_at';

/** What the ring's scheduling reads of a row. */
type RingRow = Pick<ReminderRow, 'id' | 'remind_at' | 'fired_at' | 'cancelled_at'>;

/** Pending (neither fired nor cancelled) rows, soonest first. Pure. */
function pendingSoonestFirst<R extends RingRow>(rows: readonly R[]): R[] {
  return rows
    .filter((r) => r.fired_at === null && r.cancelled_at === null)
    .sort((a, b) => Date.parse(a.remind_at) - Date.parse(b.remind_at));
}

/**
 * The next reminder the ring should fire: the soonest pending one not yet rung
 * on this device and due no earlier than RING_GRACE_MS ago. Null when none. Pure.
 */
export function nextToRing<R extends RingRow>(
  rows: readonly R[],
  nowMs: number,
  rung: ReadonlySet<string>,
): R | null {
  for (const row of pendingSoonestFirst(rows)) {
    const at = Date.parse(row.remind_at);
    if (Number.isNaN(at) || rung.has(row.id)) continue;
    if (at >= nowMs - RING_GRACE_MS) return row;
  }
  return null;
}

/** The timeout for a reminder at `remindAtMs`: 0 when due, capped at MAX_TIMER_MS. Pure. */
export function ringDelayMs(remindAtMs: number, nowMs: number): number {
  return Math.min(MAX_TIMER_MS, Math.max(0, remindAtMs - nowMs));
}

/**
 * Arm one timeout for the next reminder to ring. When it fires on the minute
 * it calls `onRing`; a capped wait calls `onRearm` instead so the caller arms
 * again from the new moment. Returns the cancel, which the caller runs before
 * arming again and on unmount.
 */
export function armRing<R extends RingRow>(input: {
  rows: readonly R[];
  now: () => number;
  rung: ReadonlySet<string>;
  onRing: (row: R) => void;
  onRearm: () => void;
}): () => void {
  const nowMs = input.now();
  const row = nextToRing(input.rows, nowMs, input.rung);
  if (row === null) return () => {};
  const at = Date.parse(row.remind_at);
  const delay = ringDelayMs(at, nowMs);
  const handle = setTimeout(() => {
    if (input.now() >= at) input.onRing(row);
    else input.onRearm();
  }, delay);
  return () => clearTimeout(handle);
}

/** A 'reminder' inbox row as the missed count reads it. */
interface MissedCandidate {
  createdAt: string;
  readAt: string | null;
  reminderId: string | null;
}

/**
 * How many reminders fired while the app was closed: unread reminder rows
 * created after the device's last-seen moment, minus any this device already
 * rang. No last-seen (first run on this device) counts none. Pure.
 */
export function missedCount(
  rows: readonly MissedCandidate[],
  lastSeenMs: number | null,
  rung: ReadonlySet<string>,
): number {
  if (lastSeenMs === null) return 0;
  return rows.filter((row) => {
    const at = Date.parse(row.createdAt);
    if (Number.isNaN(at) || at <= lastSeenMs || row.readAt !== null) return false;
    return row.reminderId === null || !rung.has(row.reminderId);
  }).length;
}

/** Fired on window when the pending reminders may have changed: the ring and the chat reload them. */
export const REMINDERS_CHANGED_EVENT = 'sorted:reminders-changed';

/**
 * Ask every reminder reader (the ring, the chat's Remind me, Activity's
 * Upcoming) to reload: after a reminder is set, moved or cancelled on this
 * device, after one rings, and when the shell's inbox poll tick found new rows
 * (a reminder that fired, or one set on another device).
 */
export function announceRemindersChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(REMINDERS_CHANGED_EVENT));
}

/** "You missed 1 reminder" / "You missed N reminders". Pure. */
export function missedCopy(count: number): string {
  return `You missed ${count} reminder${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Per-device marks (localStorage, wrapped: private mode or blocked storage
// reads as "nothing stored" and a failed write is ignored by design)
// ---------------------------------------------------------------------------

function lastSeenKey(userId: string): string {
  return `sorted:bell:last-seen:${userId}`;
}

function rungKey(userId: string): string {
  return `sorted:bell:rung:${userId}`;
}

/** The most recent rung ids kept per device. */
const RUNG_KEEP = 50;

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
export function readLastSeen(
  userId: string,
  store: KeyValueStore | null = storage(),
): number | null {
  try {
    const raw = store?.getItem(lastSeenKey(userId)) ?? null;
    if (raw === null) return null;
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Store the last-seen moment; a storage failure leaves the old value. */
export function writeLastSeen(
  userId: string,
  ms: number,
  store: KeyValueStore | null = storage(),
): void {
  try {
    store?.setItem(lastSeenKey(userId), String(ms));
  } catch {
    // Storage blocked: the next open counts from the older mark (or none).
  }
}

/** The reminder ids this device already rang (newest last). */
export function readRung(userId: string, store: KeyValueStore | null = storage()): string[] {
  try {
    const raw = store?.getItem(rungKey(userId)) ?? null;
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember one more rung id, keeping the newest RUNG_KEEP. */
export function writeRung(
  userId: string,
  ids: readonly string[],
  store: KeyValueStore | null = storage(),
): void {
  try {
    store?.setItem(rungKey(userId), JSON.stringify(ids.slice(-RUNG_KEEP)));
  } catch {
    // Storage blocked: a rung reminder may count as missed after a restart.
  }
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

/**
 * The caller's pending reminders in a workspace, soonest first. RLS returns
 * only the caller's own rows. Never throws.
 */
export async function readPendingReminders(
  client: Client,
  params: { workspaceId: string; signal?: AbortSignal },
): Promise<Result<ReminderRow[]>> {
  try {
    const query = client
      .from('chat_message_reminders')
      .select('*')
      .eq('workspace_id', params.workspaceId)
      .is('fired_at', null)
      .is('cancelled_at', null)
      .order('remind_at', { ascending: true })
      .limit(UPCOMING_PAGE);
    const { data, error } = await abortable(query, params.signal);
    if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
    return { ok: true, data: pendingSoonestFirst((data ?? []) as ReminderRow[]) };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

/**
 * The caller's pending reminders in a workspace, soonest first, with only the
 * PendingReminder columns. RLS returns only the caller's own rows. Never throws.
 */
export async function readPendingReminderTimes(
  client: Client,
  params: { workspaceId: string; signal?: AbortSignal },
): Promise<Result<PendingReminder[]>> {
  try {
    const query = client
      .from('chat_message_reminders')
      .select(PENDING_REMINDER_COLUMNS)
      .eq('workspace_id', params.workspaceId)
      .is('fired_at', null)
      .is('cancelled_at', null)
      .order('remind_at', { ascending: true })
      .limit(UPCOMING_PAGE);
    const { data, error } = await abortable(query, params.signal);
    if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
    return { ok: true, data: pendingSoonestFirst((data ?? []) as PendingReminder[]) };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

// The one pending-reminders read the ring and the chat's Remind me share: the
// last read for this user and workspace answers every caller until something
// says the reminders may have changed (a cause: the tab turning visible, a
// REMINDERS_CHANGED_EVENT). Both readers hear the same Event object, so one
// cause starts one read, and the second reader joins it. A failed read is not
// kept (the next caller reads again).
interface SharedPending {
  userId: string;
  workspaceId: string;
  generation: number;
  read: Promise<Result<PendingReminder[]>>;
}
let sharedPending: SharedPending | null = null;
let generation = 0;
let lastCause: Event | null = null;

/**
 * The shared pending reminders. `cause`: the event that asked (visibility or
 * reminders changed); a cause not seen before starts a new read, one already
 * seen (the other reader's listener) joins it. No cause (a mount) takes the
 * last read when there is one.
 */
export function readSharedPendingReminders(
  client: Client,
  params: { userId: string; workspaceId: string; cause?: Event },
): Promise<Result<PendingReminder[]>> {
  const { userId, workspaceId, cause } = params;
  if (cause !== undefined && cause !== lastCause) {
    lastCause = cause;
    generation += 1;
  }
  const held = sharedPending;
  if (
    held !== null &&
    held.userId === userId &&
    held.workspaceId === workspaceId &&
    held.generation === generation
  ) {
    return held.read;
  }
  const dropFailed = (res: Result<PendingReminder[]>): Result<PendingReminder[]> => {
    if (!res.ok && sharedPending?.read === read) sharedPending = null;
    return res;
  };
  const read = readPendingReminderTimes(client, { workspaceId }).then(dropFailed);
  sharedPending = { userId, workspaceId, generation, read };
  return read;
}

/** Forget the shared read (tests; sign-out drops it by user). */
export function resetSharedPendingReminders(): void {
  sharedPending = null;
  lastCause = null;
}

/** How many missed 'reminder' rows one open reads. */
const MISSED_READ_LIMIT = 50;

/**
 * The caller's unread 'reminder' inbox rows created after `sinceIso` (the
 * missed count on open), newest first, at most MISSED_READ_LIMIT. Never throws.
 */
export async function readUnreadRemindersSince(
  client: Client,
  params: { workspaceId: string; userId: string; sinceIso: string },
): Promise<Result<MissedCandidate[]>> {
  try {
    const { data, error } = await client
      .from('inbox_entries')
      .select('created_at, read_at, payload')
      .eq('workspace_id', params.workspaceId)
      .eq('user_id', params.userId)
      .eq('event_type', 'reminder')
      .is('read_at', null)
      .is('deleted_at', null)
      .gt('created_at', params.sinceIso)
      .order('created_at', { ascending: false })
      .limit(MISSED_READ_LIMIT);
    if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
    return {
      ok: true,
      data: (data ?? []).map((row) => {
        const payload: unknown = row.payload;
        const reminderId =
          typeof payload === 'object' && payload !== null
            ? (payload as Record<string, unknown>).reminder_id
            : null;
        return {
          createdAt: row.created_at,
          readAt: row.read_at,
          reminderId: typeof reminderId === 'string' && reminderId !== '' ? reminderId : null,
        };
      }),
    };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

type ReminderWriteResult = { ok: true } | RecordFailed;

async function runWrite(
  timeoutMs: number | undefined,
  call: (signal: AbortSignal) => PromiseLike<{
    error: { message: string; code?: string } | null;
    status?: number;
  }>,
): Promise<ReminderWriteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? SEND_TIMEOUT_MS);
  const reason = (): 'timeout' | 'error' => (controller.signal.aborted ? 'timeout' : 'error');
  try {
    const { error, status } = await call(controller.signal);
    if (error) {
      return {
        ok: false,
        reason: reason(),
        message: error.message,
        ...(typeof error.code === 'string' && error.code !== '' ? { code: error.code } : {}),
        ...(typeof status === 'number' ? { status } : {}),
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: reason(), message: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

interface SetReminderParams {
  client: Client;
  /** A fresh uuid_v7 per call; Change time also sends a new one. */
  id: string;
  messageId: string;
  channelId: string;
  remindAt: Date;
  traceId: string;
  timeoutMs?: number;
}

/** Set (or, with a new id on the same message, move) a reminder via chat_reminder_set. */
export function setReminder(params: SetReminderParams): Promise<ReminderWriteResult> {
  const args: Functions['chat_reminder_set']['Args'] = {
    p_id: params.id,
    p_message_id: params.messageId,
    p_channel_id: params.channelId,
    p_remind_at: params.remindAt.toISOString(),
    p_trace_id: params.traceId,
  };
  return runWrite(params.timeoutMs, (signal) =>
    params.client.rpc('chat_reminder_set', args).abortSignal(signal),
  );
}

interface CancelReminderParams {
  client: Client;
  id: string;
  traceId: string;
  timeoutMs?: number;
}

/** Cancel the caller's pending reminder via chat_reminder_cancel (any other id is a no-op). */
export function cancelReminder(params: CancelReminderParams): Promise<ReminderWriteResult> {
  const args: Functions['chat_reminder_cancel']['Args'] = {
    p_id: params.id,
    p_trace_id: params.traceId,
  };
  return runWrite(params.timeoutMs, (signal) =>
    params.client.rpc('chat_reminder_cancel', args).abortSignal(signal),
  );
}
