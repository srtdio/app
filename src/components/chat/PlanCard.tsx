// The plan shared into a message, as a ui/ChatCard (the card is the bubble,
// like BriefCard): the plan glyph and title, the date range in mono, count
// chips ("Draft" on a Draft plan), the shown side's progress (Draft "Team X of
// N", Open "Client X of N", the same for every viewer), and the action row:
// Forward left (the agency on every plan, a client on an Open plan), Open plan
// right. Forwarding a Draft plan into a
// chat with a client (known from the list, or refused by the server for that
// reason) asks "Open this plan for approvers?" first (PlanOpenSendSheet: Open
// and send opens the plan, then shares it). Ids resolve through the thread's
// plan card cache (PlanCardsProvider), so every plan across the loaded thread
// comes back in one batch, never one read per bubble. A plan the viewer can no
// longer read (deleted, RLS) renders the neutral box with "Plan deleted";
// a read that failed keeps the skeleton and is re-read, then shows "Couldn't
// load" with a tap to retry. The read starts once the chat bundle returns, or
// at a tap on the waiting card if that comes first. The card waits for the viewer's side and its whole
// bundle (plan, items, reviews, post stages, draft rows) before its first
// paint, at the skeleton's exact height, so it paints once and the footer never
// flips. Tokens only (light and dark parity).

import { Bone } from '@/lib/motion';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { ICON_SIZE, IconChat, IconPlan } from '@/components/ui/icons';
import {
  CouldntLoadCard,
  cardGroupClass,
  metaForLast,
  type CardPlacement,
} from '@/components/chat/PostCard';
import { ChatCard } from '@/components/ui/ChatCard';
import { SECTION_LABEL_INK, textRole } from '@/components/ui/Text';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import { usePaintLogCommit } from '@/components/chat/PaintLog';
import {
  HAS_CLIENT_TAG,
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
import {
  PlanOpenSendSheet,
  openPlanThenShare,
  type PlanOpenSendAsk,
} from '@/components/chat/PlanOpenSendSheet';
import { errorText } from '@/lib/error-copy';
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

/** The plan card's rows under line 2: the count chips, the bar and the progress line. */
const PLAN_CARD_ROWS = 'flex flex-col gap-2';

const NO_SUBSCRIBE = (): (() => void) => () => {};
const NO_VERSION = (): number => 0;

/** The plan cards of one message. */
export function SharedPlanCards(
  props: { planIds: string[]; senderName: string } & CardPlacement,
): ReactElement {
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
  const inBubble = props.inBubble ?? true;
  const count = props.planIds.length;
  if (count === 0) return <></>;
  if (skeleton) {
    // The card's own rows (PlanCardSkeleton), so the card fills in place. A
    // tap while the open still waits for the chat bundle starts this card's
    // read now (plan-fire.ts).
    return (
      <div className={cardGroupClass(inBubble)} onPointerDown={() => ctx?.tapPlans(props.planIds)}>
        {props.planIds.map((id, i) => (
          <PlanCardSkeleton key={id} cardMeta={metaForLast(i, count, props.cardMeta)} />
        ))}
      </div>
    );
  }
  return (
    <div className={cardGroupClass(inBubble)}>
      {props.planIds.map((id, i) => {
        const cardMeta = metaForLast(i, count, props.cardMeta);
        if (snapshot.failed.includes(id)) {
          return (
            <CouldntLoadCard
              key={id}
              icon={IconPlan}
              onRetry={() => cache?.retry([id])}
              cardMeta={cardMeta}
            />
          );
        }
        const bundle = snapshot.bundles.get(id);
        return (
          <PlanCardItem
            key={id}
            view={bundle !== undefined ? { kind: 'plan', bundle } : { kind: 'unavailable' }}
            side={side}
            onOpen={() => ctx?.openPlan({ planId: id, senderName: props.senderName })}
            cardMeta={cardMeta}
          />
        );
      })}
    </div>
  );
}

/**
 * A loading plan card: ui/ChatCard with the card's own rows (bones for the
 * title, the range, the chips and the progress line, the empty bar, the 44
 * action row), so it is exactly the card's height and the card fills in place.
 */
export function PlanCardSkeleton(props: { cardMeta?: ReactNode }): ReactElement {
  return (
    <ChatCard
      icon={IconPlan}
      title={<Bone lit="flat" as="span" className="h-5 w-40 rounded" />}
      meta={<Bone lit="flat" as="span" className="h-4 w-24 rounded" />}
      primaryAction={<span aria-hidden="true" className="h-11" />}
      time={props.cardMeta}
      rootProps={{ 'aria-hidden': true, 'data-plan-skeleton': '' }}
    >
      <span className={PLAN_CARD_ROWS}>
        <Bone lit="flat" as="span" className="h-6 w-32 rounded" />
        <PlanCardBar label="" value={0} max={0} percent={0} side="team" />
        <Bone lit="flat" as="span" className="h-4 w-28 rounded" />
      </span>
    </ChatCard>
  );
}

/** One card plus its Forward sheet. */
function PlanCardItem(props: {
  view: PlanCardView;
  side: ViewerSide;
  onOpen: () => void;
  cardMeta?: ReactNode;
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
        cardMeta={props.cardMeta}
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
/**
 * A shared card's eyebrow (the section label role: sm/600 uppercase): the
 * plan card's "Plan" and the idea card's "Idea". `className` carries the
 * caller's ink and gap.
 */
export function CardEyebrow(props: {
  icon: ReactNode;
  label: string;
  className: string;
}): ReactElement {
  return (
    <span className={cn(`flex h-4 items-center ${SECTION_LABEL_INK}`, props.className)}>
      {props.icon}
      {props.label}
    </span>
  );
}

export function PlanCardTop(props: {
  plan: Pick<PlanBundle['plan'], 'title' | 'starts_on' | 'ends_on'>;
  wrapTitle?: boolean;
}): ReactElement {
  return (
    <>
      <CardEyebrow
        icon={<IconPlan size={ICON_SIZE.inline} />}
        label={PLAN_EYEBROW}
        className="gap-2 text-accent"
      />
      <span
        data-plan-title=""
        className={cn(
          'text-xl font-semibold text-fg',
          props.wrapTitle === true ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'truncate',
        )}
      >
        {props.plan.title}
      </span>
      <span data-plan-range="" className="truncate font-mono text-md text-fg-3">
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
      className="block h-1.5 overflow-hidden rounded-full bg-panel-3 lit-well lit-track"
    >
      <span
        data-plan-card-bar={props.side}
        className={cn('block h-1.5 lit-fill', props.side === 'team' ? 'bg-accent' : 'bg-good')}
        style={{ width: `${props.percent}%` }}
      />
    </span>
  );
}

/**
 * The card itself: a pure render (no reads), so both sides are tested
 * statically. ui/ChatCard (the card is the bubble): the plan glyph and title
 * (heading) on line 1, the mono date range on line 2, the count chips, the
 * shown side's bar and progress line, then the 44 action row: Forward (when
 * offered) left, Open plan right. `cardMeta` is the message's time and tick.
 */
export function PlanCardBody(props: {
  view: PlanCardView;
  side: ViewerSide;
  onOpen: () => void;
  onForward: () => void;
  cardMeta?: ReactNode;
}): ReactElement {
  if (props.view.kind === 'unavailable') {
    return (
      <ChatCard
        icon={IconPlan}
        title={PLAN_DELETED}
        muted
        time={props.cardMeta}
        rootProps={{ 'data-plan-card': 'unavailable' }}
      />
    );
  }
  const { bundle } = props.view;
  const progress = planProgress(bundle);
  const forward = canForwardPlan(props.side, bundle.plan.audience);
  const draft = progress.side === 'team';
  return (
    <ChatCard
      icon={IconPlan}
      title={<span data-plan-title="">{bundle.plan.title}</span>}
      meta={
        <span data-plan-range="" className={textRole('meta', 'truncate')}>
          {planRangeLabel(bundle.plan.starts_on, bundle.plan.ends_on)}
        </span>
      }
      secondaryAction={
        forward ? (
          <Button type="button" variant="link" data-plan-forward="" onClick={props.onForward}>
            Forward
          </Button>
        ) : undefined
      }
      primaryAction={
        <Button
          type="button"
          variant="link"
          data-plan-open=""
          data-induction={INDUCTION_KEYS.briefOpenPlan}
          onClick={props.onOpen}
        >
          Open plan
        </Button>
      }
      time={props.cardMeta}
      rootProps={{ 'data-plan-card': bundle.plan.id }}
    >
      <span className={PLAN_CARD_ROWS}>
        <span className="flex h-6 gap-2 overflow-hidden">
          {planChips(bundle).map((chip) => (
            <span
              key={chip.label}
              data-plan-chip={chip.tone}
              className={cn(
                'inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-lg border px-2 text-md lit-pill',
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
        <span data-plan-progress="" className="truncate text-sm text-fg-3">
          {progressLabel(progress)}
        </span>
      </span>
    </ChatCard>
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
  const [ask, setAsk] = useState<PlanOpenSendAsk | null>(null);
  const [askBusy, setAskBusy] = useState(false);
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
    return livePublishFor(channel, client, planCards?.channelId ?? null);
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

  // A Draft plan into a chat with the client: ask first (opening cannot be undone).
  function openFirst(channel: ChannelSummary): void {
    props.onClose();
    setAsk({
      planId,
      planTitle: props.bundle.plan.title,
      channelId: channel.channelId,
      chatName: channel.title,
    });
  }

  async function openAndSend(next: PlanOpenSendAsk): Promise<void> {
    if (askBusy) return;
    setAskBusy(true);
    const messageId = newMessageId();
    const result = await openPlanThenShare({
      planId: next.planId,
      channelId: next.channelId,
      messageId,
    });
    setAskBusy(false);
    if (!result.ok) {
      logger.warn('chat: plan open and send failed', {
        channel_id: next.channelId,
        plan_id: next.planId,
        error: result.error.message,
      });
      toast.show({ title: errorText('send the plan', result.error.message), tone: 'error' });
      return;
    }
    setAsk(null);
    const channel =
      load.status === 'ready'
        ? load.channels.find((c) => c.channelId === next.channelId)
        : undefined;
    const publish = channel !== undefined ? publishOf(channel) : null;
    if (publish !== null) {
      void publish({ sorted_message_id: result.data.id, sorted_channel_id: next.channelId }).catch(
        (error: unknown) =>
          logger.warn('chat: opened plan live publish did not complete', {
            message_id: result.data.id,
            error: String(error),
          }),
      );
    }
    landed({ channelId: next.channelId, title: next.chatName }, result.data, generateTraceId());
  }

  async function forward(channel: ChannelSummary): Promise<void> {
    if (forwardBlocked(props.bundle.plan.audience, summaryHasClient(channel))) {
      openFirst(channel);
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
      openFirst(channel);
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
    <>
      <Sheet open={props.open} onClose={props.onClose} title="Forward plan">
        {load.status === 'ready' && load.channels.length > 0
          ? chatPickList(load.channels, sendingId, agencyOnly, (channel) => void forward(channel))
          : conversationPickerBody(load, sendingId, (channel) => void forward(channel))}
      </Sheet>
      <PlanOpenSendSheet
        ask={ask}
        busy={askBusy}
        onClose={() => setAsk(null)}
        onOpenAndSend={(next) => void openAndSend(next)}
      />
    </>
  );
}

/**
 * The live publish for a share into `channel`: none into the open chat (the
 * thread adds the row and publishes it) or with no connection. Hook-free.
 */
export function livePublishFor(
  channel: ChannelSummary,
  connection: unknown,
  openChannelId: string | null,
): ((liveIds: LiveMessageIds) => Promise<unknown>) | null {
  let target: ChannelTarget | null = null;
  try {
    target = targetFromSummary(channel);
  } catch {
    target = null;
  }
  const here = forwardLandsInOpenChat(channel.channelId, openChannelId);
  return !here && connection !== null && connection !== undefined && target !== null
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

/**
 * The chat pick list (Forward plan, Send idea to chat): the conversation picker's rows (same box, same fixed body
 * height), with "Has client" on chats known to have a client when the plan is
 * a Draft. Hook-free.
 */
export function chatPickList(
  channels: readonly ChannelSummary[],
  sendingId: string | null,
  agencyOnly: boolean,
  onPick: (channel: ChannelSummary) => void,
): ReactElement {
  return (
    <div className="h-72 overflow-y-auto">
      <div className={cn('flex flex-col gap-1', NO_TOUCH_SELECT)}>
        {channels.map((channel) => (
          <PressableRow
            key={channel.channelId}
            type="button"
            data-plan-forward-target={channel.channelId}
            onClick={() => onPick(channel)}
            className="flex items-center gap-3 px-3 py-2 text-fg mv-tint"
          >
            <span className="flex shrink-0 items-center justify-center text-fg-2">
              <IconChat size={ICON_SIZE.nav} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-base font-medium">{channel.title}</span>
              <span className="truncate text-sm text-fg-3">
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
                className="shrink-0 whitespace-nowrap rounded-full bg-warn-soft px-2 py-1 text-xs font-semibold text-warn lit-pill"
              >
                {HAS_CLIENT_TAG}
              </span>
            ) : null}
          </PressableRow>
        ))}
      </div>
    </div>
  );
}
