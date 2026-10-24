// The plan shared into a message, as a card (modelled on BriefCard): eyebrow
// PLAN, title, the date range in mono, count chips ("Draft" on a Draft plan),
// the shown side's progress (Draft "Team X of N", Open "Client X of N", the
// same for every viewer), and a footer with Open plan (and Forward: the agency
// on every plan, a client on an Open plan). Forwarding a Draft plan into a
// chat with a client sends nothing and says "Open the plan for client first."
// (when the chat is known to have one, or when the server refuses it for that
// reason). Ids resolve through the thread's
// plan card cache (PlanCardsProvider), so every plan across the loaded thread
// comes back in one batch, never one read per bubble. A plan the viewer can no
// longer read (deleted, RLS) renders the neutral box with "Plan deleted";
// a read that failed keeps the skeleton and is re-read, then shows "Couldn't
// load" with a tap to retry. The card waits for the viewer's side and its whole
// bundle (plan, items, reviews, post stages, draft rows) before its first
// paint, at the skeleton's exact height, so it paints once and the footer never
// flips. Tokens only (light and dark parity).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { IconChat, IconPlan } from '@/components/ui/icons';
import { CouldntLoadCard, SHARED_CARD } from '@/components/chat/PostCard';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import { usePaintLogCommit } from '@/components/chat/PaintLog';
import {
  HAS_CLIENT_TAG,
  OPEN_FOR_CLIENT_FIRST,
  PLAN_DELETED,
  PLAN_EYEBROW,
  canForwardPlan,
  forwardBlocked,
  forwardedToast,
  planChips,
  planProgress,
  planRangeLabel,
  progressLabel,
  progressPercent,
  summaryHasClient,
} from '@/components/chat/plan-card';
import { conversationPickerBody, type LoadState } from '@/components/pages/pcs/ConversationPicker';
import { useChat } from '@/lib/chat';
import { listChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';
import { createTextMessage } from '@/lib/chat/message-factory';
import { newMessageId } from '@/lib/chat/message-id';
import { refusedForClient, type PlanBundle } from '@/lib/chat/plans';
import { forwardLandsInOpenChat, sharePlanToChannel } from '@/lib/chat/share-plan';
import {
  sendText,
  targetFromSummary,
  type ChannelTarget,
  type ChatMessageRow,
  type LiveMessageIds,
  type ThreadConnection,
} from '@/lib/chat/thread';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { cn } from '@/lib/cn';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';
import { chatPlanShare } from '@srtdio/rpc';

/** What one card shows. */
export type PlanCardView = { kind: 'plan'; bundle: PlanBundle } | { kind: 'unavailable' };

/**
 * The plan card frame (same width as the prototype's card, tokens only). Its
 * height is fixed and every line inside is one line (explicit line heights,
 * truncated text, chips that never wrap), so the card is always exactly the
 * skeleton's height: the swap from skeleton to card never moves the thread.
 */
export const PLAN_CARD =
  'flex h-[217px] w-[284px] max-w-full flex-col overflow-hidden rounded-lg border border-border bg-panel text-left';

/** A loading plan card: exactly the card's height. */
export const PLAN_CARD_SKELETON =
  'h-[217px] w-[284px] max-w-full rounded-lg border border-border bg-panel-2';

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
  const skeleton = snapshot.loading || !ready;
  // ?paintlog=1 only: this message's cards, every mount, unmount and commit.
  usePaintLogCommit(
    `plan cards ${key}`,
    skeleton ? `skeleton (loading ${snapshot.loading}, side ready ${ready})` : `cards v${version}`,
  );
  if (props.planIds.length === 0) return <></>;
  if (skeleton) {
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
  const bundle = props.view.kind === 'plan' ? props.view.bundle : null;
  usePaintLogCommit(`plan card ${bundle?.plan.id ?? 'unavailable'}`, props.side);
  return (
    <>
      <PlanCardBody
        view={props.view}
        side={props.side}
        onOpen={props.onOpen}
        onForward={() => setForwardOpen(true)}
      />
      {bundle !== null ? (
        <PlanForwardSheet
          open={forwardOpen}
          bundle={bundle}
          side={props.side}
          onClose={() => setForwardOpen(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The card's top lines: the PLAN eyebrow, the title and the mono date range.
 * The title stays on one line (the chat card keeps its skeleton's height);
 * `wrapTitle` lets it wrap to two lines, then end on an ellipsis.
 */
export function PlanCardTop(props: {
  plan: Pick<PlanBundle['plan'], 'title' | 'starts_on' | 'ends_on'>;
  wrapTitle?: boolean;
}): ReactElement {
  return (
    <>
      <span className="flex h-4 items-center gap-1.5 text-xs font-semibold leading-4 tracking-wide text-accent">
        <IconPlan size={16} />
        {PLAN_EYEBROW}
      </span>
      <span
        data-plan-title=""
        className={cn(
          'text-[17px] font-semibold leading-[22px] text-fg',
          props.wrapTitle === true ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'truncate',
        )}
      >
        {props.plan.title}
      </span>
      <span data-plan-range="" className="truncate font-mono text-[13px] leading-5 text-fg-3">
        {planRangeLabel(props.plan.starts_on, props.plan.ends_on)}
      </span>
    </>
  );
}

/** The card's progress bar: the team side's fill in accent, the client side's in good. */
export function PlanCardBar(props: {
  label: string;
  value: number;
  max: number;
  percent: number;
  side: 'team' | 'client';
}): ReactElement {
  return (
    <span
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      className="block h-1.5 overflow-hidden rounded-full bg-panel-3"
    >
      <span
        data-plan-card-bar={props.side}
        className={cn('block h-1.5', props.side === 'team' ? 'bg-accent' : 'bg-good')}
        style={{ width: `${props.percent}%` }}
      />
    </span>
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
        <span className="truncate text-sm font-medium">{PLAN_DELETED}</span>
      </div>
    );
  }
  const { bundle } = props.view;
  const progress = planProgress(bundle);
  const forward = canForwardPlan(props.side, bundle.plan.audience);
  const draft = progress.side === 'team';
  return (
    <div data-plan-card={bundle.plan.id} className={PLAN_CARD}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3.5 pb-2.5 pt-3">
        <PlanCardTop plan={bundle.plan} />
        <span className="flex h-6 gap-1.5 overflow-hidden">
          {planChips(bundle).map((chip) => (
            <span
              key={chip.label}
              data-plan-chip={chip.tone}
              className={cn(
                'inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-md border px-2 text-[13px]',
                chip.tone === 'warn'
                  ? 'border-warn bg-warn-soft text-warn'
                  : 'border-transparent bg-panel-2 text-fg-2',
              )}
            >
              {chip.label}
            </span>
          ))}
        </span>
        <PlanCardBar
          label={draft ? 'Checked by creators' : 'Approved'}
          value={draft ? progress.teamApproved : progress.approved}
          max={progress.total}
          percent={progressPercent(progress)}
          side={draft ? 'team' : 'client'}
        />
        <span data-plan-progress="" className="truncate text-xs leading-4 text-fg-3">
          {progressLabel(progress)}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-t border-border p-1">
        <Button
          type="button"
          variant="link"
          data-plan-open=""
          data-induction={INDUCTION_KEYS.briefOpenPlan}
          onClick={props.onOpen}
          className="flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Open plan
        </Button>
        {forward ? (
          <>
            <span aria-hidden="true" className="h-6 w-px shrink-0 bg-border" />
            <Button
              type="button"
              variant="link"
              data-plan-forward=""
              onClick={props.onForward}
              className="flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Forward
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Forward: pick one of my chats and share the plan into it with a fresh
 * message id (chat_plan_share), then publish it live when connected. The list
 * is the Chat page's own read; the body keeps one fixed height in every state.
 * A Draft plan gets a "Has client" tag on chats known to have a client (a DM
 * with a client); picking one, or one the server refuses for that reason,
 * sends nothing and toasts "Open the plan for client first." No read per chat.
 */
function PlanForwardSheet(props: {
  open: boolean;
  bundle: PlanBundle;
  side: ViewerSide;
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
  const planId = props.bundle.plan.id;
  const agencyOnly = props.bundle.plan.audience === 'team';

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

  /** The live publish for a forward: none into the open chat (the thread adds it) or offline. */
  function publishOf(
    channel: ChannelSummary,
  ): ((liveIds: LiveMessageIds) => Promise<unknown>) | null {
    let target: ChannelTarget | null = null;
    try {
      target = targetFromSummary(channel);
    } catch {
      target = null;
    }
    const connection = client;
    const here =
      planCards !== null && forwardLandsInOpenChat(channel.channelId, planCards.channelId);
    return !here && connection !== null && target !== null
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
      : null;
  }

  function landed(
    channel: { channelId: string; title: string },
    row: ChatMessageRow,
    traceId: string,
  ): void {
    if (planCards !== null && forwardLandsInOpenChat(channel.channelId, planCards.channelId)) {
      planCards.addRowHere(row, traceId);
    }
    toast.show({ title: forwardedToast(channel.title) });
  }

  function openFirst(): void {
    toast.show({ title: OPEN_FOR_CLIENT_FIRST });
  }

  async function forward(channel: ChannelSummary): Promise<void> {
    if (forwardBlocked(props.bundle.plan.audience, summaryHasClient(channel))) {
      openFirst();
      return;
    }
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
        publish: publishOf(channel),
        newMessageId,
        newTraceId: generateTraceId,
        onPublishFailed: ({ error, traceId, messageId }) =>
          logger.warn('chat: forwarded plan live publish did not complete', {
            trace_id: traceId,
            message_id: messageId,
            error,
          }),
      },
      { channelId: channel.channelId, planId },
    );
    if (!result.ok && result.reason === 'busy') return;
    setSendingId(null);
    if (result.ok) {
      landed(channel, result.row, result.traceId);
      props.onClose();
      return;
    }
    if (refusedForClient(result.message)) {
      openFirst();
      return;
    }
    logger.error('chat: plan forward failed', {
      channel_id: channel.channelId,
      plan_id: planId,
      error: result.message,
    });
    toast.show({ title: result.copy });
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Forward plan">
      {load.status === 'ready' && load.channels.length > 0
        ? forwardList(load.channels, sendingId, agencyOnly, (channel) => void forward(channel))
        : conversationPickerBody(load, sendingId, (channel) => void forward(channel))}
    </Sheet>
  );
}

/**
 * The Forward list: the conversation picker's rows (same box, same fixed body
 * height), with "Has client" on chats known to have a client when the plan is
 * a Draft. Hook-free.
 */
function forwardList(
  channels: readonly ChannelSummary[],
  sendingId: string | null,
  agencyOnly: boolean,
  onPick: (channel: ChannelSummary) => void,
): ReactElement {
  return (
    <div className="h-[288px] overflow-y-auto">
      <div className={cn('flex flex-col gap-1', NO_TOUCH_SELECT)}>
        {channels.map((channel) => (
          <button
            key={channel.channelId}
            type="button"
            data-plan-forward-target={channel.channelId}
            onClick={() => onPick(channel)}
            className="flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-fg transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className="flex shrink-0 items-center justify-center text-fg-2">
              <IconChat size={18} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium leading-snug">{channel.title}</span>
              <span className="truncate text-xs leading-snug text-fg-3">
                {sendingId === channel.channelId
                  ? 'Sending'
                  : channel.channelType === 'group'
                    ? 'Group'
                    : 'Direct message'}
              </span>
            </span>
            {agencyOnly && summaryHasClient(channel) === true ? (
              <span
                data-plan-has-client=""
                className="shrink-0 whitespace-nowrap rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-semibold leading-4 text-warn"
              >
                {HAS_CLIENT_TAG}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
