// Pure, framework-free store for the always-on chat live layer. It holds one
// summary per channel (keyed by OUR channel_id, never an Agora id) plus the
// active and pending-open selection, and derives the total unread the Chat tab
// badge reads. Every exported function is a pure transition: same input, same
// output, with no React, no Agora, and no clock. The provider
// (ChatStoreProvider) wires these to the SDK and React state; keeping the logic
// here lets the reducer be unit-tested in isolation with no connection.

/** Sender label written before the preview when the current user sent it. */
export const OWN_PREFIX = 'You';

/** One conversation's preview + unread, as the chat list and badge read it. */
export interface ConversationSummary {
  /** Body of the most recent message; '' when the channel has no messages yet. */
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

/** A channel's Agora-derived summary, already mapped to our channel_id. */
export interface AgoraConversationSummary {
  channelId: string;
  lastMessageText: string;
  lastMessagePrefix?: string;
  lastMessageTs: number;
  unread: number;
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

/**
 * Seed the store from the workspace roster and the Agora conversation summaries.
 * Every roster channel is keyed at unread 0 with an empty line, then each Agora
 * summary overlays its last message + unread, so a channel with no Agora
 * conversation stays at unread 0 rather than vanishing.
 */
export function mergeInitial(
  roster: readonly RosterEntry[],
  agoraConvos: readonly AgoraConversationSummary[],
): ChatStoreState {
  const conversations: Record<string, ConversationSummary> = {};
  for (const entry of roster) {
    conversations[entry.channelId] = emptySummary();
  }
  for (const convo of agoraConvos) {
    conversations[convo.channelId] = summary(
      convo.lastMessageText,
      convo.lastMessageTs,
      convo.unread,
      convo.lastMessagePrefix,
    );
  }
  return { conversations, activeConversationId: null, pendingOpenConversationId: null };
}

/**
 * Fold a live incoming message into the store. Self-sent messages are ignored
 * (the sender already echoes its own send). A message for the active channel
 * refreshes the last line but stays read; any other channel also increments
 * unread.
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
