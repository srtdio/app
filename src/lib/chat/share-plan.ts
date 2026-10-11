// Share one plan into one chat, Postgres first (modelled on share-post.ts): the
// message is recorded through chat_plan_share (via the injected record step,
// idempotent on the message id), and only once the row exists is it published
// over Agora for live delivery. Receivers re-read the row (live verify), so the
// live message carries no plan field. The live publish is optional (null when
// there is no open connection or live target) and never fails the share.
// Pure of React and of the SDK so the contract is unit-tested directly.

import type { Result } from '@srtdio/rpc';
import { publishWithTimeout, LIVE_PUBLISH_TIMEOUT_MS } from '@/lib/chat/send-flow';
import type { ChatMessageRow, LiveMessageIds } from '@/lib/chat/thread';
import type { InFlightGuard } from '@/lib/chat/thread-actions';
import { shareFailureCopy } from '@/lib/chat/plans';

/**
 * Whether a forward lands in the chat that is open: its row then goes into
 * the open thread at once (the thread's own add-row path, which also
 * publishes it live), instead of a separate live publish. Pure.
 */
export function forwardLandsInOpenChat(
  targetChannelId: string,
  openChannelId: string | null,
): boolean {
  return openChannelId !== null && targetChannelId === openChannelId;
}

/** The one guard key: a share runs at a time per picker. */
export const SHARE_PLAN_GUARD_KEY = 'share-plan';

export interface SharePlanRecordInput {
  id: string;
  channelId: string;
  planId: string;
  traceId: string;
}

export interface SharePlanDeps {
  guard: InFlightGuard;
  record: (input: SharePlanRecordInput) => Promise<Result<ChatMessageRow>>;
  /** Live publish for the recorded row, or null to skip live delivery. */
  publish: ((liveIds: LiveMessageIds) => Promise<unknown>) | null;
  newMessageId: () => string;
  newTraceId: () => string;
  onPublishFailed: (failure: { error: string; traceId: string; messageId: string }) => void;
  publishTimeoutMs?: number;
}

export type SharePlanResult =
  | { ok: true; row: ChatMessageRow; traceId: string }
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'record'; message: string; copy: string };

/** Record the plan message, then publish it live when possible. Never throws on a failed publish. */
export async function sharePlanToChannel(
  deps: SharePlanDeps,
  input: { channelId: string; planId: string },
): Promise<SharePlanResult> {
  if (!deps.guard.tryStart(SHARE_PLAN_GUARD_KEY)) return { ok: false, reason: 'busy' };
  try {
    const id = deps.newMessageId();
    const traceId = deps.newTraceId();
    let recorded: Result<ChatMessageRow>;
    try {
      recorded = await deps.record({
        id,
        channelId: input.channelId,
        planId: input.planId,
        traceId,
      });
    } catch (error) {
      recorded = { ok: false, error: { code: 'unknown', message: String(error) } };
    }
    if (!recorded.ok) {
      return {
        ok: false,
        reason: 'record',
        message: recorded.error.message,
        copy: shareFailureCopy(recorded.error.message),
      };
    }
    if (deps.publish !== null) {
      const liveIds: LiveMessageIds = {
        sorted_message_id: recorded.data.id,
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
        deps.onPublishFailed({ error: published.error, traceId, messageId: recorded.data.id });
      }
    }
    return { ok: true, row: recorded.data, traceId };
  } finally {
    deps.guard.finish(SHARE_PLAN_GUARD_KEY);
  }
}

/** The two writes behind "Share with client and send". */
export interface ShareFirstDeps {
  /** plan_share_with_client (idempotent once the plan is a client plan). */
  shareWithClient: (planId: string, traceId: string) => Promise<Result<unknown>>;
  /** chat_plan_share through sharePlanToChannel, carrying this trace id. */
  send: (traceId: string) => Promise<SharePlanResult>;
}

/** How far a "Share with client and send" got; a retry resumes from here. */
export interface ShareFirstProgress {
  clientShared: boolean;
}

export type ShareFirstResult =
  | { ok: true; row: ChatMessageRow; progress: ShareFirstProgress }
  | { ok: false; reason: 'busy'; progress: ShareFirstProgress }
  | { ok: false; reason: 'client' | 'send'; message: string; progress: ShareFirstProgress };

/**
 * Share the plan with the client, then send it into the chat: in sequence,
 * one trace id for both. A step already done is not run again on a retry
 * (the send reuses its message id, so a retry never posts a second card).
 * Never throws.
 */
export async function shareWithClientThenSend(
  deps: ShareFirstDeps,
  input: { planId: string; traceId: string },
  start: ShareFirstProgress,
): Promise<ShareFirstResult> {
  let progress = { ...start };
  if (!progress.clientShared) {
    let shared: Result<unknown>;
    try {
      shared = await deps.shareWithClient(input.planId, input.traceId);
    } catch (error) {
      shared = { ok: false, error: { code: 'unknown', message: String(error) } };
    }
    if (!shared.ok) {
      return { ok: false, reason: 'client', message: shared.error.message, progress };
    }
    progress = { clientShared: true };
  }
  let sent: SharePlanResult;
  try {
    sent = await deps.send(input.traceId);
  } catch (error) {
    return { ok: false, reason: 'send', message: String(error), progress };
  }
  if (sent.ok) return { ok: true, row: sent.row, progress };
  if (sent.reason === 'busy') return { ok: false, reason: 'busy', progress };
  return { ok: false, reason: 'send', message: sent.message, progress };
}
