// "Share with client first?": an Agency only plan going into a chat with a
// client. The sheet says what changes (every client in the workspace can open
// the plan, drafts show by name only, it can't be undone); the primary button
// runs plan_share_with_client then chat_plan_share in sequence with one trace
// id, then tells every open card and screen the plan changed. A failure shows
// "Couldn't share. Try again." inline; a retry skips a step already done and
// reuses the message id, so nothing half-done runs twice. Cancel sends nothing.
// Tokens only; the sheet moves on translateY only.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { chatPlanShare, planShareWithClient } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { IconCheck, IconEdit, IconUsers } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import {
  SHARE_FIRST_CONFIRM,
  SHARE_FIRST_TITLE,
  SHARE_FIRST_UNDO,
  draftCount,
  shareFirstAudience,
  shareFirstDrafts,
  shareFirstRest,
} from '@/components/chat/plan-card';
import { newMessageId } from '@/lib/chat/message-id';
import { PLAN_SHARE_FAILED, dispatchPlanChanged, type PlanBundle } from '@/lib/chat/plans';
import {
  sharePlanToChannel,
  shareWithClientThenSend,
  type ShareFirstProgress,
} from '@/lib/chat/share-plan';
import type { ChatMessageRow, LiveMessageIds } from '@/lib/chat/thread';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

/** The confirm sheet itself: a pure render of the copy and the two buttons. */
export function PlanShareConfirm(props: {
  open: boolean;
  planTitle: string;
  chatName: string;
  group: boolean;
  workspaceName: string;
  drafts: number;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  const drafts = shareFirstDrafts(props.drafts);
  return (
    <Sheet
      open={props.open}
      onClose={props.onCancel}
      title={SHARE_FIRST_TITLE}
      footer={
        <div className="grid w-full gap-2">
          <Button
            size="lg"
            variant="primary"
            data-plan-share-first=""
            onClick={props.onConfirm}
            disabled={props.busy}
            className="min-h-[44px] w-full"
          >
            {SHARE_FIRST_CONFIRM}
          </Button>
          <Button
            size="lg"
            data-plan-share-first-cancel=""
            onClick={props.onCancel}
            disabled={props.busy}
            className="min-h-[44px] w-full"
          >
            Cancel
          </Button>
        </div>
      }
    >
      <div data-plan-share-confirm="" className={cn('flex flex-col gap-3', NO_TOUCH_SELECT)}>
        <p className="text-[15px] leading-[22px] text-fg-2">
          <b className="font-semibold text-fg">{props.planTitle}</b>
          {shareFirstRest(props.chatName, props.group)}
        </p>
        <div className="flex flex-col gap-2 rounded-lg bg-panel-2 p-3 text-sm leading-5 text-fg">
          <p className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-fg-3">
              <IconUsers size={16} />
            </span>
            <span>{shareFirstAudience(props.workspaceName)}</span>
          </p>
          {drafts !== null ? (
            <p data-plan-share-first-drafts="" className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0 text-warn">
                <IconEdit size={16} />
              </span>
              <span>{drafts}</span>
            </p>
          ) : null}
          <p className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-fg-3">
              <IconCheck size={16} />
            </span>
            <span>{SHARE_FIRST_UNDO}</span>
          </p>
        </div>
        {props.error !== null ? (
          <p role="alert" data-plan-share-first-error="" className="text-sm text-bad">
            {props.error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

/** One "Share with client and send" to run: the plan and where it goes. */
export interface ShareFirstRequest {
  bundle: PlanBundle;
  channelId: string;
  chatName: string;
  group: boolean;
  /** Live publish for the recorded row; null when the open thread adds it. */
  publish: ((liveIds: LiveMessageIds) => Promise<unknown>) | null;
}

/**
 * The confirm with its writes. Each request starts clean (one message id and
 * one trace id for it); `onSent` gets the recorded row once both steps landed.
 */
export function ShareFirstFlow(props: {
  request: ShareFirstRequest | null;
  workspaceName: string;
  onCancel: () => void;
  onSent: (row: ChatMessageRow, traceId: string, request: ShareFirstRequest) => void;
}): ReactElement {
  const { request } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guard] = useState(createInFlightGuard);
  const run = useRef<{ messageId: string; traceId: string; progress: ShareFirstProgress } | null>(
    null,
  );
  // The last request shown: the sheet keeps its copy while it slides away.
  const [shown, setShown] = useState<ShareFirstRequest | null>(request);
  useEffect(() => {
    run.current =
      request !== null
        ? {
            messageId: newMessageId(),
            traceId: generateTraceId(),
            progress: { clientShared: false },
          }
        : null;
    setBusy(false);
    setError(null);
    if (request !== null) setShown(request);
  }, [request]);

  const confirm = async (): Promise<void> => {
    const current = run.current;
    if (request === null || current === null || busy) return;
    setBusy(true);
    setError(null);
    const planId = request.bundle.plan.id;
    const result = await shareWithClientThenSend(
      {
        shareWithClient: (id, traceId) =>
          planShareWithClient(supabase, { p_plan_id: id, p_trace_id: traceId }),
        send: (traceId) =>
          sharePlanToChannel(
            {
              guard,
              record: (input) =>
                chatPlanShare(supabase, {
                  p_id: input.id,
                  p_channel_id: input.channelId,
                  p_plan_id: input.planId,
                  p_trace_id: input.traceId,
                }),
              publish: request.publish,
              newMessageId: () => current.messageId,
              newTraceId: () => traceId,
              onPublishFailed: (failure) =>
                logger.warn('chat: shared plan live publish did not complete', {
                  trace_id: failure.traceId,
                  message_id: failure.messageId,
                  error: failure.error,
                }),
            },
            { channelId: request.channelId, planId },
          ),
      },
      { planId, traceId: current.traceId },
      current.progress,
    );
    // A request replaced or cancelled meanwhile keeps nothing of this run.
    if (run.current !== current) return;
    current.progress = result.progress;
    if (result.progress.clientShared) dispatchPlanChanged(window, planId);
    if (!result.ok && result.reason === 'busy') return;
    setBusy(false);
    if (result.ok) {
      props.onSent(result.row, current.traceId, request);
      return;
    }
    logger.warn('chat: share with client and send failed', {
      trace_id: current.traceId,
      plan_id: planId,
      channel_id: request.channelId,
      step: result.reason,
      error: result.message,
    });
    setError(PLAN_SHARE_FAILED);
  };

  const view = request ?? shown;
  return (
    <PlanShareConfirm
      open={request !== null}
      planTitle={view?.bundle.plan.title ?? ''}
      chatName={view?.chatName ?? ''}
      group={view?.group ?? false}
      workspaceName={props.workspaceName}
      drafts={view !== null ? draftCount(view.bundle) : 0}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onCancel={() => {
        if (!busy) props.onCancel();
      }}
    />
  );
}
