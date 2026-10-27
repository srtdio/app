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
//
// A cold open is ONE chat_open_bundle call (open-bundle.ts): the latest page
// with its reactions, quoted and root rows and the channel's cursors (and the
// other hooks' parts) in one round trip, started while the switch renders so
// every other hook of the open joins it. If it fails the thread shows its
// failed-load state with Retry (a fresh bundle).
//
// A chat opened before in this session reopens from memory (open-cache): its
// remembered page is the first frame (no skeleton), then one background
// revalidation brings it level with the record: the same bundle call from the
// remembered page's contiguous end (p_since), one batched re-read of the
// remembered rows by id and one batched reactions read. While the thread shows a chat it owns that chat's
// rows and writes them back when it leaves; while closed, live events land
// on the remembered rows through the same apply functions used here.
//
// Remembered pages are also saved on the device (open-cache.ts), so a cold
// open reopens a chat the same way; the open chat's page is kept (and saved)
// when the tab hides too, so closing the app keeps the chat on screen. The
// top chats are pre-warmed at idle (prewarmChats): the open's bundle read,
// folded as an open folds it and kept as the page the open would leave
// behind, so the first tap reopens with no skeleton. A tap within
// PREWARM_FRESH_MS of the pre-warm takes its bundle as the open's own and
// skips the revalidation (open-bundle.ts, openedFromPrewarm).

import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { newMessageId } from '@/lib/chat/message-id';
import { createCmdMessage, createTextMessage } from '@/lib/chat/message-factory';
import {
  CATCH_UP_LIMIT,
  aggregateReactions,
  loadLatestMessages,
  readChatOpenBundle,
  loadMessageById,
  loadMessagesByIds,
  loadNewerMessages,
  loadOlderMessages,
  loadPeerReadCursor,
  loadReactions,
  loadReadPositions,
  type ChatOpenBundle,
  type PeerReadCursor,
  type ReadPositionsRead,
  type HistoryPage,
} from '@/lib/chat/history';
import {
  joinChatBundle,
  openedFromPrewarm,
  startChatBundle,
  type ChatBundleDeps,
} from '@/lib/chat/open-bundle';
import { sharedChatRead } from '@/lib/chat/workspace-reads';
import {
  browserCatchUpTriggers,
  catchUpRows,
  createContiguityTracker,
  reactionRecheckIds,
  reactionRecheckWanted,
  rereadReactions,
  untouchedSince,
  windowFocusTrigger,
  type CatchUpReason,
} from '@/lib/chat/catch-up';
import { liveVerifierFor, type LiveVerifier } from '@/lib/chat/live-verify';
import {
  chatKey,
  openCache,
  rememberedWindow,
  withOwnCursor,
  type ChatKey,
  type OpenCache,
  type RememberedThread,
} from '@/lib/chat/open-cache';
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
import {
  openCursorFrom,
  resolvePositions,
  type OpenCursor,
  type ReadPosition,
} from '@/lib/chat/read-receipts';
import { LIVE_PUBLISH_TIMEOUT_MS, publishWithTimeout } from '@/lib/chat/send-flow';
import { forwardRecordInput, forwardableInOrder, runForward } from '@/lib/chat/forward';
import { withLateRead, withReadTimeout, type ChannelSummary } from '@/lib/chat-reads';
import {
  attachmentAssetIds,
  purgeChatFiles,
  runDelete,
  runEdit,
  type PurgeChatOutcome,
} from '@/lib/chat/delete-flow';
import { findInOlderPages, type FindOlderOutcome } from '@/lib/chat/marks';
import { createInFlightGuard, recordThenSignal } from '@/lib/chat/thread-actions';
import {
  applyEdit,
  applyEditFromRow,
  applyLiveDelete,
  applyLiveEditRow,
  applyLiveRead,
  applyLiveReaction,
  applyReactionOp,
  liveEditWanted,
  hydrateReplies,
  hydrateRoots,
  missingRootIds,
  markMessagesDeleted,
  markReadUpTo,
  mergeFetched,
  mergeReactions,
  replaceReactions,
  oldestCursor,
  reactionEventExt,
  readEventExt,
  removeMessages,
  rowCursor,
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
  type MessageReaction,
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
import { channelOlderKey, setOlderPageFailed } from '@/lib/chat/older-page-status';

/**
 * The channel's read cursors for the reading layer: every member's position
 * (live as cursors change) and the viewer's own cursor as it stood on open,
 * read before this thread writes any cursor.
 */
export interface ThreadReadState {
  status: 'loading' | 'ready' | 'failed';
  positions: ReadonlyMap<string, ReadPosition>;
  open: OpenCursor;
  /** Re-read the cursors (a sheet's Retry). */
  retry: () => void;
}

const NO_READS: ReadPositionsRead = { rows: [], times: new Map() };

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
  channelType?: 'dm' | 'group' | 'notes' | null;
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
  /** The chat `messages` belongs to (it follows a switch in the same render). */
  channelId: string | null;
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
   * raw text) and the ids that were deleted. Messages with files: their asset
   * ids are read before the delete and sent to POST /purge-chat once it is
   * recorded (a failed purge never undoes it); ok then carries the toast.
   */
  deleteMessages: (
    messageIds: readonly string[],
    /**
     * The chat the ids belong to; absent: the open chat. A delete committed
     * after its Undo window may land once the chat was left (FT39).
     */
    channelId?: string,
  ) => Promise<
    { ok: true; toast?: string } | { ok: false; message: string; deleted: readonly string[] }
  >;
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
  /** Every member's read cursor plus the viewer's cursor as it was on open. */
  readState: ThreadReadState;
  /** The newest message is on screen: advance the read cursor (debounced). */
  markNewestVisible: () => void;
  /**
   * Show an own row recorded outside the outbox (a scheduled message sent now)
   * the way a normal send's recorded row lands, then publish it live with the
   * normal send's publish. A publish failure is only logged (the row is in the
   * record; receivers catch up from Postgres).
   */
  addSentRow: (row: ChatMessageRow, traceId: string) => Promise<void>;
  /**
   * A message's created_at when this thread has read it: a thread root read
   * by reply hydration (not loaded), else a loaded row. The reply counts read
   * takes its lower bound from it.
   */
  rootCreatedAt: (rootId: string) => string | undefined;
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
export type LatestLoadOutcome<T = HistoryPage> =
  | { kind: 'page'; page: T }
  | { kind: 'failed'; message: string };

/**
 * Run one latest-page load (the open's bundle, or a page). The read is
 * bounded (5s); a rejection is a failure too. Never throws, so the thread
 * always leaves its skeleton for rows, the empty state or Retry.
 */
export async function runLatestLoad<T = HistoryPage>(
  load: () => Promise<Result<T>>,
): Promise<LatestLoadOutcome<T>> {
  try {
    const result = await load();
    return result.ok
      ? { kind: 'page', page: result.data }
      : { kind: 'failed', message: result.error.message };
  } catch (error) {
    return { kind: 'failed', message: String(error) };
  }
}

/** What a reopen's background revalidation read. */
export type ReopenRead =
  /**
   * More new rows than one forward read holds: the remembered page is dropped
   * (no gap shown). `bundle`: the read was the latest page itself (nothing was
   * contiguous), so it is the fresh open's page; null: a fresh open reads.
   */
  | { kind: 'gap'; bundle: ChatOpenBundle | null }
  | {
      kind: 'read';
      /** Rows at or after the remembered page's end (oldest first); null: that read failed. */
      newer: ChatMessageRow[] | null;
      /** The bundle they came in (their reactions, quotes, roots); null: it failed. */
      bundle: ChatOpenBundle | null;
      /** Where the record is contiguous through after `newer`. */
      through: MessageCursor | undefined;
      /** The remembered rows re-read by id; null: failed. */
      rechecked: ChatMessageRow[] | null;
      /** The remembered rows' reactions as recorded; null: failed. */
      reactions: Map<string, MessageReaction[]> | null;
      /** Which rows the reactions read covered. */
      checkedIds: string[];
    };

/** The reads a reopen's revalidation makes (the app's history reads; tests pass fakes). */
export interface ReopenLoaders {
  /**
   * The open's chat bundle from `since` (p_since: the remembered page's
   * contiguous end, inclusive), or the latest page when null.
   */
  loadBundle: (since: string | null, signal: AbortSignal) => Promise<Result<ChatOpenBundle>>;
  loadByIds: (ids: readonly string[], signal: AbortSignal) => Promise<Result<ChatMessageRow[]>>;
  loadReactions: (
    ids: readonly string[],
    signal: AbortSignal,
  ) => Promise<Result<Map<string, MessageReaction[]>>>;
}

/**
 * A reopen's safety net for events missed while closed (asleep, away, sent
 * outside live delivery, notes): the open's bundle from `through` (p_since;
 * the latest page when nothing was contiguous), one IN re-read of the
 * remembered rows (edited_at, deleted_at, body) and one IN reactions read, all
 * at once, each bounded at 5s by its reader. A bundle with has_more means
 * more followed than it holds: 'gap'.
 */
export async function revalidateRemembered(
  loaders: ReopenLoaders,
  remembered: Pick<RememberedThread, 'rows' | 'through'>,
  signal: AbortSignal,
): Promise<ReopenRead> {
  const ids = remembered.rows.slice(-CATCH_UP_LIMIT).map((m) => m.id);
  const through = remembered.through;
  const since = through !== undefined ? through.createdAt : null;
  const [forward, rechecked, reactions] = await Promise.all([
    loaders.loadBundle(since, signal),
    ids.length > 0 ? loaders.loadByIds(ids, signal) : Promise.resolve(null),
    ids.length > 0 ? loaders.loadReactions(ids, signal) : Promise.resolve(null),
  ]);
  if (forward.ok && forward.data.page.hasMore) {
    return { kind: 'gap', bundle: since === null ? forward.data : null };
  }
  const rows = forward.ok ? forward.data.page.rows : null;
  const newest = rows !== null ? rows[rows.length - 1] : undefined;
  return {
    kind: 'read',
    newer: rows,
    bundle: forward.ok ? forward.data : null,
    through: newest !== undefined ? rowCursor(newest) : through,
    rechecked: rechecked === null ? [] : rechecked.ok ? rechecked.data : null,
    reactions: reactions === null ? new Map() : reactions.ok ? reactions.data : null,
    checkedIds: ids,
  };
}

/**
 * The page an open of this bundle leaves behind, built by the open's own
 * fold (applyOpenBundle over no rows and no outbox) and the leave's window
 * (rememberedWindow); null when the chat has no rows (an empty page is never
 * kept). Pure.
 */
export function rememberedFromBundle(
  bundle: ChatOpenBundle,
  currentUserId: string,
): RememberedThread | null {
  const fetched = bundle.page.rows.map((row) => rowToThreadMessage(row, currentUserId));
  const quoted = bundle.quoted.map((row) => rowToThreadMessage(row, currentUserId));
  const reactions = aggregateReactions(bundle.reactions, currentUserId);
  const folded = applyOpenBundle([], { fetched, quoted, reactions, entries: [], currentUserId });
  const window = rememberedWindow(folded, bundle.page.hasMore);
  if (window.rows.length === 0) return null;
  const newest = bundle.page.rows[bundle.page.rows.length - 1];
  return {
    rows: window.rows,
    hasMore: window.hasMore,
    through: newest !== undefined ? rowCursor(newest) : undefined,
    reads: bundle.readPositions,
    unresolved: awaitingResolve(window.rows),
  };
}

/** The most chats one list load pre-warms. */
export const PREWARM_LIMIT = 5;

/** What a pre-warm needs (the app's; tests pass fakes). */
export interface PrewarmDeps {
  store?: OpenCache;
  /** The open's chat_open_bundle read for a chat with no remembered page (p_since null). */
  read: (key: ChatKey) => Promise<Result<ChatOpenBundle>>;
  /** Whether the device asks to save data (navigator.connection.saveData). */
  saveData: () => boolean;
  /**
   * Whether the list this pre-warm started for still shows (same user and
   * workspace): an answer that lands after a switch is dropped, never kept.
   */
  current: () => boolean;
}

/**
 * Pre-warm the top chats (most recent first) after the list painted: for at
 * most PREWARM_LIMIT of them with no remembered page, the open's bundle read
 * runs and its page is kept as an open would leave it (attach, keep,
 * release), so the first tap reopens from it with no skeleton; within
 * PREWARM_FRESH_MS that tap also takes the bundle as its own (open-bundle.ts:
 * no bundle, re-read or reactions read at the tap). Never notes
 * an open (no opened(), no open hold), never touches a chat a thread shows or
 * a tap already started, and does nothing under Save-Data. Never throws.
 */
export async function prewarmChats(keys: readonly ChatKey[], deps: PrewarmDeps): Promise<number> {
  const store = deps.store ?? openCache;
  if (deps.saveData() || !deps.current()) return 0;
  const busy = (key: ChatKey): boolean =>
    store.attached(key) ||
    store.joinable(key, 'bundle') ||
    store.recall(key, 'thread') !== undefined;
  const picked = keys.filter((key) => !busy(key)).slice(0, PREWARM_LIMIT);
  if (picked.length === 0) return 0;
  mark('chat:prewarm:start');
  const kept = await Promise.all(
    picked.map(async (key) => {
      let result: Result<ChatOpenBundle>;
      try {
        result = await deps.read(key);
      } catch {
        return false;
      }
      // A switch since, or a tap or a thread got there first: the open's own read wins.
      if (!result.ok || !deps.current() || busy(key)) return false;
      const page = rememberedFromBundle(result.data, key.userId);
      if (page === null) return false;
      const owner = store.attach(key);
      owner.keep(page);
      owner.release();
      // The bundle stays beside the page: a tap within PREWARM_FRESH_MS opens
      // from it (its marks, scheduled rows, cursors and posts too), no re-read.
      store.notePrewarm(key, result.data);
      return true;
    }),
  );
  mark('chat:prewarm:end');
  return kept.filter(Boolean).length;
}

/**
 * Fold a reopen's re-reads into the rows: reactions as recorded (rows a local
 * toggle touched since are left alone), tombstones and edits from the re-read
 * rows. The same list when nothing changed. Pure.
 */
export function applyReopenChecks(
  messages: ThreadMessage[],
  read: Extract<ReopenRead, { kind: 'read' }>,
  channelId: string,
  untouched: (ids: readonly string[]) => string[] = (ids) => [...ids],
): { messages: ThreadMessage[]; deleted: string[] } {
  let next = messages;
  if (read.reactions !== null) {
    next = replaceReactions(next, untouched(read.checkedIds), read.reactions);
  }
  if (read.rechecked === null || read.rechecked.length === 0)
    return { messages: next, deleted: [] };
  return applyRevalidatedRows(next, read.rechecked, channelId);
}

/**
 * Fold an open's bundle rows in: merge (the outbox laid back on top), their
 * reactions as recorded, and their reply quotes and thread roots from the
 * bundle's quoted rows (settled: a quote the bundle could not return reads
 * the generic label). No read. Pure.
 */
export function applyOpenBundle(
  messages: ThreadMessage[],
  input: {
    fetched: readonly ThreadMessage[];
    quoted: readonly ThreadMessage[];
    reactions: Map<string, MessageReaction[]>;
    entries: readonly OutboxEntry[];
    currentUserId: string;
  },
): ThreadMessage[] {
  const ids = input.fetched.map((m) => m.id);
  const merged = withOutboxBubbles(
    mergeFetched(messages, [...input.fetched]),
    [...input.entries],
    input.currentUserId,
  );
  const reacted = replaceReactions(merged, ids, input.reactions);
  return hydrateRoots(hydrateReplies(reacted, input.quoted, true), input.quoted, new Set(ids));
}

/**
 * What a thread shows the moment it switches to a chat: a remembered page is
 * the first frame (rows with the outbox laid on top, ready cursors, no
 * loading); otherwise the outbox alone while the latest page loads. Pure.
 */
export function openingState(input: {
  channelId: string | null;
  page: RememberedThread | undefined;
  outbox: readonly OutboxEntry[];
  currentUserId: string;
}): {
  messages: ThreadMessage[];
  loading: boolean;
  hasMore: boolean;
  reads: {
    channelId: string | null;
    status: ThreadReadState['status'];
    read: ReadPositionsRead;
    open: OpenCursor;
  };
} {
  const { channelId, page, currentUserId } = input;
  if (channelId === null) {
    return {
      messages: [],
      loading: false,
      hasMore: false,
      reads: { channelId, status: 'loading', read: NO_READS, open: { kind: 'unknown' } },
    };
  }
  const messages = withOutboxBubbles(page?.rows ?? [], [...input.outbox], currentUserId);
  return {
    messages,
    loading: page === undefined,
    hasMore: page?.hasMore ?? false,
    reads:
      page?.reads !== null && page?.reads !== undefined
        ? {
            channelId,
            status: 'ready',
            read: page.reads,
            open: openCursorFrom(page.reads, currentUserId),
          }
        : { channelId, status: 'loading', read: NO_READS, open: { kind: 'unknown' } },
  };
}

/**
 * Rows whose reply quote or thread root is not resolved yet (a read still in
 * flight when the thread left), plus `pending` ids among them. Pure.
 */
export function awaitingResolve(
  rows: readonly ThreadMessage[],
  pending: ReadonlySet<string> = new Set(),
): string[] {
  const ids = new Set(rows.map((m) => m.id));
  return rows
    .filter(
      (m) =>
        pending.has(m.id) ||
        (m.reply !== null && m.reply.preview === '' && m.parentDeleted !== true) ||
        (m.threadRootId != null && !ids.has(m.threadRootId) && m.rootPostIds === undefined),
    )
    .map((m) => m.id);
}

/** The forward rows a reopen still has to fold in: ids not on screen yet. Pure. */
export function unseenRows(
  messages: readonly ThreadMessage[],
  rows: readonly ChatMessageRow[],
): ChatMessageRow[] {
  const shown = new Set(messages.map((m) => m.id));
  return rows.filter((row) => !shown.has(row.id));
}

/** Whether two cursor reads say the same thing (a background re-read changes nothing then). Pure. */
export function sameReadPositions(a: ReadPositionsRead, b: ReadPositionsRead): boolean {
  if (a.rows.length !== b.rows.length) return false;
  // A cursor whose message time is known is placed by it (lastReadAt is the fallback).
  // readAt is what Seen and Message info show, so a change to it alone counts.
  const key = (r: ReadPositionsRead['rows'][number], times: ReadPositionsRead['times']): string =>
    `${r.userId}\n${r.lastReadMessageId}\n${times.has(r.lastReadMessageId) ? '' : r.lastReadAt}\n${r.readAt ?? ''}`;
  const left = new Set(a.rows.map((r) => key(r, a.times)));
  if (!b.rows.every((r) => left.has(key(r, b.times)))) return false;
  for (const r of a.rows) {
    if (a.times.get(r.lastReadMessageId) !== b.times.get(r.lastReadMessageId)) return false;
  }
  return true;
}

/**
 * The DM peer's cursor as the channel's cursors read has it: the same
 * chat_read_cursors row loadPeerReadCursor selects, so the seen ticks need no
 * read of their own. Pure.
 */
export function peerCursorFrom(read: ReadPositionsRead, peerUserId: string): PeerReadCursor {
  const row = read.rows.find((r) => r.userId === peerUserId);
  return row === undefined
    ? { found: false }
    : { found: true, lastReadMessageId: row.lastReadMessageId, lastReadAt: row.lastReadAt };
}

/** Who takes an open's cursors read: the reading layer's first read, the DM seen ticks. */
export type PositionsTaker = 'reads' | 'peer';

/**
 * One cursors read per open, shared by its two takers: the first take for a
 * chat starts it, the other taker joins it. A taker asking again during the
 * same open (a Retry, a reopen falling back to a fresh page) gets null and
 * reads on its own, as it did before. `release` ends the open (the chat is
 * left): the next take for any chat starts over.
 */
export function createPositionsShare(
  load: (channelId: string) => Promise<Result<ReadPositionsRead>>,
): {
  take: (channelId: string, taker: PositionsTaker) => Promise<Result<ReadPositionsRead>> | null;
  release: (channelId: string) => void;
} {
  let held: {
    channelId: string;
    promise: Promise<Result<ReadPositionsRead>>;
    taken: Set<PositionsTaker>;
  } | null = null;
  return {
    take: (channelId, taker) => {
      if (held !== null && held.channelId === channelId) {
        if (held.taken.has(taker)) return null;
        held.taken.add(taker);
        return held.promise;
      }
      const promise = load(channelId);
      held = { channelId, promise, taken: new Set([taker]) };
      return promise;
    },
    release: (channelId) => {
      if (held !== null && held.channelId === channelId) held = null;
    },
  };
}

/** The Foundation client is the real connection; widen it to the messaging surface. */
function asThreadConnection(client: ChatConnection): ThreadConnection {
  return client as ThreadConnection;
}

function asSignalConnection(client: ChatConnection): TypingConnection {
  return client as TypingConnection;
}

/**
 * POST /purge-chat for a delete's files on the asset-upload Worker, with the
 * session's bearer token and a fresh trace. Missing config or session is a
 * failed purge (the nightly job sweeps the rows the delete marked).
 */
async function purgeChat(
  workspaceId: string | null,
  assetIds: string[],
): Promise<PurgeChatOutcome> {
  const endpoint = env.VITE_ASSET_UPLOAD_URL;
  if (endpoint === undefined || endpoint === '' || workspaceId === null) {
    return { ok: false, error: 'purge-chat not configured' };
  }
  const token = (await supabase.auth.getSession()).data.session?.access_token ?? '';
  if (token === '') return { ok: false, error: 'no session' };
  const traceId = generateTraceId();
  return purgeChatFiles({
    endpoint,
    token,
    workspaceId,
    assetIds,
    fetcher: (input, init) => fetchWithTrace(input, init, traceId),
  });
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
  channelType?: 'dm' | 'group' | 'notes' | null;
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
  /**
   * Also catch up on window focus (notes: no live delivery, so another
   * device's notes land on focus, tab visible and open).
   */
  catchUpOnFocus?: boolean;
  /** The open workspace: with the user and the chat it keys the remembered page. */
  workspaceId?: string | null;
  /** Injected in tests; the app uses the tab's one store. */
  memory?: OpenCache;
}): UseChatThread {
  const { client, status, channelId, target, currentUserId, peerUserId, onOwnMessage, onCaughtUp } =
    params;
  const db: Client = params.db ?? supabase;
  const verifier = params.verifier ?? liveVerifierFor(db);
  const outbox = params.outbox;
  const memory = params.memory ?? openCache;
  const workspaceId = params.workspaceId ?? null;
  const memoryKey = useMemo(
    () => chatKey(currentUserId, params.workspaceId ?? null, channelId),
    [currentUserId, params.workspaceId, channelId],
  );
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  // The open's one bundle call, over this thread's client and memory.
  const bundleDeps = useMemo<ChatBundleDeps>(
    () => ({
      store: memory,
      read: (input, signal) => readChatOpenBundle(db, input, signal),
      share: sharedChatRead,
      traceId: generateTraceId,
    }),
    [db, memory],
  );

  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const hasMoreRef = useRef(false);
  hasMoreRef.current = hasMore;

  // Live values the stable callbacks read.
  const messagesRef = useRef<ThreadMessage[]>([]);
  // created_at of the quoted and root rows reply hydration read (they are not loaded).
  const readTimesRef = useRef(new Map<string, string>());
  const rootCreatedAt = useCallback<UseChatThread['rootCreatedAt']>(
    (rootId) =>
      readTimesRef.current.get(rootId) ??
      messagesRef.current.find((m) => m.id === rootId)?.createdAt,
    [],
  );
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
  // contiguousThrough: catch-up reads from here, never from the newest row on
  // screen (a live row or an own send can sit past a row live delivery dropped).
  const contiguity = useMemo(() => createContiguityTracker(), []);
  const loadingOlderRef = useRef(false);
  const lastCursorRef = useRef<string | null>(null);
  // The reading layer's cursors: the raw read, its status, and the viewer's
  // cursor as captured on open. Until that first read settles (or fails at 5s)
  // the thread writes no cursor, so the capture is never this open's own write.
  const [reads, setReads] = useState<{
    channelId: string | null;
    status: ThreadReadState['status'];
    read: ReadPositionsRead;
    open: OpenCursor;
  }>({ channelId: null, status: 'loading', read: NO_READS, open: { kind: 'unknown' } });
  const [readAttempt, setReadAttempt] = useState(0);
  const openReadRef = useRef<{ settled: boolean; pendingWrite: boolean }>({
    settled: false,
    pendingWrite: false,
  });
  const markNewestRef = useRef<() => void>(() => {});
  // The cursors as last read for the open chat, for the page this thread leaves behind.
  const readsRef = useRef(reads);
  readsRef.current = reads;

  // A switch (or the mount): the chat's first frame is set while rendering,
  // so no frame ever shows the previous chat or a skeleton before a
  // remembered page. The load effect below then revalidates or loads.
  const [shownChannel, setShownChannel] = useState<string | null>(null);
  const seededRef = useRef<RememberedThread | undefined>(undefined);
  // The chat being left, as it stood: its cleanups (the page left behind,
  // the previews released) run after this render already holds the new chat.
  const leavingRef = useRef<{
    channelId: string | null;
    messages: ThreadMessage[];
    hasMore: boolean;
    reads: typeof reads;
  } | null>(null);
  if (shownChannel !== channelId) {
    leavingRef.current = {
      channelId: shownChannel,
      messages: messagesRef.current,
      hasMore: hasMoreRef.current,
      reads: readsRef.current,
    };
    setShownChannel(channelId);
    mark('chat:thread:switch');
    const page = memoryKey !== null ? memory.recall(memoryKey, 'thread') : undefined;
    const opening = openingState({
      channelId,
      page,
      outbox: channelId !== null ? outbox.entries(channelId) : [],
      currentUserId,
    });
    seededRef.current = page;
    // The open's bundle starts now, while the switch renders: every hook of
    // this open (the children's effects run first) joins it, none reads alone.
    if (memoryKey !== null && channelId !== null)
      void joinChatBundle(memoryKey, { deps: bundleDeps });
    setMessages(opening.messages);
    setLoading(opening.loading);
    setHasMore(opening.hasMore);
    setLoadFailed(false);
    setReads(opening.reads);
  }
  /** The rows, hasMore and cursors of a chat this thread is leaving (its cleanups read them). */
  const leaving = useCallback((forChannel: string | null) => {
    const left = leavingRef.current;
    return left !== null && left.channelId === forChannel
      ? left
      : {
          channelId: forChannel,
          messages: messagesRef.current,
          hasMore: hasMoreRef.current,
          reads: readsRef.current,
        };
  }, []);

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

  // The open's cursors read, shared by the reading layer and the seen ticks:
  // the open's bundle part while it can be joined, else a read of its own.
  const positionsShare = useMemo(
    () =>
      createPositionsShare((forChannel) => {
        const key = chatKey(currentUserId, workspaceId, forChannel);
        return (
          (key !== null ? memory.join(key, 'positions') : null) ?? loadReadPositions(db, forChannel)
        );
      }),
    [db, memory, currentUserId, workspaceId],
  );

  /**
   * Apply the DM peer's recorded read position to the seen ticks: from the
   * open's cursors read (already running beside the page), else its own read.
   */
  const attachPeerCursor = useCallback(
    async (forChannel: string, peer: string): Promise<void> => {
      const shared = positionsShare.take(forChannel, 'peer');
      const read = shared !== null ? await shared : null;
      if (channelRef.current !== forChannel) return;
      let cursor: PeerReadCursor;
      if (read !== null && read.ok) {
        cursor = peerCursorFrom(read.data, peer);
      } else {
        const result = await loadPeerReadCursor(db, forChannel, peer);
        if (!result.ok) {
          if (channelRef.current === forChannel) {
            logger.warn('chat: peer read cursor load failed', { error: result.error.message });
          }
          return;
        }
        cursor = result.data;
      }
      if (channelRef.current !== forChannel) return;
      if (!cursor.found) return;
      const readAt = Date.parse(cursor.lastReadAt);
      if (Number.isNaN(readAt)) return;
      setMessages((prev) => markReadUpTo(prev, readAt));
    },
    [db, positionsShare],
  );

  /**
   * Fill the reply quotes and thread roots of freshly fetched rows: from what
   * is loaded, else one IN read for the quoted and root rows that are not.
   */
  const resolveReplies = useCallback(
    async (fetched: readonly ThreadMessage[], forChannel: string): Promise<void> => {
      const known = new Set([...messagesRef.current, ...fetched].map((m) => m.id));
      const missing = [
        ...new Set([
          ...fetched
            .filter((m) => m.reply !== null && m.reply.preview === '' && !known.has(m.reply.id))
            .map((m) => m.reply?.id ?? ''),
          ...missingRootIds(fetched, known),
        ]),
      ];
      // Only this batch's rows settle a root that cannot be read; another
      // batch whose read is still in flight keeps waiting for its own.
      const batch = new Set(fetched.map((m) => m.id));
      if (missing.length === 0) {
        setMessages((prev) => hydrateRoots(hydrateReplies(prev, [], true), [], batch));
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
      for (const m of quoted) readTimesRef.current.set(m.id, m.createdAt);
      setMessages((prev) => hydrateRoots(hydrateReplies(prev, quoted, true), quoted, batch));
    },
    [db, currentUserId],
  );

  /**
   * Fold fetched rows in: merge, lay the outbox back on top, then reactions +
   * quotes. `newOnly` (catch-up, which re-reads rows already folded live):
   * reactions and quotes are read for ids not loaded yet only, so a row
   * already on screen keeps its object.
   */
  const foldRows = useCallback(
    (fetched: ThreadMessage[], forChannel: string, newOnly = false): void => {
      const loaded = newOnly ? new Set(messagesRef.current.map((m) => m.id)) : null;
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
      const fresh = loaded === null ? fetched : fetched.filter((m) => !loaded.has(m.id));
      if (fresh.length === 0) return;
      void attachReactions(
        fresh.map((m) => m.id),
        forChannel,
      );
      void resolveReplies(fresh, forChannel);
    },
    [currentUserId, attachReactions, resolveReplies, reportDeleted],
  );

  /**
   * Fold an open's bundle in: its rows, their reactions and their quoted and
   * root rows all came in the one call, so nothing more is read. `newOnly`
   * (a reopen's catch-up): rows already on screen are left as they are.
   */
  const foldBundle = useCallback(
    (bundle: ChatOpenBundle, forChannel: string, newOnly = false): void => {
      const shown = new Set(messagesRef.current.map((m) => m.id));
      const all = bundle.page.rows.map((row) => rowToThreadMessage(row, currentUserId));
      const fetched = newOnly ? all.filter((m) => !shown.has(m.id)) : all;
      for (const m of fetched) {
        // A queued send whose row landed anyway (timeout after commit) is done.
        if (outboxRef.current.entries(forChannel).some((e) => e.id === m.id)) {
          outboxRef.current.settle(forChannel, m.id);
        }
      }
      const entries = outboxRef.current.entries(forChannel);
      const turned =
        channelRef.current === forChannel ? newlyTombstoned(messagesRef.current, fetched) : [];
      const quoted = bundle.quoted.map((row) => rowToThreadMessage(row, currentUserId));
      for (const m of quoted) readTimesRef.current.set(m.id, m.createdAt);
      const reactions = aggregateReactions(bundle.reactions, currentUserId);
      setMessages((prev) =>
        applyOpenBundle(prev, { fetched, quoted, reactions, entries, currentUserId }),
      );
      if (turned.length > 0) reportDeleted(forChannel, turned);
    },
    [currentUserId, reportDeleted],
  );
  // The load effect's Retry runs ask a fresh bundle (a failed one is never joined again).
  const attemptSeenRef = useRef(0);

  // Load the latest page whenever the channel changes (and on Retry). The
  // channel's unrecorded sends (outbox) show at once and stay on top of
  // whatever loads. A failed or timed-out (5s) read is the Retry state; a
  // timed-out read keeps running (withLateRead) and its late page still wins:
  // the rows show and the Retry state clears. A switch, unmount or Retry
  // aborts it.
  useEffect(() => {
    lastCursorRef.current = null;
    const epoch = contiguity.reset();
    setLoadFailed(false);
    if (channelId === null) {
      setHasMore(false);
      setMessages([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const abort = new AbortController();
    // This thread owns the chat's remembered page while it shows the chat.
    let owner = memoryKey !== null ? memory.attach(memoryKey) : null;
    const remembered = memoryKey !== null ? memory.recall(memoryKey, 'thread') : undefined;
    // Rows on screen came from this effect (a page or the memory): only then
    // is the page left behind on leaving.
    let shown = false;
    // Remembered rows whose quotes and roots are not resolved yet.
    const pendingResolve = new Set<string>();
    // A Retry (or a reopen whose memory was dropped) asks a fresh bundle.
    const retrying = loadAttempt !== attemptSeenRef.current;
    attemptSeenRef.current = loadAttempt;
    const settledOpen = (): void => {
      setLoadFailed(false);
      setLoading(false);
      shown = true;
      if (peerUserId !== null) void attachPeerCursor(channelId, peerUserId);
    };
    const applyPage = (page: HistoryPage): void => {
      const fetched = page.rows.map((row) => rowToThreadMessage(row, currentUserId));
      foldRows(fetched, channelId);
      contiguity.latestPageApplied(epoch, page.rows);
      setHasMore(page.hasMore);
      settledOpen();
    };
    const applyBundle = (bundle: ChatOpenBundle): void => {
      foldBundle(bundle, channelId);
      contiguity.latestPageApplied(epoch, bundle.page.rows);
      setHasMore(bundle.page.hasMore);
      // Its cursors came with it: a cursors read that failed with an earlier
      // bundle (all or nothing) is ready again.
      setReads((prev) =>
        prev.channelId === channelId && prev.status === 'failed'
          ? {
              channelId,
              status: 'ready',
              read: bundle.readPositions,
              open: openCursorFrom(bundle.readPositions, currentUserId),
            }
          : prev,
      );
      settledOpen();
      mark('chat:bundle:applied');
    };
    const failOpen = (message: string): void => {
      logger.error('chat: history load failed', { channel_id: channelId, error: message });
      setLoadFailed(true);
      setLoading(false);
      // A page that lands later (Retry) reads the peer's cursor as it is then.
      positionsShare.release(channelId);
    };
    const openFresh = (opts: { fresh: boolean; bundle?: ChatOpenBundle }): void => {
      setHasMore(false);
      setMessages(withOutboxBubbles([], outboxRef.current.entries(channelId), currentUserId));
      setLoading(true);
      const given = opts.bundle;
      if (given !== undefined) {
        applyBundle(given);
        return;
      }
      void (async (): Promise<void> => {
        if (memoryKey === null) {
          // No workspace to ask the bundle for: the latest page alone.
          const outcome = await runLatestLoad(() => loadLatestMessages(db, channelId));
          if (cancelled) return;
          if (outcome.kind === 'failed') failOpen(outcome.message);
          else applyPage(outcome.page);
          return;
        }
        const key = memoryKey;
        const outcome = await runLatestLoad(() =>
          withLateRead(
            () =>
              opts.fresh
                ? startChatBundle(key, { since: null, deps: bundleDeps })
                : joinChatBundle(key, { since: null, deps: bundleDeps }),
            {
              onLate: (bundle) => {
                if (!cancelled) applyBundle(bundle);
              },
              cancel: abort.signal,
            },
          ),
        );
        if (cancelled) return;
        if (outcome.kind === 'failed') failOpen(outcome.message);
        else applyBundle(outcome.page);
      })();
    };
    const reopen = (page: RememberedThread, key: NonNullable<typeof memoryKey>): void => {
      // The first frame: the remembered rows with the outbox laid on top, as a
      // load does (already on screen when the render's switch seeded this page).
      if (seededRef.current !== page) {
        const seeded = withOutboxBubbles(
          page.rows,
          outboxRef.current.entries(channelId),
          currentUserId,
        );
        messagesRef.current = seeded;
        hasMoreRef.current = page.hasMore;
        setMessages(seeded);
        setHasMore(page.hasMore);
        setLoading(false);
      } else {
        // The render's seed is a render-phase update, and React can drop it
        // after commit (a navigation into the chat): the same rows are queued
        // again here, as a no-op whenever the seed held.
        const newest = page.rows[page.rows.length - 1];
        if (newest !== undefined) {
          setMessages((prev) =>
            prev.some((m) => m.id === newest.id)
              ? prev
              : withOutboxBubbles(page.rows, outboxRef.current.entries(channelId), currentUserId),
          );
          setHasMore((prev) => prev || page.hasMore);
          setLoading(false);
        }
      }
      seededRef.current = undefined;
      contiguity.catchUpApplied(epoch, page.through);
      shown = true;
      for (const id of page.unresolved) pendingResolve.add(id);
      if (pendingResolve.size > 0) {
        void resolveReplies(
          page.rows.filter((m) => pendingResolve.has(m.id)),
          channelId,
        ).then(() => {
          if (!cancelled) pendingResolve.clear();
        });
      }
      if (peerUserId !== null) void attachPeerCursor(channelId, peerUserId);
      // The open took the pre-warm's bundle (within PREWARM_FRESH_MS): this
      // page is that bundle plus every live event since, so nothing is re-read.
      if (openedFromPrewarm(key, memory)) {
        mark('chat:reopen:prewarmed');
        return;
      }
      const reactionsFrom = reactionTouchesRef.current.seq;
      void revalidateRemembered(
        {
          // The open's bundle from the remembered page's end, bounded at 5s.
          loadBundle: (since) =>
            withReadTimeout(() => joinChatBundle(key, { since, deps: bundleDeps })),
          loadByIds: (ids, signal) => loadMessagesByIds(db, ids, signal),
          // The catch-up's batched reactions re-read (chunks of 100, 5s each).
          loadReactions: (ids) =>
            rereadReactions(
              (chunk, signal) => loadReactions(db, chunk, currentUserId, signal),
              ids,
            ),
        },
        page,
        abort.signal,
      ).then((read) => {
        if (cancelled || contiguity.epoch() !== epoch) return;
        if (read.kind === 'gap') {
          // Too much happened while away: today's fresh open, never a gap.
          // The fresh page this open loads is what it leaves behind (a new owner:
          // the forget voided the old one's write-back).
          memory.forget(key, 'thread');
          owner?.release();
          owner = memory.attach(key);
          shown = false;
          openFresh(read.bundle !== null ? { fresh: false, bundle: read.bundle } : { fresh: true });
          return;
        }
        if (read.newer === null || read.rechecked === null || read.reactions === null) {
          logger.warn('chat: reopen revalidation read failed', { channel_id: channelId });
          if (page.rows.length === 0) {
            // An empty remembered page with nothing read to fill it: a fresh
            // open (as a gap), never an empty chat for the rest of the session.
            memory.forget(key, 'thread');
            owner?.release();
            owner = memory.attach(key);
            shown = false;
            openFresh({ fresh: true });
            return;
          }
        }
        const untouched = (ids: readonly string[]): string[] =>
          untouchedSince(ids, reactionTouchesRef.current.byId, reactionsFrom);
        const checked = applyReopenChecks(messagesRef.current, read, channelId, untouched);
        if (checked.messages !== messagesRef.current) {
          setMessages((prev) => applyReopenChecks(prev, read, channelId, untouched).messages);
        }
        if (checked.deleted.length > 0) reportDeleted(channelId, checked.deleted);
        if (read.rechecked !== null) {
          for (const row of editedRows(messagesRef.current, read.rechecked, channelId)) {
            onMessageEditedRef.current?.(row);
          }
        }
        if (read.bundle !== null) {
          foldBundle(read.bundle, channelId, true);
          contiguity.catchUpApplied(epoch, read.through);
        }
      });
    };
    if (remembered !== undefined && memoryKey !== null) reopen(remembered, memoryKey);
    else openFresh({ fresh: retrying });
    /**
     * What this thread leaves behind: its server rows (the newest window) and
     * the cursors, the viewer's own as this thread last wrote it; null when no
     * server row is recorded.
     */
    const leftBehind = (): RememberedThread | null => {
      const left = leaving(channelId);
      const window = rememberedWindow(left.messages, left.hasMore);
      if (window.rows.length === 0) return null;
      const r = left.reads;
      let readsLeft = r.channelId === channelId && r.status === 'ready' ? r.read : null;
      const written = lastCursorRef.current;
      const cursorRow = written !== null ? left.messages.find((m) => m.id === written) : undefined;
      if (readsLeft !== null && cursorRow !== undefined) {
        readsLeft = withOwnCursor(
          readsLeft,
          currentUserId,
          { id: cursorRow.id, time: cursorRow.time },
          new Date().toISOString(),
        );
      }
      return {
        rows: window.rows,
        hasMore: window.hasMore,
        through: contiguity.through(),
        reads: readsLeft,
        // Quotes and roots still waiting are resolved on the next reopen.
        unresolved: awaitingResolve(window.rows, pendingResolve),
      };
    };
    // The tab hides (the app may close without a leave): the page as it
    // stands is kept now, so a cold open reopens this chat from the device.
    // Off the paint path; the thread keeps owning its rows.
    const onHidden = (): void => {
      if (cancelled || !shown || owner === null || document.visibilityState !== 'hidden') return;
      const page = leftBehind();
      if (page !== null) owner.keep(page);
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      cancelled = true;
      abort.abort();
      document.removeEventListener('visibilitychange', onHidden);
      if (owner === null) return;
      if (shown) {
        const page = leftBehind();
        if (page === null) {
          // No server rows recorded (a render before the page landed, or only
          // outbox rows): never remember an empty page; the next open is fresh.
          if (memoryKey !== null) memory.forget(memoryKey, 'thread');
          owner.release();
          return;
        }
        owner.keep(page);
      }
      owner.release();
    };
  }, [
    db,
    channelId,
    currentUserId,
    peerUserId,
    foldRows,
    foldBundle,
    attachPeerCursor,
    resolveReplies,
    reportDeleted,
    loadAttempt,
    contiguity,
    memory,
    memoryKey,
    leaving,
    positionsShare,
    bundleDeps,
  ]);

  // The channel's cursors, read once on open (in parallel with the latest
  // page) and again after a peer's live read signal or a catch-up. The DM
  // peer's seen ticks take their cursor from this same read (no read of their
  // own). Only the first read sets the open cursor; a Retry re-reads positions only.
  // A reopen: the remembered cursors are the open cursor at once (the
  // viewer's own as this thread last wrote it), and the re-read only refreshes
  // the positions (Seen, Read by), never moving the unread divider.
  useEffect(() => {
    const remembered =
      memoryKey !== null ? (memory.recall(memoryKey, 'thread')?.reads ?? null) : null;
    openReadRef.current = {
      settled: channelId === null || remembered !== null,
      pendingWrite: false,
    };
    // Already set by the render's switch when it seeded these cursors.
    setReads((prev) =>
      remembered !== null && prev.channelId === channelId && prev.read === remembered
        ? prev
        : remembered !== null
          ? {
              channelId,
              status: 'ready',
              read: remembered,
              open: openCursorFrom(remembered, currentUserId),
            }
          : { channelId, status: 'loading', read: NO_READS, open: { kind: 'unknown' } },
    );
    if (channelId === null) return;
    let cancelled = false;
    // The open's one cursors read (the DM seen ticks join it).
    const read = positionsShare.take(channelId, 'reads') ?? loadReadPositions(db, channelId);
    void read.then((result) => {
      mark('chat:positions:end');
      if (cancelled) return;
      const gate = openReadRef.current;
      gate.settled = true;
      if (!result.ok) {
        logger.warn('chat: read cursors load failed', { error: result.error.message });
        if (remembered === null) setReads((prev) => ({ ...prev, status: 'failed' }));
      } else if (remembered !== null) {
        setReads((prev) =>
          prev.channelId !== channelId || sameReadPositions(prev.read, result.data)
            ? prev
            : { ...prev, read: result.data },
        );
      } else {
        setReads({
          channelId,
          status: 'ready',
          read: result.data,
          open: openCursorFrom(result.data, currentUserId),
        });
      }
      if (gate.pendingWrite) {
        gate.pendingWrite = false;
        markNewestRef.current();
      }
    });
    return () => {
      cancelled = true;
      // Leaving the chat ends its open: the next open reads its cursors afresh.
      positionsShare.release(channelId);
    };
  }, [db, channelId, currentUserId, memory, memoryKey, positionsShare]);

  /** Re-read every cursor (positions only; the open cursor stays as captured). */
  const rereadPositions = useCallback((): void => {
    const forChannel = channelRef.current;
    if (forChannel === null) return;
    void loadReadPositions(db, forChannel).then((result) => {
      if (channelRef.current !== forChannel) return;
      if (!result.ok) {
        logger.warn('chat: read cursors re-read failed', { error: result.error.message });
        setReads((prev) =>
          prev.channelId === forChannel && prev.status !== 'ready'
            ? { ...prev, status: 'failed' }
            : prev,
        );
        return;
      }
      setReads((prev) =>
        prev.channelId === forChannel
          ? {
              ...prev,
              status: 'ready',
              read: result.data,
              open:
                prev.open.kind === 'unknown'
                  ? openCursorFrom(result.data, currentUserId)
                  : prev.open,
            }
          : prev,
      );
    });
  }, [db, currentUserId]);
  const rereadRef = useRef(rereadPositions);
  rereadRef.current = rereadPositions;
  const rereadDebounced = useMemo(
    () => createDebouncer<null>(() => rereadRef.current(), READ_CURSOR_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => rereadDebounced.cancel(), [rereadDebounced]);
  useEffect(() => {
    if (readAttempt > 0) rereadRef.current();
  }, [readAttempt]);
  const retryReads = useCallback(() => setReadAttempt((n) => n + 1), []);

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
      onReaction: (event) => setMessages((prev) => applyLiveReaction(prev, event, currentUserId)),
      onRead: ({ messageId, fromUserId }) => {
        if (fromUserId === currentUserId) return;
        setMessages((prev) => applyLiveRead(prev, messageId));
        rereadDebounced.schedule(null);
      },
      // A sender can only delete or edit their own messages: ids of anyone
      // else's are ignored (the record is truth on the next load either way).
      onDelete: (event) => {
        if (channelRef.current !== channelId) return;
        const { deleted } = applyLiveDelete(messagesRef.current, event);
        if (deleted.length === 0) return;
        setMessages((prev) => applyLiveDelete(prev, event).messages);
        reportDeleted(channelId, deleted);
      },
      // The edit renders from the re-read row (like live messages), never the
      // Agora payload; a missing (deleted, unreadable) or unchanged row is ignored.
      onEdit: ({ messageId, fromUserId }) => {
        if (channelRef.current !== channelId) return;
        if (!liveEditWanted(messagesRef.current, { messageId, fromUserId })) return;
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
          setMessages((prev) => applyLiveEditRow(prev, { row: stored, channelId, fromUserId }));
          onMessageEditedRef.current?.(stored);
        });
      },
    });
    return unsubscribe;
  }, [db, client, channelId, currentUserId, verifier, foldRows, reportDeleted, rereadDebounced]);

  // Catch-up from Postgres, never gated on the Agora state: rows newer than
  // contiguousThrough (paging past the 200 cap; a run capped at 20 pages
  // resumes there next time), or the latest page when nothing contiguous is
  // loaded yet, plus one batched re-read of loaded rows from the
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
      const epoch = contiguity.epoch();
      const cursor = contiguity.through();
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
          // A switch, reopen or Retry since the run began: its rows belong to the old list.
          if (channelRef.current !== forChannel || contiguity.epoch() !== epoch) return;
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
          // Rows already folded live keep their objects; a dropped row lands in order.
          if (fetched.length > 0) foldRows(fetched, forChannel, true);
          contiguity.catchUpApplied(epoch, outcome.through);
          if (outcome.ok && outcome.latestPage !== undefined) {
            setHasMore(outcome.latestPage.hasMore);
            // The latest page landed after all (a first load that failed):
            // the Retry state goes, the rows are the thread.
            setLoadFailed(false);
          }
        } finally {
          catchingUpRef.current = false;
          onCaughtUpRef.current?.();
          // Read signals missed while away: the cursors are re-read too.
          if (reason !== 'interval') rereadDebounced.schedule(null);
        }
      })();
    },
    [db, currentUserId, foldRows, reportDeleted, rereadDebounced, contiguity],
  );

  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  // Tab visible, browser online, and every 60s while visible (cleared while
  // hidden and on unmount).
  useEffect(() => browserCatchUpTriggers((reason) => catchUpRef.current(reason)), []);

  // Window focus (notes only); removed on unmount and when it turns off.
  const catchUpOnFocus = params.catchUpOnFocus === true;
  useEffect(() => {
    if (!catchUpOnFocus) return;
    return windowFocusTrigger(() => catchUpRef.current('visible'));
  }, [catchUpOnFocus]);

  // Every transition to 'connected'.
  const previousStatusRef = useRef<ChatStatus>(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== 'connected' || previous === 'connected') return;
    mark('chat:catchup:connected');
    catchUpRef.current('connected');
  }, [status]);

  const loadOlder = useCallback((): void => {
    const forChannel = channelRef.current;
    const cursor = oldestCursor(messagesRef.current);
    if (forChannel === null || cursor === undefined || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderPageFailed(channelOlderKey(forChannel), false);
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
        // FT41: the list shows "Couldn't load earlier messages." + Retry.
        setOlderPageFailed(channelOlderKey(forChannel), true);
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
            : setMessageState(prev, event.id, event.state, event.refusal),
        );
      }),
    [outbox, currentUserId],
  );

  // Recorded bubbles keep their local previews for the session; when the
  // thread leaves the channel (or unmounts) those bubbles go, and so do their
  // object URLs. Unrecorded ones stay in the outbox and keep theirs.
  useEffect(
    () => () => {
      const recorded = leaving(channelId).messages.filter((m) => m.state === 'sent');
      revokeLocalPreviews(recorded.flatMap((m) => m.attachments));
    },
    [channelId, leaving],
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

  const addSentRow = useCallback<UseChatThread['addSentRow']>(
    async (row, traceId) => {
      const message = rowToThreadMessage(row, currentUserId);
      const forChannel = row.channel_id;
      if (channelRef.current === forChannel) {
        const behind = outboxRef.current.entries(forChannel);
        setMessages((prev) =>
          withOutboxBubbles(upsertMessage(prev, message), behind, currentUserId),
        );
      }
      onOwnMessageRef.current?.(
        forChannel,
        previewText(messagePreviewContent(message)),
        message.time,
        message.id,
      );
      const connection = clientRef.current;
      const liveTarget = targetRef.current;
      if (connection === null || liveTarget === null || channelRef.current !== forChannel) {
        logger.warn('chat: live publish did not complete', {
          trace_id: traceId,
          message_id: message.id,
          skipped: 'no connection',
        });
        return;
      }
      let publish: Promise<unknown>;
      try {
        publish = sendText({
          connection: asThreadConnection(connection),
          target: liveTarget,
          text: message.body,
          attachments: message.attachments,
          sharedPostIds: message.sharedPostIds,
          reply: message.reply,
          createMessage: createTextMessage,
          liveIds: { sorted_message_id: message.id, sorted_channel_id: forChannel },
        });
      } catch (error) {
        publish = Promise.reject(error);
      }
      const published = await publishWithTimeout(publish, LIVE_PUBLISH_TIMEOUT_MS);
      if (!published.ok) {
        logger.warn('chat: live publish did not complete', {
          trace_id: traceId,
          message_id: message.id,
          error: published.error,
        });
      }
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
    async (messageIds, channelId) => {
      const forChannel = channelId ?? channelRef.current;
      if (forChannel === null || messageIds.length === 0) return { ok: true };
      const traceId = generateTraceId();
      // The live signal goes to the open chat's target only; a delete for a
      // chat already left skips it (peers read the tombstone from Postgres).
      const open = channelRef.current === forChannel;
      const connection = open ? clientRef.current : null;
      const liveTarget = open ? targetRef.current : null;
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
          collectAssetIds: (ids) => attachmentAssetIds(messagesRef.current, ids),
          purgeChat: (assetIds) => purgeChat(workspaceId, assetIds),
          onPurgeFailed: (error) =>
            logger.warn('chat: purge-chat failed', { trace_id: traceId, error }),
        },
        { channelId: forChannel, messageIds, traceId },
      );
      if (result.ok)
        return result.toast !== undefined ? { ok: true, toast: result.toast } : { ok: true };
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
    [db, reportDeleted, workspaceId],
  );

  const editMessage = useCallback<UseChatThread['editMessage']>(
    async (messageId, body) => {
      const forChannel = channelRef.current;
      if (forChannel === null) return { ok: false, message: "Couldn't edit. Try again." };
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
    // The open cursor is captured first: hold the write until that read settles.
    const gate = openReadRef.current;
    if (!gate.settled) {
      gate.pendingWrite = true;
      return;
    }
    const forChannel = channelRef.current;
    if (forChannel === null) return;
    const recorded = messagesRef.current.filter((m) => m.state === 'sent' && m.createdAt !== '');
    const newest = recorded[recorded.length - 1];
    if (newest === undefined) return;
    readCursor.schedule({ channelId: forChannel, messageId: newest.id });
  }, [readCursor]);

  markNewestRef.current = markNewestVisible;

  const readMessages = messages;
  const positions = useMemo(() => {
    const loaded = new Map(readMessages.map((m) => [m.id, m.time] as const));
    return resolvePositions(reads.read.rows, (id) => reads.read.times.get(id) ?? loaded.get(id));
  }, [reads.read, readMessages]);
  const readState = useMemo<ThreadReadState>(
    () => ({
      status: reads.channelId === channelId ? reads.status : 'loading',
      positions,
      open: reads.channelId === channelId ? reads.open : { kind: 'unknown' },
      retry: retryReads,
    }),
    [reads.channelId, reads.status, reads.open, channelId, positions, retryReads],
  );

  return {
    channelId: shownChannel,
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
    readState,
    markNewestVisible,
    addSentRow,
    rootCreatedAt,
  };
}
