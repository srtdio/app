// The send orchestration, Postgres first: record the message through
// chat_message_send, and only once the row exists publish it over Agora for
// live delivery. Pure of React and of the SDK (both steps are injected) so the
// contract is unit-tested directly: the record write always precedes the live
// publish, the rendered message carries the RETURNED row's server created_at,
// a live publish failure or a publish slower than LIVE_PUBLISH_TIMEOUT_MS never
// fails the send (the row exists; receivers catch up from Postgres), and a
// record failure or timeout reports 'failed' with its class (send-errors.ts).
//
// createOutboxSender runs those sends in the background, one channel queue at a
// time (FIFO per channel: a later message never records before an earlier
// pending one). A transient failure (network, timeout, 408 / 429 / 5xx, an
// upload error or stall) never shows: the bubble keeps its clock and the
// attempt repeats with backoff (2s, 4s, 8s, 16s, then every 30s, with no end;
// a backoff attempt is skipped while the device is offline) using the SAME
// message id and a fresh trace id per attempt; kick() (reconnect, tab
// visible, online) retries at once. Only a permanent failure (the server
// refused this message) turns the bubble 'failed' ("Not sent" + Retry); the
// queue then moves on to the next message, and Retry re-stamps the refused
// one (it moves to the bottom) and puts it back in line. A recorded send
// re-stamps the sends queued behind it to just after its server time, so
// they never show above it.
//
// Instant attachment sends: an entry may carry picked files or a recorded voice
// note (attachment.local) whose asset id is still ''. Each attempt first
// uploads those, in order and one at a time, reporting progress as 'progress'
// events, and stores every returned version id on the entry; only then does it
// record once with all the ids. A
// retry uploads only the files that still have no version id. An entry
// restored while its files are read back (restoring) holds its place without
// running; one whose files are gone (filesMissing) never runs and does not
// hold up the queue.
//
// Cancel (the X on an uploading bubble): each entry owns one AbortController
// whose signal rides every upload of it. cancel() aborts the in-flight request,
// skips the uploads still to run, drops the entry (its stored files and
// previews go through onCancelled), clears its backoff timer and frees the
// lane at once, so the next queued send starts now. A cancelled upload's
// answer is ignored: never "Not sent", a retry or a backoff. The record call is
// the point of no return: deliver checks for a cancel synchronously right
// before it, and once it has fired a cancel is ignored and the bubble stays.
// Files already uploaded for a cancelled message stay as orphan assets.
//
// Mentions ride in the body as @[uuid] tokens; every attempt derives p_mentions
// from the body, so a retry (or a send restored from storage) resends them.
// When the server refuses a mention ('mentioned people must be in this chat')
// the attempt re-reads the chat's members once and records again without the
// ones who left (without any mention when that re-read fails): never a failed
// bubble for it.

import { mark } from '@/lib/perf-marks';
import type { SendRecordResult } from '@/lib/chat/record';
import {
  outboxDropChannel,
  outboxPut,
  outboxRecorded,
  outboxRemove,
  outboxSetAttachments,
  outboxSetState,
  selectOutbox,
  type Outbox,
  type OutboxEntry,
  type OutboxEvent,
} from '@/lib/chat/chat-store';
import {
  awaitsUpload,
  buildAttachmentMeta,
  type AttachmentMetaMap,
  type AttachmentUploader,
  type ChatAttachmentUpload,
  type MessageAttachment,
} from '@/lib/chat/attachments';
import {
  ALL_MENTION,
  isEveryoneRefusal,
  isMentionRefusal,
  mentionTargets,
  mentionsAfterRefusal,
} from '@/lib/chat/mentions';
import type { Result } from '@srtdio/rpc';
import {
  classifyRecordFailure,
  classifyUploadFailure,
  uploadFailureStatus,
  refusalReason,
  uploadRefusalContext,
  type SendErrorClass,
} from '@/lib/chat/send-errors';
import { headerHex, readHeader, recorderMimeOf } from '@/lib/chat/audio-sniff';
import { logger } from '@/lib/logger';
import {
  rowToThreadMessage,
  type LocalMessageContent,
  type ThreadMessage,
} from '@/lib/chat/thread';

/**
 * Log a permanently refused upload once, when it is refused: the status, the
 * Worker code, what was sent (type, size, the recorder's reported mimeType
 * when known, the first 12 bytes as hex) and the user agent. Nothing else:
 * no name, no content past the header. Never throws.
 */
export async function logUploadRefusal(
  file: Blob,
  message: string,
  status: number | undefined,
): Promise<void> {
  try {
    const header = await readHeader(file);
    logger.warn(
      'chat: upload refused',
      uploadRefusalContext({
        message,
        status,
        mime: file.type,
        size: file.size,
        recorderMime: recorderMimeOf(file),
        headerHex: headerHex(header),
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      }),
    );
  } catch {
    // Logging never fails a send.
  }
}

/** The Agora publish is abandoned (the bubble stays sent) after this long. */
export const LIVE_PUBLISH_TIMEOUT_MS = 5_000;

/** What one send carries; a retry passes the same `id` and `pending` again. */
export interface SendInput {
  id: string;
  channelId: string;
  currentUserId: string;
  traceId: string;
  text: string;
  local: LocalMessageContent;
  /** The chat's type; a DM never sends "all" in p_mentions, notes send none. */
  channelType?: 'dm' | 'group' | 'notes';
}

export interface SendFlowDeps {
  /** chat_message_send; never throws (record.ts contract). */
  recordMessage: (input: {
    id: string;
    channelId: string;
    traceId: string;
    body: string;
    /** The body's mentioned user ids (and "all"), from its tokens; empty when none. */
    mentions: string[];
    attachmentAssetIds: string[];
    sharedPostIds: string[];
    sharedBriefIds: string[];
    replyToMessageId: string | null;
    attachmentMeta: AttachmentMetaMap;
    /** Save to notes: the source message (p_forwarded_from_message_id); absent on ordinary sends. */
    forwardedFromMessageId?: string;
  }) => Promise<SendRecordResult>;
  /**
   * Agora publish for live delivery, or undefined while there is no live
   * connection (the message is still sent: it is in the record).
   */
  publishLive:
    | ((input: {
        id: string;
        channelId: string;
        text: string;
        local: LocalMessageContent;
      }) => Promise<unknown>)
    | undefined;
  /**
   * Resolve the live target before the publish starts (an unsynced group's
   * member read, bounded on its own). Awaited after the record and never
   * counted against the publish timeout; a throw is ignored (the publish then
   * finds no target).
   */
  beforePublish?: () => Promise<unknown>;
  /**
   * Re-read who this chat's mentions may name, after the server refused one.
   * Absent (or failed): the retry carries no mentions.
   */
  recheckMentions?: (channelId: string) => Promise<Result<string[]>>;
  /** Live publish problems are reported here, never surfaced to the user. */
  onLiveWarning: (context: Record<string, unknown>) => void;
  /** Called as soon as the row exists, before the live publish settles. */
  onRecorded?: (message: ThreadMessage) => void;
  /** Override for tests; defaults to LIVE_PUBLISH_TIMEOUT_MS. */
  publishTimeoutMs?: number;
}

export type SendOutcome =
  | { ok: true; message: ThreadMessage; livePublished: boolean }
  | {
      ok: false;
      reason: 'timeout' | 'error';
      error: string;
      /** Absent is 'transient' (keep trying). */
      errorClass?: SendErrorClass;
    };

/** Race the publish against a timer; the timer is always cleared. */
export async function publishWithTimeout(
  publish: Promise<unknown>,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'live publish timed out' }), timeoutMs);
  });
  try {
    return await Promise.race([
      publish.then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error: String(error) }) as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One member re-read for a refused mention; a missing reader or a throw is a failed read. */
export async function recheck(
  read: ((channelId: string) => Promise<Result<string[]>>) | undefined,
  channelId: string,
): Promise<Result<string[]>> {
  const failed: Result<string[]> = {
    ok: false,
    error: { code: 'unknown', message: 'mention re-check unavailable' },
  };
  if (read === undefined) return failed;
  try {
    return await read(channelId);
  } catch {
    return failed;
  }
}

/** Record, then publish. Resolves to the rendered message or a failure. */
export async function runSend(deps: SendFlowDeps, input: SendInput): Promise<SendOutcome> {
  const record = (mentions: string[]): Promise<SendRecordResult> =>
    deps.recordMessage({
      id: input.id,
      channelId: input.channelId,
      traceId: input.traceId,
      body: input.text,
      mentions,
      attachmentAssetIds: input.local.attachments.map((a) => a.assetId),
      sharedPostIds: [...input.local.sharedPostIds],
      sharedBriefIds: [...(input.local.sharedBriefIds ?? [])],
      replyToMessageId: input.local.reply?.id ?? null,
      attachmentMeta: buildAttachmentMeta(input.local.attachments),
      ...(input.local.forwardedFromMessageId !== undefined
        ? { forwardedFromMessageId: input.local.forwardedFromMessageId }
        : {}),
    });
  // A saved copy (Save to notes) names nobody: p_mentions stays null.
  let mentions =
    input.local.forwardedFromMessageId !== undefined
      ? []
      : mentionTargets(input.text, input.channelType);
  let recorded = await record(mentions);
  // The chat's type was unknown and "all" went out in a DM: drop only "all"
  // and send the people first; a further refusal takes the ladder below.
  if (
    !recorded.ok &&
    input.channelType === undefined &&
    mentions.includes(ALL_MENTION) &&
    isEveryoneRefusal(recorded.message)
  ) {
    mentions = mentions.filter((id) => id !== ALL_MENTION);
    recorded = await record(mentions);
  }
  if (!recorded.ok && mentions.length > 0 && isMentionRefusal(recorded.message)) {
    const fresh = await recheck(deps.recheckMentions, input.channelId);
    const retry = mentionsAfterRefusal(mentions, fresh);
    recorded = await record(retry);
    // Refused again: the last step sends without mentions, never a failed send.
    if (!recorded.ok && retry.length > 0 && isMentionRefusal(recorded.message)) {
      recorded = await record([]);
    }
  }
  if (!recorded.ok) {
    return {
      ok: false,
      reason: recorded.reason,
      error: recorded.message,
      errorClass: classifyRecordFailure(recorded),
    };
  }
  mark('chat:send:recorded');
  const message = rowToThreadMessage(recorded.row, input.currentUserId, input.local);
  deps.onRecorded?.(message);

  if (deps.publishLive === undefined) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, skipped: 'no connection' });
    return { ok: true, message, livePublished: false };
  }
  if (deps.beforePublish !== undefined) {
    try {
      await deps.beforePublish();
    } catch {
      // The publish below finds no target and is reported there.
    }
  }
  let publish: Promise<unknown>;
  try {
    publish = deps.publishLive({
      id: input.id,
      channelId: input.channelId,
      text: input.text,
      local: input.local,
    });
  } catch (error) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, error: String(error) });
    return { ok: true, message, livePublished: false };
  }
  const published = await publishWithTimeout(
    publish,
    deps.publishTimeoutMs ?? LIVE_PUBLISH_TIMEOUT_MS,
  );
  mark('chat:send:published');
  if (!published.ok) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, error: published.error });
    return { ok: true, message, livePublished: false };
  }
  return { ok: true, message, livePublished: true };
}

/** The longest wait between two attempts. */
const RETRY_CAP_MS = 30_000;
/** Waits between attempts after a transient failure; the last one repeats with no end. */
const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, RETRY_CAP_MS];

/** The wait before the next attempt after `failures` consecutive failures (>= 1). */
export function retryDelayMs(failures: number): number {
  const index = Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index] ?? RETRY_CAP_MS;
}

/** A chat upload with no progress event for this long is aborted (a transient failure). */
export const UPLOAD_STALL_MS = 30_000;
/** Once every byte is sent, the Worker's answer is awaited this long, then aborted (transient). */
export const UPLOAD_RESPONSE_WAIT_MS = 120_000;

/** The slice of an XMLHttpRequest the stall watch needs. */
interface StallWatchable {
  upload: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  abort: () => void;
}

export interface StallWatch {
  /** Stop watching: clears the timer and every listener (idempotent). */
  stop: () => void;
}

/**
 * Abort `request` when its upload goes UPLOAD_STALL_MS without progress (an
 * upload start or progress event, a response progress or state change), or
 * when, after its last byte (the upload 'load' event), the Worker has not
 * answered within UPLOAD_RESPONSE_WAIT_MS. The abort surfaces as the XHR
 * transport failure the upload already maps to a transient error, so the
 * outbox retries and the queue behind it moves on. Stops by itself on
 * loadend; the caller also stops it when the upload settles.
 */
export function watchUploadStall(
  request: StallWatchable,
  opts: {
    stallMs?: number;
    responseWaitMs?: number;
    setTimer?: (fn: () => void, delayMs: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): StallWatch {
  const stallMs = opts.stallMs ?? UPLOAD_STALL_MS;
  const responseWaitMs = opts.responseWaitMs ?? UPLOAD_RESPONSE_WAIT_MS;
  const setTimer =
    opts.setTimer ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  let timer: unknown = null;
  let stopped = false;
  // Every byte is out: one response wait runs and nothing re-arms it.
  let sent = false;
  const disarm = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const armFor = (delayMs: number): void => {
    disarm();
    timer = setTimer(() => {
      timer = null;
      stop();
      request.abort();
    }, delayMs);
  };
  const arm = (): void => {
    if (stopped || sent) return;
    armFor(stallMs);
  };
  const lastByte = (): void => {
    if (stopped || sent) return;
    sent = true;
    armFor(responseWaitMs);
  };
  const UPLOAD_EVENTS = ['loadstart', 'progress'] as const;
  const REQUEST_EVENTS = ['progress', 'readystatechange'] as const;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    disarm();
    for (const type of UPLOAD_EVENTS) request.upload.removeEventListener(type, arm);
    request.upload.removeEventListener('load', lastByte);
    for (const type of REQUEST_EVENTS) request.removeEventListener(type, arm);
    request.removeEventListener('loadend', stop);
  }
  for (const type of UPLOAD_EVENTS) request.upload.addEventListener(type, arm);
  request.upload.addEventListener('load', lastByte);
  for (const type of REQUEST_EVENTS) request.addEventListener(type, arm);
  request.addEventListener('loadend', stop);
  arm();
  return { stop };
}

/** navigator.onLine where there is one; true elsewhere (and when it is unknown). */
function deviceOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** One chat upload attempt: its Result and the HTTP status its XHR ended with (null: none). */
export interface UploadAttemptResult {
  result: ChatAttachmentUpload;
  status: number | null;
}

/** How a session refresh went: a new token, a refusal, or no answer (offline). */
export type SessionRefresh = 'refreshed' | 'rejected' | 'unreachable';

/** The result of an upload the sender cancelled (the X); the outbox never reads it as a failure. */
export const UPLOAD_CANCELLED = 'upload cancelled';

/**
 * Run one chat upload; on a 401 refresh the session once and retry once. A
 * failure comes back carrying the status its classification reads
 * (uploadFailureStatus): a second 401, or a refresh the server refused, is
 * 401 (permanent); a refresh that could not reach the server is 0
 * (transient). A cancelled send (aborted `signal`) never refreshes or
 * re-uploads. Never throws.
 */
export async function uploadWithSessionRetry(
  attempt: () => Promise<UploadAttemptResult>,
  refreshSession: () => Promise<SessionRefresh>,
  signal?: AbortSignal,
): Promise<ChatAttachmentUpload> {
  const cancelled: ChatAttachmentUpload = { ok: false, message: UPLOAD_CANCELLED };
  // Read fresh each time: the X can land during any await below.
  const isCancelled = (): boolean => signal?.aborted === true;
  if (isCancelled()) return cancelled;
  const withStatus = (
    outcome: UploadAttemptResult,
    status: number | null,
  ): ChatAttachmentUpload => {
    if (outcome.result.ok || status === null) return outcome.result;
    const failed: ChatAttachmentUpload & { status: number } = { ...outcome.result, status };
    return failed;
  };
  let first: UploadAttemptResult;
  try {
    first = await attempt();
  } catch (error) {
    return { ok: false, message: String(error) };
  }
  if (first.result.ok || first.status !== 401) return withStatus(first, first.status);
  // Cancelled during the first attempt: no refresh, no second upload.
  if (isCancelled()) return cancelled;
  let refreshed: SessionRefresh;
  try {
    refreshed = await refreshSession();
  } catch {
    refreshed = 'unreachable';
  }
  if (refreshed === 'unreachable') return withStatus(first, 0);
  if (refreshed === 'rejected') return withStatus(first, 401);
  // Cancelled while the session refreshed: no second upload.
  if (isCancelled()) return cancelled;
  try {
    const second = await attempt();
    return withStatus(second, second.status);
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

export interface OutboxSenderDeps {
  /**
   * One attempt: record, then publish (runSend). onRecorded fires the moment
   * the row exists, so the queue moves on without waiting for the publish.
   */
  deliver: (
    channelId: string,
    entry: OutboxEntry,
    traceId: string,
    onRecorded: (message: ThreadMessage) => void,
  ) => Promise<SendOutcome>;
  newTraceId: () => string;
  /** Bubble updates for the open thread. */
  onEvent: (event: OutboxEvent) => void;
  /** The whole outbox after every change (persistence). */
  onChange: (outbox: Outbox) => void;
  /** One failed attempt, for the log. */
  onAttemptFailed: (context: Record<string, unknown>) => void;
  /** Uploads a file whose attachment carries no uploader (restored after a reload). */
  upload?: AttachmentUploader;
  /**
   * An entry was cancelled (and has left the outbox): release what it holds
   * outside the sender (stored files, object URLs).
   */
  onCancelled?: (channelId: string, entry: OutboxEntry) => void;
  /** Whether the device is online; a backoff attempt is skipped while it is not. */
  isOnline?: () => boolean;
  /** Device clock (the Retry tap re-stamps an entry); defaults to Date.now. */
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface OutboxSender {
  entries: (channelId: string) => readonly OutboxEntry[];
  enqueue: (channelId: string, entry: OutboxEntry) => void;
  /** Retry on a refused ('failed') entry: back in line, same id. */
  retry: (channelId: string, id: string) => void;
  settle: (channelId: string, id: string) => void;
  /**
   * The X on an uploading send: abort, drop and free the lane now. False
   * (ignored) once its record call fired or when nothing of it uploads.
   */
  cancel: (channelId: string, id: string) => boolean;
  dropChannel: (channelId: string) => void;
  /**
   * A restoring entry's files came back from IndexedDB (its attachments, with
   * the files attached) and it resumes; null: they are gone, so it turns
   * filesMissing ('failed', Remove only).
   */
  restoreFiles: (
    channelId: string,
    id: string,
    attachments: readonly MessageAttachment[] | null,
  ) => void;
  /** Attempt every waiting queue now (reconnect, tab visible, online). */
  kick: () => void;
  /** Stop: clear every timer and ignore every answer still in flight. */
  dispose: () => void;
}

/**
 * The entry a channel's queue runs next: the oldest one still pending. A
 * refused ('failed') entry waits on Retry and one whose files are gone waits
 * on Remove; neither holds up the messages behind it.
 */
function headOf(entries: readonly OutboxEntry[]): OutboxEntry | undefined {
  return entries.find((e) => e.filesMissing !== true && e.state === 'sending');
}

/** Copy of `attachments` with one item replaced. */
function replaceAt(
  attachments: readonly MessageAttachment[],
  index: number,
  next: MessageAttachment,
): MessageAttachment[] {
  return attachments.map((a, i) => (i === index ? next : a));
}

/** The attempt a lane is running; release() makes every later answer of it a no-op. */
interface Attempt {
  id: string;
  release: () => void;
}

/** One channel's queue runner. */
interface Lane {
  busy: boolean;
  timer: unknown;
  failures: number;
  attempt: Attempt | null;
}

type AttemptFailure = { error: string; errorClass: SendErrorClass };

/**
 * The background sender over an outbox (restored entries resume at once).
 * Nothing here throws; a deliver that rejects counts as a transient failure.
 */
export function createOutboxSender(deps: OutboxSenderDeps, initial: Outbox = {}): OutboxSender {
  const setTimer =
    deps.setTimer ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  let outbox: Outbox = initial;
  let disposed = false;
  const lanes = new Map<string, Lane>();
  const isOnline = deps.isOnline ?? deviceOnline;
  const now = deps.now ?? ((): number => Date.now());
  // One abort controller per entry, shared by every upload of it.
  const controllers = new Map<string, AbortController>();
  // Entries whose record call has fired: past the point of no return.
  const committed = new Set<string>();
  const controllerFor = (id: string): AbortController => {
    const known = controllers.get(id);
    if (known !== undefined) return known;
    const controller = new AbortController();
    controllers.set(id, controller);
    return controller;
  };
  const forget = (id: string): void => {
    controllers.delete(id);
    committed.delete(id);
  };

  const commit = (next: Outbox): void => {
    if (next === outbox) return;
    outbox = next;
    deps.onChange(outbox);
  };

  const laneFor = (channelId: string): Lane => {
    const existing = lanes.get(channelId);
    if (existing !== undefined) return existing;
    const lane: Lane = { busy: false, timer: null, failures: 0, attempt: null };
    lanes.set(channelId, lane);
    return lane;
  };

  const stopTimer = (lane: Lane): void => {
    if (lane.timer !== null) {
      clearTimer(lane.timer);
      lane.timer = null;
    }
  };

  const setState = (
    channelId: string,
    id: string,
    state: OutboxEntry['state'],
    refusal?: string,
  ): void => {
    commit(outboxSetState(outbox, channelId, id, state, refusal));
    deps.onEvent({
      type: 'state',
      channelId,
      id,
      state,
      ...(refusal !== undefined ? { refusal } : {}),
    });
  };

  /** The entry as the outbox holds it now; undefined once settled or dropped. */
  const current = (channelId: string, id: string): OutboxEntry | undefined =>
    selectOutbox(outbox, channelId).find((e) => e.id === id);

  const isLive = (channelId: string, lane: Lane): boolean =>
    !disposed && lanes.get(channelId) === lane;

  /** Its files are gone: 'failed' with filesMissing (Remove only); the queue moves on. */
  const markFilesMissing = (channelId: string, id: string): void => {
    const entry = current(channelId, id);
    if (entry === undefined) return;
    const lost: OutboxEntry = { ...entry, state: 'failed', filesMissing: true };
    delete lost.restoring;
    commit(outboxPut(outbox, channelId, lost));
    deps.onEvent({ type: 'state', channelId, id, state: 'failed' });
  };

  /**
   * Upload the entry's files that have no version id yet, in order. Progress ticks update memory only (no
   * persistence write per tick); each finished upload is committed, so a
   * retry or a reload keeps its version id. Resolves to the entry ready to
   * record, null when it left the outbox (or the sender stopped, or its files
   * are gone) mid-way, or the first failure with its class.
   */
  const uploadPending = async (
    channelId: string,
    lane: Lane,
    id: string,
  ): Promise<{ ok: true; entry: OutboxEntry | null } | ({ ok: false } & AttemptFailure)> => {
    for (;;) {
      if (!isLive(channelId, lane)) return { ok: true, entry: null };
      const entry = current(channelId, id);
      if (entry === undefined) return { ok: true, entry: null };
      const attachments = entry.local.attachments;
      const index = attachments.findIndex(awaitsUpload);
      if (index === -1) return { ok: true, entry };
      const target = attachments[index];
      const local = target?.local;
      if (target === undefined || local === undefined) return { ok: true, entry };
      if (local.file === null) {
        markFilesMissing(channelId, id);
        return { ok: true, entry: null };
      }
      const file = local.file;
      const upload = local.upload ?? deps.upload;
      if (upload === undefined) {
        return { ok: false, error: 'attachment upload unavailable', errorClass: 'transient' };
      }
      const signal = controllerFor(id).signal;
      // Cancelled: the uploads still to run are skipped.
      if (signal.aborted) return { ok: true, entry: null };
      const publish = (next: MessageAttachment, persist: boolean): void => {
        const latest = current(channelId, id);
        if (latest === undefined || !isLive(channelId, lane)) return;
        const list = replaceAt(latest.local.attachments, index, next);
        const updated = outboxSetAttachments(outbox, channelId, id, list);
        if (persist) commit(updated);
        else outbox = updated;
        deps.onEvent({ type: 'progress', channelId, id, attachments: list });
      };
      // The request runs: the ring shows real progress from here.
      publish({ ...target, local: { ...local, uploading: true } }, false);
      mark('chat:upload:start');
      let result: ChatAttachmentUpload;
      try {
        result = await upload(
          file,
          (fraction) =>
            publish({ ...target, local: { ...local, progress: fraction, uploading: true } }, false),
          signal,
        );
      } catch (error) {
        result = { ok: false, message: String(error) };
      }
      mark('chat:upload:end');
      // Cancelled mid-upload: whatever came back is ignored.
      if (signal.aborted) return { ok: true, entry: null };
      if (!result.ok) {
        // Waiting for the next attempt: the ring spins again.
        const latest = current(channelId, id)?.local.attachments[index];
        if (latest?.local !== undefined) {
          publish({ ...latest, local: { ...latest.local, uploading: false } }, false);
        }
        const status = uploadFailureStatus(result);
        const errorClass = classifyUploadFailure(result.message, status);
        if (errorClass === 'permanent') void logUploadRefusal(file, result.message, status);
        return { ok: false, error: result.message, errorClass };
      }
      publish(
        {
          ...target,
          assetId: result.versionId,
          local: { ...local, progress: 1, uploading: false },
        },
        true,
      );
    }
  };

  const onRecorded = (channelId: string, lane: Lane, message: ThreadMessage): void => {
    lane.busy = false;
    lane.failures = 0;
    forget(message.id);
    if (!isLive(channelId, lane)) return;
    const held = selectOutbox(outbox, channelId).some((e) => e.id === message.id);
    // Sends queued behind it never read earlier than its server time.
    commit(outboxRecorded(outbox, channelId, message.id, message.time));
    if (held) deps.onEvent({ type: 'recorded', channelId, message });
    pump(channelId);
  };

  const onFailed = (
    channelId: string,
    lane: Lane,
    head: OutboxEntry,
    traceId: string,
    reason: string,
    failure: AttemptFailure,
  ): void => {
    lane.busy = false;
    if (!isLive(channelId, lane)) return;
    deps.onAttemptFailed({
      trace_id: traceId,
      message_id: head.id,
      channel_id: channelId,
      reason,
      error: failure.error,
      error_class: failure.errorClass,
      failures: lane.failures + 1,
    });
    // Settled by a catch-up (or dropped, or refused) while this attempt was in flight.
    if (headOf(selectOutbox(outbox, channelId))?.id !== head.id) {
      lane.failures = 0;
      pump(channelId);
      return;
    }
    if (failure.errorClass === 'permanent') {
      // The server refused this message for good: "Not sent" with the reason
      // and Delete only (a Retry would be refused again); the rest go on.
      lane.failures = 0;
      setState(
        channelId,
        head.id,
        'failed',
        refusalReason(reason === 'upload' ? 'upload' : 'record', failure.error),
      );
      pump(channelId);
      return;
    }
    lane.failures += 1;
    lane.timer = setTimer(() => {
      lane.timer = null;
      // Offline: skip the attempt; the 'online' (or visible, connected) kick resumes.
      if (!isOnline()) return;
      pump(channelId);
    }, retryDelayMs(lane.failures));
  };

  function pump(channelId: string): void {
    if (disposed) return;
    const lane = laneFor(channelId);
    if (lane.busy || lane.timer !== null) return;
    const head = headOf(selectOutbox(outbox, channelId));
    // A restoring head holds its place until its files are back.
    if (head === undefined || head.restoring === true) return;
    lane.busy = true;
    const traceId = deps.newTraceId();
    let settled = false;
    const attempt: Attempt = {
      id: head.id,
      release: () => {
        settled = true;
      },
    };
    lane.attempt = attempt;
    const done = (): void => {
      if (lane.attempt === attempt) lane.attempt = null;
    };
    const recorded = (message: ThreadMessage): void => {
      if (settled) return;
      settled = true;
      done();
      onRecorded(channelId, lane, message);
    };
    const failed = (reason: string, failure: AttemptFailure): void => {
      if (settled) return;
      settled = true;
      done();
      onFailed(channelId, lane, head, traceId, reason, failure);
    };
    const deliver = (entry: OutboxEntry): void => {
      // The point of no return, checked synchronously right before the record
      // call: a cancelled entry (released, or gone) never records.
      if (settled || controllers.get(entry.id)?.signal.aborted === true) return;
      committed.add(entry.id);
      void deps.deliver(channelId, entry, traceId, recorded).then(
        (outcome) => {
          if (outcome.ok) recorded(outcome.message);
          else {
            failed(outcome.reason, {
              error: outcome.error,
              errorClass: outcome.errorClass ?? 'transient',
            });
          }
        },
        (error: unknown) => failed('error', { error: String(error), errorClass: 'transient' }),
      );
    };
    // A text-only (or fully uploaded) entry records in this same tick.
    if (!head.local.attachments.some(awaitsUpload)) {
      deliver(head);
      return;
    }
    void uploadPending(channelId, lane, head.id).then((uploaded) => {
      if (!uploaded.ok) {
        failed('upload', uploaded);
        return;
      }
      if (uploaded.entry !== null) {
        deliver(uploaded.entry);
        return;
      }
      // Cancelled: cancel() already freed the lane (a new attempt may run).
      if (settled) return;
      // Settled, dropped, lost or stopped while uploading: release the lane.
      settled = true;
      done();
      lane.busy = false;
      if (isLive(channelId, lane)) pump(channelId);
    });
  }

  for (const channelId of Object.keys(outbox)) pump(channelId);

  return {
    entries: (channelId) => selectOutbox(outbox, channelId),
    enqueue: (channelId, entry) => {
      if (disposed) return;
      mark('chat:send:outbox');
      commit(outboxPut(outbox, channelId, entry));
      pump(channelId);
    },
    retry: (channelId, id) => {
      if (disposed) return;
      const entry = selectOutbox(outbox, channelId).find((e) => e.id === id);
      if (entry === undefined || entry.state !== 'failed' || entry.filesMissing === true) return;
      // The tap re-stamps it: it moves to the bottom now and keeps that place.
      const again: OutboxEntry = { ...entry, createdMs: now() };
      delete again.refusal;
      commit(outboxPut(outbox, channelId, again));
      setState(channelId, id, 'sending');
      // Back in line at once: a backoff wait for the head restarts now.
      const lane = laneFor(channelId);
      stopTimer(lane);
      lane.failures = 0;
      pump(channelId);
    },
    settle: (channelId, id) => {
      if (disposed) return;
      mark('chat:send:settled');
      const wasHead = headOf(selectOutbox(outbox, channelId))?.id === id;
      const lane = lanes.get(channelId);
      // A pending upload of this send (a Delete on a failed one, or a
      // catch-up) stops now; its answer is ignored and the lane is free.
      controllers.get(id)?.abort();
      const running = lane?.attempt?.id === id ? lane.attempt : null;
      commit(outboxRemove(outbox, channelId, id));
      forget(id);
      if (lane !== undefined && running !== null) {
        running.release();
        lane.attempt = null;
        lane.busy = false;
      }
      if ((!wasHead && running === null) || lane === undefined) return;
      stopTimer(lane);
      lane.failures = 0;
      pump(channelId);
    },
    cancel: (channelId, id) => {
      if (disposed) return false;
      const entry = current(channelId, id);
      // Only an uploading send has the X; once its record call fired the
      // cancel is ignored and the bubble stays.
      if (
        entry === undefined ||
        committed.has(id) ||
        entry.state !== 'sending' ||
        entry.filesMissing === true ||
        !entry.local.attachments.some(awaitsUpload)
      ) {
        return false;
      }
      controllerFor(id).abort();
      const lane = lanes.get(channelId);
      const wasHead = headOf(selectOutbox(outbox, channelId))?.id === id;
      const running = lane?.attempt?.id === id ? lane.attempt : null;
      commit(outboxRemove(outbox, channelId, id));
      forget(id);
      deps.onCancelled?.(channelId, entry);
      deps.onEvent({ type: 'cancelled', channelId, id });
      if (lane !== undefined && (running !== null || wasHead)) {
        // The lane is free at once: its answer is ignored, the next send runs now.
        running?.release();
        if (running !== null) lane.attempt = null;
        lane.busy = false;
        stopTimer(lane);
        lane.failures = 0;
        pump(channelId);
      }
      return true;
    },
    dropChannel: (channelId) => {
      const lane = lanes.get(channelId);
      if (lane !== undefined) stopTimer(lane);
      lanes.delete(channelId);
      // A cleared chat stops its uploads too; their answers are ignored.
      for (const e of selectOutbox(outbox, channelId)) {
        controllers.get(e.id)?.abort();
        forget(e.id);
      }
      commit(outboxDropChannel(outbox, channelId));
    },
    restoreFiles: (channelId, id, attachments) => {
      if (disposed) return;
      const entry = current(channelId, id);
      if (entry === undefined || entry.restoring !== true) return;
      if (attachments === null) {
        markFilesMissing(channelId, id);
      } else {
        const back: OutboxEntry = { ...entry, local: { ...entry.local, attachments } };
        delete back.restoring;
        commit(outboxPut(outbox, channelId, back));
        deps.onEvent({ type: 'progress', channelId, id, attachments });
      }
      pump(channelId);
    },
    kick: () => {
      if (disposed) return;
      for (const channelId of Object.keys(outbox)) {
        const lane = laneFor(channelId);
        stopTimer(lane);
        pump(channelId);
      }
    },
    dispose: () => {
      disposed = true;
      for (const lane of lanes.values()) stopTimer(lane);
      lanes.clear();
    },
  };
}
