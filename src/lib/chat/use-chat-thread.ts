// React adapter over thread.ts + history.ts + record.ts. Postgres is the record
// and the read path: the thread loads its latest page from chat_messages, pages
// older rows by keyset on scroll-to-top, and catches up (rows newer than the
// newest loaded) on tab visible, browser online, every transition to
// 'connected', and every 60s while visible, whatever the Agora state. Agora is
// live delivery only: an incoming text for the open channel is verified against
// its chat_messages row (RLS) and the ROW renders; an id with no row is
// dropped. Reaction / read signals arrive as command messages. A send is queued
// on the store's outbox and returns at once: the optimistic bubble shows in
// the same tick, and the background sender records it (chat_message_send
// FIRST; the returned row with its server created_at is what the thread shows),
// publishes it live, and retries it with the same id for as long as it takes
// (only a server refusal reads "Not sent"). Unrecorded sends live in
// the per-channel outbox, so switching channels keeps a sending or failed
// bubble and its Retry payload.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { newMessageId } from '@/lib/chat/message-id';
import { createCmdMessage, createTextMessage } from '@/lib/chat/message-factory';
import {
  loadLatestMessages,
  readLatestMessages,
  loadMessageById,
  loadMessagesByIds,
  loadNewerMessages,
  loadOlderMessages,
  loadPeerReadCursor,
  loadReactions,
  type HistoryPage,
} from '@/lib/chat/history';
import {
  browserCatchUpTriggers,
  catchUpRows,
  reactionRecheckIds,
  reactionRecheckWanted,
  rereadReactions,
  untouchedSince,
  type CatchUpReason,
} from '@/lib/chat/catch-up';
import { liveVerifierFor, type LiveVerifier } from '@/lib/chat/live-verify';
import {
  messagePreviewContent,
  previewText,
  type ChannelOutbox,
  type OutboxEntry,
} from '@/lib/chat/chat-store';
import {
  addReactionRecord,
  deleteOutcomeCopy,
  removeReactionRecord,
  sendMessageRecord,
  setReadCursorRecord,
} from '@/lib/chat/record';
import { createDebouncer, READ_CURSOR_DEBOUNCE_MS } from '@/lib/chat/read-cursor';
import { LIVE_PUBLISH_TIMEOUT_MS, publishWithTimeout } from '@/lib/chat/send-flow';
import { forwardRecordInput, forwardableInOrder, runForward } from '@/lib/chat/forward';
import { withLateRead, type ChannelSummary } from '@/lib/chat-reads';
import { runDelete, runEdit } from '@/lib/chat/delete-flow';
import { findInOlderPages, type FindOlderOutcome } from '@/lib/chat/marks';
import { createInFlightGuard, recordThenSignal } from '@/lib/chat/thread-actions';
import {
  applyEdit,
  applyEditFromRow,
  applyReactionOp,
  hydrateReplies,
  markMessagesDeleted,
  markReadUpTo,
  markReadUpToMessage,
  mergeFetched,
  mergeReactions,
  replaceReactions,
  newestCursor,
  oldestCursor,
  reactionEventExt,
  readEventExt,
  removeMessages,
  rowToThreadMessage,
  sendText,
  setMessageAttachments,
  setMessageState,
  subscribeIncoming,
  targetFromSummary,
  upsertMessage,
  withOutboxBubbles,
  type ChannelTarget,
  type ChatMessageRow,
  type MessageCursor,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { sendSignal, type TypingConnection } from '@/lib/chat/typing';
import {
  revokeLocalPreviews,
  type MessageAttachment,
  type ReplyQuote,
} from '@/lib/chat/attachments';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';

/** The whole jump-to (every older page it reads) ends within this. */
export const JUMP_BUDGET_MS = 5_000;

/** The chat's type for an edit, so a DM edit never sends "all" in p_mentions. */
export function editChannelType(target: ChannelTarget | null): 'dm' | 'group' | undefined {
  if (target === null) return undefined;
  return target.chatType === 'groupChat' ? 'group' : 'dm';
}

/**
 * The exact input editMessage hands runEdit: the edit itself plus the chat's
 * type. With `channelType` (the open chat's row: group or DM) that is used and
 * the live target is ignored, so an unsynced group, whose fan-out target is
 * singleChat, still edits as a group. Without it, from the target (absent when
 * there is none). Pure.
 */
export function editRunInput(input: {
  channelId: string;
  messageId: string;
  body: string;
  traceId: string;
  target: ChannelTarget | null;
  channelType?: 'dm' | 'group' | null;
}): Parameters<typeof runEdit>[1] {
  const channelType =
    input.channelType !== undefined
      ? (input.channelType ?? undefined)
      : editChannelType(input.target);
  return {
    channelId: input.channelId,
    messageId: input.messageId,
    body: input.body,
    traceId: input.traceId,
    ...(channelType !== undefined ? { channelType } : {}),
  };
}

/**
 * Page older history for a jump under one budget: when it runs out, the page
 * read in flight is aborted (its signal), no later page is handed to `onPage`,
 * and the jump ends as 'error'. `onDone` runs once it ends, however it ends.
 */
export async function findWithinBudget(params: {
  start: MessageCursor | undefined;
  targetId: string;
  loadPage: (cursor: MessageCursor, signal: AbortSignal) => Promise<Result<HistoryPage>>;
  onPage: (rows: ChatMessageRow[], hasMore: boolean) => void;
  onDone: (timedOut: boolean) => void;
  budgetMs?: number;
}): Promise<FindOlderOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<FindOlderOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('error');
    }, params.budgetMs ?? JUMP_BUDGET_MS);
  });
  try {
    const found = findInOlderPages({
      start: params.start,
      targetId: params.targetId,
      loadPage: (cursor) => params.loadPage(cursor, controller.signal),
      onPage: (rows, more) => {
        if (!controller.signal.aborted) params.onPage(rows, more);
      },
    }).catch((): FindOlderOutcome => 'error');
    return await Promise.race([found, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    params.onDone(controller.signal.aborted);
  }
}

export interface UseChatThread {
  messages: ThreadMessage[];
  loading: boolean;
  /** The latest page failed or timed out (5s): the thread shows Retry, never "No messages yet". */
  loadFailed: boolean;
  /** Re-run the latest-page load after a failure. */
  retryLoad: () => void;
  /** An older page is being fetched (scroll-to-top). */
  loadingOlder: boolean;
  /** Whether an older page may exist. */
  hasMore: boolean;
  /** Fetch the page before the oldest loaded message. */
  loadOlder: () => void;
  /**
   * Queue text and/or attachments and/or shared posts/briefs; a send with none
   * is a no-op. Synchronous: the bubble shows now, delivery runs in the background.
   */
  send: (
    text: string,
    attachments?: readonly MessageAttachment[],
    sharedPostIds?: readonly string[],
    reply?: ReplyQuote | null,
    sharedBriefIds?: readonly string[],
  ) => void;
  /**
   * Delete own messages for everyone (chunked at 100 per proc call). Accepted
   * chunks turn into tombstones at once and are signalled live; the first
   * failing chunk stops the run. A failure returns the user copy
   * (deleteOutcomeCopy: "Deleted N of M ..." or the mapped proc error, never
   * raw text) and the ids that were deleted.
   */
  deleteMessages: (
    messageIds: readonly string[],
  ) => Promise<{ ok: true } | { ok: false; message: string; deleted: readonly string[] }>;
  /**
   * Edit the body of an own message: recorded first, then the bubble shows the
   * returned row and peers are signalled live. A failure returns the user copy
   * ("Edit window has closed (15 min)", ...); the bubble never changes then.
   */
  editMessage: (
    messageId: string,
    body: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * Make sure a message is loaded: 'found' when it already is or an older page
   * brought it in (at most 10 pages), otherwise why it is not.
   */
  ensureLoaded: (messageId: string) => Promise<FindOlderOutcome>;
  /**
   * Forward messages to chats: for each chat, each message in thread order, a
   * fresh record (same body, attachments, shared posts and briefs; no reply)
   * then a live publish. Sequential; the first failure stops the run and names
   * its chat. A second call while one runs is ignored (resolves ok: false with
   * no chat).
   */
  forward: (
    messages: readonly ThreadMessage[],
    targets: readonly ChannelSummary[],
  ) => Promise<{ ok: true } | { ok: false; failed: ChannelSummary | null }>;
  /**
   * Resume a failed send (and its channel's queue) with the SAME message id. On
   * a send whose files were lost to a reload (filesMissing) it is the Remove:
   * the entry and its bubble are dropped.
   */
  retry: (messageId: string) => void;
  /** Add or remove the current user's reaction: optimistic, recorded, signalled live. */
  toggleReaction: (messageId: string, emoji: string, currentlyMine: boolean) => void;
  /** The newest message is on screen: advance the read cursor (debounced). */
  markNewestVisible: () => void;
}

/** In-flight guard key for a forward run (message ids are uuids, never this). */
const FORWARD_GUARD_KEY = 'forward';

/** A forward target's Agora target; a bad row yields none (the record still holds it). */
function liveTargetFor(channel: ChannelSummary): ChannelTarget | null {
  try {
    return targetFromSummary(channel);
  } catch {
    return null;
  }
}

/**
 * Ids of rows that were visible (not deleted) and come back from a fetch as
 * tombstones. Pure.
 */
export function newlyTombstoned(
  visible: readonly ThreadMessage[],
  fetched: readonly ThreadMessage[],
): string[] {
  const live = new Set(visible.filter((m) => m.deleted !== true).map((m) => m.id));
  return fetched.filter((m) => m.deleted === true && live.has(m.id)).map((m) => m.id);
}

/**
 * How far back a catch-up re-reads loaded rows: a message can be deleted for
 * everyone within 30 min (edited within 15), so an older row can no longer
 * change and a delete or edit signal missed on it would stay missed.
 */
export const REVALIDATE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Ids of loaded, recorded, non-tombstone rows created within the revalidate
 * window: the only rows a missed delete or edit can still touch. Pure.
 */
export function revalidationIds(messages: readonly ThreadMessage[], nowMs: number): string[] {
  const since = nowMs - REVALIDATE_WINDOW_MS;
  return messages
    .filter(
      (m) => m.deleted !== true && m.state === 'sent' && !m.provisionalTime && m.time >= since,
    )
    .map((m) => m.id);
}

/**
 * The catch-up recheck: one batched read of the revalidation ids, or null (no
 * read) when none qualify. Only on a 'connected' transition or a foreground
 * (visible, online) trigger, never on the periodic interval, so an open chat
 * stays at one read per interval.
 */
export function recheckLoaded(
  load: (ids: readonly string[]) => Promise<Result<ChatMessageRow[]>>,
  messages: readonly ThreadMessage[],
  nowMs: number,
  reason: CatchUpReason,
): Promise<Result<ChatMessageRow[]>> | null {
  if (reason === 'interval') return null;
  const ids = revalidationIds(messages, nowMs);
  return ids.length > 0 ? load(ids) : null;
}

/**
 * Fold re-read rows through the tombstone and applyEditFromRow paths: the new
 * list plus the ids that turned into tombstones (to report). Rows of another
 * channel are ignored. Pure.
 */
export function applyRevalidatedRows(
  messages: ThreadMessage[],
  rows: readonly ChatMessageRow[],
  channelId: string,
): { messages: ThreadMessage[]; deleted: string[] } {
  const own = rows.filter((r) => r.channel_id === channelId);
  const live = new Set(messages.filter((m) => m.deleted !== true).map((m) => m.id));
  const deleted = own.filter((r) => r.deleted_at !== null && live.has(r.id)).map((r) => r.id);
  let next = markMessagesDeleted(messages, deleted);
  for (const row of own) {
    if (row.deleted_at === null) next = applyEditFromRow(next, row);
  }
  return { messages: next, deleted };
}

/**
 * The re-read rows that carry an edit the loaded messages do not show yet (a
 * missed live edit): live rows of this channel whose edited_at is newer. Pure.
 */
export function editedRows(
  messages: readonly ThreadMessage[],
  rows: readonly ChatMessageRow[],
  channelId: string,
): ChatMessageRow[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return rows.filter((row) => {
    if (row.channel_id !== channelId || row.deleted_at !== null || row.edited_at === null) {
      return false;
    }
    const loaded = byId.get(row.id);
    return (
      loaded === undefined || loaded.editedAt !== row.edited_at || loaded.body !== (row.body ?? '')
    );
  });
}

/**
 * What an own edit does once recorded: the list line hears it (whatever chat
 * is open now), and the open thread shows the returned row when it is still
 * that chat. Pure wiring, so it is tested without a DOM.
 */
export function ownEditApplier(deps: {
  forChannel: string;
  openChannel: () => string | null;
  onEdited: (row: ChatMessageRow) => void;
  update: (fn: (prev: ThreadMessage[]) => ThreadMessage[]) => void;
}): (row: ChatMessageRow) => void {
  return (row) => {
    deps.onEdited(row);
    if (deps.openChannel() !== deps.forChannel) return;
    deps.update((prev) =>
      applyEdit(prev, {
        messageId: row.id,
        body: row.body ?? '',
        editedAt: row.edited_at ?? new Date().toISOString(),
      }),
    );
  };
}

/** How a latest-page load ended: the page, or a failure (an error or the 5s timeout). */
export type LatestLoadOutcome =
  | { kind: 'page'; page: HistoryPage }
  | { kind: 'failed'; message: string };

/**
 * Run one latest-page load. The read is bounded (loadLatestMessages times out
 * at 5s); a rejection is a failure too. Never throws, so the thread always
 * leaves its skeleton for rows, the empty state or Retry.
 */
export async function runLatestLoad(
  load: () => Promise<Result<HistoryPage>>,
): Promise<LatestLoadOutcome> {
  try {
    const result = await load();
    return result.ok
      ? { kind: 'page', page: result.data }
      : { kind: 'failed', message: result.error.message };
  } catch (error) {
    return { kind: 'failed', message: String(error) };
  }
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
  /**
   * A forward target's live target, resolved when it is sent (an unsynced
   * group fans out per member). Absent: the synced group or DM peer only.
   */
  resolveTarget?: (channel: ChannelSummary) => Promise<ChannelTarget | null>;
  /** The open chat's type from its row (group or DM); edits take it, never the target's chatType. */
  channelType?: 'dm' | 'group' | null;
  currentUserId: string;
  /** The DM peer, for the seen ticks; null for groups. */
  peerUserId: string | null;
  /** Called after a forward is recorded so the live store can show 'You: ...'. */
  onOwnMessage?: (channelId: string, text: string, ts: number, messageId?: string) => void;
  /** Called after each catch-up so the caller can refresh unread counts and marks. */
  onCaughtUp?: () => void;
  /** Called when messages of the open channel were deleted (by us or live by a peer); they stay as tombstones. */
  onMessagesDeleted?: (channelId: string, messageIds: readonly string[]) => void;
  /** Called with the recorded row after an edit lands (own, or a verified live edit). */
  onMessageEdited?: (row: ChatMessageRow) => void;
  /** Per-channel unrecorded sends and their background sender (the chat store's). */
  outbox: ChannelOutbox;
  /** Injected in tests; the app uses the shared Supabase client. */
  db?: Client;
  /** Injected in tests; the app shares one verifier per client with the store. */
  verifier?: LiveVerifier;
}): UseChatThread {
  const { client, status, channelId, target, currentUserId, peerUserId, onOwnMessage, onCaughtUp } =
    params;
  const db: Client = params.db ?? supabase;
  const verifier = params.verifier ?? liveVerifierFor(db);
  const outbox = params.outbox;
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // Live values the stable callbacks read.
  const messagesRef = useRef<ThreadMessage[]>([]);
  messagesRef.current = messages;
  const clientRef = useRef(client);
  clientRef.current = client;
  const targetRef = useRef(target);
  targetRef.current = target;
  const resolveTargetRef = useRef(params.resolveTarget);
  resolveTargetRef.current = params.resolveTarget;
  const channelTypeRef = useRef(params.channelType ?? null);
  channelTypeRef.current = params.channelType ?? null;
  // Local reaction toggles, numbered: a reactions re-read started before a
  // toggle never overwrites that message's reactions with its older result.
  const reactionTouchesRef = useRef<{ seq: number; byId: Map<string, number> }>({
    seq: 0,
    byId: new Map(),
  });
  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const onOwnMessageRef = useRef(onOwnMessage);
  onOwnMessageRef.current = onOwnMessage;
  const onCaughtUpRef = useRef(onCaughtUp);
  onCaughtUpRef.current = onCaughtUp;
  const onMessagesDeletedRef = useRef(params.onMessagesDeleted);
  onMessagesDeletedRef.current = params.onMessagesDeleted;
  const onMessageEditedRef = useRef(params.onMessageEdited);
  onMessageEditedRef.current = params.onMessageEdited;
  /** Messages became tombstones: tell the caller and the store (drafts, outbox, list line). */
  const reportDeleted = useCallback((forChannel: string, ids: readonly string[]): void => {
    onMessagesDeletedRef.current?.(forChannel, ids);
    outboxRef.current.messagesDeleted(ids);
  }, []);
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
        // A queued send whose row landed anyway (timeout after commit) is done.
        if (outboxRef.current.entries(forChannel).some((e) => e.id === m.id)) {
          outboxRef.current.settle(forChannel, m.id);
        }
      }
      const entries = outboxRef.current.entries(forChannel);
      // A load, catch-up or reload can turn a row on screen into a tombstone
      // (its delete signal was missed): report it like a live delete.
      const turned =
        channelRef.current === forChannel ? newlyTombstoned(messagesRef.current, fetched) : [];
      setMessages((prev) => withOutboxBubbles(mergeFetched(prev, fetched), entries, currentUserId));
      if (turned.length > 0) reportDeleted(forChannel, turned);
      if (fetched.length === 0) return;
      void attachReactions(
        fetched.map((m) => m.id),
        forChannel,
      );
      void resolveReplies(fetched, forChannel);
    },
    [currentUserId, attachReactions, resolveReplies, reportDeleted],
  );

  // Load the latest page whenever the channel changes (and on Retry). The
  // channel's unrecorded sends (outbox) show at once and stay on top of
  // whatever loads. A failed or timed-out (5s) read is the Retry state; a
  // timed-out read keeps running (withLateRead) and its late page still wins:
  // the rows show and the Retry state clears. A switch, unmount or Retry
  // aborts it.
  useEffect(() => {
    lastCursorRef.current = null;
    setHasMore(false);
    setLoadFailed(false);
    if (channelId === null) {
      setMessages([]);
      setLoading(false);
      return;
    }
    setMessages(withOutboxBubbles([], outboxRef.current.entries(channelId), currentUserId));
    let cancelled = false;
    const abort = new AbortController();
    setLoading(true);
    const applyPage = (page: HistoryPage): void => {
      const fetched = page.rows.map((row) => rowToThreadMessage(row, currentUserId));
      foldRows(fetched, channelId);
      setHasMore(page.hasMore);
      setLoadFailed(false);
      setLoading(false);
      if (peerUserId !== null) void attachPeerCursor(channelId, peerUserId);
    };
    void (async (): Promise<void> => {
      const outcome = await runLatestLoad(() =>
        withLateRead((signal) => readLatestMessages(db, channelId, signal), {
          onLate: (page) => {
            if (!cancelled) applyPage(page);
          },
          cancel: abort.signal,
        }),
      );
      if (cancelled) return;
      if (outcome.kind === 'failed') {
        logger.error('chat: history load failed', {
          channel_id: channelId,
          error: outcome.message,
        });
        setLoadFailed(true);
        setLoading(false);
        return;
      }
      applyPage(outcome.page);
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [db, channelId, currentUserId, peerUserId, foldRows, attachPeerCursor, loadAttempt]);

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
      // A sender can only delete or edit their own messages: ids of anyone
      // else's are ignored (the record is truth on the next load either way).
      onDelete: ({ messageIds, fromUserId }) => {
        if (channelRef.current !== channelId) return;
        const own = messagesRef.current
          .filter((m) => messageIds.includes(m.id) && m.senderUserId === fromUserId)
          .map((m) => m.id);
        if (own.length === 0) return;
        setMessages((prev) => markMessagesDeleted(prev, own));
        reportDeleted(channelId, own);
      },
      // The edit renders from the re-read row (like live messages), never the
      // Agora payload; a missing (deleted, unreadable) or unchanged row is ignored.
      onEdit: ({ messageId, fromUserId }) => {
        if (channelRef.current !== channelId) return;
        const target = messagesRef.current.find((m) => m.id === messageId);
        if (target === undefined || target.senderUserId !== fromUserId) return;
        void loadMessageById(db, messageId).then((lookup) => {
          if (!lookup.ok) {
            logger.warn('chat: live edit verification failed, ignored', {
              message_id: messageId,
              error: lookup.error.message,
            });
            return;
          }
          if (!lookup.data.found) return;
          const stored = lookup.data.row;
          if (channelRef.current !== channelId || stored.channel_id !== channelId) return;
          if (stored.sender_user_id !== fromUserId) return;
          setMessages((prev) => applyEditFromRow(prev, stored));
          onMessageEditedRef.current?.(stored);
        });
      },
    });
    return unsubscribe;
  }, [db, client, channelId, currentUserId, verifier, foldRows, reportDeleted]);

  // Catch-up from Postgres, never gated on the Agora state: rows newer than the
  // newest recorded message (paging past the 200 cap), or the latest page when
  // nothing is recorded yet, plus one batched re-read of loaded rows from the
  // last 30 min (a delete or edit signal missed on them; on 'connected' and
  // the foreground triggers only, never the interval), then the unread
  // refresh. One run at a time.
  const catchUp = useCallback(
    (reason: CatchUpReason): void => {
      if (catchingUpRef.current) return;
      const forChannel = channelRef.current;
      if (forChannel === null) {
        onCaughtUpRef.current?.();
        return;
      }
      catchingUpRef.current = true;
      const cursor = newestCursor(messagesRef.current);
      // Loaded rows a missed delete or edit can still touch: one batched re-read.
      const recheck = recheckLoaded(
        (ids) => loadMessagesByIds(db, ids),
        messagesRef.current,
        Date.now(),
        reason,
      );
      // Reactions a live signal missed: one batched re-read of every loaded
      // row (chunks of 100, 5s each), never on the interval.
      const reactionIds = reactionRecheckWanted(reason)
        ? reactionRecheckIds(messagesRef.current)
        : [];
      const reactionsFrom = reactionTouchesRef.current.seq;
      const reactionsRead =
        reactionIds.length > 0
          ? rereadReactions(
              (ids, signal) => loadReactions(db, ids, currentUserId, signal),
              reactionIds,
            )
          : Promise.resolve(null);
      void (async (): Promise<void> => {
        try {
          const [outcome, rechecked, reread] = await Promise.all([
            catchUpRows(
              {
                loadLatest: () => loadLatestMessages(db, forChannel),
                loadNewer: (from) => loadNewerMessages(db, forChannel, from),
              },
              cursor,
            ),
            recheck,
            reactionsRead,
          ]);
          if (channelRef.current !== forChannel) return;
          if (reread !== null && !reread.ok) {
            logger.warn('chat: catch-up reactions re-read failed', {
              channel_id: forChannel,
              error: reread.error.message,
            });
          }
          if (reread !== null && reread.ok) {
            const byId = reread.data;
            const apply = untouchedSince(
              reactionIds,
              reactionTouchesRef.current.byId,
              reactionsFrom,
            );
            setMessages((prev) => replaceReactions(prev, apply, byId));
          }
          if (rechecked !== null && !rechecked.ok) {
            logger.warn('chat: catch-up recheck failed', {
              channel_id: forChannel,
              error: rechecked.error.message,
            });
          }
          if (rechecked !== null && rechecked.ok) {
            const rows = rechecked.data;
            const { deleted } = applyRevalidatedRows(messagesRef.current, rows, forChannel);
            setMessages((prev) => applyRevalidatedRows(prev, rows, forChannel).messages);
            if (deleted.length > 0) reportDeleted(forChannel, deleted);
            // A missed edit found here moves the list line too (when it is the latest).
            for (const row of editedRows(messagesRef.current, rows, forChannel)) {
              onMessageEditedRef.current?.(row);
            }
          }
          if (!outcome.ok) {
            logger.warn('chat: catch-up load failed', {
              channel_id: forChannel,
              error: outcome.error,
            });
          }
          const fetched = outcome.rows.map((row) => rowToThreadMessage(row, currentUserId));
          if (fetched.length > 0) foldRows(fetched, forChannel);
          if (outcome.ok && outcome.latestPage !== undefined) {
            setHasMore(outcome.latestPage.hasMore);
            // The latest page landed after all (a first load that failed):
            // the Retry state goes, the rows are the thread.
            setLoadFailed(false);
          }
        } finally {
          catchingUpRef.current = false;
          onCaughtUpRef.current?.();
        }
      })();
    },
    [db, currentUserId, foldRows, reportDeleted],
  );

  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  // Tab visible, browser online, and every 60s while visible (cleared while
  // hidden and on unmount).
  useEffect(() => browserCatchUpTriggers((reason) => catchUpRef.current(reason)), []);

  // Every transition to 'connected'.
  const previousStatusRef = useRef<ChatStatus>(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== 'connected' || previous === 'connected') return;
    catchUpRef.current('connected');
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

  const ensureLoaded = useCallback(
    async (messageId: string): Promise<FindOlderOutcome> => {
      if (messagesRef.current.some((m) => m.id === messageId)) return 'found';
      const forChannel = channelRef.current;
      if (forChannel === null || loadingOlderRef.current) return 'error';
      loadingOlderRef.current = true;
      setLoadingOlder(true);
      let timedOut = false;
      const outcome = await findWithinBudget({
        start: oldestCursor(messagesRef.current),
        targetId: messageId,
        loadPage: (cursor, signal) => loadOlderMessages(db, forChannel, cursor, signal),
        onPage: (rows, more) => {
          if (channelRef.current !== forChannel) return;
          const fetched = rows.map((row) => rowToThreadMessage(row, currentUserId));
          // Keep the next page's cursor current before React re-renders.
          messagesRef.current = [...fetched, ...messagesRef.current];
          foldRows(fetched, forChannel);
          setHasMore(more);
        },
        onDone: (expired) => {
          timedOut = expired;
          loadingOlderRef.current = false;
          if (channelRef.current === forChannel) setLoadingOlder(false);
        },
      });
      if (outcome === 'error') {
        logger.warn('chat: jump-to page load failed', {
          channel_id: forChannel,
          message_id: messageId,
          timed_out: timedOut,
        });
      }
      return outcome;
    },
    [db, currentUserId, foldRows],
  );

  // Background sender updates for the open channel: a retry flips a bubble's
  // state, upload progress refreshes its tiles, a cancelled send's bubble
  // goes (the store released its files and previews), a recorded row replaces the
  // optimistic bubble (keeping the local previews, so the tile never swaps).
  // A send that records while its channel is not open has no bubble left to
  // show its previews: their object URLs are released.
  useEffect(
    () =>
      outbox.subscribe((event) => {
        if (channelRef.current !== event.channelId) {
          if (event.type === 'recorded') revokeLocalPreviews(event.message.attachments);
          return;
        }
        if (event.type === 'recorded') {
          const message = event.message;
          // The row replaces its bubble; the sends queued behind it are laid
          // back on (the sender keeps them after it).
          const behind = outbox.entries(event.channelId);
          setMessages((prev) =>
            withOutboxBubbles(upsertMessage(prev, message), behind, currentUserId),
          );
          return;
        }
        if (event.type === 'progress') {
          const { id, attachments } = event;
          setMessages((prev) => setMessageAttachments(prev, id, attachments));
          return;
        }
        // Cancelled with the X: the bubble (caption included) goes at once.
        if (event.type === 'cancelled') {
          const { id } = event;
          setMessages((prev) => removeMessages(prev, [id]));
          return;
        }
        // A restored send whose files could not be read back reads "Photos
        // not sent" (Remove only), as when it is laid over a fresh load.
        const lost =
          outboxRef.current.entries(event.channelId).find((e) => e.id === event.id)
            ?.filesMissing === true;
        setMessages((prev) =>
          lost
            ? prev.map((m) =>
                m.id === event.id ? { ...m, state: event.state, filesMissing: true } : m,
              )
            : setMessageState(prev, event.id, event.state),
        );
      }),
    [outbox, currentUserId],
  );

  // Recorded bubbles keep their local previews for the session; when the
  // thread leaves the channel (or unmounts) those bubbles go, and so do their
  // object URLs. Unrecorded ones stay in the outbox and keep theirs.
  useEffect(
    () => () => {
      const recorded = messagesRef.current.filter((m) => m.state === 'sent');
      revokeLocalPreviews(recorded.flatMap((m) => m.attachments));
    },
    [channelId],
  );

  const send = useCallback<UseChatThread['send']>(
    (text, attachments = [], sharedPostIds = [], reply = null, sharedBriefIds = []) => {
      const forChannel = channelRef.current;
      const trimmed = text.trim();
      if (
        forChannel === null ||
        (trimmed === '' &&
          attachments.length === 0 &&
          sharedPostIds.length === 0 &&
          sharedBriefIds.length === 0)
      )
        return;
      const entry: OutboxEntry = {
        id: newMessageId(),
        text: trimmed,
        local: {
          attachments: [...attachments],
          sharedPostIds: [...sharedPostIds],
          sharedBriefIds: [...sharedBriefIds],
          reply,
        },
        state: 'sending',
      };
      // The store stamps the tap with its estimated server time (createdMs):
      // the bubble's place, day pill and time label.
      outboxRef.current.enqueue(forChannel, entry);
      const queued = outboxRef.current.entries(forChannel).find((e) => e.id === entry.id) ?? {
        ...entry,
        createdMs: Date.now(),
      };
      setMessages((prev) => withOutboxBubbles(prev, [queued], currentUserId));
    },
    [currentUserId],
  );

  const forward = useCallback<UseChatThread['forward']>(
    async (messages, targets) => {
      const sources = forwardableInOrder(messages);
      if (sources.length === 0 || targets.length === 0) return { ok: true };
      // One forward at a time: a double tap on "Send" never sends twice.
      if (!inFlight.tryStart(FORWARD_GUARD_KEY)) return { ok: false, failed: null };
      try {
        const result = await runForward({
          targets,
          messages: sources,
          sendOne: async (channel, source) => {
            const id = newMessageId();
            const traceId = generateTraceId();
            const input = forwardRecordInput(source, { id, channelId: channel.channelId, traceId });
            let recorded: ThreadMessage | null = null;
            let failure = '';
            await recordThenSignal({
              record: async () => {
                const outcome = await sendMessageRecord({ client: db, ...input });
                if (!outcome.ok) return { ok: false, message: outcome.message };
                recorded = rowToThreadMessage(outcome.row, currentUserId);
                if (channelRef.current === channel.channelId) {
                  const shown = recorded;
                  setMessages((prev) => upsertMessage(prev, shown));
                }
                onOwnMessageRef.current?.(
                  channel.channelId,
                  previewText(messagePreviewContent(source)),
                  recorded.time,
                  recorded.id,
                );
                return { ok: true };
              },
              // The row exists; a slow or failed live publish never fails the forward.
              signal: async () => {
                const connection = clientRef.current;
                const resolve = resolveTargetRef.current;
                const liveTarget =
                  resolve !== undefined ? await resolve(channel) : liveTargetFor(channel);
                if (connection === null || liveTarget === null) return;
                const published = await publishWithTimeout(
                  sendText({
                    connection: asThreadConnection(connection),
                    target: liveTarget,
                    text: input.body,
                    attachments: source.attachments,
                    sharedPostIds: source.sharedPostIds,
                    reply: null,
                    createMessage: createTextMessage,
                    liveIds: { sorted_message_id: id, sorted_channel_id: channel.channelId },
                    forwardedFrom: source.id,
                  }),
                  LIVE_PUBLISH_TIMEOUT_MS,
                );
                if (!published.ok) throw new Error(published.error);
              },
              onRecordFailed: (message) => {
                failure = message;
                logger.error('chat: forward record failed', {
                  trace_id: traceId,
                  message_id: id,
                  channel_id: channel.channelId,
                  forwarded_from: source.id,
                  error: message,
                });
              },
              onSignalFailed: (error) =>
                logger.warn('chat: live publish did not complete', {
                  trace_id: traceId,
                  message_id: id,
                  error: String(error),
                }),
            });
            return recorded !== null ? { ok: true } : { ok: false, message: failure };
          },
        });
        return result.ok ? { ok: true } : { ok: false, failed: result.failed };
      } finally {
        inFlight.finish(FORWARD_GUARD_KEY);
      }
    },
    [db, currentUserId, inFlight],
  );

  const retry = useCallback(
    (messageId: string): void => {
      const forChannel = channelRef.current;
      if (forChannel === null) return;
      const entry = outboxRef.current.entries(forChannel).find((e) => e.id === messageId);
      if (entry?.filesMissing === true) {
        outboxRef.current.settle(forChannel, messageId);
        revokeLocalPreviews(entry.local.attachments);
        setMessages((prev) => removeMessages(prev, [messageId]));
        return;
      }
      outboxRef.current.retry(forChannel, messageId);
      // The tap re-stamped it: the bubble moves to its new time (the bottom) now,
      // and its record lands there.
      const retried = outboxRef.current.entries(forChannel).find((e) => e.id === messageId);
      if (retried !== undefined && retried.createdMs !== entry?.createdMs) {
        setMessages((prev) => withOutboxBubbles(prev, [retried], currentUserId));
      }
    },
    [currentUserId],
  );

  const toggleReaction = useCallback(
    (messageId: string, emoji: string, currentlyMine: boolean): void => {
      const forChannel = channelRef.current;
      if (forChannel === null) return;
      const op = currentlyMine ? 'remove' : 'add';
      const traceId = generateTraceId();
      const touches = reactionTouchesRef.current;
      touches.seq += 1;
      touches.byId.set(messageId, touches.seq);
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

  const deleteMessages = useCallback<UseChatThread['deleteMessages']>(
    async (messageIds) => {
      const forChannel = channelRef.current;
      if (forChannel === null || messageIds.length === 0) return { ok: true };
      const traceId = generateTraceId();
      const connection = clientRef.current;
      const liveTarget = targetRef.current;
      const result = await runDelete(
        {
          client: db,
          markDeletedLocal: (ids) => {
            if (channelRef.current === forChannel) {
              setMessages((prev) => markMessagesDeleted(prev, ids));
            }
            reportDeleted(forChannel, ids);
          },
          signal:
            connection !== null && liveTarget !== null
              ? (ext) =>
                  sendSignal({
                    connection: asSignalConnection(connection),
                    target: liveTarget,
                    createCmd: createCmdMessage,
                    ext,
                  })
              : undefined,
          onSignalFailed: (error) =>
            logger.warn('chat: delete signal failed', { trace_id: traceId, error: String(error) }),
        },
        { channelId: forChannel, messageIds, traceId },
      );
      if (result.ok) return { ok: true };
      logger.warn('chat: delete failed', {
        trace_id: traceId,
        deleted: result.deleted.length,
        error: result.message,
      });
      return {
        ok: false,
        message: deleteOutcomeCopy(result.deleted.length, messageIds.length, result.message),
        deleted: result.deleted,
      };
    },
    [db, reportDeleted],
  );

  const editMessage = useCallback<UseChatThread['editMessage']>(
    async (messageId, body) => {
      const forChannel = channelRef.current;
      if (forChannel === null) return { ok: false, message: "Couldn't edit, try again" };
      const traceId = generateTraceId();
      const connection = clientRef.current;
      const liveTarget = targetRef.current;
      const result = await runEdit(
        {
          client: db,
          applyLocal: ownEditApplier({
            forChannel,
            openChannel: () => channelRef.current,
            onEdited: (row) => onMessageEditedRef.current?.(row),
            update: (fn) => setMessages(fn),
          }),
          signal:
            connection !== null && liveTarget !== null
              ? (ext) =>
                  sendSignal({
                    connection: asSignalConnection(connection),
                    target: liveTarget,
                    createCmd: createCmdMessage,
                    ext,
                  })
              : undefined,
          onSignalFailed: (error) =>
            logger.warn('chat: edit signal failed', { trace_id: traceId, error: String(error) }),
        },
        editRunInput({
          channelId: forChannel,
          messageId,
          body,
          traceId,
          target: liveTarget,
          channelType: channelTypeRef.current,
        }),
      );
      if (result.ok) return { ok: true };
      logger.warn('chat: edit failed', {
        trace_id: traceId,
        message_id: messageId,
        error: result.error,
      });
      return { ok: false, message: result.message };
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
    loadFailed,
    retryLoad,
    loadingOlder,
    hasMore,
    loadOlder,
    send,
    forward,
    deleteMessages,
    editMessage,
    ensureLoaded,
    retry,
    toggleReaction,
    markNewestVisible,
  };
}
