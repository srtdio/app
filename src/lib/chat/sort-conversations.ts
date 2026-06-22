// Pure ordering for the chat conversation list. The roster (ChannelSummary[])
// comes from the registry, while recency lives in the chat store; this helper
// joins them via a `summaryFor` lookup so it stays framework-free and unit
// testable with no store. Conversations with a message sort most-recent first by
// lastMessageTs; message-less channels fall to the end, newest-created first, so
// a brand-new empty channel still surfaces above older empty ones.

import type { ChannelSummary } from '@/lib/chat-reads';

/** The recency slice this helper reads from a channel's store summary. */
export interface RecencySummary {
  /** Epoch ms of the most recent message; 0 (or no summary) means no messages. */
  lastMessageTs: number;
}

/**
 * Sort the roster recent-first. A channel "has a message" when its summary
 * reports a positive lastMessageTs; those sort by lastMessageTs descending.
 * Message-less channels (no summary or lastMessageTs 0) follow, ordered by
 * createdAt descending. Equal keys keep their input order (stable), and the
 * input array is never mutated.
 */
export function sortChannelsByRecency(
  channels: readonly ChannelSummary[],
  summaryFor: (channelId: string) => RecencySummary | undefined,
): ChannelSummary[] {
  const tsOf = (channel: ChannelSummary): number =>
    summaryFor(channel.channelId)?.lastMessageTs ?? 0;
  const withMessages = channels.filter((channel) => tsOf(channel) > 0);
  const messageLess = channels.filter((channel) => tsOf(channel) <= 0);
  const recent = [...withMessages].sort((a, b) => tsOf(b) - tsOf(a));
  const idle = [...messageLess].sort((a, b) => compareDesc(a.createdAt, b.createdAt));
  return [...recent, ...idle];
}

/** Descending string compare; ISO timestamps order chronologically this way. */
function compareDesc(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}
