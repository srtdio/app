// Pure, framework-free store for the always-on chat live layer. It holds one
// summary per channel (keyed by OUR channel_id, never an Agora id) plus the
// active and pending-open selection, and derives the total unread the Chat tab
// badge reads. Unread counts and ordering come from the chat_unread_counts proc
// (Postgres is the record); the last-line preview comes from a bounded Postgres
// scan and is refreshed live by incoming and own messages. Every exported
// function is a pure transition: same input, same output, with no React, no
// Agora, and no clock. The provider (ChatStoreProvider) wires these to the SDK
// and React state; keeping the logic here lets the reducer be unit-tested in
// isolation with no connection.

import type { ConversationPreview, UnreadCount } from '@/lib/chat/history';
import type { LocalMessageContent } from '@/lib/chat/thread';

/** Sender label written before the preview when the current user sent it. */
export const OWN_PREFIX = 'You';

/** Preview line for a recorded message with attachments and no text. */
export const ATTACHMENT_PREVIEW = 'Attachment';

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
}

/** Full store state. `conversations` is keyed by our channel_id. */
export interface ChatStoreState {
  conversations: Record<string, ConversationSummary>;
  /** The channel the user is viewing; its incoming messages stay read. */
  activeConversationId: string | null;
  /** A channel a toast asked to open, consumed once the chat page reads it. */
  pendingOpenConversationId: string | null;
}

/** A channel present in the workspace roster; only its id matters to the store. */
export interface RosterEntry {
  channelId: string;
}

/** A live incoming message, already mapped to our channel_id. */
export interface IncomingMessage {
  channelId: string;
  senderIsSelf: boolean;
  text: string;
  prefix?: string;
  ts: number;
}

/** A just-sent outbound message, used to refresh the channel's last line. */
export interface OwnMessage {
  channelId: string;
  text: string;
  ts: number;
}

/** Empty store: no conversations, nothing active, nothing pending. */
export function initialState(): ChatStoreState {
  return { conversations: {}, activeConversationId: null, pendingOpenConversationId: null };
}

function summary(text: string, ts: number, unread: number, prefix?: string): ConversationSummary {
  return {
    lastMessageText: text,
    lastMessageTs: ts,
    unread,
    ...(prefix !== undefined ? { lastMessagePrefix: prefix } : {}),
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

/** The card line for a recorded preview: its body, or a label for attachment-only. */
export function previewText(preview: Pick<ConversationPreview, 'body' | 'hasAttachments'>): string {
  if (preview.body.trim() !== '') return preview.body;
  return preview.hasAttachments ? ATTACHMENT_PREVIEW : '';
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
  return { conversations, activeConversationId: null, pendingOpenConversationId: null };
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
    conversations[row.channelId] = {
      ...existing,
      unread: state.activeConversationId === row.channelId ? 0 : row.unread,
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
 * 'You' prefix so the card reads correctly.
 */
export function applyPreviews(
  state: ChatStoreState,
  previews: readonly ConversationPreview[],
  currentUserId: string,
): ChatStoreState {
  const conversations = { ...state.conversations };
  for (const preview of previews) {
    const existing = conversations[preview.channelId] ?? emptySummary();
    const ts = Date.parse(preview.createdAt);
    const isOwn = preview.senderUserId !== null && preview.senderUserId === currentUserId;
    conversations[preview.channelId] = summary(
      previewText(preview),
      Number.isNaN(ts) ? existing.lastMessageTs : Math.max(existing.lastMessageTs, ts),
      existing.unread,
      isOwn ? OWN_PREFIX : undefined,
    );
  }
  return { ...state, conversations };
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
    summary(message.text, message.ts, unread, message.prefix),
  );
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
    summary(own.text, own.ts, existingUnread, OWN_PREFIX),
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
 * One own send that has not reached the record yet: in flight ('sending') or
 * failed and waiting on Retry. Kept per channel, outside any open thread, so
 * switching channels neither loses a failed bubble nor its Retry payload.
 */
export interface OutboxEntry {
  id: string;
  text: string;
  local: LocalMessageContent;
  state: 'sending' | 'failed';
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

/** A channel's unrecorded sends; empty when there are none. */
export function selectOutbox(outbox: Outbox, channelId: string): readonly OutboxEntry[] {
  return outbox[channelId] ?? [];
}

/** The outbox surface the thread drives; the store provider implements it. */
export interface ChannelOutbox {
  entries: (channelId: string) => readonly OutboxEntry[];
  put: (channelId: string, entry: OutboxEntry) => void;
  setState: (channelId: string, id: string, state: OutboxEntry['state']) => void;
  remove: (channelId: string, id: string) => void;
}

/** A ChannelOutbox over a mutable holder (the provider's ref, or a hook-local fallback). */
export function createChannelOutbox(holder: { current: Outbox }): ChannelOutbox {
  return {
    entries: (channelId) => selectOutbox(holder.current, channelId),
    put: (channelId, entry) => {
      holder.current = outboxPut(holder.current, channelId, entry);
    },
    setState: (channelId, id, state) => {
      holder.current = outboxSetState(holder.current, channelId, id, state);
    },
    remove: (channelId, id) => {
      holder.current = outboxRemove(holder.current, channelId, id);
    },
  };
}
