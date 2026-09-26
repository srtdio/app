// The send orchestration, Postgres first: record the message through
// chat_message_send, and only once the row exists publish it over Agora for
// live delivery. Pure of React and of the SDK (both steps are injected) so the
// contract is unit-tested directly: the record write always precedes the live
// publish, the rendered message carries the RETURNED row's server created_at,
// a live publish failure or a publish slower than LIVE_PUBLISH_TIMEOUT_MS never
// fails the send (the row exists; receivers catch up from Postgres), and a
// record failure or timeout reports 'failed' so the bubble can offer Retry with
// the same id.

import type { SendRecordResult } from '@/lib/chat/record';
import { buildAttachmentMeta, type AttachmentMetaMap } from '@/lib/chat/attachments';
import {
  rowToThreadMessage,
  type LocalMessageContent,
  type ThreadMessage,
} from '@/lib/chat/thread';

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
}

export interface SendFlowDeps {
  /** chat_message_send; never throws (record.ts contract). */
  recordMessage: (input: {
    id: string;
    channelId: string;
    traceId: string;
    body: string;
    attachmentAssetIds: string[];
    sharedPostIds: string[];
    replyToMessageId: string | null;
    attachmentMeta: AttachmentMetaMap;
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
  /** Live publish problems are reported here, never surfaced to the user. */
  onLiveWarning: (context: Record<string, unknown>) => void;
  /** Called as soon as the row exists, before the live publish settles. */
  onRecorded?: (message: ThreadMessage) => void;
  /** Override for tests; defaults to LIVE_PUBLISH_TIMEOUT_MS. */
  publishTimeoutMs?: number;
}

export type SendOutcome =
  | { ok: true; message: ThreadMessage; livePublished: boolean }
  | { ok: false; reason: 'timeout' | 'error'; error: string };

/** Race the publish against a timer; the timer is always cleared. */
async function publishWithTimeout(
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

/** Record, then publish. Resolves to the rendered message or a failure. */
export async function runSend(deps: SendFlowDeps, input: SendInput): Promise<SendOutcome> {
  const recorded = await deps.recordMessage({
    id: input.id,
    channelId: input.channelId,
    traceId: input.traceId,
    body: input.text,
    attachmentAssetIds: input.local.attachments.map((a) => a.assetId),
    sharedPostIds: [...input.local.sharedPostIds],
    replyToMessageId: input.local.reply?.id ?? null,
    attachmentMeta: buildAttachmentMeta(input.local.attachments),
  });
  if (!recorded.ok) {
    return { ok: false, reason: recorded.reason, error: recorded.message };
  }
  const message = rowToThreadMessage(recorded.row, input.currentUserId, input.local);
  deps.onRecorded?.(message);

  if (deps.publishLive === undefined) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, skipped: 'no connection' });
    return { ok: true, message, livePublished: false };
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
  if (!published.ok) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, error: published.error });
    return { ok: true, message, livePublished: false };
  }
  return { ok: true, message, livePublished: true };
}
