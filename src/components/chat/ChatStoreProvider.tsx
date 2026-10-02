// The always-on chat live layer. Mounted once at the shell (inside the Agora
// ChatProvider, the toast provider, and the router), it owns the chat roster and
// seeds the pure chat store from it plus Postgres (clears, chat_unread_counts
// for badges and ordering, one bounded scan for the preview lines), all read in
// parallel and applied in one update, then keeps it live off
// the controller's global incoming-message fan-out. Every live message is
// verified against its chat_messages row before it counts (the shared verifier
// logs a missing row once, for store and thread). Unread counts are re-read
// on open, on every reconnect, and 2s after the last incoming live message, so
// Postgres stays the truth for the badge. The provider also owns the
// per-channel outbox and its background sender (send-flow.ts): sends record and
// publish here, retry with backoff for as long as it takes (and at once on
// reconnect, tab visible and online; only a server refusal reads "Not sent"),
// persist to localStorage for this workspace and user, their picked files and
// voice notes to IndexedDB (outbox-files.ts), so a reload resumes them, and
// are wiped from both on sign-out. A channel switch or
// leaving the chat page never drops a sending or failed bubble. A message for a
// conversation the user is not viewing fires a toast and stays unread; a message for the open
// conversation is marked read locally (the thread writes the cursor). All store
// mutation lives in the pure reducer (chat-store.ts); this file only wires that
// reducer to Agora, Postgres, React, and the toast surface.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgoraChat } from 'agora-chat';
import type { Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/Avatar';
import {
  listChannelSummaries,
  listGroupMemberIds,
  readChannelClears,
  readChannelMemberIds,
  readMentionProfiles,
  LATE_READ_GRACE_MS,
  READ_TIMEOUT_MS,
  withLateRead,
  withReadTimeout,
  type ChannelSummary,
  type MentionProfile,
} from '@/lib/chat-reads';
import {
  isFormerMember,
  knownMentionName,
  mentionIds,
  mentionNamesIn,
  rememberMentionProfiles,
  resolveMentionPreview,
} from '@/lib/chat/mentions';
import { SIGNOUT_EVENT } from '@/lib/events';
import { stripDeletedReplies } from '@/lib/chat/drafts';
import { leaveSelectionThen } from '@/lib/chat/forward';
import { generateTraceId } from '@/lib/trace';
import { useChat } from '@/lib/chat/chat-context';
import { createTextMessage } from '@/lib/chat/message-factory';
import { sendMessageRecord } from '@/lib/chat/record';
import { createOutboxSender, runSend, type OutboxSender } from '@/lib/chat/send-flow';
import {
  clearOutboxFiles,
  deleteOutboxFiles,
  openIndexedDbFiles,
  pruneOutboxFiles,
  restoreOutboxFiles,
  saveOutboxFiles,
  type OutboxFileAdapter,
} from '@/lib/chat/outbox-files';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import { revokeLocalPreviews, type AttachmentUploader } from '@/lib/chat/attachments';
import { isImageMime } from '@srtdio/storage';
import {
  isForeignWorkspace,
  mapLiveTextMessage,
  parseLiveEvent,
  sendText,
  setLiveWorkspaceId,
  type ChannelTarget,
  type ChatMessageRow,
  type ThreadConnection,
} from '@/lib/chat/thread';
import { liveVerifierFor, onLiveVerifyGiveUp } from '@/lib/chat/live-verify';
import { subscribeGlobalCmds, subscribeGlobalMessages } from '@/lib/chat/controller';
import {
  createGroupMemberCache,
  createHeldMessages,
  createRosterReloader,
  parseRosterCmd,
  resolveLiveTarget,
  type GroupMemberCache,
  type HeldMessages,
  type RosterReload,
  type RosterReloader,
} from '@/lib/chat/roster-signal';
import {
  loadConversationPreviews,
  loadMessagesByIds,
  loadUnreadCounts,
  readConversationPreviews,
  readUnreadCounts,
  rowPreviewContent,
  type ConversationPreview,
  type PreviewContent,
  type UnreadCount,
} from '@/lib/chat/history';
import { createDebouncer, UNREAD_REFRESH_DEBOUNCE_MS } from '@/lib/chat/read-cursor';
import * as store from '@/lib/chat/chat-store';
import type {
  ChannelClear,
  ChannelOutbox,
  ChatLoadStatus,
  ChatStoreState,
  OutboxEvent,
  OutboxStorage,
} from '@/lib/chat/chat-store';

/** The store plus the actions the chat UI uses to keep it in step. */
export interface ChatStoreContextValue {
  state: ChatStoreState;
  /** The list's load status for the current workspace; rows render only when 'ready'. */
  loadStatus: ChatLoadStatus;
  /** The current workspace's channels; empty unless loadStatus is 'ready'. */
  roster: readonly ChannelSummary[];
  /** Re-run the first load after an error (Retry). */
  retryLoad: () => void;
  /** Re-read the roster after a mutation; resolves to it, or null when the read failed. */
  reloadRoster: () => Promise<readonly ChannelSummary[] | null>;
  /**
   * Bumped each time a roster re-read is applied (live roster signal, mutation,
   * unknown chat), tagged with the workspace scope it was applied for.
   */
  rosterReload: RosterReload;
  /** Group member ids for an unsynced group's live fan-out; cleared on every roster re-read. */
  groupMembers: GroupMemberCache;
  /** Sum of unread across every channel; the Chat-tab badge reads this. */
  totalUnread: number;
  /** Mark the viewed channel (its incoming messages stay read), or clear it. */
  setActive: (channelId: string | null) => void;
  /** Zero a channel's unread locally (the thread records the read cursor). */
  markConversationRead: (channelId: string) => void;
  /** Refresh a channel's last line after a recorded own send ('You: ...'). */
  updateOwnMessage: (channelId: string, text: string, ts: number, messageId?: string) => void;
  /** An edit landed (own or verified live): the line updates when it shows that message. */
  updateEditedMessage: (row: ChatMessageRow) => void;
  /** Re-read chat_unread_counts now (after a catch-up). */
  refreshUnreadCounts: () => void;
  /** Re-read the last-line previews (after messages were deleted for everyone). */
  refreshPreviews: () => void;
  /** Ask the chat page to open a channel (consumed via pendingOpenConversationId). */
  requestOpen: (channelId: string) => void;
  /** Clear the pending-open request once the chat page has acted on it. */
  clearPendingOpen: () => void;
  /** Unrecorded own sends per channel and their background sender; survives channel switches. */
  outbox: ChannelOutbox;
  /**
   * The chat was deleted for the caller (chat_channel_clear accepted): record the
   * clear time, empty its card and drop its unrecorded sends.
   */
  clearConversation: (channelId: string, clearedAtMs: number) => void;
}

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null);

/** Stable empty roster while the list is not ready. */
const EMPTY_ROSTER: readonly ChannelSummary[] = [];

/** Bound on the live-message ids remembered for dedupe. */
const SEEN_IDS_LIMIT = 500;

/** Bound on the deleted message ids remembered for stripping queued quotes. */
const DELETED_IDS_LIMIT = 500;

function indexSummaries(roster: readonly ChannelSummary[]): Map<string, ChannelSummary> {
  const map = new Map<string, ChannelSummary>();
  for (const summary of roster) {
    map.set(summary.channelId, summary);
  }
  return map;
}

/** localStorage, or null where reading it throws (blocked storage, private mode). */
function browserStorage(): OutboxStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The file store for pending sends, or null where IndexedDB is unavailable. */
function browserFiles(): OutboxFileAdapter | null {
  try {
    return openIndexedDbFiles();
  } catch {
    return null;
  }
}

/** A restored image's tile preview (revoked with the bubble, like a picked file's). */
function restoredPreview(file: File): string | null {
  if (!isImageMime(file.type)) return null;
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

/**
 * Release what a cancelled send held outside the sender: its IndexedDB files
 * (after a save still in flight lands, so none is left behind) and the object
 * URLs of its previews and recorded audio. Never throws.
 */
export function releaseCancelled(
  files: OutboxFileAdapter | null,
  entry: Pick<store.OutboxEntry, 'id' | 'local'>,
  saving: Promise<unknown> = Promise.resolve(),
): Promise<void> {
  revokeLocalPreviews(entry.local.attachments);
  return saving.then(
    () => deleteOutboxFiles(files, [entry.id]),
    () => deleteOutboxFiles(files, [entry.id]),
  );
}

/**
 * The X on an uploading bubble for one chat: cancel that send (ignored once
 * its record call fired). Null outside a provider.
 */
export function useCancelUpload(): ((channelId: string, id: string) => boolean) | null {
  const outbox = useContext(ChatStoreContext)?.outbox ?? null;
  return outbox !== null ? outbox.cancel : null;
}

/** A verified message held for a roster re-read, with the list update it commits. */
interface HeldIncoming {
  row: ChatMessageRow;
  incoming: store.IncomingMessage;
}

/**
 * Whether a live command re-reads the roster: only a roster command, and not
 * one stamped with another workspace (absent = older client, counts). Pure.
 */
export function rosterCmdTriggersReload(
  message: { action?: string; ext?: unknown },
  currentWorkspaceId: string | null,
): boolean {
  if (parseRosterCmd(message) === null) return false;
  return !isForeignWorkspace(message.ext, currentWorkspaceId);
}

/**
 * What a verified incoming row does to the list: 'apply' when its chat is in
 * the roster; for a chat not in it, 'hold' (one roster re-read, the only
 * reload a message may trigger) when the list is ready and the message is not
 * stamped with another workspace, else 'drop' (the pre-live-roster handling:
 * verified, then dropped). Pure.
 */
export function incomingRowAction(input: {
  known: boolean;
  foreignWorkspace: boolean;
  listReady: boolean;
}): 'apply' | 'hold' | 'drop' {
  if (input.known) return 'apply';
  if (input.foreignWorkspace || !input.listReady) return 'drop';
  return 'hold';
}

/** Remember a live message id; true when it was already seen. Bounded FIFO. */
export function rememberSeen(
  seen: Set<string>,
  id: string,
  limit: number = SEEN_IDS_LIMIT,
): boolean {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > limit) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

/** What handling a tombstone signal touches, injected so the order is unit-tested. */
export interface DeletedSignalDeps {
  /** The channels whose list line shows one of the ids (store.channelsShowingDeleted). */
  channelsShowing: (messageIds: readonly string[]) => string[];
  /** One batched preview read (the existing reader), applied to just these channels. */
  rereadPreviews: (channelIds: readonly string[]) => void;
  /** Strip draft replies that quote the ids (drafts.stripDeletedReplies). */
  stripDrafts: (messageIds: readonly string[]) => void;
  /** Clear the quote text of queued sends that quote the ids (persisted outbox). */
  stripOutbox: (messageIds: readonly string[]) => void;
}

/**
 * Messages became tombstones, in any channel: strip them from draft replies and
 * the queued outbox, and re-read the list lines that showed one, all in one
 * preview read however many channels are hit (none when no line showed one).
 */
export function handleMessagesDeleted(
  deps: DeletedSignalDeps,
  messageIds: readonly string[],
): void {
  if (messageIds.length === 0) return;
  deps.stripDrafts(messageIds);
  deps.stripOutbox(messageIds);
  const channels = deps.channelsShowing(messageIds);
  if (channels.length > 0) deps.rereadPreviews(channels);
}

/** What routing a global command needs, injected so the trust check is unit-tested. */
export interface GlobalCmdDeps {
  /** One batched read of the named rows (loadMessagesByIds). */
  loadByIds: (messageIds: readonly string[]) => Promise<Result<ChatMessageRow[]>>;
  /** The ids whose rows are tombstones on record. */
  onDeleted: (messageIds: readonly string[]) => void;
  /** A live edit verified against its row (any chat, open or not): the list line may take it. */
  onEdited?: (row: ChatMessageRow) => void;
  /**
   * Whether this message is some chat's list line now. An edit of any other
   * message moves no line, so it is not re-read (the open thread reads its own).
   */
  isShownLine?: (messageId: string) => boolean;
}

/**
 * A live command for any channel (the global fan-out). The payload alone is
 * never trusted: a delete signal's ids are re-read in one batched read and only
 * rows whose deleted_at is set reach the tombstone handler; an edit signal's
 * row is re-read and only a live row that carries an edit reaches the list
 * line (which takes it only when it is that chat's latest). Ids not found are
 * ignored. Every other command is the open thread's business.
 */
export async function routeGlobalCmd(ext: unknown, deps: GlobalCmdDeps): Promise<void> {
  const event = parseLiveEvent(ext);
  if (event.kind === 'edit') {
    if (deps.onEdited === undefined) return;
    if (deps.isShownLine !== undefined && !deps.isShownLine(event.messageId)) return;
    const result = await deps.loadByIds([event.messageId]);
    if (!result.ok) {
      logger.warn('chat store: edit signal verification failed, ignored', {
        error: result.error.message,
      });
      return;
    }
    const row = result.data.find((r) => r.id === event.messageId);
    if (row !== undefined && row.deleted_at === null && row.edited_at !== null) deps.onEdited(row);
    return;
  }
  if (event.kind !== 'delete' || event.messageIds.length === 0) return;
  const claimed = new Set(event.messageIds);
  const result = await deps.loadByIds([...claimed]);
  if (!result.ok) {
    logger.warn('chat store: delete signal verification failed, ignored', {
      error: result.error.message,
    });
    return;
  }
  const deleted = result.data
    .filter((row) => claimed.has(row.id) && row.deleted_at !== null)
    .map((row) => row.id);
  if (deleted.length > 0) deps.onDeleted(deleted);
}

/**
 * A held message's line once its chat is listed: the sender prefix from the
 * chat's roster row (a new group gets "<first name>:"), names already read.
 */
export function heldWithPrefix(
  incoming: store.IncomingMessage,
  row: Pick<ChatMessageRow, 'sender_user_id' | 'workspace_id'>,
  summary: Pick<ChannelSummary, 'channelType'> | undefined,
  currentUserId: string | null,
): store.IncomingMessage {
  if (currentUserId === null) return incoming;
  const prefix = store.previewPrefix({
    senderUserId: row.sender_user_id,
    currentUserId,
    isGroup: summary?.channelType === 'group',
    nameOf: mentionNamesIn(row.workspace_id),
  });
  const next: store.IncomingMessage = { ...incoming };
  delete next.prefix;
  if (prefix !== undefined) next.prefix = prefix;
  return next;
}

/**
 * A refresh's answer applied to the store: a failed read keeps the current
 * values, and an answer for a scope the store has moved on from (workspace
 * switch, sign-out) is dropped. Pure.
 */
export function refreshedState<T>(
  prev: ChatStoreState,
  scope: string,
  result: Result<T>,
  apply: (state: ChatStoreState, data: T) => ChatStoreState,
): ChatStoreState {
  if (!result.ok || prev.scope !== scope) return prev;
  return apply(prev, result.data);
}

/** A body with @[uuid] tokens as list text: "@Name" (this workspace's registry names). */
export function previewMentionText(text: string, workspaceId: string | null): string {
  return resolveMentionPreview(text, mentionNamesIn(workspaceId));
}

/**
 * Make sure every @mention in these bodies (and every sender in `senderIds`,
 * for group lines' first names) has a remembered name: one batched profile
 * read (with membership, same pass) for the ids not known yet (none when all
 * are). An id read without an active membership reads "@Unknown member". A
 * failed read (an error, a rejection or the 5s timeout) is logged; those
 * mentions then read "@Unknown member", never a raw token, and those senders
 * get no prefix. Never throws.
 */
export async function rememberBodyNames(
  bodies: readonly string[],
  readNames: (ids: string[], signal?: AbortSignal) => Promise<Result<MentionProfile[]>>,
  workspaceId: string,
  senderIds: readonly string[] = [],
): Promise<void> {
  // Unknown FOR THIS WORKSPACE: a name learned in another one never counts.
  const ids = [...new Set([...bodies.flatMap(mentionIds), ...senderIds])].filter(
    (id) => knownMentionName(workspaceId, id) === undefined,
  );
  if (ids.length === 0) return;
  const result = await withReadTimeout((signal) => readNames(ids, signal));
  if (!result.ok) {
    logger.warn('chat store: mention names read failed', { error: result.error.message });
    return;
  }
  rememberMentionProfiles(workspaceId, result.data);
}

/**
 * The previews with their mentions resolved to "@Name", after one batched name
 * read that also covers the other senders (group lines' first names), so the
 * list's first paint is final. A failed preview read passes through.
 */
export async function resolvePreviewMentions(
  previews: Result<ConversationPreview[]>,
  readNames: (ids: string[], signal?: AbortSignal) => Promise<Result<MentionProfile[]>>,
  workspaceId: string,
  currentUserId: string | null = null,
): Promise<Result<ConversationPreview[]>> {
  if (!previews.ok) return previews;
  await rememberBodyNames(
    previews.data.map((p) => p.body),
    readNames,
    workspaceId,
    previews.data
      .map((p) => p.senderUserId)
      .filter((id): id is string => id !== null && id !== currentUserId),
  );
  return {
    ok: true,
    data: previews.data.map((p) => ({ ...p, body: previewMentionText(p.body, workspaceId) })),
  };
}

/** The one batched name read the list lines use (mentions and senders). */
function readListNames(
  workspaceId: string,
): (ids: string[], signal?: AbortSignal) => Promise<Result<MentionProfile[]>> {
  return (ids, signal) =>
    readMentionProfiles(supabase, {
      workspaceId,
      userIds: ids,
      ...(signal !== undefined ? { signal } : {}),
    });
}

/**
 * The scanned previews with their names resolved: one batched name read with
 * its own 5s. A failed name read never fails the lines: they keep their text
 * and the senders it could not name get no prefix. Never throws.
 */
export async function namePreviews(
  previews: ConversationPreview[],
  readNames: (ids: string[], signal?: AbortSignal) => Promise<Result<MentionProfile[]>>,
  workspaceId: string,
  currentUserId: string | null,
): Promise<ConversationPreview[]> {
  const named = await resolvePreviewMentions(
    { ok: true, data: previews },
    readNames,
    workspaceId,
    currentUserId,
  );
  return named.ok ? named.data : previews;
}

/**
 * The last-line previews for a refresh: the scan (its own 5s) then the name
 * read (its own 5s, never failing the lines).
 */
async function readPreviews(
  workspaceId: string,
  currentUserId: string | null,
): Promise<Result<ConversationPreview[]>> {
  const scan = await loadConversationPreviews(supabase, workspaceId);
  if (!scan.ok) return scan;
  return {
    ok: true,
    data: await namePreviews(scan.data, readListNames(workspaceId), workspaceId, currentUserId),
  };
}

/**
 * An edited row's list line: its new mentions are named first (one batched
 * read, 5s), so a current member never reads "@Unknown member". When the read
 * failed and a mention is still unnamed (membership unknown), null: the line
 * keeps what it shows rather than guess. Never throws.
 */
export async function editedPreviewLine(
  row: ChatMessageRow,
  readNames: (ids: string[], signal?: AbortSignal) => Promise<Result<MentionProfile[]>>,
): Promise<string | null> {
  const body = row.body ?? '';
  await rememberBodyNames([body], readNames, row.workspace_id);
  const unnamed = mentionIds(body).some(
    (id) =>
      knownMentionName(row.workspace_id, id) === undefined && !isFormerMember(row.workspace_id, id),
  );
  if (unnamed) return null;
  return previewLineFor(rowPreviewContent(row), row.workspace_id);
}

/** A message's list line: mentions as "@Name" in its body, else what it carries. */
export function previewLineFor(content: PreviewContent, workspaceId: string | null): string {
  return store.previewText({ ...content, body: previewMentionText(content.body, workspaceId) });
}

/** The four reads the chat list's first paint waits on; `signal` cancels each. */
export interface ChatListReaders {
  roster: (signal: AbortSignal) => Promise<Result<ChannelSummary[]>>;
  clears: (signal: AbortSignal) => Promise<Result<ChannelClear[]>>;
  /** The preview scan only; names are resolved by `names` after it. */
  previews: (signal: AbortSignal) => Promise<Result<ConversationPreview[]>>;
  counts: (signal: AbortSignal) => Promise<Result<UnreadCount[]>>;
  /** Resolve the scanned lines' names (own 5s; a failure keeps the lines, no prefix). */
  names?: (previews: ConversationPreview[]) => Promise<ConversationPreview[]>;
}

/** A roster re-read's deadline: its two round-trips, 5s each (reload, deep link). */
export const ROSTER_READ_BUDGET_MS = 2 * READ_TIMEOUT_MS;

/** Store transition for a first load. */
type LoadTransition = (prev: ChatStoreState) => ChatStoreState;

/**
 * Run the four list reads in parallel and resolve to the one store transition
 * that applies them all ('ready'), or to 'error' (the list's Retry state) when
 * any of them failed. Each read has its own 5s, so the load settles within 5s
 * (plus the name read's own 5s): the skeleton never outlives it. A read that
 * only timed out keeps running (withLateRead): once every read has data, the
 * 'ready' transition is handed to `onLate` and the list replaces the error.
 * `cancel` (Retry, switch, unmount) aborts them all and delivers nothing.
 */
export async function loadChatList(
  readers: ChatListReaders,
  scope: string,
  currentUserId: string,
  nameOf?: store.PreviewNameOf,
  opts: { onLate?: (transition: LoadTransition) => void; cancel?: AbortSignal } = {},
): Promise<LoadTransition> {
  const names = readers.names ?? ((p: ConversationPreview[]) => Promise.resolve(p));
  const slots: {
    roster?: ChannelSummary[];
    clears?: ChannelClear[];
    previews?: ConversationPreview[];
    counts?: UnreadCount[];
  } = {};
  let failedFirst = false;
  let delivered = false;
  const ready = (): LoadTransition | null => {
    const { roster, clears, previews, counts } = slots;
    if (roster === undefined || clears === undefined || previews === undefined) return null;
    if (counts === undefined) return null;
    return (prev) =>
      store.loadReady(prev, {
        scope,
        roster,
        clears,
        previews,
        counts,
        currentUserId,
        ...(nameOf !== undefined ? { nameOf } : {}),
      });
  };
  const late = (): void => {
    const transition = ready();
    if (!failedFirst || delivered || transition === null || opts.cancel?.aborted === true) return;
    delivered = true;
    opts.onLate?.(transition);
  };
  const lateOpts = <T,>(fill: (data: T) => void) => ({
    onLate: (data: T) => {
      fill(data);
      late();
    },
    ...(opts.cancel !== undefined ? { cancel: opts.cancel } : {}),
  });
  const [roster, clears, previews, counts] = await Promise.all([
    // The roster reader has its own 5s like the others; a roster that lands
    // later (its registry trip runs to the grace) still wins.
    withLateRead(
      readers.roster,
      lateOpts<ChannelSummary[]>((d) => (slots.roster = d)),
    ),
    withLateRead(
      readers.clears,
      lateOpts<ChannelClear[]>((d) => (slots.clears = d)),
    ),
    withLateRead(readers.previews, {
      onLate: (data: ConversationPreview[]) =>
        void names(data).then((named) => {
          slots.previews = named;
          late();
        }),
      ...(opts.cancel !== undefined ? { cancel: opts.cancel } : {}),
    }).then(
      async (r): Promise<Result<ConversationPreview[]>> =>
        r.ok ? { ok: true, data: await names(r.data) } : r,
    ),
    withLateRead(
      readers.counts,
      lateOpts<UnreadCount[]>((d) => (slots.counts = d)),
    ),
  ]);
  if (roster.ok) slots.roster = roster.data;
  if (clears.ok) slots.clears = clears.data;
  if (previews.ok) slots.previews = previews.data;
  if (counts.ok) slots.counts = counts.data;
  // Every read has data (on time, or already landed late): the list, final.
  const complete = ready();
  if (complete !== null) {
    delivered = true;
    return complete;
  }
  if (!roster.ok || !clears.ok || !previews.ok || !counts.ok) {
    failedFirst = true;
    logger.error('chat store: initial load failed', {
      roster: roster.ok ? 'ok' : roster.error.message,
      clears: clears.ok ? 'ok' : clears.error.message,
      previews: previews.ok ? 'ok' : previews.error.message,
      counts: counts.ok ? 'ok' : counts.error.message,
    });
  }
  return (prev) => store.loadFailed(prev, scope);
}

export function ChatStoreProvider({ children }: { children: ReactNode }): ReactElement {
  const { status, client } = useChat();
  const { session } = useSession();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const currentUserId = session?.user.id ?? null;

  const [state, setState] = useState<ChatStoreState>(store.initialState);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [rosterReload, setRosterReload] = useState<RosterReload>({ version: 0, scope: null });
  // One group-member cache per provider; emptied on every scope change and re-read.
  const groupMembers = useMemo(
    () =>
      createGroupMemberCache((groupId, signal) =>
        listGroupMemberIds(supabase, { groupId, signal }),
      ),
    [],
  );
  const reloaderRef = useRef<RosterReloader | null>(null);
  // Verified messages for chats not in the roster yet, and how many re-reads
  // have started (a held message waits for one that starts after it).
  const heldRef = useRef<HeldMessages<HeldIncoming> | null>(null);
  const reloadsStartedRef = useRef(0);
  // Badge refresh and toast for a message committed to the list (set below).
  const afterIncomingRef = useRef<(row: ChatMessageRow, text: string) => void>(() => {});
  const scope =
    workspaceId && currentUserId !== null ? store.loadScope(workspaceId, currentUserId) : null;

  // The live handler reads these refs so the global subscription registers once
  // and never goes stale: roster summaries, the active channel, and the ids
  // already folded in.
  const summariesRef = useRef<Map<string, ChannelSummary>>(new Map());
  const activeRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const clientRef = useRef(client);
  clientRef.current = client;
  const senderRef = useRef<OutboxSender | null>(null);
  const outboxListenersRef = useRef<Set<(event: OutboxEvent) => void>>(new Set());
  // Latest store state for the tombstone handler (it runs outside render).
  const stateRef = useRef(state);
  stateRef.current = state;
  // Deleted ids whose quotes queued sends must not persist (bounded FIFO).
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const onMessagesDeletedRef = useRef<(messageIds: readonly string[]) => void>(() => {});
  // Which record attempts may sample the server clock (session-wide).
  const clockSamplerRef = useRef<store.ClockSampler>(store.createClockSampler());
  // The current sender's file store (IndexedDB); null where there is none.
  const filesRef = useRef<OutboxFileAdapter | null>(null);
  // File saves still in flight by entry id (a cancel deletes after its save lands).
  const savesRef = useRef<Map<string, Promise<boolean>>>(new Map());
  // Uploads for sends restored after a reload (their attachments carry no
  // uploader) and for voice notes; read at call time.
  const chatAttachments = useChatAttachments();
  const uploadRef = useRef<AttachmentUploader | null>(null);
  uploadRef.current = chatAttachments.canAttach ? chatAttachments.uploadFile : null;
  // Stable facade over the current sender, which is replaced per workspace/user.
  const outbox = useMemo<ChannelOutbox>(
    () => ({
      entries: (channelId) => senderRef.current?.entries(channelId) ?? [],
      enqueue: (channelId, queued) => {
        // The tap's estimated server time (the guarded offset), stamped once.
        const entry =
          queued.createdMs !== undefined
            ? queued
            : { ...queued, createdMs: store.serverNowMs(stateRef.current, Date.now()) };
        clockSamplerRef.current.fresh(entry.id);
        senderRef.current?.enqueue(channelId, entry);
        // Its files survive a reload until the row lands (best-effort).
        if (entry.local.attachments.some((a) => a.assetId === '' && a.local?.file != null)) {
          const saving = saveOutboxFiles(filesRef.current, entry);
          savesRef.current.set(entry.id, saving);
          void saving.finally(() => {
            if (savesRef.current.get(entry.id) === saving) savesRef.current.delete(entry.id);
          });
        }
      },
      retry: (channelId, id) => senderRef.current?.retry(channelId, id),
      settle: (channelId, id) => senderRef.current?.settle(channelId, id),
      cancel: (channelId, id) => senderRef.current?.cancel(channelId, id) ?? false,
      subscribe: (listener) => {
        const listeners = outboxListenersRef.current;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      messagesDeleted: (messageIds) => onMessagesDeletedRef.current(messageIds),
    }),
    [],
  );

  useEffect(() => {
    activeRef.current = state.activeConversationId;
  }, [state.activeConversationId]);

  // The live handler resolves channels from the store's roster, so a channel
  // created after the first load (new DM or group) counts too.
  useEffect(() => {
    summariesRef.current = indexSummaries(state.roster);
  }, [state.roster]);

  const setActive = useCallback((channelId: string | null) => {
    setState((prev) => store.setActive(prev, channelId));
  }, []);

  const markConversationRead = useCallback((channelId: string) => {
    setState((prev) => store.markRead(prev, channelId));
  }, []);

  const updateOwnMessage = useCallback(
    (channelId: string, text: string, ts: number, messageId?: string) => {
      const line = previewMentionText(text, workspaceId);
      setState((prev) =>
        store.updateOwnMessage(prev, {
          channelId,
          text: line,
          ts,
          ...(messageId !== undefined ? { messageId } : {}),
        }),
      );
    },
    [workspaceId],
  );

  const editSeqRef = useRef(new Map<string, number>());
  // An edit's new mentions are named first (one batched read, 5s), so a current
  // member never reads "@Unknown member" on the line. Only the channel's latest
  // message moves the line.
  const updateEditedMessage = useCallback(
    (row: ChatMessageRow) => {
      if (stateRef.current.conversations[row.channel_id]?.lastMessageId !== row.id) return;
      const forScope = scope;
      // Two quick edits of one message: only the newest one's line lands.
      const seq = (editSeqRef.current.get(row.id) ?? 0) + 1;
      editSeqRef.current.set(row.id, seq);
      void editedPreviewLine(row, readListNames(row.workspace_id)).then((text) => {
        if (editSeqRef.current.get(row.id) !== seq) return;
        editSeqRef.current.delete(row.id);
        if (text === null) return;
        setState((prev) =>
          prev.scope === forScope
            ? store.applyEditedPreview(prev, { channelId: row.channel_id, messageId: row.id, text })
            : prev,
        );
      });
    },
    [scope],
  );

  const updateEditedRef = useRef(updateEditedMessage);
  updateEditedRef.current = updateEditedMessage;

  const clearConversation = useCallback((channelId: string, clearedAtMs: number) => {
    senderRef.current?.dropChannel(channelId);
    setState((prev) => store.applyClear(prev, channelId, clearedAtMs));
  }, []);

  const requestOpen = useCallback((channelId: string) => {
    setState((prev) => store.requestOpen(prev, channelId));
  }, []);

  const clearPendingOpen = useCallback(() => {
    setState((prev) => store.clearPendingOpen(prev));
  }, []);

  // Refreshes after the first load (each bounded at 5s); a failure keeps the
  // current values, and a response for a workspace the store has moved on
  // from is dropped.
  const refreshUnreadCounts = useCallback(() => {
    if (scope === null || workspaceId === null) return;
    void loadUnreadCounts(supabase, workspaceId).then((result) => {
      if (!result.ok) {
        logger.warn('chat store: unread counts load failed', { error: result.error.message });
      }
      setState((prev) => refreshedState(prev, scope, result, store.applyUnreadCounts));
    });
  }, [scope, workspaceId]);

  const refreshPreviews = useCallback(() => {
    if (scope === null || workspaceId === null || currentUserId === null) return;
    const forUser = currentUserId;
    const nameOf = mentionNamesIn(workspaceId);
    void readPreviews(workspaceId, forUser).then((result) => {
      if (!result.ok) {
        logger.warn('chat store: previews load failed', { error: result.error.message });
      }
      setState((prev) =>
        refreshedState(prev, scope, result, (s, data) =>
          store.applyPreviews(s, data, forUser, nameOf),
        ),
      );
    });
  }, [scope, workspaceId, currentUserId]);

  // A live message that could not be verified (twice) is not lost: the lines
  // and unread counts are re-read from the record.
  const refreshAfterGiveUpRef = useRef(() => {});
  refreshAfterGiveUpRef.current = () => {
    refreshPreviews();
    refreshUnreadCounts();
  };
  // A workspace switch, sign-out or unmount drops the live verifies still
  // waiting to retry: their messages belong to the scope that is gone.
  useEffect(() => () => liveVerifierFor(supabase).cancelRetries?.(), [scope]);

  // Only a message this workspace's store saw live counts: a give-up for one
  // from before a switch refreshes nothing.
  useEffect(
    () =>
      onLiveVerifyGiveUp((messageId) => {
        if (seenRef.current.has(messageId)) refreshAfterGiveUpRef.current();
      }),
    [],
  );

  // Messages became tombstones: drafts, the queued outbox and the list lines
  // that showed one. The re-read is one preview scan for every hit channel.
  // The open thread and the global cmd fan-out both report a live delete; ids
  // already handled are skipped so the line is re-read once.
  onMessagesDeletedRef.current = (reported) => {
    const messageIds = reported.filter((id) => !deletedIdsRef.current.has(id));
    handleMessagesDeleted(
      {
        channelsShowing: (ids) => store.channelsShowingDeleted(stateRef.current, ids),
        rereadPreviews: (channelIds) => {
          if (scope === null || workspaceId === null || currentUserId === null) return;
          const forUser = currentUserId;
          const nameOf = mentionNamesIn(workspaceId);
          void readPreviews(workspaceId, forUser).then((result) => {
            if (!result.ok) {
              logger.warn('chat store: previews load failed', { error: result.error.message });
              return;
            }
            setState((prev) =>
              prev.scope === scope
                ? store.applyChannelPreviews(prev, channelIds, result.data, forUser, nameOf)
                : prev,
            );
          });
        },
        stripDrafts: stripDeletedReplies,
        stripOutbox: (ids) => {
          for (const id of ids) rememberSeen(deletedIdsRef.current, id, DELETED_IDS_LIMIT);
          store.stripPersistedQuotes(browserStorage(), ids);
        },
      },
      messageIds,
    );
  };

  // Seed the store on workspace/user switch (and on Retry): the roster, clears,
  // previews and unread counts are read in parallel and applied in one update,
  // so the list's first paint is its final state. Any failure is the error
  // state. Independent of the Agora connection: the list and badges work while
  // chat is still connecting.
  useEffect(() => {
    if (scope === null || !workspaceId || currentUserId === null) return;
    let cancelled = false;
    // Retry, a switch or unmount aborts every read of this load (late ones too).
    const abort = new AbortController();
    seenRef.current = new Set();
    setState((prev) => store.beginLoad(prev, scope));
    void loadChatList(
      {
        // The registry trip runs up to the late grace (the load's own abort
        // still cancels it) so a slow roster still lands; names stay at 5s.
        roster: (signal) =>
          listChannelSummaries(
            supabase,
            { workspaceId, currentUserId },
            signal,
            LATE_READ_GRACE_MS,
          ),
        clears: (signal) => readChannelClears(supabase, { workspaceId }, signal),
        previews: (signal) => readConversationPreviews(supabase, workspaceId, signal),
        counts: (signal) => readUnreadCounts(supabase, workspaceId, signal),
        names: (previews) =>
          namePreviews(previews, readListNames(workspaceId), workspaceId, currentUserId),
      },
      scope,
      currentUserId,
      mentionNamesIn(workspaceId),
      {
        // A read that only timed out and lands later: its data wins, the error clears.
        onLate: (transition) => {
          if (!cancelled) setState(transition);
        },
        cancel: abort.signal,
      },
    ).then((transition) => {
      if (!cancelled) setState(transition);
    });
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [scope, workspaceId, currentUserId, loadAttempt]);

  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);

  // A failed or timed-out (5s) re-read keeps the current roster. A success also
  // refreshes the live lookup at once (held messages re-check it right after)
  // and drops the cached group members, so the next fan-out reads them again.
  // Held messages whose chat the re-read lists commit in the SAME update as
  // the roster, so their new tile paints once, final.
  const reloadRoster = useCallback(async (): Promise<readonly ChannelSummary[] | null> => {
    if (scope === null || !workspaceId || currentUserId === null) return null;
    reloadsStartedRef.current += 1;
    const reloadNumber = reloadsStartedRef.current;
    // Each round-trip has its own 5s and is aborted when it fires.
    const result = await withReadTimeout(
      (signal) => listChannelSummaries(supabase, { workspaceId, currentUserId }, signal),
      ROSTER_READ_BUDGET_MS,
    );
    if (!result.ok) {
      logger.error('chat store: roster reload failed', { error: result.error.message });
      return null;
    }
    if (stateRef.current.scope !== scope) return null;
    const listed = indexSummaries(result.data);
    summariesRef.current = listed;
    groupMembers.clear();
    const ready = heldRef.current?.settle((id) => listed.has(id), reloadNumber) ?? [];
    setState((prev) =>
      prev.scope === scope
        ? store.applyRosterWithIncoming(
            prev,
            result.data,
            // A new group's line takes its sender prefix from the re-read roster.
            ready.map((held) =>
              heldWithPrefix(
                held.incoming,
                held.row,
                listed.get(held.row.channel_id),
                currentUserId,
              ),
            ),
          )
        : prev,
    );
    setRosterReload((prev) => ({ version: prev.version + 1, scope }));
    for (const held of ready) afterIncomingRef.current(held.row, held.incoming.text);
    return result.data;
  }, [scope, workspaceId, currentUserId, groupMembers]);

  // Every live send is stamped with this workspace (receivers elsewhere skip it).
  useEffect(() => {
    setLiveWorkspaceId(workspaceId || null);
    return () => setLiveWorkspaceId(null);
  }, [workspaceId]);

  // One debounced, single-flight live reload per workspace and user. Teardown
  // (workspace switch, sign-out, unmount) clears its timers and held messages.
  const reloadRosterRef = useRef(reloadRoster);
  reloadRosterRef.current = reloadRoster;
  useEffect(() => {
    groupMembers.clear();
    if (scope === null) return;
    const reloader = createRosterReloader({
      reload: async () => (await reloadRosterRef.current()) !== null,
      onError: (context) => logger.warn('chat store: live roster reload failed', context),
    });
    const held = createHeldMessages<HeldIncoming>();
    reloaderRef.current = reloader;
    heldRef.current = held;
    return () => {
      reloader.dispose();
      held.dispose();
      if (reloaderRef.current === reloader) reloaderRef.current = null;
      if (heldRef.current === held) heldRef.current = null;
      groupMembers.clear();
    };
  }, [scope, groupMembers]);

  // One background sender per workspace and user, seeded from this scope's
  // persisted outbox. Teardown (workspace switch, sign-out, unmount) clears its
  // timers and ignores every answer still in flight; sign-out also wipes the
  // persisted bodies.
  useEffect(() => {
    if (!workspaceId || currentUserId === null) return;
    const scopeKey = { workspaceId, userId: currentUserId };
    const storage = browserStorage();
    // Persisted sends are replays (never marked fresh): their acks carry the
    // original created_at.
    const files = browserFiles();
    filesRef.current = files;
    // With a file store, sends whose files never finished uploading wait for
    // their bytes (clock) instead of reading "Photos not sent".
    const read = store.readPersistedOutbox(storage, scopeKey);
    // Sends persisted without a tap time get one now, once, and keep it.
    const stamped = store.stampMissingCreatedMs(
      read,
      store.serverNowMs(stateRef.current, Date.now()),
    );
    if (stamped !== read) store.writePersistedOutbox(storage, scopeKey, stamped);
    const persisted = files !== null ? store.awaitRestoredFiles(stamped) : stamped;
    const clockSampler = clockSamplerRef.current;
    // Entry ids the outbox holds, to drop their files once they leave it.
    let heldIds = new Set(Object.values(persisted).flatMap((list) => list.map((e) => e.id)));
    // Blobs of sends neither persisted (any scope) nor queued since are orphans.
    const keepIds = store.persistedOutboxIds(storage);
    if (keepIds !== null) {
      void pruneOutboxFiles(files, (id) => keepIds.has(id) || heldIds.has(id));
    }
    const sender = createOutboxSender(
      {
        deliver: (channelId, entry, traceId, onRecorded) => {
          const connection = clientRef.current;
          const summary = summariesRef.current.get(channelId);
          // Resolved before the publish starts (its own 5s member read), so the
          // publish keeps its full timeout.
          let target: ChannelTarget | null = null;
          return runSend(
            {
              // The ack's server created_at against the device time of the
              // send sets the server clock offset (edit / delete windows and
              // pending send times). Only the first attempt of an id queued in
              // this session samples it; its ack or failure ends that.
              recordMessage: (input) =>
                store.recordWithClockSample(
                  clockSampler,
                  input.id,
                  () => sendMessageRecord({ client: supabase, ...input }),
                  (createdAt, sentAt) =>
                    setState((prev) => store.applyServerClock(prev, createdAt, sentAt)),
                ),
              // An unsynced group fans out once per member (its ids loaded, else
              // one 5s read); no target (read failed, over 50) skips the publish.
              ...(connection !== null && summary !== undefined
                ? {
                    beforePublish: async () => {
                      target = await resolveLiveTarget(summary, scopeKey.userId, groupMembers);
                    },
                  }
                : {}),
              publishLive:
                connection !== null && summary !== undefined
                  ? async (input) => {
                      if (target === null) throw new Error('no live target');
                      return sendText({
                        connection: connection as ThreadConnection,
                        target,
                        text: input.text,
                        attachments: input.local.attachments,
                        sharedPostIds: input.local.sharedPostIds,
                        reply: input.local.reply,
                        createMessage: createTextMessage,
                        liveIds: {
                          sorted_message_id: input.id,
                          sorted_channel_id: input.channelId,
                        },
                      });
                    }
                  : undefined,
              // A refused mention re-reads the chat's members once (5s timeout).
              recheckMentions: (id) => readChannelMemberIds(supabase, { channelId: id }),
              // The row exists; receivers catch up from Postgres.
              onLiveWarning: (context) =>
                logger.warn('chat: live publish did not complete', context),
              onRecorded,
            },
            {
              id: entry.id,
              channelId,
              currentUserId: scopeKey.userId,
              traceId,
              text: entry.text,
              local: entry.local,
              ...(summary !== undefined ? { channelType: summary.channelType } : {}),
            },
          );
        },
        newTraceId: generateTraceId,
        onEvent: (event) => {
          // The row exists: the list card shows 'You: ...', whatever page is open.
          if (event.type === 'recorded') {
            const { channelId, message } = event;
            setState((prev) =>
              store.updateOwnMessage(prev, {
                channelId,
                messageId: message.id,
                text: previewLineFor(store.messagePreviewContent(message), scopeKey.workspaceId),
                ts: message.time,
              }),
            );
          }
          for (const listener of outboxListenersRef.current) listener(event);
        },
        // A queued send quoting a deleted message never persists its quote text.
        onChange: (next) => {
          store.writePersistedOutbox(
            storage,
            scopeKey,
            store.stripDeletedQuotes(next, deletedIdsRef.current),
          );
          // Recorded, settled, removed or dropped: its files are not needed.
          const nextIds = new Set(Object.values(next).flatMap((list) => list.map((e) => e.id)));
          const gone = [...heldIds].filter((id) => !nextIds.has(id));
          heldIds = nextIds;
          if (gone.length > 0) void deleteOutboxFiles(files, gone);
        },
        onAttemptFailed: (context) => logger.warn('chat: message record attempt failed', context),
        // A Retry tap re-stamps its entry with the estimated server time now.
        now: () => store.serverNowMs(stateRef.current, Date.now()),
        upload: (file, onProgress, signal) => {
          const upload = uploadRef.current;
          return upload !== null
            ? upload(file, onProgress, signal)
            : Promise.resolve({ ok: false, message: 'Upload is unavailable.' });
        },
        // A cancelled send: its stored files and object URLs go now.
        onCancelled: (_channelId, entry) =>
          void releaseCancelled(files, entry, savesRef.current.get(entry.id)),
      },
      persisted,
    );
    senderRef.current = sender;
    // Bring restored sends' files back from IndexedDB; each resumes in its
    // place in the queue, or turns filesMissing when its bytes are gone.
    for (const [channelId, list] of Object.entries(persisted)) {
      for (const entry of list) {
        if (entry.restoring !== true) continue;
        void restoreOutboxFiles(files, entry, restoredPreview).then((attachments) => {
          // Torn down meanwhile: the previews made for it have no bubble.
          if (senderRef.current !== sender) {
            revokeLocalPreviews(attachments ?? []);
            return;
          }
          sender.restoreFiles(channelId, entry.id, attachments);
          // Cancelled while its files were read back: the previews have no bubble.
          if (!sender.entries(channelId).some((e) => e.id === entry.id)) {
            revokeLocalPreviews(attachments ?? []);
          }
        });
      }
    }
    const kick = (): void => sender.kick();
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') kick();
    };
    const onSignout = (): void => {
      sender.dispose();
      store.clearPersistedOutbox(storage);
      void clearOutboxFiles(files);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', kick);
    window.addEventListener(SIGNOUT_EVENT, onSignout);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', kick);
      window.removeEventListener(SIGNOUT_EVENT, onSignout);
      sender.dispose();
      if (senderRef.current === sender) senderRef.current = null;
      if (filesRef.current === files) filesRef.current = null;
      files?.close();
    };
  }, [workspaceId, currentUserId, groupMembers]);

  // Every (re)connect re-reads the counts (live messages missed while offline
  // are already in Postgres) and retries any queued send at once.
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== 'connected' || previous === 'connected') return;
    refreshUnreadCounts();
    senderRef.current?.kick();
  }, [status, refreshUnreadCounts]);

  // Debounced reconcile after live traffic (2s after the last incoming message).
  const refreshRef = useRef(refreshUnreadCounts);
  refreshRef.current = refreshUnreadCounts;
  const debouncedRefresh = useMemo(
    () => createDebouncer<null>(() => refreshRef.current(), UNREAD_REFRESH_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => debouncedRefresh.cancel(), [debouncedRefresh]);

  // A message committed to the list: re-read the badge counts soon, and toast
  // it unless its chat is open. Name and photo come from the RLS-read roster.
  afterIncomingRef.current = (row, text) => {
    debouncedRefresh.schedule(null);
    const summary = summariesRef.current.get(row.channel_id);
    if (summary === undefined || row.channel_id === activeRef.current) return;
    toast.show({
      title: summary.title,
      description: text,
      icon: (
        <Avatar
          name={summary.title}
          size="sm"
          {...(summary.avatarUrl !== null ? { src: summary.avatarUrl } : {})}
        />
      ),
      // A thread selecting messages exits that first (history.back()).
      onPress: () =>
        leaveSelectionThen(() => {
          requestOpen(row.channel_id);
          navigate('/chat');
        }),
    });
  };

  // Latest incoming-message logic, held in a ref so the global subscription
  // below registers exactly once yet always runs the current closure.
  const onIncomingRef = useRef<(message: AgoraChat.TextMsgBody) => void>(() => {});
  onIncomingRef.current = (raw) => {
    if (currentUserId === null) return;
    const mapped = mapLiveTextMessage(raw, currentUserId);
    if (!mapped.ok) {
      logger.warn('chat store: live message without sorted ids ignored', { agora_id: raw.id });
      return;
    }
    if (mapped.message.mine) return;
    if (rememberSeen(seenRef.current, mapped.message.id)) return;
    const forUser = currentUserId;
    // Only a row the caller can read counts: badge, preview and toast all come
    // from the verified row, never from the Agora payload.
    void liveVerifierFor(supabase)
      .verify(mapped.message.id)
      .then(async (lookup) => {
        if (!lookup.found) return;
        const row = lookup.row;
        if (row.sender_user_id === forUser) return;
        const held = heldRef.current;
        const reloader = reloaderRef.current;
        // Another workspace's chat (or the list not ready): dropped after the
        // verify, as before live roster updates.
        const action = incomingRowAction({
          known: summariesRef.current.has(row.channel_id),
          foreignWorkspace: isForeignWorkspace(raw.ext, workspaceId || null),
          listReady:
            held !== null &&
            reloader !== null &&
            store.selectLoadStatus(stateRef.current, scope) === 'ready',
        });
        if (action === 'drop') return;
        // Names first (one batched read for unknown ids, 5s; on timeout the line
        // commits without them), so the line and the toast read "@Name" from
        // their first paint. A group line's sender joins the same read.
        const known = summariesRef.current.get(row.channel_id);
        const isGroup = known?.channelType === 'group';
        await rememberBodyNames(
          [row.body ?? ''],
          (ids, signal) =>
            readMentionProfiles(supabase, {
              workspaceId: row.workspace_id,
              userIds: ids,
              ...(signal !== undefined ? { signal } : {}),
            }),
          row.workspace_id,
          // A chat not listed yet may be a new group: its sender is named too.
          (isGroup || known === undefined) && row.sender_user_id !== null
            ? [row.sender_user_id]
            : [],
        );
        const text = previewLineFor(rowPreviewContent(row), row.workspace_id);
        const prefix = store.previewPrefix({
          senderUserId: row.sender_user_id,
          currentUserId: forUser,
          isGroup,
          nameOf: mentionNamesIn(row.workspace_id),
        });
        const ts = Date.parse(row.created_at);
        const incoming: store.IncomingMessage = {
          channelId: row.channel_id,
          messageId: row.id,
          senderIsSelf: false,
          text,
          ...(prefix !== undefined ? { prefix } : {}),
          ts: Number.isNaN(ts) ? mapped.message.time : ts,
        };
        if (!summariesRef.current.has(row.channel_id)) {
          // A chat not in my list yet (new DM or group, just added): held for
          // the next roster re-read that starts after now, committed with it.
          if (held === null || reloader === null || heldRef.current !== held) return;
          held.add(row.channel_id, { row, incoming }, reloadsStartedRef.current);
          reloader.request();
          return;
        }
        setState((prev) => store.applyIncoming(prev, incoming));
        afterIncomingRef.current(row, text);
      });
  };

  useEffect(() => subscribeGlobalMessages((message) => onIncomingRef.current(message)), []);
  // Only a roster command re-reads the roster (debounced); typing, read,
  // reaction, edit, delete and mark commands never do, and neither does one
  // stamped with another workspace. The payload only triggers it: names,
  // photos and membership come from the re-read under RLS.
  const onRosterCmdRef = useRef<(message: AgoraChat.CmdMsgBody) => void>(() => {});
  onRosterCmdRef.current = (message) => {
    if (!rosterCmdTriggersReload(message, workspaceId || null)) return;
    if (store.selectLoadStatus(stateRef.current, scope) !== 'ready') return;
    reloaderRef.current?.request();
  };
  // A delete signal for any chat, open or not, strips its drafts, queued quotes
  // and list line once its rows read back deleted (the open thread also turns
  // the rows into tombstones itself).
  useEffect(
    () =>
      subscribeGlobalCmds((message) => {
        onRosterCmdRef.current(message);
        void routeGlobalCmd(message.ext, {
          loadByIds: (ids) => loadMessagesByIds(supabase, ids),
          onDeleted: (ids) => onMessagesDeletedRef.current(ids),
          onEdited: (row) => updateEditedRef.current(row),
          isShownLine: (id) =>
            Object.values(stateRef.current.conversations).some((c) => c.lastMessageId === id),
        });
      }),
    [],
  );

  const loadStatus = store.selectLoadStatus(state, scope);
  const roster = loadStatus === 'ready' ? state.roster : EMPTY_ROSTER;
  const value = useMemo<ChatStoreContextValue>(
    () => ({
      state,
      loadStatus,
      roster,
      retryLoad,
      reloadRoster,
      rosterReload,
      groupMembers,
      totalUnread: store.selectTotalUnread(state),
      setActive,
      markConversationRead,
      updateOwnMessage,
      updateEditedMessage,
      refreshUnreadCounts,
      refreshPreviews,
      requestOpen,
      clearPendingOpen,
      outbox,
      clearConversation,
    }),
    [
      loadStatus,
      roster,
      retryLoad,
      reloadRoster,
      rosterReload,
      groupMembers,
      outbox,
      clearConversation,
      state,
      setActive,
      markConversationRead,
      updateOwnMessage,
      updateEditedMessage,
      refreshUnreadCounts,
      refreshPreviews,
      requestOpen,
      clearPendingOpen,
    ],
  );

  return <ChatStoreContext.Provider value={value}>{children}</ChatStoreContext.Provider>;
}

/**
 * Server time now: the device clock plus the store's server clock offset (0
 * outside a provider or before the first own-send ack). The edit and delete
 * windows read this, never Date.now() alone.
 */
export function useServerNow(): () => number {
  const offset = useContext(ChatStoreContext)?.state.serverClockOffsetMs ?? 0;
  return useCallback(() => Date.now() + offset, [offset]);
}

export function useChatStore(): ChatStoreContextValue {
  const ctx = useContext(ChatStoreContext);
  if (ctx === null) {
    throw new Error('useChatStore must be used within a ChatStoreProvider');
  }
  return ctx;
}
