// Pure, framework-free store for the always-on chat live layer. It holds one
// summary per channel (keyed by OUR channel_id, never an Agora id) plus the
// active and pending-open selection, and derives the total unread the Chat tab
// badge reads. Unread counts and ordering come from the chat_unread_counts proc
// (Postgres is the record); the last-line preview comes from a bounded Postgres
// scan and is refreshed live by incoming and own messages. Every exported
// function is a pure transition: same input, same output, with no React, no
// Agora, and no clock. The provider (ChatStoreProvider) wires these to the SDK
// and React state; keeping the logic here lets the reducer be unit-tested in
// isolation with no connection. The outbox persistence helpers at the end take
// the storage as a parameter and never throw.

import type { ChannelSummary } from '@/lib/chat-reads';
import {
  attachmentPreviewKind,
  type ConversationPreview,
  type PreviewContent,
  type UnreadCount,
} from '@/lib/chat/history';
import {
  attachmentSummary,
  attachmentSummaryText,
  SUMMARY_LABELS,
  type LocalMessageContent,
  type SummaryAttachment,
  type ThreadMessage,
} from '@/lib/chat/thread';
import {
  withoutLocal,
  type AttachmentKind,
  type MessageAttachment,
  type ReplyQuote,
} from '@/lib/chat/attachments';
import { parsePeaks } from '@/lib/chat/waveform-peaks';

/** Sender label written before the preview when the current user sent it. */
export const OWN_PREFIX = 'You';

/** Preview line for a message with attachments and no text, when nothing finer is known. */
export const ATTACHMENT_PREVIEW = 'Attachment';

/** Preview lines for a message with no text, by what it carries (first applicable wins). */
export const PREVIEW_LABELS = {
  post: 'Post',
  brief: 'Brief',
  plan: 'Plan',
  photo: SUMMARY_LABELS.photo,
  file: SUMMARY_LABELS.file,
  voice: SUMMARY_LABELS.voice,
} as const;

/** A stand-in attachment per preview kind: the list line knows kinds, not names. */
const KIND_ATTACHMENT: Record<AttachmentKind, SummaryAttachment> = {
  image: { assetId: '', name: '', mime: 'image/jpeg' },
  audio: { assetId: '', name: '', mime: 'audio/webm' },
  file: { assetId: '', name: '', mime: '' },
};

/** A registry name lookup (display name by user id; undefined when not loaded). */
export type PreviewNameOf = (userId: string) => string | undefined;

/** One conversation's preview + unread, as the chat list and badge read it. */
export interface ConversationSummary {
  /** Body of the most recent message; '' when unknown or the channel is empty. */
  lastMessageText: string;
  /** Sender label before the preview ('You' for own sends); omitted on a plain line. */
  lastMessagePrefix?: string;
  /** Epoch ms of the most recent message; 0 when there are none. */
  lastMessageTs: number;
  /** Unread count for this channel; 0 when read or empty. */
  unread: number;
  /** Id of the message the line shows, when known (a delete of it re-reads the line). */
  lastMessageId?: string;
}

/**
 * Where the chat list's first load stands. 'ready' only once the roster, clears,
 * previews and unread counts have all resolved and been applied together, so
 * the first painted list is already hidden-filtered and recency-sorted.
 */
export type ChatLoadStatus = 'loading' | 'ready' | 'error';

/** Full store state. `conversations` is keyed by our channel_id. */
export interface ChatStoreState {
  /** The workspace + user the loaded data belongs to; null before any load. */
  scope: string | null;
  status: ChatLoadStatus;
  /** The workspace's channels (registry + display info); the list renders these. */
  roster: readonly ChannelSummary[];
  conversations: Record<string, ConversationSummary>;
  /** The channel the user is viewing; its incoming messages stay read. */
  activeConversationId: string | null;
  /** A channel a toast asked to open, consumed once the chat page reads it. */
  pendingOpenConversationId: string | null;
  /**
   * The caller's "delete chat for me" time per channel (epoch ms), from
   * chat_channel_clears. A channel stays hidden from the list until a message
   * newer than this arrives; the record hides older rows itself (RLS).
   */
  clears: Record<string, number>;
  /**
   * Server clock minus device clock (ms), from the created_at on the ack of the
   * caller's own sends; 0 until the first ack. The edit and delete windows are
   * judged on Date.now() + this, never the device clock alone.
   */
  serverClockOffsetMs: number;
}

/** One chat_channel_clears row as the store reads it. */
export interface ChannelClear {
  channelId: string;
  clearedAt: string;
}

/** A channel present in the workspace roster; only its id matters to the store. */
export interface RosterEntry {
  channelId: string;
}

/** A live incoming message, already mapped to our channel_id. */
export interface IncomingMessage {
  channelId: string;
  /** The row's id; the line re-reads when this message is deleted. */
  messageId?: string;
  senderIsSelf: boolean;
  text: string;
  prefix?: string;
  ts: number;
}

/** A just-sent outbound message, used to refresh the channel's last line. */
export interface OwnMessage {
  channelId: string;
  /** The recorded row's id, when known. */
  messageId?: string;
  text: string;
  ts: number;
}

/** Empty store: no conversations, nothing active, nothing pending. */
export function initialState(): ChatStoreState {
  return {
    scope: null,
    status: 'loading',
    roster: [],
    conversations: {},
    activeConversationId: null,
    pendingOpenConversationId: null,
    clears: {},
    serverClockOffsetMs: 0,
  };
}

function summary(
  text: string,
  ts: number,
  unread: number,
  prefix?: string,
  messageId?: string,
): ConversationSummary {
  return {
    lastMessageText: text,
    lastMessageTs: ts,
    unread,
    ...(prefix !== undefined ? { lastMessagePrefix: prefix } : {}),
    ...(messageId !== undefined ? { lastMessageId: messageId } : {}),
  };
}

function emptySummary(): ConversationSummary {
  return { lastMessageText: '', lastMessageTs: 0, unread: 0 };
}

function setConversation(
  state: ChatStoreState,
  channelId: string,
  next: ConversationSummary,
): ChatStoreState {
  return { ...state, conversations: { ...state.conversations, [channelId]: next } };
}

/**
 * The card line for a message: its body, or for a message with no text the
 * first of Post, Brief, Photo, File, Voice message that it carries. The one
 * function behind the live line, the reload scan and own sends. Pure.
 */
export function previewText(content: PreviewContent): string {
  if (content.body.trim() !== '') return content.body;
  if ((content.sharedPostCount ?? 0) > 0) return PREVIEW_LABELS.post;
  if ((content.sharedBriefCount ?? 0) > 0) return PREVIEW_LABELS.brief;
  if ((content.sharedPlanCount ?? 0) > 0) return PREVIEW_LABELS.plan;
  const summary = attachmentSummary({
    attachments: (content.attachmentKinds ?? []).map((kind) => KIND_ATTACHMENT[kind]),
  });
  if (summary !== null) return attachmentSummaryText(summary);
  return content.hasAttachments ? ATTACHMENT_PREVIEW : '';
}

/** A thread message's preview content (own send, forward). Pure. */
export function messagePreviewContent(
  message: Pick<ThreadMessage, 'body' | 'attachments' | 'sharedPostIds' | 'sharedBriefIds'> &
    Partial<Pick<ThreadMessage, 'sharedPlanIds'>>,
): PreviewContent {
  const sharedPlanCount = (message.sharedPlanIds ?? []).length;
  return {
    body: message.body,
    hasAttachments:
      message.attachments.length > 0 ||
      message.sharedPostIds.length > 0 ||
      message.sharedBriefIds.length > 0 ||
      sharedPlanCount > 0,
    attachmentKinds: message.attachments.map(attachmentPreviewKind),
    sharedPostCount: message.sharedPostIds.length,
    sharedBriefCount: message.sharedBriefIds.length,
    ...(sharedPlanCount > 0 ? { sharedPlanCount } : {}),
  };
}

/** The first word of a display name ('' for a blank one). */
function firstNameOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/**
 * The sender label before a line: 'You' for own messages; in a group, the
 * sender's first name from names already loaded, and nothing when it is not
 * loaded (never a placeholder). DMs label only own messages. Pure.
 */
export function previewPrefix(input: {
  senderUserId: string | null;
  currentUserId: string;
  isGroup: boolean;
  nameOf?: PreviewNameOf | undefined;
}): string | undefined {
  const { senderUserId } = input;
  if (senderUserId === null) return undefined;
  if (senderUserId === input.currentUserId) return OWN_PREFIX;
  if (!input.isGroup) return undefined;
  const first = firstNameOf(input.nameOf?.(senderUserId) ?? '');
  return first !== '' ? first : undefined;
}

function isGroupChannel(state: ChatStoreState, channelId: string): boolean {
  return state.roster.some((c) => c.channelId === channelId && c.channelType === 'group');
}

/**
 * An edit landed (own, or a live edit verified against its row): when the
 * edited message is the line a channel shows, the line takes the new text;
 * sender, time and unread stay. Any other edit changes nothing. Pure.
 */
export function applyEditedPreview(
  state: ChatStoreState,
  edit: { channelId: string; messageId: string; text: string },
): ChatStoreState {
  const existing = state.conversations[edit.channelId];
  if (existing?.lastMessageId !== edit.messageId || existing.lastMessageText === edit.text) {
    return state;
  }
  return setConversation(state, edit.channelId, { ...existing, lastMessageText: edit.text });
}

/**
 * Seed the store from the workspace roster. Every roster channel is keyed at
 * unread 0 with an empty line, so a channel with no messages yet still exists
 * in the store rather than vanishing; unread counts and previews overlay next.
 */
export function mergeInitial(roster: readonly RosterEntry[]): ChatStoreState {
  const conversations: Record<string, ConversationSummary> = {};
  for (const entry of roster) {
    conversations[entry.channelId] = emptySummary();
  }
  return { ...initialState(), conversations };
}

/** The key a load is tied to; a response for another scope is stale. */
export function loadScope(workspaceId: string, currentUserId: string): string {
  return `${workspaceId}:${currentUserId}`;
}

/**
 * The load status for the given scope. Data loaded for another workspace or
 * user reads as 'loading', so a switch never paints the previous rows.
 */
export function selectLoadStatus(state: ChatStoreState, scope: string | null): ChatLoadStatus {
  return scope !== null && state.scope === scope ? state.status : 'loading';
}

/**
 * Start a (re)load for a scope: drop every previous row, preview, count and
 * clear. The viewed and pending-open channels are kept for a same-scope retry.
 */
export function beginLoad(state: ChatStoreState, scope: string): ChatStoreState {
  const sameScope = state.scope === scope;
  return {
    ...initialState(),
    scope,
    activeConversationId: sameScope ? state.activeConversationId : null,
    pendingOpenConversationId: sameScope ? state.pendingOpenConversationId : null,
    serverClockOffsetMs: state.serverClockOffsetMs,
  };
}

/** Everything the first paint needs, resolved together. */
export interface InitialLoad {
  scope: string;
  roster: readonly ChannelSummary[];
  clears: readonly ChannelClear[];
  previews: readonly ConversationPreview[];
  counts: readonly UnreadCount[];
  currentUserId: string;
  /** Names already loaded, for group lines' sender first names. */
  nameOf?: PreviewNameOf;
}

/**
 * Apply a finished load in one transition: roster, then clears (so the unread
 * overlay knows what was deleted), previews and unread counts, then 'ready'.
 * A load for a scope the store has moved on from is ignored.
 */
export function loadReady(state: ChatStoreState, load: InitialLoad): ChatStoreState {
  if (state.scope !== load.scope) return state;
  const seeded: ChatStoreState = {
    ...mergeInitial(load.roster),
    scope: load.scope,
    roster: load.roster,
    activeConversationId: state.activeConversationId,
    pendingOpenConversationId: state.pendingOpenConversationId,
    serverClockOffsetMs: state.serverClockOffsetMs,
  };
  const withClears = applyClears(seeded, load.clears);
  const withPreviews = applyPreviews(withClears, load.previews, load.currentUserId, load.nameOf);
  return { ...applyUnreadCounts(withPreviews, load.counts), status: 'ready' };
}

/** A load for this scope failed: show the error state, never a partial list. */
export function loadFailed(state: ChatStoreState, scope: string): ChatStoreState {
  if (state.scope !== scope) return state;
  return { ...state, status: 'error', roster: [], conversations: {}, clears: {} };
}

/**
 * Replace the roster after a mutation (new DM or group, rename, leave). Known
 * channels keep their summary; a new one is keyed empty so it still lists.
 */
export function applyRoster(
  state: ChatStoreState,
  roster: readonly ChannelSummary[],
): ChatStoreState {
  const conversations: Record<string, ConversationSummary> = {};
  for (const entry of roster) {
    conversations[entry.channelId] = state.conversations[entry.channelId] ?? emptySummary();
  }
  return { ...state, roster, conversations };
}

/**
 * Overlay the chat_unread_counts result: each row sets its channel's unread and
 * last message time (preview text is untouched). A channel absent from the rows
 * has nothing unread for the caller, so its unread is set to 0 (a stale local
 * increment never outlives the refresh); the active conversation is pinned at
 * unread 0 because the reader is looking at it.
 */
export function applyUnreadCounts(
  state: ChatStoreState,
  rows: readonly UnreadCount[],
): ChatStoreState {
  const conversations: Record<string, ConversationSummary> = {};
  for (const [channelId, existing] of Object.entries(state.conversations)) {
    conversations[channelId] = existing.unread === 0 ? existing : { ...existing, unread: 0 };
  }
  for (const row of rows) {
    const existing = conversations[row.channelId] ?? emptySummary();
    const ts = Date.parse(row.lastMessageAt);
    // Nothing at or before the caller's clear counts: a cleared chat with no
    // newer message stays at unread 0 (and so stays hidden).
    const clearedAt = state.clears[row.channelId];
    const clearedOnly = clearedAt !== undefined && !Number.isNaN(ts) && ts <= clearedAt;
    conversations[row.channelId] = {
      ...existing,
      unread: state.activeConversationId === row.channelId || clearedOnly ? 0 : row.unread,
      lastMessageTs: Number.isNaN(ts)
        ? existing.lastMessageTs
        : Math.max(existing.lastMessageTs, ts),
    };
  }
  return { ...state, conversations };
}

/**
 * Overlay the latest-message previews from the record: sets each channel's line
 * (and time) without touching unread. A preview by the current user carries the
 * 'You' prefix; in a group, another sender's first name (when loaded).
 */
export function applyPreviews(
  state: ChatStoreState,
  previews: readonly ConversationPreview[],
  currentUserId: string,
  nameOf?: PreviewNameOf,
): ChatStoreState {
  const conversations = { ...state.conversations };
  for (const preview of previews) {
    const existing = conversations[preview.channelId] ?? emptySummary();
    const ts = Date.parse(preview.createdAt);
    conversations[preview.channelId] = summary(
      previewText(preview),
      Number.isNaN(ts) ? existing.lastMessageTs : Math.max(existing.lastMessageTs, ts),
      existing.unread,
      previewPrefix({
        senderUserId: preview.senderUserId,
        currentUserId,
        isGroup: isGroupChannel(state, preview.channelId),
        nameOf,
      }),
      preview.messageId,
    );
  }
  return { ...state, conversations };
}

/**
 * The channels whose list line shows one of these (now deleted) messages, in
 * roster order; only those need their line re-read. Pure.
 */
export function channelsShowingDeleted(
  state: ChatStoreState,
  messageIds: readonly string[],
): string[] {
  if (messageIds.length === 0) return [];
  const hit = new Set(messageIds);
  return Object.entries(state.conversations)
    .filter(([, convo]) => convo.lastMessageId !== undefined && hit.has(convo.lastMessageId))
    .map(([channelId]) => channelId);
}

/**
 * Apply one re-read of the previews to just these channels (the ones whose
 * line showed a deleted message). A listed channel with no preview left in the
 * read has no live message to show: its line empties (time and unread stay).
 * Other channels are untouched.
 */
export function applyChannelPreviews(
  state: ChatStoreState,
  channelIds: readonly string[],
  previews: readonly ConversationPreview[],
  currentUserId: string,
  nameOf?: PreviewNameOf,
): ChatStoreState {
  if (channelIds.length === 0) return state;
  const wanted = new Set(channelIds);
  const byChannel = new Map(
    previews.filter((p) => wanted.has(p.channelId)).map((p) => [p.channelId, p]),
  );
  const conversations = { ...state.conversations };
  for (const channelId of wanted) {
    const existing = conversations[channelId];
    if (existing === undefined) continue;
    const preview = byChannel.get(channelId);
    if (preview === undefined) {
      conversations[channelId] = summary('', existing.lastMessageTs, existing.unread);
      continue;
    }
    conversations[channelId] = summary(
      previewText(preview),
      existing.lastMessageTs,
      existing.unread,
      previewPrefix({
        senderUserId: preview.senderUserId,
        currentUserId,
        isGroup: isGroupChannel(state, channelId),
        nameOf,
      }),
      preview.messageId,
    );
  }
  return { ...state, conversations };
}

/**
 * The server clock offset from one own send's ack: the row's server created_at
 * minus the device time the send was made. An unparseable time keeps the
 * current offset. Pure.
 */
export function applyServerClock(
  state: ChatStoreState,
  createdAt: string,
  localSentMs: number,
): ChatStoreState {
  const server = Date.parse(createdAt);
  if (Number.isNaN(server) || !Number.isFinite(localSentMs)) return state;
  const offset = server - localSentMs;
  return offset === state.serverClockOffsetMs ? state : { ...state, serverClockOffsetMs: offset };
}

/**
 * The estimated server time at device time `deviceNowMs`: plus the guarded
 * server clock offset (0 until the first sampled ack). The one clock every
 * pending send is stamped with (new send, Retry, restored without a time). Pure.
 */
export function serverNowMs(
  state: Pick<ChatStoreState, 'serverClockOffsetMs'>,
  deviceNowMs: number,
): number {
  return deviceNowMs + state.serverClockOffsetMs;
}

/**
 * Which record attempts may sample the server clock: only the first send
 * attempt of a message id freshly queued in this session. A retry, or a replay
 * of a persisted outbox entry, gets the original created_at back from the
 * idempotent chat_message_send, so its ack says nothing about the clock now.
 * An id is held only from its enqueue to its first ack or failure (bounded
 * FIFO for sends that never reach a record attempt).
 */
export interface ClockSampler {
  /** A new send was queued: its first record attempt may sample. */
  fresh: (id: string) => void;
  /** A record attempt starts: the device time to sample against, or null when it must not. */
  begin: (id: string) => number | null;
  /** The attempt was acked or failed: the id never samples again. */
  settled: (id: string) => void;
}

/**
 * One record attempt under the sampler: it may sample only when its id is
 * fresh (queued this session, first attempt); ack or failure ends that id.
 * `onSample` gets the ack's created_at and the device time of the send. A
 * retry, a lost-ack retry or a replayed persisted send never samples.
 */
export async function recordWithClockSample<
  R extends { ok: true; row: { created_at: string } } | { ok: false },
>(
  sampler: ClockSampler,
  id: string,
  record: () => Promise<R>,
  onSample: (createdAt: string, sentAt: number) => void,
): Promise<R> {
  const sentAt = sampler.begin(id);
  try {
    const result = await record();
    if (result.ok && sentAt !== null) onSample(result.row.created_at, sentAt);
    return result;
  } finally {
    sampler.settled(id);
  }
}

/** Bound on the fresh ids a clock sampler holds. */
export const CLOCK_SAMPLER_LIMIT = 200;

export function createClockSampler(now: () => number = Date.now): ClockSampler & {
  /** How many ids are held (tests). */
  size: () => number;
} {
  const eligible = new Set<string>();
  return {
    fresh: (id) => {
      eligible.add(id);
      if (eligible.size > CLOCK_SAMPLER_LIMIT) {
        const oldest = eligible.values().next().value;
        if (oldest !== undefined) eligible.delete(oldest);
      }
    },
    begin: (id) => (eligible.has(id) ? now() : null),
    settled: (id) => {
      eligible.delete(id);
    },
    size: () => eligible.size,
  };
}

/**
 * Fold a live incoming message into the store. Self-sent messages are ignored
 * (the sender already echoes its own send). A message for the active channel
 * refreshes the last line but stays read; any other channel also increments
 * unread until the next chat_unread_counts refresh reconciles it.
 */
export function applyIncoming(state: ChatStoreState, message: IncomingMessage): ChatStoreState {
  if (message.senderIsSelf) {
    return state;
  }
  const existingUnread = state.conversations[message.channelId]?.unread ?? 0;
  const isActive = state.activeConversationId === message.channelId;
  const unread = isActive ? existingUnread : existingUnread + 1;
  return setConversation(
    state,
    message.channelId,
    summary(message.text, message.ts, unread, message.prefix, message.messageId),
  );
}

/**
 * A roster re-read and the messages held for it, as ONE transition: the new
 * chats' tiles land with their preview, unread and time already set, so a
 * tile never paints empty first. Existing chats keep their summaries.
 */
export function applyRosterWithIncoming(
  state: ChatStoreState,
  roster: readonly ChannelSummary[],
  incoming: readonly IncomingMessage[],
): ChatStoreState {
  let next = applyRoster(state, roster);
  for (const message of incoming) next = applyIncoming(next, message);
  return next;
}

/** Zero one channel's unread; a no-op when it is already read or unknown. */
export function markRead(state: ChatStoreState, channelId: string): ChatStoreState {
  const existing = state.conversations[channelId];
  if (existing === undefined || existing.unread === 0) {
    return state;
  }
  return setConversation(state, channelId, { ...existing, unread: 0 });
}

/** Set (or clear) the channel whose incoming messages stay read. */
export function setActive(state: ChatStoreState, channelId: string | null): ChatStoreState {
  if (state.activeConversationId === channelId) {
    return state;
  }
  return { ...state, activeConversationId: channelId };
}

/**
 * Refresh a channel's last line after the current user sends, prefixing it with
 * 'You'. Unread is untouched: an own send never changes the unread count.
 */
export function updateOwnMessage(state: ChatStoreState, own: OwnMessage): ChatStoreState {
  const existingUnread = state.conversations[own.channelId]?.unread ?? 0;
  return setConversation(
    state,
    own.channelId,
    summary(own.text, own.ts, existingUnread, OWN_PREFIX, own.messageId),
  );
}

/** Record that a toast asked to open a channel, for the chat page to consume. */
export function requestOpen(state: ChatStoreState, channelId: string): ChatStoreState {
  if (state.pendingOpenConversationId === channelId) {
    return state;
  }
  return { ...state, pendingOpenConversationId: channelId };
}

/** Clear the pending-open request once the chat page has acted on it. */
export function clearPendingOpen(state: ChatStoreState): ChatStoreState {
  if (state.pendingOpenConversationId === null) {
    return state;
  }
  return { ...state, pendingOpenConversationId: null };
}

/**
 * Whether a channel is hidden from the chat list: the caller deleted it for
 * themselves and no known message is newer than that (lastMessageTs <=
 * clearedAt). Any newer live message, catch-up row or own send unhides it.
 */
export function isChannelHidden(
  summary: Pick<ConversationSummary, 'lastMessageTs'> | undefined,
  clearedAtMs: number | undefined,
): boolean {
  if (clearedAtMs === undefined) return false;
  return (summary?.lastMessageTs ?? 0) <= clearedAtMs;
}

/** Store-level form of {@link isChannelHidden}. */
export function selectHidden(state: ChatStoreState, channelId: string): boolean {
  return isChannelHidden(state.conversations[channelId], state.clears[channelId]);
}

/**
 * Overlay the caller's chat_channel_clears rows (a later clear wins). An
 * unparseable time is skipped rather than hiding a channel forever.
 */
export function applyClears(state: ChatStoreState, rows: readonly ChannelClear[]): ChatStoreState {
  if (rows.length === 0) return state;
  const clears = { ...state.clears };
  for (const row of rows) {
    const ts = Date.parse(row.clearedAt);
    if (Number.isNaN(ts)) continue;
    clears[row.channelId] = Math.max(clears[row.channelId] ?? 0, ts);
  }
  return { ...state, clears };
}

/**
 * The caller deleted a chat for themselves: remember when, and empty its card
 * (no preview, no time, unread 0) so it hides until a newer message arrives.
 */
export function applyClear(
  state: ChatStoreState,
  channelId: string,
  clearedAtMs: number,
): ChatStoreState {
  return {
    ...setConversation(state, channelId, emptySummary()),
    clears: { ...state.clears, [channelId]: clearedAtMs },
  };
}

/** Sum of unread across every channel; 0 for an empty store. */
export function selectTotalUnread(state: ChatStoreState): number {
  let total = 0;
  for (const convo of Object.values(state.conversations)) {
    total += convo.unread;
  }
  return total;
}

/** One channel's summary, or undefined when the store has not seen it. */
export function selectConversation(
  state: ChatStoreState,
  channelId: string,
): ConversationSummary | undefined {
  return state.conversations[channelId];
}

/**
 * One own send that has not reached the record yet: in flight or retrying in
 * the background ('sending', for as long as it takes), or refused by the
 * server and waiting on Retry ('failed'). Kept per channel, outside any open
 * thread, so switching channels neither loses a failed bubble nor its Retry
 * payload.
 */
export interface OutboxEntry {
  id: string;
  text: string;
  /**
   * Attachments with an empty asset id carry their File (attachment.local) and
   * upload in the background before the record; progress lives here too.
   */
  local: LocalMessageContent;
  state: 'sending' | 'failed';
  /**
   * Estimated server time (epoch ms) of the Send tap, or of the last Retry
   * tap: device clock + the server clock offset known then. The pending
   * bubble's place, day and time label; stamped once, so it never moves.
   */
  createdMs?: number;
  /**
   * Restored from storage with files that never finished uploading: the File
   * could not be brought back (no IndexedDB, or its blob is gone), so it can
   * only be removed ('failed', no Retry).
   */
  filesMissing?: true;
  /**
   * Restored from storage while its files are read back from IndexedDB: it
   * shows its clock and holds its place in the queue, but does not run until
   * the files are back (or turns filesMissing when they are not).
   */
  restoring?: true;
}

/** Unrecorded own sends keyed by our channel_id, oldest first per channel. */
export type Outbox = Record<string, readonly OutboxEntry[]>;

/** Add (or replace by id) one entry in a channel's outbox. */
export function outboxPut(outbox: Outbox, channelId: string, entry: OutboxEntry): Outbox {
  const list = outbox[channelId] ?? [];
  const next = list.some((e) => e.id === entry.id)
    ? list.map((e) => (e.id === entry.id ? entry : e))
    : [...list, entry];
  return { ...outbox, [channelId]: next };
}

/** Set one entry's state; unknown ids leave the outbox unchanged. */
export function outboxSetState(
  outbox: Outbox,
  channelId: string,
  id: string,
  state: OutboxEntry['state'],
): Outbox {
  const list = outbox[channelId];
  if (list === undefined || !list.some((e) => e.id === id)) return outbox;
  return { ...outbox, [channelId]: list.map((e) => (e.id === id ? { ...e, state } : e)) };
}

/** Replace one entry's attachments (upload progress, a returned version id). */
export function outboxSetAttachments(
  outbox: Outbox,
  channelId: string,
  id: string,
  attachments: readonly MessageAttachment[],
): Outbox {
  const list = outbox[channelId];
  if (list === undefined || !list.some((e) => e.id === id)) return outbox;
  return {
    ...outbox,
    [channelId]: list.map((e) => (e.id === id ? { ...e, local: { ...e.local, attachments } } : e)),
  };
}

/**
 * One entry recorded at server time `recordedMs`: drop it, and re-stamp every
 * entry that was queued behind it with a tap time not after `recordedMs` to
 * just after it (in queue order), so a quick later send never shows above the
 * message it was sent after. The recorded entry's queue position decides who
 * is behind it. Pure.
 */
export function outboxRecorded(
  outbox: Outbox,
  channelId: string,
  id: string,
  recordedMs: number,
): Outbox {
  const list = outbox[channelId];
  const index = list?.findIndex((e) => e.id === id) ?? -1;
  if (list === undefined || index === -1) return outbox;
  let bump = 0;
  const next = list
    .map((entry, i) => {
      // Only pending sends move along; a refused one keeps its time and place.
      if (
        i <= index ||
        entry.state !== 'sending' ||
        entry.createdMs === undefined ||
        !Number.isFinite(recordedMs)
      ) {
        return entry;
      }
      if (entry.createdMs > recordedMs) return entry;
      bump += 1;
      return { ...entry, createdMs: recordedMs + bump };
    })
    .filter((e) => e.id !== id);
  const copy = { ...outbox };
  if (next.length === 0) delete copy[channelId];
  else copy[channelId] = next;
  return copy;
}

/** Drop one entry once its row is recorded; an emptied channel is removed. */
export function outboxRemove(outbox: Outbox, channelId: string, id: string): Outbox {
  const list = outbox[channelId];
  if (list === undefined || !list.some((e) => e.id === id)) return outbox;
  const next = list.filter((e) => e.id !== id);
  const copy = { ...outbox };
  if (next.length === 0) delete copy[channelId];
  else copy[channelId] = next;
  return copy;
}

/** Drop every unrecorded send of one channel (the chat was deleted for the caller). */
export function outboxDropChannel(outbox: Outbox, channelId: string): Outbox {
  if (outbox[channelId] === undefined) return outbox;
  const copy = { ...outbox };
  delete copy[channelId];
  return copy;
}

/** A channel's unrecorded sends; empty when there are none. */
export function selectOutbox(outbox: Outbox, channelId: string): readonly OutboxEntry[] {
  return outbox[channelId] ?? [];
}

/** What the outbox tells the open thread: a bubble changed state, or its row landed. */
export type OutboxEvent =
  | { type: 'state'; channelId: string; id: string; state: OutboxEntry['state'] }
  | { type: 'recorded'; channelId: string; message: ThreadMessage }
  | {
      type: 'progress';
      channelId: string;
      id: string;
      attachments: readonly MessageAttachment[];
    }
  /** The sender cancelled an uploading send (the X): its bubble goes, peers never see it. */
  | { type: 'cancelled'; channelId: string; id: string };

/**
 * The outbox surface the thread drives; the store provider implements it over
 * the background sender (send-flow.ts createOutboxSender).
 */
export interface ChannelOutbox {
  entries: (channelId: string) => readonly OutboxEntry[];
  /**
   * Queue one send; delivery (record, then publish) runs in the background.
   * An entry without createdMs is stamped with the estimated server time now
   * (serverNowMs), which its bubble then reads back from entries().
   */
  enqueue: (channelId: string, entry: OutboxEntry) => void;
  /** The Retry tap on a failed bubble: resume the channel's queue, same ids. */
  retry: (channelId: string, id: string) => void;
  /**
   * The row was read back from Postgres (catch-up): the send is done. Also the
   * Remove on an entry whose files were lost to a reload (it drops the entry).
   */
  settle: (channelId: string, id: string) => void;
  /**
   * The X on an uploading send: abort its upload, drop the entry, its stored
   * files, previews and timers, and free the queue at once. False (ignored)
   * once its record call has fired, or when nothing of it is uploading.
   */
  cancel: (channelId: string, id: string) => boolean;
  subscribe: (listener: (event: OutboxEvent) => void) => () => void;
  /**
   * Messages became tombstones (by us, or live by their sender): the store
   * strips their text from draft replies and queued sends that quote them, and
   * re-reads any chat list line that showed one.
   */
  messagesDeleted: (messageIds: readonly string[]) => void;
}

/**
 * Queued sends that quote a deleted message lose the quote's text (the
 * reply_to id stays, so the record still links it). The same outbox when none
 * match. Pure.
 */
export function stripDeletedQuotes(outbox: Outbox, deletedIds: ReadonlySet<string>): Outbox {
  if (deletedIds.size === 0) return outbox;
  let changed = false;
  const next: Record<string, readonly OutboxEntry[]> = {};
  for (const [channelId, list] of Object.entries(outbox)) {
    next[channelId] = list.map((entry) => {
      const reply = entry.local.reply;
      if (reply === null || reply.preview === '' || !deletedIds.has(reply.id)) return entry;
      changed = true;
      return { ...entry, local: { ...entry.local, reply: { ...reply, preview: '' } } };
    });
  }
  return changed ? next : outbox;
}

/**
 * The one localStorage key the pending outbox lives under: one user, one slot
 * per workspace ({ userId, byWorkspace: { [workspaceId]: outbox } }).
 */
export const OUTBOX_STORAGE_KEY = 'sorted:chat:outbox:v2';

/** The single-workspace blob before v2; folded into v2 on first read. */
const LEGACY_OUTBOX_STORAGE_KEY = 'sorted:chat:outbox:v1';

/** The slice of Web Storage the outbox persistence uses. */
export interface OutboxStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** Whose outbox is persisted: one workspace, one user. */
export interface OutboxScope {
  workspaceId: string;
  userId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseAttachment(value: unknown): MessageAttachment | null {
  if (!isRecord(value)) return null;
  const { assetId, name, mime, transcript, size, durationMs } = value;
  if (typeof assetId !== 'string' || typeof name !== 'string' || typeof mime !== 'string') {
    return null;
  }
  // A voice note's waveform survives a reload; invalid peaks are dropped.
  const peaks = parsePeaks(value.peaks);
  return {
    assetId,
    name,
    mime,
    ...(typeof transcript === 'string' ? { transcript } : {}),
    ...(typeof size === 'number' ? { size } : {}),
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
    ...(peaks !== undefined ? { peaks } : {}),
  };
}

function parseReply(value: unknown): ReplyQuote | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { id, authorUserId, preview, rootId } = value;
  if (typeof id !== 'string' || typeof preview !== 'string') return undefined;
  if (authorUserId !== null && typeof authorUserId !== 'string') return undefined;
  return { id, authorUserId, preview, ...(typeof rootId === 'string' ? { rootId } : {}) };
}

/**
 * One persisted entry back to an OutboxEntry; null when malformed. It resumes
 * 'sending' unless an attachment never got its version id: that File is not
 * in localStorage, so the entry is 'failed' with filesMissing (Remove only)
 * until outbox-files.ts brings it back (see awaitRestoredFiles).
 */
function parseEntry(value: unknown): OutboxEntry | null {
  if (!isRecord(value) || !isRecord(value.local)) return null;
  const { id, text, createdMs } = value;
  const { attachments, sharedPostIds, sharedBriefIds, reply, forwardedFromMessageId } = value.local;
  if (typeof id !== 'string' || typeof text !== 'string') return null;
  if (forwardedFromMessageId !== undefined && typeof forwardedFromMessageId !== 'string')
    return null;
  if (!Array.isArray(attachments) || !isStringArray(sharedPostIds)) return null;
  if (sharedBriefIds !== undefined && !isStringArray(sharedBriefIds)) return null;
  const parsedAttachments = attachments.map(parseAttachment);
  const parsedReply = parseReply(reply);
  if (parsedReply === undefined) return null;
  const valid = parsedAttachments.filter((a): a is MessageAttachment => a !== null);
  if (valid.length !== attachments.length) return null;
  const filesMissing = valid.some((a) => a.assetId === '');
  return {
    id,
    text,
    local: {
      attachments: valid,
      sharedPostIds,
      ...(sharedBriefIds !== undefined ? { sharedBriefIds } : {}),
      reply: parsedReply,
      ...(forwardedFromMessageId !== undefined ? { forwardedFromMessageId } : {}),
    },
    state: filesMissing ? 'failed' : 'sending',
    ...(typeof createdMs === 'number' && Number.isFinite(createdMs) && createdMs > 0
      ? { createdMs }
      : {}),
    ...(filesMissing ? { filesMissing: true as const } : {}),
  };
}

/**
 * Restored entries persisted without a tap time get one, once (`nowMs`, the
 * estimated server time at restore), so their bubble's time and place never
 * change on later loads. The same outbox when none match. Pure.
 */
export function stampMissingCreatedMs(outbox: Outbox, nowMs: number): Outbox {
  let changed = false;
  const next: Record<string, readonly OutboxEntry[]> = {};
  for (const [channelId, list] of Object.entries(outbox)) {
    next[channelId] = list.map((entry) => {
      if (entry.createdMs !== undefined) return entry;
      changed = true;
      return { ...entry, createdMs: nowMs };
    });
  }
  return changed ? next : outbox;
}

/**
 * Restored entries whose files were not in localStorage wait for IndexedDB
 * instead of reading "Photos not sent": 'sending' + restoring, same place in
 * the queue. Used only where outbox-files.ts can try to bring the files back.
 * The same outbox when none match. Pure.
 */
export function awaitRestoredFiles(outbox: Outbox): Outbox {
  let changed = false;
  const next: Record<string, readonly OutboxEntry[]> = {};
  for (const [channelId, list] of Object.entries(outbox)) {
    next[channelId] = list.map((entry) => {
      if (entry.filesMissing !== true) return entry;
      changed = true;
      const waiting: OutboxEntry = { ...entry, state: 'sending', restoring: true };
      delete waiting.filesMissing;
      return waiting;
    });
  }
  return changed ? next : outbox;
}

/** The stored v2 blob; slots are raw (unparsed) outboxes. */
interface StoredOutboxes {
  userId: string;
  byWorkspace: Record<string, Record<string, unknown>>;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Save the blob; no slots left removes the key. May throw (storage). */
function saveStored(storage: OutboxStorage, stored: StoredOutboxes): void {
  if (Object.keys(stored.byWorkspace).length === 0) storage.removeItem(OUTBOX_STORAGE_KEY);
  else storage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(stored));
}

/**
 * The stored v2 blob, after folding any v1 blob into it (v1 is always removed;
 * its entries survive only when no other user's v2 blob is present). A
 * malformed v2 blob is removed. Null when nothing is stored. May throw only
 * when storage itself does.
 */
function loadStored(storage: OutboxStorage): StoredOutboxes | null {
  const rawV2 = storage.getItem(OUTBOX_STORAGE_KEY);
  const v2 = parseJsonRecord(rawV2);
  let stored: StoredOutboxes | null = null;
  if (v2 !== null && typeof v2.userId === 'string' && isRecord(v2.byWorkspace)) {
    const byWorkspace: Record<string, Record<string, unknown>> = {};
    for (const [workspaceId, slot] of Object.entries(v2.byWorkspace)) {
      if (isRecord(slot)) byWorkspace[workspaceId] = slot;
    }
    stored = { userId: v2.userId, byWorkspace };
  } else if (rawV2 !== null) {
    storage.removeItem(OUTBOX_STORAGE_KEY);
  }

  const rawV1 = storage.getItem(LEGACY_OUTBOX_STORAGE_KEY);
  if (rawV1 === null) return stored;
  const v1 = parseJsonRecord(rawV1);
  storage.removeItem(LEGACY_OUTBOX_STORAGE_KEY);
  if (
    v1 === null ||
    typeof v1.userId !== 'string' ||
    typeof v1.workspaceId !== 'string' ||
    !isRecord(v1.outbox)
  ) {
    return stored;
  }
  if (stored !== null && stored.userId !== v1.userId) return stored;
  const next: StoredOutboxes = stored ?? { userId: v1.userId, byWorkspace: {} };
  // A v2 slot is newer than the v1 blob and wins.
  if (next.byWorkspace[v1.workspaceId] === undefined) {
    next.byWorkspace[v1.workspaceId] = v1.outbox;
    saveStored(storage, next);
  }
  return next;
}

/**
 * The persisted outbox for exactly this workspace and user, every entry back
 * to 'sending' (or 'failed' with filesMissing when its upload never
 * finished). Other workspaces' slots are left in place (they resume when the
 * user returns to them); another user's blob is deleted. Never throws:
 * unreadable storage or a malformed blob is an empty outbox.
 */
export function readPersistedOutbox(storage: OutboxStorage | null, scope: OutboxScope): Outbox {
  if (storage === null) return {};
  try {
    const stored = loadStored(storage);
    if (stored === null) return {};
    if (stored.userId !== scope.userId) {
      storage.removeItem(OUTBOX_STORAGE_KEY);
      return {};
    }
    const slot = stored.byWorkspace[scope.workspaceId];
    if (slot === undefined) return {};
    const outbox: Record<string, OutboxEntry[]> = {};
    for (const [channelId, list] of Object.entries(slot)) {
      if (!Array.isArray(list)) continue;
      const entries = list.map(parseEntry).filter((e): e is OutboxEntry => e !== null);
      if (entries.length > 0) outbox[channelId] = entries;
    }
    return outbox;
  } catch {
    return {};
  }
}

/**
 * Every entry id the persisted outbox holds, across every workspace slot of
 * the stored user (the file store keeps blobs for exactly these). Empty when
 * nothing is stored; null when storage is missing or unreadable (keep every
 * blob).
 */
export function persistedOutboxIds(storage: OutboxStorage | null): Set<string> | null {
  if (storage === null) return null;
  try {
    const ids = new Set<string>();
    const stored = loadStored(storage);
    if (stored === null) return ids;
    for (const slot of Object.values(stored.byWorkspace)) {
      for (const list of Object.values(slot)) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (isRecord(entry) && typeof entry.id === 'string') ids.add(entry.id);
        }
      }
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * Persist this scope's pending sends (bodies included) into its workspace
 * slot; other workspaces' slots stay. An empty outbox drops the slot, and the
 * key goes with the last slot. Another user's blob is replaced, never merged.
 * Never throws.
 */
export function writePersistedOutbox(
  storage: OutboxStorage | null,
  scope: OutboxScope,
  outbox: Outbox,
): void {
  if (storage === null) return;
  try {
    const loaded = loadStored(storage);
    const stored: StoredOutboxes =
      loaded !== null && loaded.userId === scope.userId
        ? loaded
        : { userId: scope.userId, byWorkspace: {} };
    const pending = Object.entries(outbox).filter(([, list]) => list.length > 0);
    if (pending.length === 0) {
      delete stored.byWorkspace[scope.workspaceId];
      if (loaded === null) return;
      saveStored(storage, stored);
      return;
    }
    const persisted: Record<
      string,
      { id: string; text: string; local: LocalMessageContent; createdMs?: number }[]
    > = {};
    for (const [channelId, list] of pending) {
      // A File and its object URL cannot be stored here: only the attachment
      // fields are, so an unfinished upload restores with an empty asset id
      // (its bytes live in IndexedDB, outbox-files.ts).
      persisted[channelId] = list.map((e) => ({
        id: e.id,
        text: e.text,
        local: { ...e.local, attachments: e.local.attachments.map(withoutLocal) },
        ...(e.createdMs !== undefined ? { createdMs: e.createdMs } : {}),
      }));
    }
    stored.byWorkspace[scope.workspaceId] = persisted;
    saveStored(storage, stored);
  } catch {
    // Storage full or blocked: the send carries on from memory.
  }
}

/**
 * Clear the quote text of persisted sends that quote a deleted message, in
 * place (every workspace slot of the stored user); reply ids stay. Never
 * throws.
 */
export function stripPersistedQuotes(
  storage: OutboxStorage | null,
  deletedIds: readonly string[],
): void {
  if (storage === null || deletedIds.length === 0) return;
  try {
    const stored = loadStored(storage);
    if (stored === null) return;
    const hit = new Set(deletedIds);
    let changed = false;
    for (const slot of Object.values(stored.byWorkspace)) {
      for (const list of Object.values(slot)) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
          if (!isRecord(entry) || !isRecord(entry.local) || !isRecord(entry.local.reply)) continue;
          const reply = entry.local.reply;
          if (typeof reply.id !== 'string' || !hit.has(reply.id) || reply.preview === '') continue;
          reply.preview = '';
          changed = true;
        }
      }
    }
    if (changed) saveStored(storage, stored);
  } catch {
    // Unreadable or blocked storage: nothing to strip.
  }
}

/** Sign-out: no message body outlives the session. Never throws. */
export function clearPersistedOutbox(storage: OutboxStorage | null): void {
  if (storage === null) return;
  try {
    storage.removeItem(OUTBOX_STORAGE_KEY);
    storage.removeItem(LEGACY_OUTBOX_STORAGE_KEY);
  } catch {
    // Blocked storage has nothing to clear.
  }
}
