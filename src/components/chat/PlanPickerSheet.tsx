// "Share a plan", the agency's Plan tile: this workspace's upcoming plans
// (not deleted, ending today or later in the workspace zone, ending soonest
// first, at most 100), one plans select then their bundles through the batched
// plan reads, never one read per plan. Each row: the plan icon, title, date
// range in mono, chips (concepts, posts, "Agency only", "In this chat") and a
// chevron; the last row opens the New plan screen. A tap sends the plan into
// this chat at once (a fresh card, even when it is already here), except an
// Agency only plan in a chat with a client, which asks "Share with client
// first?" (also when the server refuses it for that reason). The body keeps
// one fixed height in every state: a skeleton until the read settles, so the
// list never reorders or shortens. Tokens only; translateY motion only.

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { chatPlanShare } from '@srtdio/rpc';
import { Sheet } from '@/components/ui/Sheet';
import { IconChevronRight, IconPlan, IconPlus } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { useScreenRead } from '@/components/chat/PlanScreen';
import { ShareFirstFlow, type ShareFirstRequest } from '@/components/chat/PlanShareConfirm';
import {
  pickerChips,
  planRangeLabel,
  planShareDecision,
  todayInZone,
  type PlanChip,
} from '@/components/chat/plan-card';
import { newMessageId } from '@/lib/chat/message-id';
import {
  PLAN_SHARE_FAILED,
  readUpcomingPlans,
  refusedForClient,
  type PlanBundle,
} from '@/lib/chat/plans';
import { sharePlanToChannel } from '@/lib/chat/share-plan';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

export const PICKER_TITLE = 'Share a plan';
export const PICKER_EMPTY = 'No upcoming plans';
export const PICKER_EMPTY_SUB = "Plans that have ended don't show here.";
export const NEW_PLAN_LABEL = 'New plan';

/** The list's fixed height in every state (loading, list, empty, error). */
const BODY_BOX = 'flex h-[min(420px,56vh)] flex-col overflow-y-auto overscroll-contain';

/** Skeleton rows while the list loads: enough to fill the fixed body. */
const SKELETON_ROWS = 5;

const CHIP_TONES: Record<PlanChip['tone'], string> = {
  neutral: 'bg-panel-2 text-fg-2',
  warn: 'border-warn bg-warn-soft text-warn',
  accent: 'bg-accent-soft text-accent',
};

/** The upcoming plans in list order, and whether each is already in this chat. Pure. */
export function pickerRows(
  plans: readonly PlanBundle[],
  inChat: ReadonlySet<string>,
): Array<{ bundle: PlanBundle; chips: PlanChip[] }> {
  return plans.map((bundle) => ({
    bundle,
    chips: pickerChips(bundle, inChat.has(bundle.plan.id)),
  }));
}

export function PlanPickerSheet(props: {
  open: boolean;
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  chatName: string;
  group: boolean;
  timeZone: string;
  /** A client among the chat's members; null while unknown. */
  hasClient: boolean | null;
  /** Plans this chat already holds a card for (loaded thread and ticker). */
  inChatPlanIds: readonly string[];
  onClose: () => void;
  onNewPlan: () => void;
  /** A plan card was recorded into this chat. */
  onSent: (row: ChatMessageRow, traceId: string) => void;
}): ReactElement {
  const { workspaceId, timeZone } = props;
  // Fixed per open: the day the list was asked for.
  const today = useMemo(
    () => todayInZone(new Date(), timeZone),
    // A new day starts with the next open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.open, timeZone],
  );
  const { read, reload } = useScreenRead<PlanBundle[]>(
    props.open,
    `${workspaceId}:${today}`,
    (signal) => readUpcomingPlans(supabase, workspaceId, today, signal),
  );
  const [guard] = useState(createInFlightGuard);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ShareFirstRequest | null>(null);
  const inChat = useMemo(() => new Set(props.inChatPlanIds), [props.inChatPlanIds]);
  // Another chat drops a confirm asked for this one.
  useEffect(() => setConfirm(null), [props.channelId]);

  const close = (): void => {
    setError(null);
    props.onClose();
  };

  const askFirst = (bundle: PlanBundle): void => {
    setError(null);
    setConfirm({
      bundle,
      channelId: props.channelId,
      chatName: props.chatName,
      group: props.group,
      // The open thread adds and publishes the row itself.
      publish: null,
    });
    props.onClose();
  };

  const choose = async (bundle: PlanBundle): Promise<void> => {
    if (planShareDecision(bundle.plan.audience, props.hasClient) === 'confirm') {
      askFirst(bundle);
      return;
    }
    setError(null);
    const result = await sharePlanToChannel(
      {
        guard,
        record: (input) => {
          setSendingId(bundle.plan.id);
          return chatPlanShare(supabase, {
            p_id: input.id,
            p_channel_id: input.channelId,
            p_plan_id: input.planId,
            p_trace_id: input.traceId,
          });
        },
        publish: null,
        newMessageId,
        newTraceId: generateTraceId,
        onPublishFailed: () => {},
      },
      { channelId: props.channelId, planId: bundle.plan.id },
    );
    if (!result.ok && result.reason === 'busy') return;
    setSendingId(null);
    if (result.ok) {
      props.onSent(result.row, result.traceId);
      close();
      return;
    }
    if (refusedForClient(result.message)) {
      askFirst(bundle);
      return;
    }
    logger.warn('chat: plan share from the Plan tile failed', {
      channel_id: props.channelId,
      plan_id: bundle.plan.id,
      error: result.message,
    });
    setError(PLAN_SHARE_FAILED);
  };

  return (
    <>
      <Sheet open={props.open} onClose={close} title={PICKER_TITLE}>
        <div data-plan-picker="" className={cn('-mx-[18px] -my-4', NO_TOUCH_SELECT)}>
          <p className="px-[18px] pb-1 pt-3 text-xs leading-4 text-fg-3">
            Upcoming plans in {props.workspaceName}
          </p>
          {error !== null ? (
            <p role="alert" data-plan-picker-error="" className="px-[18px] pt-1 text-sm text-bad">
              {error}
            </p>
          ) : null}
          <div className={BODY_BOX}>
            {read.status === 'loading' ? (
              <div role="status" aria-busy="true" aria-label="Loading plans" className="px-[18px]">
                {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
                  <PickerSkeletonRow key={i} />
                ))}
              </div>
            ) : read.status === 'error' ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-[18px] text-center">
                <p className="text-sm text-fg-2">Couldn&apos;t load. Try again.</p>
                <button
                  type="button"
                  onClick={reload}
                  className="min-h-[44px] rounded-lg px-4 text-[15px] font-semibold text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Retry
                </button>
              </div>
            ) : (
              <div className="flex flex-col px-[18px] pb-4">
                {read.data.length === 0 ? (
                  <div data-plan-picker-empty="" className="pb-4 pt-6 text-center">
                    <p className="text-sm leading-5 text-fg-2">{PICKER_EMPTY}</p>
                    <p className="mt-1 text-xs text-fg-3">{PICKER_EMPTY_SUB}</p>
                  </div>
                ) : (
                  pickerRows(read.data, inChat).map(({ bundle, chips }) => (
                    <button
                      key={bundle.plan.id}
                      type="button"
                      data-plan-pick={bundle.plan.id}
                      disabled={sendingId !== null}
                      onClick={() => void choose(bundle)}
                      className="flex min-h-[72px] w-full items-center gap-3 border-b border-border py-3 text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                        <IconPlan size={20} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-[15px] font-semibold leading-5 text-fg">
                          {bundle.plan.title}
                        </span>
                        <span className="font-mono text-xs leading-4 text-fg-3">
                          {sendingId === bundle.plan.id
                            ? 'Sending'
                            : planRangeLabel(bundle.plan.starts_on, bundle.plan.ends_on)}
                        </span>
                        <span className="flex flex-wrap gap-1">
                          {chips.map((chip) => (
                            <span
                              key={chip.label}
                              data-plan-chip={chip.tone}
                              className={cn(
                                'inline-flex min-h-[20px] items-center rounded-md border border-transparent px-1.5 text-[11px]',
                                CHIP_TONES[chip.tone],
                              )}
                            >
                              {chip.label}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="shrink-0 text-fg-3">
                        <IconChevronRight />
                      </span>
                    </button>
                  ))
                )}
                <button
                  type="button"
                  data-plan-pick-new=""
                  disabled={sendingId !== null}
                  onClick={() => {
                    close();
                    props.onNewPlan();
                  }}
                  className="flex min-h-[48px] w-full items-center gap-3 py-2 text-left text-[15px] font-semibold text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-panel-2">
                    <IconPlus size={20} />
                  </span>
                  <span className="flex-1">{NEW_PLAN_LABEL}</span>
                  <span className="shrink-0 text-fg-3">
                    <IconChevronRight />
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </Sheet>
      <ShareFirstFlow
        request={confirm}
        workspaceName={props.workspaceName}
        onCancel={() => setConfirm(null)}
        onSent={(row, traceId) => {
          setConfirm(null);
          props.onSent(row, traceId);
        }}
      />
    </>
  );
}

/** A placeholder with a plan row's box, so the rows swap in without a shift. */
function PickerSkeletonRow(): ReactElement {
  return (
    <div
      data-plan-pick-skeleton=""
      className="flex min-h-[72px] w-full items-center gap-3 border-b border-border py-3"
    >
      <span className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-panel-2" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="h-5 w-40 animate-pulse rounded bg-panel-2" />
        <span className="h-4 w-24 animate-pulse rounded bg-panel-2" />
        <span className="h-5 w-32 animate-pulse rounded bg-panel-2" />
      </span>
    </div>
  );
}
