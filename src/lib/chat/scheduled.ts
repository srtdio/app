// Scheduled chat messages: the caller's own rows in chat_scheduled_messages
// (RLS returns own rows only) and the four SECURITY DEFINER procs that are the
// only write paths: chat_message_schedule, chat_scheduled_update,
// chat_scheduled_cancel and chat_scheduled_send_now. Same conventions as
// record.ts: the Supabase client is injected, the args object is typed against
// the generated proc signature and built ahead of the `.rpc()` call, the trace
// id is the explicit p_trace_id, every write is aborted after SEND_TIMEOUT_MS,
// and nothing throws (a failure resolves to RecordFailed with the raw message,
// which mapScheduleError turns into user copy).
//
// Every successful write announces SCHEDULED_CHANGED_EVENT for its chat, so the
// open chat's strip refetches whichever surface made the change (the chat, or
// a failed send's Retry on Notifications).
//
// Every time here is the device's local time zone: presets land on 9:00 AM
// local and labels read local wall-clock time. Pure helpers take `now`.

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable } from '@/lib/chat-reads';
import type { ChatMessageRow } from '@/lib/chat/thread';
import {
  buildAttachmentMeta,
  toMessageAttachment,
  type AttachmentMetaMap,
  type AttachmentUploader,
  type MessageAttachment,
} from '@/lib/chat/attachments';
import { SEND_TIMEOUT_MS, type RecordFailed } from '@/lib/chat/record';

type Functions = Database['public']['Functions'];

/** One of the caller's scheduled messages. */
export type ScheduledRow = Database['public']['Tables']['chat_scheduled_messages']['Row'];

/** The earliest a message may be scheduled ahead of now. */
export const MIN_LEAD_MS = 60_000;
/** The latest a message may be scheduled ahead of now (the proc's 365 days). */
export const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** Presets send at this local hour. */
export const PRESET_HOUR = 9;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The preset times: tomorrow and the next Monday strictly after today, both 9:00 AM local. Pure. */
export function presetTimes(now: Date): { tomorrow: Date; monday: Date } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const daysToMonday = (1 - now.getDay() + 7) % 7 || 7;
  return {
    tomorrow: new Date(y, m, d + 1, PRESET_HOUR, 0, 0, 0),
    monday: new Date(y, m, d + daysToMonday, PRESET_HOUR, 0, 0, 0),
  };
}

/** Whether a send time is at least 1 minute and at most 365 days ahead of now. Pure. */
export function isWithinScheduleWindow(date: Date, now: Date): boolean {
  const lead = date.getTime() - now.getTime();
  return Number.isFinite(lead) && lead >= MIN_LEAD_MS && lead <= MAX_LEAD_MS;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** "9:00 AM" in local time. Pure. */
export function formatClock(date: Date): string {
  const h = date.getHours();
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(date.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Wed 7 Oct" (plus the year when it differs from now's). Pure. */
export function formatDay(date: Date, now: Date): string {
  const base = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

/** "Sun 4 Oct, 9:00 AM": a preset row's right text. Pure. */
export function formatDayTime(date: Date, now: Date): string {
  return `${formatDay(date, now)}, ${formatClock(date)}`;
}

function dayDiff(date: Date, now: Date): number {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((a - b) / 86_400_000);
}

/**
 * A send time as a label: "Today 3:00 PM", "Tomorrow 9:00 AM", else
 * "Wed 7 Oct, 11:30 AM". Capitalised; {@link inSentence} lowers the lead word
 * for "Sends tomorrow 9:00 AM". Pure.
 */
export function formatSendLabel(date: Date, now: Date): string {
  const diff = dayDiff(date, now);
  if (diff === 0) return `Today ${formatClock(date)}`;
  if (diff === 1) return `Tomorrow ${formatClock(date)}`;
  return formatDayTime(date, now);
}

/** A label inside a sentence: "Today" / "Tomorrow" lowered, a weekday kept. Pure. */
export function inSentence(label: string): string {
  return /^(Today|Tomorrow) /.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/** The Custom step's live summary: "Sends Wed 7 Oct at 11:30 AM". Pure. */
export function customSummary(date: Date, now: Date): string {
  return `Sends ${formatDay(date, now)} at ${formatClock(date)}`;
}

/** "2026-10-07" for a native date input, local. Pure. */
export function dateInputValue(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** "11:30" for a native time input, local. Pure. */
export function timeInputValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** The local Date for native date and time input values; null while either is incomplete. Pure. */
export function fromInputs(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})/.exec(time);
  if (d === null || t === null) return null;
  const at = new Date(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
    0,
    0,
  );
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The device's short zone name from Intl ("IST", "GMT+5:30"); never hardcoded. */
export function shortZoneName(now: Date, locale?: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

export const SCHEDULE_RANGE_COPY = 'Pick a time at least 1 minute from now';
export const SCHEDULE_LIMIT_COPY = 'You already have 100 scheduled messages';
export const SCHEDULE_FAILED_COPY = "Couldn't schedule. Try again.";
/** A picked file did not upload: nothing was scheduled. */
export const SCHEDULE_UPLOAD_FAILED_COPY = "Couldn't upload. Try again.";
/** The Edit card's line under read-only files. */
export const SCHEDULED_FILES_READONLY_COPY = 'To change files, cancel and schedule again.';

/**
 * User copy for a failed schedule write, from the proc's exception text. Null
 * for "scheduled message not found" (already sent or cancelled elsewhere): the
 * caller refetches silently. Raw text never reaches a toast. Pure.
 */
export function mapScheduleError(message: string): string | null {
  if (/scheduled message not found/i.test(message)) return null;
  if (/send time must be between/i.test(message)) return SCHEDULE_RANGE_COPY;
  if (/too many scheduled messages/i.test(message)) return SCHEDULE_LIMIT_COPY;
  return SCHEDULE_FAILED_COPY;
}

/** "1 scheduled message" / "N scheduled messages". Pure. */
export function scheduledCountLabel(count: number): string {
  return `${count} scheduled message${count === 1 ? '' : 's'}`;
}

/** The p_mentions list as stored on a row (a JSON array of ids), never anything else. Pure. */
export function rowMentions(row: Pick<ScheduledRow, 'mentions'>): string[] {
  return Array.isArray(row.mentions)
    ? row.mentions.filter((m): m is string => typeof m === 'string')
    : [];
}

/** Rows still scheduled, soonest first. Pure. */
export function soonestFirst(rows: readonly ScheduledRow[]): ScheduledRow[] {
  return rows
    .filter((r) => r.status === 'scheduled')
    .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
}

// ---------------------------------------------------------------------------
// The changed event
// ---------------------------------------------------------------------------

/** Window event after any successful scheduled write; detail names the chat. */
export const SCHEDULED_CHANGED_EVENT = 'sorted:scheduled-changed';

export interface ScheduledChangedDetail {
  channelId: string;
}

/** Tell listeners (the open chat's strip) that a chat's scheduled rows changed. */
export function announceScheduledChanged(channelId: string): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(
    new CustomEvent<ScheduledChangedDetail>(SCHEDULED_CHANGED_EVENT, { detail: { channelId } }),
  );
}

/**
 * Run `listener` whenever SCHEDULED_CHANGED_EVENT names `channelId` (any other
 * chat is ignored). Returns the unsubscribe; call it on unmount.
 */
export function onScheduledChanged(channelId: string, listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => undefined;
  }
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<Partial<ScheduledChangedDetail> | null>).detail;
    if (detail?.channelId === channelId) listener();
  };
  window.addEventListener(SCHEDULED_CHANGED_EVENT, handler);
  return () => window.removeEventListener(SCHEDULED_CHANGED_EVENT, handler);
}

function announceOnSuccess<T>(
  result: Promise<ScheduleWriteResult<T>>,
  channelOf: (row: T) => string | null,
): Promise<ScheduleWriteResult<T>> {
  return result.then((res) => {
    if (res.ok) {
      const channelId = channelOf(res.row);
      if (channelId !== null && channelId !== '') announceScheduledChanged(channelId);
    }
    return res;
  });
}

// ---------------------------------------------------------------------------
// Picked files: uploaded before chat_message_schedule, all or nothing
// ---------------------------------------------------------------------------

/** One picked file on its way into a scheduled message. */
export interface ScheduleFile {
  /** The composer chip's id. */
  key: string;
  file: File;
  /** Set once this file uploaded (an earlier attempt): never uploaded again. */
  versionId: string | null;
}

export type ScheduleUploadOutcome =
  | { ok: true; attachments: MessageAttachment[] }
  | { ok: false; aborted: true }
  | { ok: false; aborted: false; failedKeys: string[] };

/**
 * Upload every picked file not uploaded yet, in parallel, through the normal
 * send's uploader (stall watch, response wait and the one 401 refresh are in
 * it). All or nothing: any failure (or an aborted `signal`, a chat switch)
 * resolves without attachments, so the caller schedules nothing. Each success
 * is reported at once, so a retry uploads only the failed files. The
 * attachments come back in chip order, shaped exactly as the normal send
 * records them (asset version id, name, mime, size). Never throws.
 */
export async function uploadScheduleFiles(input: {
  files: readonly ScheduleFile[];
  upload: AttachmentUploader;
  signal: AbortSignal;
  onProgress?: (key: string, fraction: number) => void;
  onUploaded?: (key: string, versionId: string) => void;
}): Promise<ScheduleUploadOutcome> {
  if (input.signal.aborted) return { ok: false, aborted: true };
  const results = await Promise.all(
    input.files.map(async (item): Promise<{ key: string; versionId: string | null }> => {
      if (item.versionId !== null) return { key: item.key, versionId: item.versionId };
      try {
        const res = await input.upload(
          item.file,
          (fraction) => {
            if (!input.signal.aborted) input.onProgress?.(item.key, fraction);
          },
          input.signal,
        );
        if (!res.ok || input.signal.aborted) return { key: item.key, versionId: null };
        input.onUploaded?.(item.key, res.versionId);
        return { key: item.key, versionId: res.versionId };
      } catch {
        return { key: item.key, versionId: null };
      }
    }),
  );
  if (input.signal.aborted) return { ok: false, aborted: true };
  const failedKeys = results.filter((r) => r.versionId === null).map((r) => r.key);
  if (failedKeys.length > 0) return { ok: false, aborted: false, failedKeys };
  return {
    ok: true,
    attachments: input.files.map((item, i) =>
      toMessageAttachment(item.file, results[i]?.versionId ?? ''),
    ),
  };
}

export type ScheduleWithFilesOutcome<T> =
  | { kind: 'written'; result: T }
  | { kind: 'aborted' }
  | { kind: 'upload-failed'; failedKeys: string[] };

/**
 * Upload the picked files (uploadScheduleFiles), then run `write` with their
 * attachment args. `write` runs only when every file is up and the run was not
 * aborted: a failed upload or a chat switch never reaches the schedule proc,
 * so there is no partial schedule. No files: `write` runs at once with empty
 * args. Without an uploader every file counts as failed.
 */
export async function scheduleWithFiles<T>(input: {
  files: readonly ScheduleFile[];
  upload: AttachmentUploader | undefined;
  signal: AbortSignal;
  onProgress?: (key: string, fraction: number) => void;
  onUploaded?: (key: string, versionId: string) => void;
  write: (args: { attachmentAssetIds: string[]; attachmentMeta: AttachmentMetaMap }) => Promise<T>;
}): Promise<ScheduleWithFilesOutcome<T>> {
  let attachments: MessageAttachment[] = [];
  if (input.files.length > 0) {
    if (input.upload === undefined) {
      return { kind: 'upload-failed', failedKeys: input.files.map((f) => f.key) };
    }
    const uploaded = await uploadScheduleFiles({
      files: input.files,
      upload: input.upload,
      signal: input.signal,
      ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
      ...(input.onUploaded !== undefined ? { onUploaded: input.onUploaded } : {}),
    });
    if (!uploaded.ok) {
      return uploaded.aborted
        ? { kind: 'aborted' }
        : { kind: 'upload-failed', failedKeys: uploaded.failedKeys };
    }
    attachments = uploaded.attachments;
  }
  if (input.signal.aborted) return { kind: 'aborted' };
  return { kind: 'written', result: await input.write(scheduleAttachmentArgs(attachments)) };
}

/** The schedule proc's attachment args for uploaded files, built like the normal send's. Pure. */
export function scheduleAttachmentArgs(attachments: readonly MessageAttachment[]): {
  attachmentAssetIds: string[];
  attachmentMeta: AttachmentMetaMap;
} {
  return {
    attachmentAssetIds: attachments.map((a) => a.assetId),
    attachmentMeta: buildAttachmentMeta(attachments),
  };
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

/**
 * The caller's scheduled rows for one chat (status 'scheduled'), soonest
 * first. RLS returns only the caller's own rows. Never throws.
 */
export async function readScheduledMessages(
  client: Client,
  params: { channelId: string; signal?: AbortSignal },
): Promise<Result<ScheduledRow[]>> {
  try {
    const query = client
      .from('chat_scheduled_messages')
      .select('*')
      .eq('channel_id', params.channelId)
      .eq('status', 'scheduled')
      .order('send_at', { ascending: true });
    const { data, error } = await abortable(query, params.signal);
    if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
    return { ok: true, data: soonestFirst((data ?? []) as ScheduledRow[]) };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

export type ScheduleWriteResult<T> = { ok: true; row: T } | RecordFailed;

async function runProc<T>(
  timeoutMs: number | undefined,
  name: string,
  call: (signal: AbortSignal) => PromiseLike<{
    data: unknown;
    error: { message: string; code?: string } | null;
    status?: number;
  }>,
  needsRow: boolean,
): Promise<ScheduleWriteResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? SEND_TIMEOUT_MS);
  const reason = (): 'timeout' | 'error' => (controller.signal.aborted ? 'timeout' : 'error');
  try {
    const { data, error, status } = await call(controller.signal);
    if (error) {
      return {
        ok: false,
        reason: reason(),
        message: error.message,
        ...(typeof error.code === 'string' && error.code !== '' ? { code: error.code } : {}),
        ...(typeof status === 'number' ? { status } : {}),
      };
    }
    if (needsRow && (data === null || data === undefined)) {
      return { ok: false, reason: 'error', message: `${name} returned no row` };
    }
    return { ok: true, row: data as T };
  } catch (error) {
    return { ok: false, reason: reason(), message: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ScheduleParams {
  client: Client;
  /** Client-generated id (newMessageId); the sent message keeps it. */
  id: string;
  channelId: string;
  sendAt: Date;
  traceId: string;
  body: string;
  /** Mentioned user ids (and "all"), as the normal send derives them. */
  mentions: readonly string[];
  attachmentAssetIds: readonly string[];
  attachmentMeta?: AttachmentMetaMap;
  sharedPostIds: readonly string[];
  sharedBriefIds: readonly string[];
  replyToMessageId: string | null;
  timeoutMs?: number;
}

/**
 * Schedule a message via chat_message_schedule. Empty parts are omitted, the
 * same way sendMessageRecord builds chat_message_send's args.
 */
export function scheduleMessage(
  params: ScheduleParams,
): Promise<ScheduleWriteResult<ScheduledRow>> {
  const body = params.body.trim();
  const args: Functions['chat_message_schedule']['Args'] = {
    p_id: params.id,
    p_channel_id: params.channelId,
    p_send_at: params.sendAt.toISOString(),
    p_trace_id: params.traceId,
    ...(body !== '' ? { p_body: body } : {}),
    ...(params.mentions.length > 0 ? { p_mentions: [...params.mentions] } : {}),
    ...(params.attachmentAssetIds.length > 0
      ? { p_attachment_asset_ids: [...params.attachmentAssetIds] }
      : {}),
    ...(params.attachmentMeta !== undefined && Object.keys(params.attachmentMeta).length > 0
      ? { p_attachment_meta: params.attachmentMeta }
      : {}),
    ...(params.sharedPostIds.length > 0 ? { p_shared_post_ids: [...params.sharedPostIds] } : {}),
    ...(params.sharedBriefIds.length > 0 ? { p_shared_brief_ids: [...params.sharedBriefIds] } : {}),
    ...(params.replyToMessageId !== null && params.replyToMessageId !== ''
      ? { p_reply_to_message_id: params.replyToMessageId }
      : {}),
  };
  return announceOnSuccess(
    runProc<ScheduledRow>(
      params.timeoutMs,
      'chat_message_schedule',
      (signal) => params.client.rpc('chat_message_schedule', args).abortSignal(signal),
      true,
    ),
    () => params.channelId,
  );
}

export interface ScheduledUpdateParams {
  client: Client;
  id: string;
  sendAt: Date;
  body: string;
  /** The COMPLETE mention list; the proc stores what it is given. */
  mentions: readonly string[];
  traceId: string;
  timeoutMs?: number;
}

/** Change a scheduled message's time and / or body via chat_scheduled_update. */
export function updateScheduledMessage(
  params: ScheduledUpdateParams,
): Promise<ScheduleWriteResult<ScheduledRow>> {
  const args: Functions['chat_scheduled_update']['Args'] = {
    p_id: params.id,
    p_send_at: params.sendAt.toISOString(),
    p_body: params.body.trim(),
    p_mentions: [...params.mentions],
    p_trace_id: params.traceId,
  };
  return announceOnSuccess(
    runProc<ScheduledRow>(
      params.timeoutMs,
      'chat_scheduled_update',
      (signal) => params.client.rpc('chat_scheduled_update', args).abortSignal(signal),
      true,
    ),
    (row) => row.channel_id,
  );
}

export interface ScheduledIdParams {
  client: Client;
  id: string;
  traceId: string;
  timeoutMs?: number;
}

/** Cancel a scheduled message via chat_scheduled_cancel. `channelId` is the row's chat (announced). */
export function cancelScheduledMessage(
  params: ScheduledIdParams & { channelId: string },
): Promise<ScheduleWriteResult<null>> {
  const args: Functions['chat_scheduled_cancel']['Args'] = {
    p_id: params.id,
    p_trace_id: params.traceId,
  };
  return announceOnSuccess(
    runProc<null>(
      params.timeoutMs,
      'chat_scheduled_cancel',
      (signal) => params.client.rpc('chat_scheduled_cancel', args).abortSignal(signal),
      false,
    ),
    () => params.channelId,
  );
}

/**
 * Send a scheduled message now via chat_scheduled_send_now: the proc records
 * it through chat_message_send (same id) and returns the chat_messages row.
 */
export function sendScheduledNow(
  params: ScheduledIdParams,
): Promise<ScheduleWriteResult<ChatMessageRow>> {
  const args: Functions['chat_scheduled_send_now']['Args'] = {
    p_id: params.id,
    p_trace_id: params.traceId,
  };
  return announceOnSuccess(
    runProc<ChatMessageRow>(
      params.timeoutMs,
      'chat_scheduled_send_now',
      (signal) => params.client.rpc('chat_scheduled_send_now', args).abortSignal(signal),
      true,
    ),
    (row) => row.channel_id,
  );
}
