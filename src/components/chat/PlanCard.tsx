// The plan shared into a message, as a card (modelled on BriefCard): eyebrow
// PLAN, title, the date range in mono, count chips ("Team only" on a team
// plan), the client's approval progress, and a footer with Open plan (and
// Forward for a client on a client plan). Ids resolve through the thread's
// plan card cache (PlanCardsProvider), so every plan across the loaded thread
// comes back in one batch, never one read per bubble. A plan the viewer cannot
// read (RLS) renders the neutral "not visible" box with "Plan not available";
// a read that failed keeps the skeleton and is re-read, then shows "Couldn't
// load" with a tap to retry. The card waits for the viewer's side before its
// first paint, so the footer never flips. Tokens only (light and dark parity).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { IconPlan } from '@/components/ui/icons';
import { CouldntLoadCard, SHARED_CARD } from '@/components/chat/PostCard';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import {
  PLAN_EYEBROW,
  PLAN_NOT_AVAILABLE,
  canForwardPlan,
  forwardedToast,
  planChips,
  planProgress,
  planRangeLabel,
  progressLabel,
  progressPercent,
} from '@/components/chat/plan-card';
import { conversationPickerBody, type LoadState } from '@/components/pages/pcs/ConversationPicker';
import { useChat } from '@/lib/chat';
import { listChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';
import { createTextMessage } from '@/lib/chat/message-factory';
import { newMessageId } from '@/lib/chat/message-id';
import type { PlanBundle } from '@/lib/chat/plans';
import { forwardLandsInOpenChat, sharePlanToChannel } from '@/lib/chat/share-plan';
import {
  sendText,
  targetFromSummary,
  type ChannelTarget,
  type ThreadConnection,
} from '@/lib/chat/thread';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';
import { chatPlanShare } from '@srtdio/rpc';

/** What one card shows. */
export type PlanCardView = { kind: 'plan'; bundle: PlanBundle } | { kind: 'unavailable' };

/** The plan card frame (same width as the prototype's card, tokens only). */
export const PLAN_CARD =
  'flex w-[284px] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-panel text-left';

/** A loading plan card: the height of a card with one title line. */
export const PLAN_CARD_SKELETON =
  'h-[214px] w-[284px] max-w-full rounded-lg border border-border bg-panel-2';

const NO_SUBSCRIBE = (): (() => void) => () => {};
const NO_VERSION = (): number => 0;

/** The plan cards of one message. */
export function SharedPlanCards(props: { planIds: string[]; senderName: string }): ReactElement {
  const ctx = usePlanCards();
  const cache = ctx?.cache ?? null;
  const { workspaceId } = useWorkspace();
  const { side, ready } = useViewerSide(workspaceId);
  const key = props.planIds.join(',');
  const idsRef = useRef(props.planIds);
  idsRef.current = props.planIds;
  useEffect(() => {
    if (idsRef.current.length > 0) cache?.request(idsRef.current);
  }, [cache, key]);
  const version = useSyncExternalStore(
    cache?.subscribe ?? NO_SUBSCRIBE,
    cache?.version ?? NO_VERSION,
  );
  const snapshot = useMemo(
    () =>
      cache !== null
        ? cache.snapshot(props.planIds)
        : { loading: false, bundles: new Map<string, PlanBundle>(), failed: [] },
    // Keyed by the ids and the cache version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cache, key, version],
  );
  if (props.planIds.length === 0) return <></>;
  if (snapshot.loading || !ready) {
    return (
      <div className="mt-1.5 flex flex-col items-start gap-1.5">
        {props.planIds.map((id) => (
          <div key={id} data-plan-skeleton="" className={`${PLAN_CARD_SKELETON} animate-pulse`} />
        ))}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {props.planIds.map((id) => {
        if (snapshot.failed.includes(id)) {
          return <CouldntLoadCard key={id} onRetry={() => cache?.retry([id])} />;
        }
        const bundle = snapshot.bundles.get(id);
        return (
          <PlanCardItem
            key={id}
            view={bundle !== undefined ? { kind: 'plan', bundle } : { kind: 'unavailable' }}
            side={side}
            onOpen={() => ctx?.openPlan({ planId: id, senderName: props.senderName })}
          />
        );
      })}
    </div>
  );
}

/** One card plus its Forward sheet. */
function PlanCardItem(props: {
  view: PlanCardView;
  side: ViewerSide;
  onOpen: () => void;
}): ReactElement {
  const [forwardOpen, setForwardOpen] = useState(false);
  const planId = props.view.kind === 'plan' ? props.view.bundle.plan.id : null;
  return (
    <>
      <PlanCardBody
        view={props.view}
        side={props.side}
        onOpen={props.onOpen}
        onForward={() => setForwardOpen(true)}
      />
      {planId !== null ? (
        <PlanForwardSheet
          open={forwardOpen}
          planId={planId}
          onClose={() => setForwardOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The card itself: a pure render (no reads), so both sides are tested statically. */
export function PlanCardBody(props: {
  view: PlanCardView;
  side: ViewerSide;
  onOpen: () => void;
  onForward: () => void;
}): ReactElement {
  if (props.view.kind === 'unavailable') {
    return (
      <div data-plan-card="unavailable" className={cn(SHARED_CARD, 'bg-panel-2 text-fg-2')}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
          <IconPlan size={18} />
        </span>
        <span className="truncate text-sm font-medium">{PLAN_NOT_AVAILABLE}</span>
      </div>
    );
  }
  const { bundle } = props.view;
  const progress = planProgress(bundle);
  const forward = canForwardPlan(props.side, bundle.plan.audience);
  return (
    <div data-plan-card={bundle.plan.id} className={PLAN_CARD}>
      <div className="flex flex-col gap-2 px-3.5 pb-2.5 pt-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-accent">
          <IconPlan size={16} />
          {PLAN_EYEBROW}
        </span>
        <span className="text-[17px] font-semibold leading-[22px] text-fg">
          {bundle.plan.title}
        </span>
        <span data-plan-range="" className="font-mono text-[13px] text-fg-3">
          {planRangeLabel(bundle.plan.starts_on, bundle.plan.ends_on)}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {planChips(bundle).map((chip) => (
            <span
              key={chip.label}
              data-plan-chip={chip.tone}
              className={cn(
                'inline-flex min-h-[24px] items-center rounded-md border px-2 text-[13px]',
                chip.tone === 'warn'
                  ? 'border-warn bg-warn-soft text-warn'
                  : 'border-transparent bg-panel-2 text-fg-2',
              )}
            >
              {chip.label}
            </span>
          ))}
        </span>
        <span
          role="progressbar"
          aria-label="Approved by client"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.approved}
          className="block h-1.5 overflow-hidden rounded-full bg-panel-3"
        >
          <span
            className="block h-1.5 bg-good"
            style={{ width: `${progressPercent(progress)}%` }}
          />
        </span>
        <span data-plan-progress="" className="text-xs text-fg-3">
          {progressLabel(progress)}
        </span>
      </div>
      <div className="flex border-t border-border">
        <button
          type="button"
          data-plan-open=""
          onClick={props.onOpen}
          className="min-h-[48px] flex-1 text-[15px] font-semibold text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Open plan
        </button>
        {forward ? (
          <button
            type="button"
            data-plan-forward=""
            onClick={props.onForward}
            className="min-h-[48px] flex-1 border-l border-border text-[15px] font-semibold text-accent hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Forward
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Forward: pick one of my chats and share the plan into it with a fresh
 * message id (chat_plan_share), then publish it live when connected. The list
 * is the Chat page's own read; the body keeps one fixed height in every state.
 */
function PlanForwardSheet(props: {
  open: boolean;
  planId: string;
  onClose: () => void;
}): ReactElement {
  const { client } = useChat();
  const { workspaceId } = useWorkspace();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const toast = useToast();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [guard] = useState(createInFlightGuard);
  const planCards = usePlanCards();
  const open = props.open;

  useEffect(() => {
    if (!open || workspaceId === null || userId === null) return;
    let cancelled = false;
    setLoad({ status: 'loading' });
    void listChannelSummaries(supabase, { workspaceId, currentUserId: userId }).then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { status: 'ready', channels: result.data.filter((c) => c.channelType !== 'notes') }
          : { status: 'error' },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, userId]);

  async function forward(channel: ChannelSummary): Promise<void> {
    let target: ChannelTarget | null = null;
    try {
      target = targetFromSummary(channel);
    } catch {
      target = null;
    }
    const connection = client;
    // Into the open chat: the thread adds (and publishes) the row itself.
    const here =
      planCards !== null && forwardLandsInOpenChat(channel.channelId, planCards.channelId);
    const result = await sharePlanToChannel(
      {
        guard,
        record: (input) => {
          setSendingId(channel.channelId);
          return chatPlanShare(supabase, {
            p_id: input.id,
            p_channel_id: input.channelId,
            p_plan_id: input.planId,
            p_trace_id: input.traceId,
          });
        },
        publish:
          !here && connection !== null && target !== null
            ? (liveIds) =>
                sendText({
                  connection: connection as ThreadConnection,
                  target: target as ChannelTarget,
                  text: '',
                  attachments: [],
                  sharedPostIds: [],
                  reply: null,
                  createMessage: createTextMessage,
                  liveIds,
                })
            : null,
        newMessageId,
        newTraceId: generateTraceId,
        onPublishFailed: ({ error, traceId, messageId }) =>
          logger.warn('chat: forwarded plan live publish did not complete', {
            trace_id: traceId,
            message_id: messageId,
            error,
          }),
      },
      { channelId: channel.channelId, planId: props.planId },
    );
    if (!result.ok && result.reason === 'busy') return;
    setSendingId(null);
    if (result.ok) {
      if (here) planCards?.addRowHere(result.row, result.traceId);
      toast.show({ title: forwardedToast(channel.title) });
      props.onClose();
      return;
    }
    logger.error('chat: plan forward failed', {
      channel_id: channel.channelId,
      plan_id: props.planId,
      error: result.message,
    });
    toast.show({ title: result.copy });
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Forward plan">
      {conversationPickerBody(load, sendingId, (channel) => void forward(channel))}
    </Sheet>
  );
}
