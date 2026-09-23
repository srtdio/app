// The send orchestration, Postgres first: record the message through
// chat_message_send, and only once the row exists publish it over Agora for
// live delivery. Pure of React and of the SDK (both steps are injected) so the
// contract is unit-tested directly: the record write always precedes the live
// publish, the rendered message carries the RETURNED row's server created_at,
// a live publish failure never fails the send (the row exists; receivers catch
// up from Postgres), and a record failure or timeout reports 'failed' so the
// bubble can offer Retry with the same id.

import type { SendRecordResult } from '@/lib/chat/record';
import {
  rowToThreadMessage,
  type LocalMessageContent,
  type ThreadMessage,
} from '@/lib/chat/thread';

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
}

export type SendOutcome =
  | { ok: true; message: ThreadMessage; livePublished: boolean }
  | { ok: false; reason: 'timeout' | 'error'; error: string };

/** Record, then publish. Resolves to the rendered message or a failure. */
export async function runSend(deps: SendFlowDeps, input: SendInput): Promise<SendOutcome> {
  const recorded = await deps.recordMessage({
    id: input.id,
    channelId: input.channelId,
    traceId: input.traceId,
    body: input.text,
    attachmentAssetIds: input.local.attachments.map((a) => a.assetId),
  });
  if (!recorded.ok) {
    return { ok: false, reason: recorded.reason, error: recorded.message };
  }
  const message = rowToThreadMessage(recorded.row, input.currentUserId, input.local);

  if (deps.publishLive === undefined) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, skipped: 'no connection' });
    return { ok: true, message, livePublished: false };
  }
  try {
    await deps.publishLive({
      id: input.id,
      channelId: input.channelId,
      text: input.text,
      local: input.local,
    });
    return { ok: true, message, livePublished: true };
  } catch (error) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, error: String(error) });
    return { ok: true, message, livePublished: false };
  }
}
