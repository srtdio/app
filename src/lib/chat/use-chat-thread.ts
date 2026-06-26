// React adapter over thread.ts. Given the Foundation client and the selected
// channel's Agora target, it loads history from the SDK, subscribes to live
// incoming text via the 'chat-thread' handler, and exposes a text send. The
// effect is keyed on the target, so changing channels tears down the previous
// subscription (React runs the cleanup) before the next one is registered, and
// unmounting removes the handler. The Postgres mirror is never touched.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createTextMessage } from '@/lib/chat/message-factory';
import {
  addMessageReaction,
  appendMessage,
  applyReactionChange,
  echoMessage,
  fetchReactions,
  loadHistory,
  markDelivered,
  markReadUpTo,
  mergeHistoryReactions,
  removeMessageReaction,
  sendText,
  subscribeIncoming,
  type ChannelTarget,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import type { MessageAttachment } from '@/lib/chat/attachments';
import type { ChatConnection } from '@/lib/chat/types';
import { logger } from '@/lib/logger';

export interface UseChatThread {
  messages: ThreadMessage[];
  loading: boolean;
  sending: boolean;
  /** Send text and/or attachments and/or shared posts; a send with none is a no-op. */
  send: (
    text: string,
    attachments?: readonly MessageAttachment[],
    sharedPostIds?: readonly string[],
  ) => Promise<void>;
  /** Add or remove the current user's reaction; live state arrives via the event. */
  toggleReaction: (messageId: string, emoji: string, currentlyMine: boolean) => void;
}

/** The Foundation client is the real connection; widen it to the messaging surface. */
function asThreadConnection(client: ChatConnection): ThreadConnection {
  return client as ThreadConnection;
}

export function useChatThread(params: {
  client: ChatConnection | null;
  target: ChannelTarget | null;
  currentUserId: string;
  /** Called after a successful own send so the live store can show 'You: ...'. */
  onOwnMessage?: (text: string, ts: number) => void;
}): UseChatThread {
  const { client, target, currentUserId, onOwnMessage } = params;
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);

  // The live target the send path reads, kept in a ref so `send` is stable.
  const connectionRef = useRef<ThreadConnection | null>(null);
  const targetRef = useRef<ChannelTarget | null>(null);

  useEffect(() => {
    if (!client || !target) {
      connectionRef.current = null;
      targetRef.current = null;
      setMessages([]);
      return;
    }

    const connection = asThreadConnection(client);
    connectionRef.current = connection;
    targetRef.current = target;
    let cancelled = false;
    setLoading(true);
    setMessages([]);

    void loadHistory({ connection, target, currentUserId })
      .then(async (history) => {
        if (cancelled) return;
        setMessages(history);
        // Reactions are not carried on history messages; fetch and merge them in
        // a follow-up. fetchReactions never throws, so a disabled-reactions
        // account degrades to no pills without breaking history load.
        const map = await fetchReactions({
          connection,
          target,
          messageIds: history.map((m) => m.id),
        });
        if (!cancelled) setMessages((prev) => mergeHistoryReactions(prev, map));
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const unsubscribe = subscribeIncoming({
      connection,
      target,
      currentUserId,
      onMessage: (message) => setMessages((prev) => appendMessage(prev, message)),
      onDelivered: (ackedId) => setMessages((prev) => markDelivered(prev, ackedId)),
      onConversationRead: (readTimeMs) => setMessages((prev) => markReadUpTo(prev, readTimeMs)),
      onReaction: (messageId, reactions) =>
        setMessages((prev) => applyReactionChange(prev, messageId, reactions)),
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // `target` is memoized on the selected channel, so its identity is stable
    // until the channel changes; depending on it re-subscribes only on switch.
  }, [client, target, currentUserId]);

  const send = useCallback(
    async (
      text: string,
      attachments: readonly MessageAttachment[] = [],
      sharedPostIds: readonly string[] = [],
    ): Promise<void> => {
      const connection = connectionRef.current;
      const sendTarget = targetRef.current;
      const trimmed = text.trim();
      // A send with no text, no attachments and no shared posts is a no-op.
      if (
        !connection ||
        !sendTarget ||
        (trimmed === '' && attachments.length === 0 && sharedPostIds.length === 0)
      )
        return;
      setSending(true);
      try {
        const result = await sendText({
          connection,
          target: sendTarget,
          text: trimmed,
          attachments,
          sharedPostIds,
          createMessage: createTextMessage,
        });
        const time = Date.now();
        const echo = echoMessage({
          result,
          text: trimmed,
          currentUserId,
          time,
          attachments: [...attachments],
          sharedPostIds: [...sharedPostIds],
        });
        setMessages((prev) => appendMessage(prev, echo));
        onOwnMessage?.(trimmed, time);
      } finally {
        setSending(false);
      }
    },
    [currentUserId, onOwnMessage],
  );

  const toggleReaction = useCallback(
    (messageId: string, emoji: string, currentlyMine: boolean): void => {
      if (!client) return;
      const conn = asThreadConnection(client);
      // State updates arrive via the onReaction event; never optimistically mutate.
      void (
        currentlyMine
          ? removeMessageReaction({ connection: conn, messageId, emoji })
          : addMessageReaction({ connection: conn, messageId, emoji })
      ).catch((error: unknown) => logger.warn('chat reaction failed', { error: String(error) }));
    },
    [client],
  );

  return { messages, loading, sending, send, toggleReaction };
}
