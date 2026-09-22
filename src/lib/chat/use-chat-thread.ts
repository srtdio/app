// React adapter over thread.ts + history.ts + record.ts. Postgres is the record
// and the read path: the thread loads its latest page from chat_messages, pages
// older rows by keyset on scroll-to-top, and catches up (rows newer than the
// newest loaded) on every transition to 'connected'. Agora is live delivery
// only: incoming text for the open channel is appended by its Sorted id (deduped
// against what is loaded), and reaction / read signals arrive as command
// messages. Sends go to chat_message_send FIRST; the returned row (server
// created_at) is what the thread shows, and the Agora publish that follows
// cannot fail the send. The effect is keyed on the channel id, so switching
// channels tears the previous subscription down before the next one registers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { newMessageId } from '@/lib/chat/message-id';
import { createCmdMessage, createTextMessage } from '@/lib/chat/message-factory';
import {
  loadLatestMessages,
  loadNewerMessages,
  loadOlderMessages,
  loadPeerReadCursor,
  loadReactions,
} from '@/lib/chat/history';
import {
  addReactionRecord,
  removeReactionRecord,
  sendMessageRecord,
  setReadCursorRecord,
} from '@/lib/chat/record';
import { createDebouncer, READ_CURSOR_DEBOUNCE_MS } from '@/lib/chat/read-cursor';
import { runSend } from '@/lib/chat/send-flow';
import {
  appendMessage,
  applyReactionOp,
  markReadUpTo,
  markReadUpToMessage,
  mergeFetched,
  mergeReactions,
  newestCursor,
  oldestCursor,
  pendingMessage,
  reactionEventExt,
  readEventExt,
  rowToThreadMessage,
  sendText,
  setMessageState,
  subscribeIncoming,
  upsertMessage,
  type ChannelTarget,
  type LocalMessageContent,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { sendSignal, type TypingConnection } from '@/lib/chat/typing';
import type { MessageAttachment, ReplyQuote } from '@/lib/chat/attachments';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';

export interface UseChatThread {
  messages: ThreadMessage[];
  loading: boolean;
  /** An older page is being fetched (scroll-to-top). */
  loadingOlder: boolean;
  /** Whether an older page may exist. */
  hasMore: boolean;
  /** Fetch the page before the oldest loaded message. */
  loadOlder: () => void;
  /** Record + publish text and/or attachments and/or shared posts; a send with none is a no-op. */
  send: (
    text: string,
    attachments?: readonly MessageAttachment[],
    sharedPostIds?: readonly string[],
    reply?: ReplyQuote | null,
  ) => Promise<void>;
  /** Re-run a failed send with the SAME message id. */
  retry: (messageId: string) => void;
  /** Add or remove the current user's reaction: optimistic, recorded, signalled live. */
  toggleReaction: (messageId: string, emoji: string, currentlyMine: boolean) => void;
  /** The newest message is on screen: advance the read cursor (debounced). */
  markNewestVisible: () => void;
}

/** The Foundation client is the real connection; widen it to the messaging surface. */
function asThreadConnection(client: ChatConnection): ThreadConnection {
  return client as ThreadConnection;
}

function asSignalConnection(client: ChatConnection): TypingConnection {
  return client as TypingConnection;
}

/** What a send needs to run again with the same id. */
interface PendingSend {
  text: string;
  local: LocalMessageContent;
}

export function useChatThread(params: {
  client: ChatConnection | null;
  status: ChatStatus;
  /** Our channel id; null when nothing is selected. */
  channelId: string | null;
  /** The Agora target for live publish; null keeps the thread Postgres-only. */
  target: ChannelTarget | null;
  currentUserId: string;
  /** The DM peer, for the seen ticks; null for groups. */
  peerUserId: string | null;
  /** Called after a successful record write so the live store can show 'You: ...'. */
  onOwnMessage?: (text: string, ts: number) => void;
  /** Called after each catch-up so the caller can refresh unread counts. */
  onCaughtUp?: () => void;
  /** Injected in tests; the app uses the shared Supabase client. */
  db?: Client;
}): UseChatThread {
  const { client, status, channelId, target, currentUserId, peerUserId, onOwnMessage, onCaughtUp } =
    params;
  const db: Client = params.db ?? supabase;

  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // Live values the stable callbacks read.
  const messagesRef = useRef<ThreadMessage[]>([]);
  messagesRef.current = messages;
  const clientRef = useRef(client);
  clientRef.current = client;
  const targetRef = useRef(target);
  targetRef.current = target;
  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const onOwnMessageRef = useRef(onOwnMessage);
  onOwnMessageRef.current = onOwnMessage;
  const onCaughtUpRef = useRef(onCaughtUp);
  onCaughtUpRef.current = onCaughtUp;
  const pendingRef = useRef<Map<string, PendingSend>>(new Map());
  const loadingOlderRef = useRef(false);
  const lastCursorRef = useRef<string | null>(null);

  /** Merge the reactions for a batch of ids into the list (one IN query). */
  const attachReactions = useCallback(
    async (ids: readonly string[], forChannel: string): Promise<void> => {
      const result = await loadReactions(db, ids, currentUserId);
      if (channelRef.current !== forChannel) return;
      if (!result.ok) {
        logger.warn('chat: reactions load failed', { error: result.error.message });
        return;
      }
      const map = result.data;
      setMessages((prev) => mergeReactions(prev, map));
    },
    [db, currentUserId],
  );

  /** Apply the DM peer's recorded read position to the seen ticks. */
  const attachPeerCursor = useCallback(
    async (forChannel: string, peer: string): Promise<void> => {
      const result = await loadPeerReadCursor(db, forChannel, peer);
      if (channelRef.current !== forChannel) return;
      if (!result.ok) {
        logger.warn('chat: peer read cursor load failed', { error: result.error.message });
        return;
      }
      const cursor = result.data;
      if (!cursor.found) return;
      const readAt = Date.parse(cursor.lastReadAt);
      if (Number.isNaN(readAt)) return;
      setMessages((prev) => markReadUpTo(prev, readAt));
    },
    [db],
  );

  // Load the latest page whenever the channel changes.
  useEffect(() => {
    pendingRef.current = new Map();
    lastCursorRef.current = null;
    setMessages([]);
    setHasMore(false);
    if (channelId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async (): Promise<void> => {
      const page = await loadLatestMessages(db, channelId);
      if (cancelled) return;
      if (!page.ok) {
        logger.error('chat: history load failed', {
          channel_id: channelId,
          error: page.error.message,
        });
        setLoading(false);
        return;
      }
      const fetched = page.data.rows.map((row) => rowToThreadMessage(row, currentUserId));
      setMessages((prev) => mergeFetched(prev, fetched));
      setHasMore(page.data.hasMore);
      setLoading(false);
      void attachReactions(
        fetched.map((m) => m.id),
        channelId,
      );
      if (peerUserId !== null) void attachPeerCursor(channelId, peerUserId);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, channelId, currentUserId, peerUserId, attachReactions, attachPeerCursor]);

  // Live traffic for the open channel.
  useEffect(() => {
    if (client === null || channelId === null) return;
    const unsubscribe = subscribeIncoming({
      connection: asThreadConnection(client),
      channelId,
      currentUserId,
      onMessage: (message) => setMessages((prev) => appendMessage(prev, message)),
      onIgnored: (rawId) =>
        logger.warn('chat: live message without sorted ids ignored', { agora_id: rawId }),
      onReaction: ({ messageId, emoji, op, fromUserId }) =>
        setMessages((prev) =>
          applyReactionOp(prev, { messageId, emoji, op, mine: fromUserId === currentUserId }),
        ),
      onRead: ({ messageId, fromUserId }) => {
        if (fromUserId === currentUserId) return;
        setMessages((prev) => markReadUpToMessage(prev, messageId));
      },
    });
    return unsubscribe;
  }, [client, channelId, currentUserId]);

  // Catch-up on every transition to 'connected': rows newer than the newest
  // loaded (created_at, id), then reactions for them, then the unread refresh.
  const previousStatusRef = useRef<ChatStatus>(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== 'connected' || previous === 'connected') return;
    const forChannel = channelRef.current;
    if (forChannel === null) {
      onCaughtUpRef.current?.();
      return;
    }
    const cursor = newestCursor(messagesRef.current);
    void (async (): Promise<void> => {
      if (cursor !== undefined) {
        const result = await loadNewerMessages(db, forChannel, cursor);
        if (channelRef.current !== forChannel) return;
        if (!result.ok) {
          logger.warn('chat: catch-up load failed', {
            channel_id: forChannel,
            error: result.error.message,
          });
        } else if (result.data.length > 0) {
          const fetched = result.data.map((row) => rowToThreadMessage(row, currentUserId));
          setMessages((prev) => mergeFetched(prev, fetched));
          void attachReactions(
            fetched.map((m) => m.id),
            forChannel,
          );
        }
      }
      onCaughtUpRef.current?.();
    })();
  }, [status, db, currentUserId, attachReactions]);

  const loadOlder = useCallback((): void => {
    const forChannel = channelRef.current;
    const cursor = oldestCursor(messagesRef.current);
    if (forChannel === null || cursor === undefined || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    void (async (): Promise<void> => {
      const page = await loadOlderMessages(db, forChannel, cursor);
      loadingOlderRef.current = false;
      if (channelRef.current !== forChannel) return;
      setLoadingOlder(false);
      if (!page.ok) {
        logger.warn('chat: older page load failed', {
          channel_id: forChannel,
          error: page.error.message,
        });
        return;
      }
      const fetched = page.data.rows.map((row) => rowToThreadMessage(row, currentUserId));
      setMessages((prev) => mergeFetched(prev, fetched));
      setHasMore(page.data.hasMore);
      void attachReactions(
        fetched.map((m) => m.id),
        forChannel,
      );
    })();
  }, [db, currentUserId, attachReactions]);

  /** Record a message (Postgres first), then publish it live. */
  const deliver = useCallback(
    async (id: string, forChannel: string, pending: PendingSend): Promise<void> => {
      const traceId = generateTraceId();
      const connection = clientRef.current;
      const liveTarget = targetRef.current;
      const publishLive =
        connection !== null && liveTarget !== null
          ? (input: { id: string; channelId: string; text: string; local: LocalMessageContent }) =>
              sendText({
                connection: asThreadConnection(connection),
                target: liveTarget,
                text: input.text,
                attachments: input.local.attachments,
                sharedPostIds: input.local.sharedPostIds,
                reply: input.local.reply,
                createMessage: createTextMessage,
                liveIds: { sorted_message_id: input.id, sorted_channel_id: input.channelId },
              })
          : undefined;
      const outcome = await runSend(
        {
          recordMessage: (input) => sendMessageRecord({ client: db, ...input }),
          publishLive,
          // The row exists; receivers catch up from Postgres on reconnect.
          onLiveWarning: (context) => logger.warn('chat: live publish did not complete', context),
        },
        {
          id,
          channelId: forChannel,
          currentUserId,
          traceId,
          text: pending.text,
          local: pending.local,
        },
      );
      if (channelRef.current !== forChannel) return;
      if (!outcome.ok) {
        logger.error('chat: message record failed', {
          trace_id: traceId,
          message_id: id,
          channel_id: forChannel,
          reason: outcome.reason,
          error: outcome.error,
        });
        setMessages((prev) => setMessageState(prev, id, 'failed'));
        return;
      }
      pendingRef.current.delete(id);
      setMessages((prev) => upsertMessage(prev, outcome.message));
      onOwnMessageRef.current?.(pending.text, outcome.message.time);
    },
    [db, currentUserId],
  );

  const send = useCallback<UseChatThread['send']>(
    async (text, attachments = [], sharedPostIds = [], reply = null) => {
      const forChannel = channelRef.current;
      const trimmed = text.trim();
      if (
        forChannel === null ||
        (trimmed === '' && attachments.length === 0 && sharedPostIds.length === 0)
      )
        return;
      const id = newMessageId();
      const pending: PendingSend = {
        text: trimmed,
        local: { attachments: [...attachments], sharedPostIds: [...sharedPostIds], reply },
      };
      pendingRef.current.set(id, pending);
      setMessages((prev) =>
        appendMessage(
          prev,
          pendingMessage({ id, currentUserId, text: trimmed, local: pending.local, after: prev }),
        ),
      );
      await deliver(id, forChannel, pending);
    },
    [currentUserId, deliver],
  );

  const retry = useCallback(
    (messageId: string): void => {
      const forChannel = channelRef.current;
      const pending = pendingRef.current.get(messageId);
      if (forChannel === null || pending === undefined) return;
      setMessages((prev) => setMessageState(prev, messageId, 'sending'));
      void deliver(messageId, forChannel, pending);
    },
    [deliver],
  );

  const toggleReaction = useCallback(
    (messageId: string, emoji: string, currentlyMine: boolean): void => {
      const forChannel = channelRef.current;
      if (forChannel === null) return;
      const op = currentlyMine ? 'remove' : 'add';
      const traceId = generateTraceId();
      setMessages((prev) => applyReactionOp(prev, { messageId, emoji, op, mine: true }));
      const params = { client: db, channelId: forChannel, messageId, emoji, traceId };
      void (currentlyMine ? removeReactionRecord(params) : addReactionRecord(params)).then(
        (result) => {
          if (result.ok) return;
          logger.warn('chat: reaction record failed', {
            trace_id: traceId,
            message_id: messageId,
            op,
            error: result.message,
          });
          if (channelRef.current !== forChannel) return;
          setMessages((prev) =>
            applyReactionOp(prev, {
              messageId,
              emoji,
              op: currentlyMine ? 'add' : 'remove',
              mine: true,
            }),
          );
        },
      );
      const connection = clientRef.current;
      const liveTarget = targetRef.current;
      if (connection === null || liveTarget === null) return;
      void sendSignal({
        connection: asSignalConnection(connection),
        target: liveTarget,
        createCmd: createCmdMessage,
        ext: reactionEventExt({ messageId, emoji, op }),
      }).catch((error: unknown) =>
        logger.warn('chat: reaction signal failed', { trace_id: traceId, error: String(error) }),
      );
    },
    [db],
  );

  // Read position: debounced 1s, forward-only server-side, plus a live signal
  // for the peer's seen ticks. Skips when the newest message is unchanged.
  const readCursor = useMemo(
    () =>
      createDebouncer<{ channelId: string; messageId: string }>((input) => {
        if (channelRef.current !== input.channelId) return;
        if (lastCursorRef.current === input.messageId) return;
        lastCursorRef.current = input.messageId;
        const traceId = generateTraceId();
        void setReadCursorRecord({
          client: db,
          channelId: input.channelId,
          messageId: input.messageId,
          traceId,
        }).then((result) => {
          if (!result.ok) {
            logger.warn('chat: read cursor write failed', {
              trace_id: traceId,
              message_id: input.messageId,
              error: result.message,
            });
          }
        });
        const connection = clientRef.current;
        const liveTarget = targetRef.current;
        if (connection === null || liveTarget === null) return;
        void sendSignal({
          connection: asSignalConnection(connection),
          target: liveTarget,
          createCmd: createCmdMessage,
          ext: readEventExt({ channelId: input.channelId, messageId: input.messageId }),
        }).catch((error: unknown) =>
          logger.warn('chat: read signal failed', { trace_id: traceId, error: String(error) }),
        );
      }, READ_CURSOR_DEBOUNCE_MS),
    [db],
  );
  useEffect(() => () => readCursor.cancel(), [readCursor]);

  const markNewestVisible = useCallback((): void => {
    const forChannel = channelRef.current;
    if (forChannel === null) return;
    const recorded = messagesRef.current.filter((m) => m.state === 'sent' && m.createdAt !== '');
    const newest = recorded[recorded.length - 1];
    if (newest === undefined) return;
    readCursor.schedule({ channelId: forChannel, messageId: newest.id });
  }, [readCursor]);

  return {
    messages,
    loading,
    loadingOlder,
    hasMore,
    loadOlder,
    send,
    retry,
    toggleReaction,
    markNewestVisible,
  };
}
