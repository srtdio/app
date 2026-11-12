// Send an idea to chat (the Bank row menu, the idea's item screen): the same
// chat picker the plan Forward uses (one listChannelSummaries read when it
// opens, Personal notes left out), a tap shares the idea as an idea card
// (chat_plan_item_share, a fresh message id; published live when the chat is
// not the open one, added to the open thread when it is). A team-only idea
// into a chat with the client in it is refused (idea_not_shared_with_client):
// a bank idea gets "Show this idea to approvers?" (Cancel, Send in Team
// instead: the picker again, chats known to have a client left out; Show and
// send: bank_idea_set show_to_client true keeping its other flags, then the
// share again with the same message id). An idea inside a Draft plan gets the
// plan path instead: "Open this plan for approvers?" (plan_share_with_client,
// then the share again); bank_idea_set is never called for a planned idea.
// Works outside a chat (the Plan tab, the bank idea route): the open-chat
// parts are optional.

import { PHONE_PAD_TIGHT } from '@/components/ui/layout';
import { cn } from '@/lib/cn';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { bankIdeaSet, chatPlanItemShare, planShareWithClient, type Result } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { usePlanCards } from '@/components/chat/PlanCardsProvider';
import { PlanOpenSendSheet } from '@/components/chat/PlanOpenSendSheet';
import { chatPickList, livePublishFor } from '@/components/chat/PlanCard';
import { forwardedToast, summaryHasClient } from '@/components/chat/plan-card';
import { conversationPickerBody, type LoadState } from '@/components/pages/pcs/ConversationPicker';
import { useChat } from '@/lib/chat';
import { listChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';
import { newMessageId } from '@/lib/chat/message-id';
import { dispatchPlanChanged } from '@/lib/chat/plans';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { errorText } from '@/lib/error-copy';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';

export interface IdeaShareTarget {
  id: string;
  title: string;
  commentCount: number;
  /** The idea's other flags, kept by Show and send; read on that tap when absent. */
  flags?: { archived: boolean; starred: boolean };
  /** The plan the idea sits in (a planned concept); null or absent for a bank idea. */
  plan?: { id: string; title: string } | null;
}

/** Which sheet a refused share opens: the plan path for a planned idea, else Show to approvers. Pure. */
export function refusedPath(idea: Pick<IdeaShareTarget, 'plan'>): 'open-plan' | 'show-idea' {
  return idea.plan !== undefined && idea.plan !== null ? 'open-plan' : 'show-idea';
}

/**
 * Open and send (an idea inside a Draft plan): plan_share_with_client, then
 * the share again with the same message id. Never calls bank_idea_set.
 * Stops at the first failure and names its step. Never throws.
 */
export async function openPlanThenShareIdea(deps: {
  openPlan: () => Promise<Result<unknown>>;
  share: () => Promise<Result<ChatMessageRow>>;
}): Promise<
  { ok: true; row: ChatMessageRow } | { ok: false; step: 'open' | 'send'; message: string }
> {
  try {
    const opened = await deps.openPlan();
    if (!opened.ok) return { ok: false, step: 'open', message: opened.error.message };
    const shared = await deps.share();
    if (!shared.ok) return { ok: false, step: 'send', message: shared.error.message };
    return { ok: true, row: shared.data };
  } catch (error) {
    return { ok: false, step: 'send', message: String(error) };
  }
}

export const IDEA_SHOW_TITLE = 'Show this idea to approvers?';

/** The Show and send sheet's line. Pure. */
export function ideaShowLine(chatName: string, comments: number): string {
  return `This idea is team only and ${chatName} has approvers in it. Showing it lets them see the idea and all ${comments} ${comments === 1 ? 'comment' : 'comments'}.`;
}

/** Whether a chat_plan_item_share failure is the team-only-idea refusal. Pure. */
export function isIdeaNotSharedWithClient(message: string): boolean {
  return message.includes('idea_not_shared_with_client');
}

/** The picker's chats: notes never; Send in Team instead leaves out chats known to have a client. Pure. */
export function ideaPickChannels(
  channels: readonly ChannelSummary[],
  teamOnly: boolean,
  skipChannelId: string | null = null,
): ChannelSummary[] {
  return channels.filter(
    (c) =>
      c.channelType !== 'notes' &&
      c.channelId !== skipChannelId &&
      (!teamOnly || summaryHasClient(c) !== true),
  );
}

/** One share with this message id (idempotent on it). Never throws. */
export async function shareIdea(input: {
  messageId: string;
  channelId: string;
  itemId: string;
}): Promise<Result<ChatMessageRow>> {
  try {
    const res = await chatPlanItemShare(supabase, {
      p_id: input.messageId,
      p_channel_id: input.channelId,
      p_item_id: input.itemId,
      p_trace_id: generateTraceId(),
    });
    if (!res.ok) return res;
    return { ok: true, data: res.data as unknown as ChatMessageRow };
  } catch (error) {
    return { ok: false, error: { code: 'unknown', message: String(error) } };
  }
}

/** The idea's archived and starred flags (one plan_items read on the Show and send tap). */
async function readIdeaFlags(
  itemId: string,
): Promise<Result<{ archived: boolean; starred: boolean }>> {
  const res = (await (
    supabase.from('plan_items') as unknown as {
      select: (c: string) => {
        eq: (
          k: string,
          v: string,
        ) => {
          maybeSingle: () => PromiseLike<{
            data: { archived_at: string | null; starred_at: string | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    }
  )
    .select('archived_at, starred_at')
    .eq('id', itemId)
    .maybeSingle()) as {
    data: { archived_at: string | null; starred_at: string | null } | null;
    error: { message: string } | null;
  };
  if (res.error !== null || res.data === null) {
    return {
      ok: false,
      error: { code: 'unknown', message: res.error?.message ?? 'idea not available' },
    };
  }
  return {
    ok: true,
    data: { archived: res.data.archived_at !== null, starred: res.data.starred_at !== null },
  };
}

/**
 * Show and send: the idea's flags (kept), show_to_client true, then the share
 * again (same message id, so a retry never posts twice). Stops at the first
 * failure and names its step. Never throws.
 */
export async function showThenShare(deps: {
  readFlags: () => Promise<Result<{ archived: boolean; starred: boolean }>>;
  setShown: (flags: { archived: boolean; starred: boolean }) => Promise<Result<unknown>>;
  share: () => Promise<Result<ChatMessageRow>>;
  onShown: () => void;
}): Promise<
  { ok: true; row: ChatMessageRow } | { ok: false; step: 'show' | 'send'; message: string }
> {
  try {
    const flags = await deps.readFlags();
    if (!flags.ok) return { ok: false, step: 'show', message: flags.error.message };
    const shown = await deps.setShown(flags.data);
    if (!shown.ok) return { ok: false, step: 'show', message: shown.error.message };
    deps.onShown();
    const shared = await deps.share();
    if (!shared.ok) return { ok: false, step: 'send', message: shared.error.message };
    return { ok: true, row: shared.data };
  } catch (error) {
    return { ok: false, step: 'send', message: String(error) };
  }
}

/** The live chat connection when the shell's ChatProvider is mounted; null otherwise (tests, bare routes). */
function useOptionalChatClient(): unknown {
  try {
    return useChat().client;
  } catch {
    return null;
  }
}

type Step =
  | { kind: 'pick'; teamOnly: boolean; skip: string | null }
  | { kind: 'ask'; channel: ChannelSummary; messageId: string }
  | {
      kind: 'open';
      channel: ChannelSummary;
      messageId: string;
      plan: { id: string; title: string };
    }
  | null;

export function IdeaShareFlow(props: {
  idea: IdeaShareTarget | null;
  onClose: () => void;
  onShown?: () => void;
}): ReactElement | null {
  const client = useOptionalChatClient();
  const { workspaceId } = useWorkspace();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const toast = useToast();
  const planCards = usePlanCards();
  const idea = props.idea;
  const [step, setStep] = useState<Step>(null);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A new idea opens the picker; none closes everything.
  useEffect(() => {
    setStep(idea !== null ? { kind: 'pick', teamOnly: false, skip: null } : null);
  }, [idea]);

  const picking = step?.kind === 'pick';
  // The chat list: one read when the picker first opens (Send in Team instead reuses it).
  const listed = useRef(false);
  useEffect(() => {
    if (!picking || workspaceId === null || userId === null || listed.current) return;
    let cancelled = false;
    setLoad({ status: 'loading' });
    void listChannelSummaries(supabase, { workspaceId, currentUserId: userId }).then((result) => {
      if (cancelled) return;
      listed.current = result.ok;
      setLoad(result.ok ? { status: 'ready', channels: result.data } : { status: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [picking, workspaceId, userId]);

  const close = (): void => {
    setStep(null);
    props.onClose();
  };

  function landed(channel: ChannelSummary, row: ChatMessageRow): void {
    const traceId = generateTraceId();
    if (planCards !== null && planCards.channelId === channel.channelId) {
      planCards.addRowHere(row, traceId);
    } else {
      const publish = livePublishFor(channel, client, planCards?.channelId ?? null);
      if (publish !== null) {
        void publish({ sorted_message_id: row.id, sorted_channel_id: channel.channelId }).catch(
          (error: unknown) =>
            logger.warn('chat: idea live publish did not complete', {
              message_id: row.id,
              error: String(error),
            }),
        );
      }
    }
    toast.show({ title: forwardedToast(channel.title) });
    close();
  }

  async function send(channel: ChannelSummary, messageId: string): Promise<void> {
    if (idea === null || sendingId !== null) return;
    setSendingId(channel.channelId);
    const result = await shareIdea({ messageId, channelId: channel.channelId, itemId: idea.id });
    setSendingId(null);
    if (result.ok) {
      landed(channel, result.data);
      return;
    }
    if (isIdeaNotSharedWithClient(result.error.message)) {
      const plan = idea.plan ?? null;
      setStep(
        refusedPath(idea) === 'open-plan' && plan !== null
          ? { kind: 'open', channel, messageId, plan }
          : { kind: 'ask', channel, messageId },
      );
      return;
    }
    logger.warn('chat: idea share failed', {
      channel_id: channel.channelId,
      item_id: idea.id,
      error: result.error.message,
    });
    toast.show({ title: errorText('send it', result.error.message), tone: 'error' });
  }

  async function showAndSend(channel: ChannelSummary, messageId: string): Promise<void> {
    if (idea === null || busy) return;
    setBusy(true);
    const result = await showThenShare({
      readFlags: () =>
        idea.flags !== undefined
          ? Promise.resolve({ ok: true as const, data: idea.flags })
          : readIdeaFlags(idea.id),
      setShown: (flags) =>
        bankIdeaSet(supabase, {
          p_item_id: idea.id,
          p_show_to_client: true,
          p_archived: flags.archived,
          p_starred: flags.starred,
          p_trace_id: generateTraceId(),
        }),
      share: () => shareIdea({ messageId, channelId: channel.channelId, itemId: idea.id }),
      onShown: () => {
        // The Bank's kept page shows it as shown to the client at once (no read).
        dispatchPlanChanged(window, '', {
          kind: 'flags',
          itemId: idea.id,
          flags: { show_to_client: true },
        });
        props.onShown?.();
      },
    });
    setBusy(false);
    if (!result.ok) {
      toast.show({
        title: errorText(
          result.step === 'show' ? 'show it to the client' : 'send it',
          result.message,
        ),
        tone: 'error',
      });
      return;
    }
    landed(channel, result.row);
  }

  async function openAndSend(
    channel: ChannelSummary,
    messageId: string,
    plan: { id: string; title: string },
  ): Promise<void> {
    if (idea === null || busy) return;
    setBusy(true);
    const result = await openPlanThenShareIdea({
      openPlan: () =>
        planShareWithClient(supabase, { p_plan_id: plan.id, p_trace_id: generateTraceId() }),
      share: () => shareIdea({ messageId, channelId: channel.channelId, itemId: idea.id }),
    });
    setBusy(false);
    if (!result.ok) {
      toast.show({
        title: errorText(
          result.step === 'open' ? 'open the plan for approvers' : 'send it',
          result.message,
        ),
        tone: 'error',
      });
      return;
    }
    landed(channel, result.row);
  }

  if (idea === null) return null;
  const channels =
    load.status === 'ready' && step?.kind === 'pick'
      ? ideaPickChannels(load.channels, step.teamOnly, step.skip)
      : [];
  const ask = step?.kind === 'ask' ? step : null;
  const openStep = step?.kind === 'open' ? step : null;
  return (
    <>
      <Sheet open={step?.kind === 'pick'} onClose={close} title="Send to chat">
        <div data-idea-share-picker="">
          {load.status === 'ready' && channels.length > 0
            ? chatPickList(
                channels,
                sendingId,
                false,
                (channel) => void send(channel, newMessageId()),
              )
            : conversationPickerBody(
                load.status === 'ready' ? { status: 'ready', channels } : load,
                sendingId,
                (channel) => void send(channel, newMessageId()),
              )}
        </div>
      </Sheet>
      <Sheet
        open={ask !== null}
        onClose={close}
        title={IDEA_SHOW_TITLE}
        busy={busy}
        footer={
          <div className="grid w-full grid-cols-2 gap-2 max-[359.98px]:grid-cols-1 md:flex md:justify-end">
            <Button
              variant="secondary"
              type="button"
              data-idea-share-team=""
              className="col-span-2 md:order-2"
              onClick={() =>
                setStep({ kind: 'pick', teamOnly: true, skip: ask?.channel.channelId ?? null })
              }
            >
              Send in Team instead
            </Button>
            <Button variant="ghost" type="button" className="md:order-1" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="button"
              data-idea-share-show=""
              // Phone: 8 side padding, so the label stays whole in its half at 320.
              className={cn(PHONE_PAD_TIGHT, 'md:order-3')}
              busy={busy}
              onClick={() => {
                if (ask !== null && !busy) void showAndSend(ask.channel, ask.messageId);
              }}
            >
              Show and send
            </Button>
          </div>
        }
      >
        <p data-idea-share-ask="" className="p-4 text-base text-fg">
          {ask !== null ? ideaShowLine(ask.channel.title, idea.commentCount) : ''}
        </p>
      </Sheet>
      <PlanOpenSendSheet
        ask={
          openStep !== null
            ? {
                planId: openStep.plan.id,
                planTitle: openStep.plan.title,
                channelId: openStep.channel.channelId,
                chatName: openStep.channel.title,
              }
            : null
        }
        busy={busy}
        onClose={close}
        onOpenAndSend={() => {
          if (openStep !== null)
            void openAndSend(openStep.channel, openStep.messageId, openStep.plan);
        }}
      />
    </>
  );
}
