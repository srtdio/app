// "Open this plan for approvers?": a Draft plan sent into a chat with the
// client in it (chat_plan_share refused with plan_not_shared_with_client, or
// the Forward picker knew the chat has a client). Open and send runs
// plan_share_with_client, then chat_plan_share again with the same message
// id (idempotent). Opening a plan cannot be undone, so the sheet asks first;
// Cancel sends nothing. Used by the plan card's Forward (PlanCard.tsx) and
// the Plan screen's send into its chat (PlanScreen.tsx).

import type { ReactElement } from 'react';
import { chatPlanShare, planShareWithClient, type Result } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { dispatchPlanChanged } from '@/lib/chat/plans';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

export interface PlanOpenSendAsk {
  planId: string;
  planTitle: string;
  channelId: string;
  chatName: string;
}

export const PLAN_OPEN_SEND_TITLE = 'Open this plan for approvers?';

/** The sheet's line. Pure. */
export function planOpenSendLine(planTitle: string, chatName: string): string {
  return `${planTitle} is a Draft. Sending it in ${chatName} opens it for approvers: they see every item in it.`;
}

/** Whether a chat_plan_share failure is the Draft-into-a-client-chat refusal. Pure. */
export function isPlanNotSharedWithClient(message: string): boolean {
  return message.includes('plan_not_shared_with_client');
}

/**
 * Open the plan for approvers (plan_share_with_client), then share it into
 * the chat with this message id (chat_plan_share; idempotent on the id).
 * Never throws.
 */
export async function openPlanThenShare(input: {
  planId: string;
  channelId: string;
  messageId: string;
}): Promise<Result<ChatMessageRow>> {
  try {
    const opened = await planShareWithClient(supabase, {
      p_plan_id: input.planId,
      p_trace_id: generateTraceId(),
    });
    if (!opened.ok) return opened;
    dispatchPlanChanged(window, input.planId);
    const shared = await chatPlanShare(supabase, {
      p_id: input.messageId,
      p_channel_id: input.channelId,
      p_plan_id: input.planId,
      p_trace_id: generateTraceId(),
    });
    if (!shared.ok) return shared;
    return { ok: true, data: shared.data as unknown as ChatMessageRow };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

export function PlanOpenSendSheet(props: {
  ask: PlanOpenSendAsk | null;
  busy?: boolean;
  onClose: () => void;
  onOpenAndSend: (ask: PlanOpenSendAsk) => void;
}): ReactElement {
  const ask = props.ask;
  return (
    <Sheet
      open={ask !== null}
      onClose={props.onClose}
      title={PLAN_OPEN_SEND_TITLE}
      busy={props.busy === true}
      footer={
        <div className="grid w-full grid-cols-2 gap-2 md:flex md:justify-end">
          <Button variant="ghost" type="button" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            data-plan-open-send-go=""
            onClick={() => {
              if (ask !== null) props.onOpenAndSend(ask);
            }}
          >
            Open and send
          </Button>
        </div>
      }
    >
      <p data-plan-open-send="" className="p-4 text-base text-fg">
        {ask !== null ? planOpenSendLine(ask.planTitle, ask.chatName) : ''}
      </p>
    </Sheet>
  );
}
