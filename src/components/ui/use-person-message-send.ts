// The person card's inline send. The card closes first (the caller does that
// in the tap); this then only queues: the message goes to my DM with the
// person through the store's outbox (clock while pending, the outbox's own
// retries, "Not sent" only on a refusal), the same path as any composer send.
// A DM the device's chat list holds is used at once with no read; otherwise
// startDmChannel (dm_channel_ensure) runs here, after the close, and the send
// queues once it answers. A card with a source sends its quote
// (local.privateReply: recorded through chat_private_reply_send with its kind
// and source id); without one it is a plain chat send. The toast says "Sent to
// <first name>" with "Open chat" to that DM. Nothing here awaits before the
// close, and nothing reads on the tap path but the held chat list.

import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { startDmChannel } from '@/components/chat/chat-actions';
import { useToast } from '@/components/ui/toast';
import type { ChannelOutbox, OutboxEntry } from '@/lib/chat/chat-store';
import type { ChannelSummary } from '@/lib/chat-reads';
import { newMessageId } from '@/lib/chat/message-id';
import { privateReplyFromDraft, type PrivateReplyDraft } from '@/lib/chat/private-reply';
import { retryDelayMs } from '@/lib/chat/send-flow';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import {
  MENTION_DM_FAILED,
  OPEN_CHAT,
  personDmRoute,
  sentToTitle,
} from '@/lib/person-card';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';

/** How many dm_channel_ensure attempts a send makes before it gives the text back. */
export const DM_ENSURE_ATTEMPTS = 4;

/** One inline send: who, what, and the quote when the card has a source. */
export interface PersonMessage {
  userId: string;
  firstName: string;
  /** The typed text, or a tapped reaction emoji. */
  text: string;
  source: PrivateReplyDraft | null;
}

/** The outbox entry for an inline send: text only, the quote when there is a source. Pure. */
export function personMessageEntry(
  id: string,
  text: string,
  source: PrivateReplyDraft | null,
): OutboxEntry | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return {
    id,
    text: trimmed,
    local: {
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      reply: null,
      ...(source !== null ? { privateReply: privateReplyFromDraft(source) } : {}),
    },
    state: 'sending',
  };
}

/** What the send needs from around it; injected so the flow is unit-tested directly. */
export interface PersonSendDeps {
  me: string | null;
  workspaceId: string | null;
  roster: readonly ChannelSummary[];
  outbox: Pick<ChannelOutbox, 'enqueue'>;
  /** dm_channel_ensure; resolves null once onOpen ran, else the failure. */
  ensureDm: (
    params: { workspaceId: string; peerUserId: string; traceId: string },
    onOpen: (channelId: string) => void,
  ) => Promise<{ message: string } | null>;
  /** The DM's id once known (the toast's Open chat reads it). */
  onChannel: (channelId: string) => void;
  /** Every ensure attempt failed: the text goes back to the card's draft. */
  onEnsureFailed: (traceId: string, message: string) => void;
  /** Waits between ensure attempts (the outbox's backoff); a test passes an instant one. */
  wait?: (ms: number) => Promise<void>;
  newId?: () => string;
}

const realWait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Queue one inline send. Synchronous when the DM is held (enqueue now);
 * otherwise the ensure runs in the background and the send queues when it
 * answers. Returns false when there is nothing to send or nowhere to send it.
 */
export function queuePersonMessage(message: PersonMessage, deps: PersonSendDeps): boolean {
  const entry = personMessageEntry((deps.newId ?? newMessageId)(), message.text, message.source);
  if (entry === null) return false;
  const route = personDmRoute({
    userId: message.userId,
    me: deps.me,
    workspaceId: deps.workspaceId,
    roster: deps.roster,
  });
  if (route.kind === 'none' || deps.workspaceId === null) return false;
  if (route.kind === 'open') {
    deps.outbox.enqueue(route.channelId, entry);
    deps.onChannel(route.channelId);
    return true;
  }
  const workspaceId = deps.workspaceId;
  const wait = deps.wait ?? realWait;
  void (async () => {
    let traceId = generateTraceId();
    let failure: { message: string } | null = null;
    for (let attempt = 0; attempt < DM_ENSURE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await wait(retryDelayMs(attempt));
      traceId = generateTraceId();
      failure = await deps.ensureDm(
        { workspaceId, peerUserId: message.userId, traceId },
        (channelId) => {
          deps.outbox.enqueue(channelId, entry);
          deps.onChannel(channelId);
        },
      );
      if (failure === null) return;
    }
    deps.onEnsureFailed(traceId, failure?.message ?? '');
  })();
  return true;
}

type ChatStoreValue = ReturnType<typeof useChatStore>;

/** Outside a ChatStoreProvider (isolated renders) there is no outbox: nothing sends. */
function useChatStoreSafe(): ChatStoreValue | null {
  try {
    return useChatStore();
  } catch {
    return null;
  }
}

function useMeSafe(): string | null {
  try {
    return useSession().session?.user.id ?? null;
  } catch {
    return null;
  }
}

function useWorkspaceIdSafe(): string | null {
  try {
    return useWorkspace().workspaceId;
  } catch {
    return null;
  }
}

/**
 * The card's send. `onGiveBack` puts the text back on the card's draft when
 * the DM could never be made (MENTION_DM_FAILED shows), so nothing typed is lost.
 */
export function usePersonMessageSend(): (
  message: PersonMessage,
  onGiveBack: (text: string) => void,
) => boolean {
  const navigate = useNavigate();
  const toast = useToast();
  const store = useChatStoreSafe();
  const me = useMeSafe();
  const workspaceId = useWorkspaceIdSafe();
  const storeRef = useRef(store);
  storeRef.current = store;

  return useCallback(
    (message: PersonMessage, onGiveBack: (text: string) => void): boolean => {
      const held = storeRef.current;
      if (held === null) return false;
      // The DM's id when held now; an ensure fills it in when it answers.
      let channelId: string | null = null;
      const queued = queuePersonMessage(message, {
        me,
        workspaceId,
        roster: held.roster,
        outbox: held.outbox,
        ensureDm: (params, onOpen) =>
          startDmChannel(supabase, params, (id) => {
            onOpen(id);
            // The new DM shows in the chat list (background, after the send queued).
            void held.reloadRoster();
          }),
        onChannel: (id) => {
          channelId = id;
        },
        onEnsureFailed: (traceId, error) => {
          logger.warn('person: inline send dm ensure failed', { trace_id: traceId, error });
          onGiveBack(message.text);
          toast.show({ title: MENTION_DM_FAILED });
        },
      });
      if (!queued) return false;
      mark('person-card:sent');
      const userId = message.userId;
      toast.show({
        title: sentToTitle(message.firstName),
        action: {
          label: OPEN_CHAT,
          onPress: () => {
            if (channelId !== null) {
              mark('person-card:dm-open');
              navigate(chatMessageHref(channelId, null));
              return;
            }
            // The ensure has not answered yet: the same one-path open (it reuses the DM).
            const traceId = generateTraceId();
            if (workspaceId === null) return;
            void startDmChannel(supabase, { workspaceId, peerUserId: userId, traceId }, (id) =>
              navigate(chatMessageHref(id, null)),
            ).then((failure) => {
              if (failure === null) return;
              logger.warn('person: open chat failed', { trace_id: traceId, error: failure.message });
              toast.show({ title: MENTION_DM_FAILED });
            });
          },
        },
      });
      return true;
    },
    [me, workspaceId, navigate, toast],
  );
}
