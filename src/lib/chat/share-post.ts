// Share one post into one chat conversation, Postgres first: record the message
// through chat_message_send (via the injected record step), and only once the
// row exists publish it over Agora for live delivery. The live publish is
// optional (null when there is no open connection or no live target, e.g. a
// Notes channel or an unsynced group) and never fails the share: the row
// exists, so receivers catch up from Postgres. Pure of React and of the SDK
// so the contract is unit-tested directly.

import type { SendRecordResult } from '@/lib/chat/record';
import { publishWithTimeout, LIVE_PUBLISH_TIMEOUT_MS } from '@/lib/chat/send-flow';
import type { LiveMessageIds } from '@/lib/chat/thread';
import type { InFlightGuard } from '@/lib/chat/thread-actions';

/** The one guard key: a share runs at a time per picker, whatever the channel. */
const SHARE_GUARD_KEY = 'share-post';

/** The record input for one shared-post message (no body, one post). */
export interface SharePostRecordInput {
  id: string;
  channelId: string;
  traceId: string;
  body: string;
  attachmentAssetIds: readonly string[];
  sharedPostIds: readonly string[];
}

export interface SharePostDeps {
  /** One share at a time: a double tap records once. */
  guard: InFlightGuard;
  record: (input: SharePostRecordInput) => Promise<SendRecordResult>;
  /** Live publish for the recorded row, or null to skip live delivery. */
  publish: ((liveIds: LiveMessageIds) => Promise<unknown>) | null;
  newMessageId: () => string;
  newTraceId: () => string;
  onPublishFailed: (failure: { error: string; traceId: string; messageId: string }) => void;
  /** Override for tests; defaults to LIVE_PUBLISH_TIMEOUT_MS. */
  publishTimeoutMs?: number;
}

type SharePostResult =
  | { ok: true }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'record'; message: string };

/** Record the shared post, then publish it live when possible. Never throws on a failed publish. */
export async function sharePostToChannel(
  deps: SharePostDeps,
  input: { channelId: string; postId: string },
): Promise<SharePostResult> {
  if (!deps.guard.tryStart(SHARE_GUARD_KEY)) return { ok: false, reason: 'busy' };
  try {
    return await recordThenPublish(deps, input);
  } finally {
    deps.guard.finish(SHARE_GUARD_KEY);
  }
}

async function recordThenPublish(
  deps: SharePostDeps,
  input: { channelId: string; postId: string },
): Promise<SharePostResult> {
  const id = deps.newMessageId();
  const traceId = deps.newTraceId();
  const recorded = await deps.record({
    id,
    channelId: input.channelId,
    traceId,
    body: '',
    attachmentAssetIds: [],
    sharedPostIds: [input.postId],
  });
  if (!recorded.ok) return { ok: false, reason: 'record', message: recorded.message };
  if (deps.publish !== null) {
    const liveIds: LiveMessageIds = {
      sorted_message_id: recorded.row.id,
      sorted_channel_id: input.channelId,
    };
    let published: { ok: true } | { ok: false; error: string };
    try {
      published = await publishWithTimeout(
        deps.publish(liveIds),
        deps.publishTimeoutMs ?? LIVE_PUBLISH_TIMEOUT_MS,
      );
    } catch (error) {
      published = { ok: false, error: String(error) };
    }
    if (!published.ok) {
      deps.onPublishFailed({ error: published.error, traceId, messageId: recorded.row.id });
    }
  }
  return { ok: true };
}
