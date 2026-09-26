// React adapter over thread.ts + history.ts + record.ts. Postgres is the record
// and the read path: the thread loads its latest page from chat_messages, pages
// older rows by keyset on scroll-to-top, and catches up (rows newer than the
// newest loaded) on tab visible, browser online, every transition to
// 'connected', and every 60s while visible, whatever the Agora state. Agora is
// live delivery only: an incoming text for the open channel is verified against
// its chat_messages row (RLS) and the ROW renders; an id with no row is
// dropped. Reaction / read signals arrive as command messages. Sends go to
// chat_message_send FIRST; the returned row (server created_at) is what the
// thread shows, and the Agora publish that follows (capped at 5s) cannot fail
// the send. Unrecorded sends live in the per-channel outbox, so switching
// channels keeps a sending or failed bubble and its Retry payload.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { newMessageId } from '@/lib/chat/message-id';
import { createCmdMessage, createTextMessage } from '@/lib/chat/message-factory';
import {
  loadLatestMessages,
  loadMessagesByIds,
  loadNewerMessages,
  loadOlderMessages,
  loadPeerReadCursor,
  loadReactions,
} from '@/lib/chat/history';
import { browserCatchUpTriggers, catchUpRows } from '@/lib/chat/catch-up';
import { liveVerifierFor, type LiveVerifier } from '@/lib/chat/live-verify';
import {
  createChannelOutbox,
  type ChannelOutbox,
  type Outbox,
  type OutboxEntry,
} from '@/lib/chat/chat-store';
import {
  addReactionRecord,
  removeReactionRecord,
  sendMessageRecord,
  setReadCursorRecord,
} from '@/lib/chat/record';
import { createDebouncer, READ_CURSOR_DEBOUNCE_MS } from '@/lib/chat/read-cursor';
import { runSend } from '@/lib/chat/send-flow';
import {
  createInFlightGuard,
  recordThenSignal,
  settleSendFailure,
} from '@/lib/chat/thread-actions';
import {
  applyReactionOp,
  hydrateReplies,
  markReadUpTo,
  markReadUpToMessage,
  mergeFetched,
  mergeReactions,
  newestCursor,
  oldestCursor,
  reactionEventExt,
  readEventExt,
  rowToThreadMessage,
  sendText,
  setMessageState,
  subscribeIncoming,
  upsertMessage,
  withOutboxBubbles,
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
  onOwnMessage?: (channelId: string, text: string, ts: number) => void;
  /** Called after each catch-up so the caller can refresh unread counts. */
  onCaughtUp?: () => void;
  /** Per-channel unrecorded sends (the chat store's); a hook-local one when absent. */
  outbox?: ChannelOutbox;
  /** Injected in tests; the app uses the shared Supabase client. */
  db?: Client;
  /** Injected in tests; the app shares one verifier per client with the store. */
  verifier?: LiveVerifier;
}): UseChatThread {
  const { client, status, channelId, target, currentUserId, peerUserId, onOwnMessage, onCaughtUp } =
    params;
  const db: Client = params.db ?? supabase;
  const verifier = params.verifier ?? liveVerifierFor(db);
  const localOutboxRef = useRef<Outbox>({});
  const localOutbox = useMemo(() => createChannelOutbox(localOutboxRef), []);
  const outbox = params.outbox ?? localOutbox;
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

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
  const inFlight = useMemo(() => createInFlightGuard(), []);
  const catchingUpRef = useRef(false);
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

  /**
   * Fill the reply quotes of freshly fetched rows: from what is loaded, else
   * one IN read for the quoted rows that are not.
   */
  const resolveReplies = useCallback(
    async (fetched: readonly ThreadMessage[], forChannel: string): Promise<void> => {
      const known = new Set([...messagesRef.current, ...fetched].map((m) => m.id));
      const missing = [
        ...new Set(
          fetched
            .filter((m) => m.reply !== null && m.reply.preview === '' && !known.has(m.reply.id))
            .map((m) => m.reply?.id ?? ''),
        ),
      ];
      if (missing.length === 0) {
        setMessages((prev) => hydrateReplies(prev, [], true));
        return;
      }
      const result = await loadMessagesByIds(db, missing);
      if (channelRef.current !== forChannel) return;
      if (!result.ok) {
        logger.warn('chat: quoted messages load failed', { error: result.error.message });
        setMessages((prev) => hydrateReplies(prev, []));
        return;
      }
      const quoted = result.data.map((row) => rowToThreadMessage(row, currentUserId));
      setMessages((prev) => hydrateReplies(prev, quoted, true));
    },
    [db, currentUserId],
  );

  /** Fold fetched rows in: merge, lay the outbox back on top, then reactions + quotes. */
  const foldRows = useCallback(
    (fetched: ThreadMessage[], forChannel: string): void => {
      for (const m of fetched) {
        // A failed send whose row landed anyway (timeout after commit) is done.
        if (outboxRef.current.entries(forChannel).some((e) => e.id === m.id)) {
          outboxRef.current.remove(forChannel, m.id);
        }
      }
      const entries = outboxRef.current.entries(forChannel);
      setMessages((prev) => withOutboxBubbles(mergeFetched(prev, fetched), entries, currentUserId));
      if (fetched.length === 0) return;
      void attachReactions(
        fetched.map((m) => m.id),
        forChannel,
      );
      void resolveReplies(fetched, forChannel);
    },
    [currentUserId, attachReactions, resolveReplies],
  );

  // Load the latest page whenever the channel changes. The channel's unrecorded
  // sends (outbox) show at once and stay on top of whatever loads.
  useEffect(() => {
    lastCursorRef.current = null;
    setHasMore(false);
    if (channelId === null) {
      setMessages([]);
      setLoading(false);
      return;
    }
    setMessages(withOutboxBubbles([], outboxRef.current.entries(channelId), currentUserId));
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
      foldRows(fetched, channelId);
      setHasMore(page.data.hasMore);
      setLoading(false);
      if (peerUserId !== null) void attachPeerCursor(channelId, peerUserId);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, channelId, currentUserId, peerUserId, foldRows, attachPeerCursor]);

  // Live traffic for the open channel. A text message renders only from its
  // verified chat_messages row; the verifier logs a missing row once.
  useEffect(() => {
    if (client === null || channelId === null) return;
    const unsubscribe = subscribeIncoming({
      connection: asThreadConnection(client),
      channelId,
      currentUserId,
      onMessage: (live) => {
        void verifier.verify(live.id).then((lookup) => {
          if (!lookup.found) return;
          if (channelRef.current !== channelId || lookup.row.channel_id !== channelId) return;
          foldRows([rowToThreadMessage(lookup.row, currentUserId)], channelId);
        });
      },
      // The store reports ids-less messages (it sees every message); stay quiet here.
      onIgnored: () => {},
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
  }, [client, channelId, currentUserId, verifier, foldRows]);

  // Catch-up from Postgres, never gated on the Agora state: rows newer than the
  // newest recorded message (paging past the 200 cap), or the latest page when
  // nothing is recorded yet, then the unread refresh. One run at a time.
  const catchUp = useCallback((): void => {
    if (catchingUpRef.current) return;
    const forChannel = channelRef.current;
    if (forChannel === null) {
      onCaughtUpRef.current?.();
      return;
    }
    catchingUpRef.current = true;
    const cursor = newestCursor(messagesRef.current);
    void (async (): Promise<void> => {
      try {
        const outcome = await catchUpRows(
          {
            loadLatest: () => loadLatestMessages(db, forChannel),
            loadNewer: (from) => loadNewerMessages(db, forChannel, from),
          },
          cursor,
        );
        if (channelRef.current !== forChannel) return;
        if (!outcome.ok) {
          logger.warn('chat: catch-up load failed', {
            channel_id: forChannel,
            error: outcome.error,
          });
        }
        const fetched = outcome.rows.map((row) => rowToThreadMessage(row, currentUserId));
        if (fetched.length > 0) foldRows(fetched, forChannel);
        if (outcome.ok && outcome.latestPage !== undefined) setHasMore(outcome.latestPage.hasMore);
      } finally {
        catchingUpRef.current = false;
        onCaughtUpRef.current?.();
      }
    })();
  }, [db, currentUserId, foldRows]);

  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  // Tab visible, browser online, and every 60s while visible (cleared while
  // hidden and on unmount).
  useEffect(() => browserCatchUpTriggers(() => catchUpRef.current()), []);

  // Every transition to 'connected'.
  const previousStatusRef = useRef<ChatStatus>(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== 'connected' || previous === 'connected') return;
    catchUpRef.current();
  }, [status]);

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
      foldRows(fetched, forChannel);
      setHasMore(page.data.hasMore);
    })();
  }, [db, currentUserId, foldRows]);

  /**
   * Record a message (Postgres first), then publish it live. The outcome is
   * written to the channel's outbox whatever channel is open now; the visible
   * list is only touched while that channel is still open. A record failure is
   * always logged.
   */
  const deliver = useCallback(
    async (id: string, forChannel: string, entry: OutboxEntry): Promise<void> => {
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
      try {
        const outcome = await runSend(
          {
            recordMessage: (input) => sendMessageRecord({ client: db, ...input }),
            publishLive,
            // The row exists; receivers catch up from Postgres.
            onLiveWarning: (context) => logger.warn('chat: live publish did not complete', context),
            // The bubble goes 'sent' the moment the row exists, not after Agora.
            onRecorded: (message) => {
              outboxRef.current.remove(forChannel, id);
              if (channelRef.current === forChannel) {
                setMessages((prev) => upsertMessage(prev, message));
              }
              onOwnMessageRef.current?.(forChannel, entry.text, message.time);
            },
          },
          {
            id,
            channelId: forChannel,
            currentUserId,
            traceId,
            text: entry.text,
            local: entry.local,
          },
        );
        if (outcome.ok) return;
        settleSendFailure({
          outcome,
          id,
          channelId: forChannel,
          traceId,
          outbox: outboxRef.current,
          isOpen: () => channelRef.current === forChannel,
          markFailed: () => setMessages((prev) => setMessageState(prev, id, 'failed')),
          logError: (message, context) => logger.error(message, context),
        });
      } finally {
        inFlight.finish(id);
      }
    },
    [db, currentUserId, inFlight],
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
      const entry: OutboxEntry = {
        id,
        text: trimmed,
        local: { attachments: [...attachments], sharedPostIds: [...sharedPostIds], reply },
        state: 'sending',
      };
      outboxRef.current.put(forChannel, entry);
      setMessages((prev) => withOutboxBubbles(prev, [entry], currentUserId));
      inFlight.tryStart(id);
      await deliver(id, forChannel, entry);
    },
    [currentUserId, deliver, inFlight],
  );

  const retry = useCallback(
    (messageId: string): void => {
      const forChannel = channelRef.current;
      if (forChannel === null) return;
      const entry = outboxRef.current.entries(forChannel).find((e) => e.id === messageId);
      if (entry === undefined || entry.state !== 'failed') return;
      // A second tap while the first retry is still recording is ignored.
      if (!inFlight.tryStart(messageId)) return;
      outboxRef.current.setState(forChannel, messageId, 'sending');
      setMessages((prev) => setMessageState(prev, messageId, 'sending'));
      void deliver(messageId, forChannel, { ...entry, state: 'sending' });
    },
    [deliver, inFlight],
  );

  const toggleReaction = useCallback(
    (messageId: string, emoji: string, currentlyMine: boolean): void => {
      const forChannel = channelRef.current;
      if (forChannel === null) return;
      const op = currentlyMine ? 'remove' : 'add';
      const traceId = generateTraceId();
      setMessages((prev) => applyReactionOp(prev, { messageId, emoji, op, mine: true }));
      const params = { client: db, channelId: forChannel, messageId, emoji, traceId };
      void recordThenSignal({
        record: () => (currentlyMine ? removeReactionRecord(params) : addReactionRecord(params)),
        // Peers are signalled only once the record holds the reaction.
        signal: async () => {
          const connection = clientRef.current;
          const liveTarget = targetRef.current;
          if (connection === null || liveTarget === null) return;
          await sendSignal({
            connection: asSignalConnection(connection),
            target: liveTarget,
            createCmd: createCmdMessage,
            ext: reactionEventExt({ messageId, emoji, op }),
          });
        },
        onRecordFailed: (message) => {
          logger.warn('chat: reaction record failed', {
            trace_id: traceId,
            message_id: messageId,
            op,
            error: message,
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
        onSignalFailed: (error) =>
          logger.warn('chat: reaction signal failed', { trace_id: traceId, error: String(error) }),
      });
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
