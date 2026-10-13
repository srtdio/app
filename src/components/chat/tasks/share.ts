// Share a task list snapshot as plain text through the existing text send
// flow. The open chat goes through its own composer send (the outbox: the
// bubble shows at once, recorded then published). Every other picked chat is
// recorded via chat_message_send (sendMessageRecord) and only then published
// live (sendText), exactly as a forward does, minus the forwarded marker; a
// slow or failed live publish never fails the share (receivers catch up from
// Postgres). Sequential; the first refused record stops the run and names its
// chat (the forward picker toasts it).

import type { Client } from '@srtdio/rpc';
import type { ChannelSummary } from '@/lib/chat-reads';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { newMessageId } from '@/lib/chat/message-id';
import { createTextMessage } from '@/lib/chat/message-factory';
import { sendMessageRecord } from '@/lib/chat/record';
import { LIVE_PUBLISH_TIMEOUT_MS, publishWithTimeout } from '@/lib/chat/send-flow';
import { recordThenSignal } from '@/lib/chat/thread-actions';
import { sendText, targetFromSummary, type ThreadConnection } from '@/lib/chat/thread';
import type { ChatConnection } from '@/lib/chat/types';
import type { ForwardSendResult } from '@/components/chat/ForwardPicker';

export async function shareTextToChats(params: {
  text: string;
  targets: readonly ChannelSummary[];
  /** The open chat: its share goes through `sendHere` (the composer's send). */
  openChannelId: string | null;
  sendHere: (text: string) => void;
  db: Client;
  connection: ChatConnection | null;
}): Promise<ForwardSendResult> {
  for (const channel of params.targets) {
    if (channel.channelId === params.openChannelId) {
      params.sendHere(params.text);
      continue;
    }
    const id = newMessageId();
    const traceId = generateTraceId();
    let recorded = false;
    await recordThenSignal({
      record: async () => {
        const outcome = await sendMessageRecord({
          client: params.db,
          id,
          channelId: channel.channelId,
          traceId,
          body: params.text,
          attachmentAssetIds: [],
        });
        if (!outcome.ok) return { ok: false, message: outcome.message };
        recorded = true;
        return { ok: true };
      },
      signal: async () => {
        let target = null;
        try {
          target = targetFromSummary(channel);
        } catch {
          target = null;
        }
        if (params.connection === null || target === null) return;
        const published = await publishWithTimeout(
          sendText({
            connection: params.connection as ThreadConnection,
            target,
            text: params.text,
            attachments: [],
            sharedPostIds: [],
            reply: null,
            createMessage: createTextMessage,
            liveIds: { sorted_message_id: id, sorted_channel_id: channel.channelId },
          }),
          LIVE_PUBLISH_TIMEOUT_MS,
        );
        if (!published.ok) throw new Error(published.error);
      },
      onRecordFailed: (message) =>
        logger.error('chat: task share record failed', {
          trace_id: traceId,
          message_id: id,
          channel_id: channel.channelId,
          error: message,
        }),
      onSignalFailed: (error) =>
        logger.warn('chat: live publish did not complete', {
          trace_id: traceId,
          message_id: id,
          error: String(error),
        }),
    });
    if (!recorded) return { ok: false, failed: channel };
  }
  return { ok: true };
}
